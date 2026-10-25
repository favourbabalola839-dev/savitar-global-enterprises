
"use strict";

require("dotenv").config();

const express = require("express");
const session = require("express-session");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Pool } = require("pg");

const app = express();
const PORT = Number(process.env.PORT) || 3000;

const ROOT_DIR = __dirname;
const PUBLIC_DIR = path.join(ROOT_DIR, "public");
const DATA_DIR = path.join(ROOT_DIR, "data");
const UPLOAD_DIR = path.join(PUBLIC_DIR, "uploads");
const PRODUCTS_FILE = path.join(DATA_DIR, "products.json");
const VISITORS_FILE = path.join(DATA_DIR, "visitor-stats.json");
const LEGACY_PRODUCTS_FILE = path.join(ROOT_DIR, "product.json");

for (const dir of [PUBLIC_DIR, DATA_DIR, UPLOAD_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

if (!process.env.DATABASE_URL) {
  console.error("ERROR: DATABASE_URL is missing.");
  process.exit(1);
}

if (!process.env.ADMIN_PASSWORD) {
  console.error("ERROR: Set ADMIN_PASSWORD in Render.");
  process.exit(1);
}

if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32) {
  console.error("ERROR: SESSION_SECRET must be at least 32 characters.");
  process.exit(1);
}

if (process.env.NODE_ENV === "production") {
  app.set("trust proxy", 1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production"
    ? { rejectUnauthorized: false }
    : undefined,
  max: 5,
  connectionTimeoutMillis: 10000
});

app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true, limit: "1mb" }));

app.use(session({
  name: "savitar.sid",
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 8 * 60 * 60 * 1000
  }
}));

// ---------- Helpers ----------

function makeId() {
  return crypto.randomUUID();
}

function text(value, maxLength = 5000) {
  return String(value ?? "").trim().slice(0, maxLength);
}

function positiveNumber(value, fieldName, allowZero = true) {
  if (value === "" || value === null || value === undefined) {
    throw new Error(`${fieldName} is required.`);
  }

  const number = Number(value);

  if (!Number.isFinite(number) ||
      number < 0 ||
      (!allowZero && number === 0)) {
    throw new Error(`${fieldName} must be a valid non-negative number.`);
  }

  return number;
}

function wholeNumber(value, fieldName = "Stock") {
  const number = positiveNumber(value, fieldName);

  if (!Number.isInteger(number)) {
    throw new Error(`${fieldName} must be a whole number.`);
  }

  return number;
}

function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;

    const contents = fs.readFileSync(file, "utf8");
    return contents.trim() ? JSON.parse(contents) : fallback;
  } catch (error) {
    console.error(`Could not read ${file}:`, error.message);
    return fallback;
  }
}

function writeJson(file, value) {
  const temporaryFile = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryFile, JSON.stringify(value, null, 2), "utf8");
  fs.renameSync(temporaryFile, file);
}

function cleanProduct(body, existing = {}) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("Invalid product data.");
  }

  const name = text(body.name ?? existing.name, 160);
  const category = text(body.category ?? existing.category, 100);

  if (!name) throw new Error("Product name is required.");
  if (!category) throw new Error("Product category is required.");

  const price = positiveNumber(body.price ?? existing.price, "Price");
  const stock = wholeNumber(body.stock ?? existing.stock, "Stock");

  const dealInput = Object.prototype.hasOwnProperty.call(body, "dealPrice")
    ? body.dealPrice
    : existing.dealPrice;

  const dealPrice =
    dealInput === "" || dealInput === null || dealInput === undefined
      ? null
      : positiveNumber(dealInput, "Deal price");

  const sweetDeal = Object.prototype.hasOwnProperty.call(body, "sweetDeal")
    ? body.sweetDeal === true || body.sweetDeal === "true"
    : Boolean(existing.sweetDeal);

  if (sweetDeal && (dealPrice === null || dealPrice <= 0)) {
    throw new Error("A Sweet Deal requires a deal price greater than zero.");
  }

  const image = text(body.image ?? existing.image, 2000);

  if (image && !image.startsWith("/uploads/")) {
    let parsed;

    try {
      parsed = new URL(image);
    } catch (_) {
      throw new Error("Image must be a valid HTTP(S) URL or uploaded image path.");
    }

    if (!["http:", "https:"].includes(parsed.protocol)) {
      throw new Error("Image URL must use HTTP or HTTPS.");
    }
  }

  const result = {
    ...existing,
    id: existing.id || makeId(),
    name,
    category,
    condition: text(body.condition ?? existing.condition ?? "New", 60),
    price,
    stock,
    dealPrice,
    sweetDeal,
    storage: text(body.storage ?? existing.storage, 80),
    color: text(body.color ?? existing.color, 80),
    description: text(body.description ?? existing.description, 5000),
    image: image || existing.image || "",
    images: Array.isArray(existing.images) ? existing.images : [],
    updatedAt: new Date().toISOString()
  };

  if (!existing.createdAt) {
    result.createdAt = new Date().toISOString();
  }

  return result;
}

function sendError(res, error, status = 400) {
  return res.status(status).json({
    ok: false,
    error: error.message || "Something went wrong."
  });
}

function requireAdmin(req, res, next) {
  if (!req.session || req.session.isAdmin !== true) {
    return res.status(401).json({
      ok: false,
      error: "Your admin session has expired. Please sign in again."
    });
  }

  next();
}

// ---------- PostgreSQL ----------

// This table belongs to SAVITAR only.
// It does not read, update, or delete Mercy's Kitchen tables.
async function initialiseDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS savitar_products (
      id TEXT PRIMARY KEY,
      product JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // Import JSON products only when the SAVITAR table is empty.
  // Existing database products are never overwritten by this import.
  const countResult = await pool.query(
    "SELECT COUNT(*)::int AS count FROM savitar_products"
  );

  if (countResult.rows[0].count === 0) {
    let legacy = readJson(PRODUCTS_FILE, null);

    if (!Array.isArray(legacy)) {
      legacy = readJson(LEGACY_PRODUCTS_FILE, []);
    }

    if (Array.isArray(legacy) && legacy.length > 0) {
      const client = await pool.connect();

      try {
        await client.query("BEGIN");

        for (const item of legacy) {
          if (!item || typeof item !== "object") continue;

          const product = {
            ...item,
            id: String(item.id || makeId())
          };

          await client.query(
            `INSERT INTO savitar_products (id, product)
             VALUES ($1, $2::jsonb)
             ON CONFLICT (id) DO NOTHING`,
            [product.id, JSON.stringify(product)]
          );
        }

        await client.query("COMMIT");
        console.log(`Imported ${legacy.length} legacy product records.`);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    }
  }

  console.log("SAVITAR PostgreSQL database is ready.");
}

async function loadProducts() {
  const result = await pool.query(
    `SELECT product
     FROM savitar_products
     ORDER BY created_at DESC, id DESC`
  );

  return result.rows.map(row => row.product);
}

async function saveProduct(product) {
  await pool.query(
    `INSERT INTO savitar_products (id, product, created_at, updated_at)
     VALUES ($1, $2::jsonb, NOW(), NOW())
     ON CONFLICT (id)
     DO UPDATE SET product = EXCLUDED.product, updated_at = NOW()`,
    [String(product.id), JSON.stringify(product)]
  );
}

async function findProduct(id) {
  const result = await pool.query(
    "SELECT product FROM savitar_products WHERE id = $1",
    [String(id)]
  );

  return result.rows[0]?.product || null;
}

async function deleteProduct(id) {
  const result = await pool.query(
    "DELETE FROM savitar_products WHERE id = $1 RETURNING id",
    [String(id)]
  );

  return result.rowCount > 0;
}

// ---------- Image uploads ----------

const storage = multer.diskStorage({
  destination: (_req, _file, callback) => callback(null, UPLOAD_DIR),

  filename: (_req, file, callback) => {
    const extension = path.extname(file.originalname || "").toLowerCase();
    const allowed = [".jpg", ".jpeg", ".png", ".webp", ".gif"];

    if (!allowed.includes(extension)) {
      return callback(new Error("Use a JPG, JPEG, PNG, WebP or GIF image."));
    }

    callback(
      null,
      `${Date.now()}-${crypto.randomBytes(8).toString("hex")}${extension}`
    );
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, callback) => {
    const allowed = ["image/jpeg", "image/png", "image/webp", "image/gif"];

    if (!allowed.includes(file.mimetype)) {
      return callback(new Error("Only JPG, PNG, WebP and GIF images are allowed."));
    }

    callback(null, true);
  }
});

// ---------- Visitor statistics ----------
// These statistics still use JSON files and are not guaranteed to survive
// Render redeploys. Product data, however, is stored in PostgreSQL.

function todayInLagos() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Lagos",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date());
}

function readVisitorStats() {
  const data = readJson(VISITORS_FILE, {});

  return {
    totalVisits: Number(data.totalVisits || 0),
    daily: data.daily && typeof data.daily === "object" ? data.daily : {},
    seenVisitors:
      data.seenVisitors && typeof data.seenVisitors === "object"
        ? data.seenVisitors
        : {}
  };
}

function recordHomepageVisit(req, res, next) {
  if (req.path !== "/" || req.method !== "GET") return next();

  try {
    const cookies = Object.fromEntries(
      String(req.headers.cookie || "")
        .split(";")
        .map(part => part.trim())
        .filter(Boolean)
        .map(part => {
          const separator = part.indexOf("=");

          return separator < 0
            ? [part, ""]
            : [
                part.slice(0, separator),
                decodeURIComponent(part.slice(separator + 1))
              ];
        })
    );

    let visitorId = cookies.savitar_visitor;

    if (!visitorId || !/^[a-f0-9-]{20,80}$/i.test(visitorId)) {
      visitorId = makeId();

      res.cookie("savitar_visitor", visitorId, {
        maxAge: 365 * 24 * 60 * 60 * 1000,
        httpOnly: true,
        sameSite: "lax",
        secure: process.env.NODE_ENV === "production"
      });
    }

    const stats = readVisitorStats();
    const day = todayInLagos();

    stats.daily[day] = Number(stats.daily[day] || 0) + 1;
    stats.totalVisits += 1;
    stats.seenVisitors[`${day}:${visitorId}`] = true;

    const keys = Object.keys(stats.seenVisitors);

    if (keys.length > 20000) {
      for (const key of keys.slice(0, keys.length - 20000)) {
        delete stats.seenVisitors[key];
      }
    }

    writeJson(VISITORS_FILE, stats);
  } catch (error) {
    console.error("Visitor statistics error:", error.message);
  }

  next();
}

// ---------- Routes ----------

app.get("/api/health", async (_req, res) => {
  try {
    await pool.query("SELECT 1");

    res.json({
      ok: true,
      service: "Savitar Global Enterprises",
      database: "connected",
      time: new Date().toISOString()
    });
  } catch (error) {
    console.error("Database health check failed:", error.message);
    res.status(503).json({
      ok: false,
      error: "Database connection unavailable."
    });
  }
});

// Public catalogue.
app.get("/api/products", async (_req, res) => {
  try {
    res.json(await loadProducts());
  } catch (error) {
    console.error("Loading products failed:", error.message);
    sendError(res, error, 500);
  }
});

// Admin session status.
app.get("/api/admin/session", (req, res) => {
  res.json({
    loggedIn: Boolean(req.session && req.session.isAdmin === true)
  });
});

// Admin login.
app.post("/api/admin/login", (req, res, next) => {
  const suppliedPassword = String(req.body?.password ?? "");

  if (!suppliedPassword || suppliedPassword !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({
      ok: false,
      error: "Incorrect admin password."
    });
  }

  req.session.regenerate(error => {
    if (error) return next(error);

    req.session.isAdmin = true;
    req.session.loginAt = new Date().toISOString();

    req.session.save(saveError => {
      if (saveError) return next(saveError);

      res.json({ ok: true, message: "Admin login successful." });
    });
  });
});

// Admin logout.
app.post("/api/admin/logout", (req, res, next) => {
  if (!req.session) return res.json({ ok: true });

  req.session.destroy(error => {
    if (error) return next(error);

    res.clearCookie("savitar.sid", {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production"
    });

    res.json({ ok: true, message: "Logged out." });
  });
});

// Admin visitor statistics.
app.get("/api/admin/stats", requireAdmin, (_req, res) => {
  try {
    const stats = readVisitorStats();
    const today = todayInLagos();

    res.json({
      ok: true,
      visitorsToday: Number(stats.daily[today] || 0),
      totalVisits: Number(stats.totalVisits || 0)
    });
  } catch (error) {
    sendError(res, error, 500);
  }
});

// Upload product image.
app.post(
  "/api/admin/upload",
  requireAdmin,
  upload.single("image"),
  (req, res) => {
    if (!req.file) {
      return res.status(400).json({
        ok: false,
        error: "Choose an image to upload."
      });
    }

    const imagePath = `/uploads/${req.file.filename}`;

    res.json({
      ok: true,
      image: imagePath,
      url: imagePath,
      path: imagePath
    });
  }
);

// Add product.
app.post("/api/admin/products", requireAdmin, async (req, res) => {
  try {
    const product = cleanProduct(req.body);
    await saveProduct(product);

    res.status(201).json({
      ok: true,
      product,
      message: "Product added."
    });
  } catch (error) {
    sendError(res, error);
  }
});

// Update product.
app.put("/api/admin/products/:id", requireAdmin, async (req, res) => {
  try {
    const existing = await findProduct(req.params.id);

    if (!existing) {
      return res.status(404).json({
        ok: false,
        error: "Product not found."
      });
    }

    const updated = cleanProduct(req.body, existing);
    updated.id = existing.id;

    await saveProduct(updated);

    res.json({
      ok: true,
      product: updated,
      message: "Product updated."
    });
  } catch (error) {
    sendError(res, error);
  }
});

// Update stock.
app.patch("/api/admin/products/:id/stock", requireAdmin, async (req, res) => {
  try {
    const product = await findProduct(req.params.id);

    if (!product) {
      return res.status(404).json({
        ok: false,
        error: "Product not found."
      });
    }

    product.stock = wholeNumber(req.body?.stock, "Stock");
    product.updatedAt = new Date().toISOString();

    await saveProduct(product);

    res.json({
      ok: true,
      product,
      message: "Stock updated."
    });
  } catch (error) {
    sendError(res, error);
  }
});

// Delete product.
app.delete("/api/admin/products/:id", requireAdmin, async (req, res) => {
  try {
    const deleted = await deleteProduct(req.params.id);

    if (!deleted) {
      return res.status(404).json({
        ok: false,
        error: "Product not found."
      });
    }

    res.json({
      ok: true,
      deleted: String(req.params.id),
      message: "Product deleted."
    });
  } catch (error) {
    sendError(res, error, 500);
  }
});

// Count visits and serve public files.
app.use(recordHomepageVisit);

app.use(express.static(PUBLIC_DIR, {
  extensions: ["html"],
  index: "index.html"
}));

app.get("/admin", (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "admin.html"));
});

// Error handler.
app.use((error, _req, res, _next) => {
  console.error("Request error:", error.message);

  if (error instanceof multer.MulterError) {
    const message = error.code === "LIMIT_FILE_SIZE"
      ? "Image is too large. Maximum size is 5 MB."
      : error.message;

    return res.status(400).json({ ok: false, error: message });
  }

  if (error.message && /image|file/i.test(error.message)) {
    return res.status(400).json({ ok: false, error: error.message });
  }

  res.status(500).json({
    ok: false,
    error: "A server error occurred."
  });
});

// Start only after the database connection and table are ready.
async function startServer() {
  try {
    await pool.query("SELECT 1");
    await initialiseDatabase();

    app.listen(PORT, () => {
      console.log(`Savitar Global Enterprises running on port ${PORT}`);
      console.log("Admin page: /admin");
      console.log("Health check: /api/health");
    });
  } catch (error) {
    console.error("Could not start SAVITAR:", error.message);
    process.exit(1);
  }
}

startServer();
