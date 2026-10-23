require("dotenv").config();

const express = require("express");
const session = require("express-session");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const app = express();
const PORT = Number(process.env.PORT) || 3000;

const DATA_DIR = path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "products.json");
const VISITOR_FILE = path.join(DATA_DIR, "visitor-stats.json");
const PUBLIC_DIR = path.join(__dirname, "public");
const UPLOAD_DIR = path.join(PUBLIC_DIR, "uploads");
const LEGACY_FILE = path.join(__dirname, "product.json");

// Create folders safely.
if (fs.existsSync(DATA_DIR) && !fs.statSync(DATA_DIR).isDirectory()) {
  throw new Error(
    `"data" exists as a file, not a folder: ${DATA_DIR}`
  );
}

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(PUBLIC_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// Preserve existing products.
if (!fs.existsSync(DATA_FILE)) {
  let initialData = "[]";

  if (fs.existsSync(LEGACY_FILE)) {
    try {
      const legacy = JSON.parse(
        fs.readFileSync(LEGACY_FILE, "utf8")
      );

      if (Array.isArray(legacy)) {
        initialData = JSON.stringify(legacy, null, 2);
      }
    } catch (error) {
      console.error(
        "Could not migrate old product.json:",
        error.message
      );
    }
  }

  fs.writeFileSync(DATA_FILE, initialData, "utf8");
}

// Persistent visitor statistics.
if (!fs.existsSync(VISITOR_FILE)) {
  fs.writeFileSync(
    VISITOR_FILE,
    JSON.stringify({
      totalVisits: 0,
      visitors: {},
      daily: {}
    }, null, 2),
    "utf8"
  );
}

if (!process.env.ADMIN_PASSWORD) {
  console.error("Missing ADMIN_PASSWORD in .env");
  process.exit(1);
}

if (
  !process.env.SESSION_SECRET ||
  process.env.SESSION_SECRET ===
    "replace-this-with-a-long-random-secret"
) {
  console.warn(
    "WARNING: Set a long, random SESSION_SECRET in .env before deployment."
  );
}

app.disable("x-powered-by");
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

app.use(session({
  name: "savitar.sid",
  secret:
    process.env.SESSION_SECRET ||
    crypto.randomBytes(48).toString("hex"),
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 8 * 60 * 60 * 1000
  }
}));

// ------------------------------
// PRODUCT STORAGE
// ------------------------------

function readProducts() {
  const products = JSON.parse(
    fs.readFileSync(DATA_FILE, "utf8")
  );

  if (!Array.isArray(products)) {
    throw new Error("Product data must be a JSON array.");
  }

  return products;
}

function saveProducts(products) {
  const tempFile = `${DATA_FILE}.tmp`;

  fs.writeFileSync(
    tempFile,
    JSON.stringify(products, null, 2),
    "utf8"
  );

  fs.renameSync(tempFile, DATA_FILE);
}

// ------------------------------
// VISITOR ANALYTICS
// ------------------------------

function getTodayKey() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Lagos",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date());
}

function readVisitorStats() {
  try {
    const stats = JSON.parse(
      fs.readFileSync(VISITOR_FILE, "utf8")
    );

    return {
      totalVisits: Number(stats.totalVisits) || 0,
      visitors: stats.visitors || {},
      daily: stats.daily || {}
    };
  } catch (error) {
    console.error(
      "Unable to read visitor statistics:",
      error.message
    );

    return {
      totalVisits: 0,
      visitors: {},
      daily: {}
    };
  }
}

function saveVisitorStats(stats) {
  const tempFile = `${VISITOR_FILE}.tmp`;

  fs.writeFileSync(
    tempFile,
    JSON.stringify(stats, null, 2),
    "utf8"
  );

  fs.renameSync(tempFile, VISITOR_FILE);
}

function getVisitorId(req, res) {
  const cookie = (req.headers.cookie || "").match(
    /(?:^|;\s*)savitar_visitor=([a-f0-9]{32})/
  );

  if (cookie) {
    return cookie[1];
  }

  const visitorId = crypto.randomBytes(16).toString("hex");

  res.cookie("savitar_visitor", visitorId, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 365 * 24 * 60 * 60 * 1000,
    path: "/"
  });

  return visitorId;
}

// Count homepage loads only, not images, CSS, scripts or API polling.
app.use((req, res, next) => {
  if (
    req.method !== "GET" ||
    (req.path !== "/" && req.path !== "/index.html")
  ) {
    return next();
  }

  try {
    const visitorId = getVisitorId(req, res);
    const stats = readVisitorStats();
    const today = getTodayKey();
    const now = new Date().toISOString();

    if (!stats.daily[today]) {
      stats.daily[today] = {
        visits: 0,
        visitorIds: []
      };
    }

    // Every homepage load counts as a visit.
    stats.totalVisits += 1;
    stats.daily[today].visits += 1;

    // Count each anonymous browser once per day.
    if (
      !stats.daily[today].visitorIds.includes(visitorId)
    ) {
      stats.daily[today].visitorIds.push(visitorId);
    }

    if (!stats.visitors[visitorId]) {
      stats.visitors[visitorId] = {
        firstSeen: now,
        lastSeen: now,
        visitCount: 0
      };
    }

    stats.visitors[visitorId].lastSeen = now;
    stats.visitors[visitorId].visitCount += 1;

    saveVisitorStats(stats);
  } catch (error) {
    // Analytics errors must not stop the shop from opening.
    console.error(
      "Visitor statistics error:",
      error.message
    );
  }

  next();
});

// ------------------------------
// STATIC WEBSITE FILES
// ------------------------------

app.use(express.static(PUBLIC_DIR));

// ------------------------------
// IMAGE UPLOADS
// ------------------------------

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, UPLOAD_DIR);
  },

  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();

    cb(
      null,
      `${Date.now()}-${crypto.randomBytes(6).toString("hex")}${ext}`
    );
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 8 * 1024 * 1024 },

  fileFilter: (_req, file, cb) => {
    if (
      !file.mimetype ||
      !file.mimetype.startsWith("image/")
    ) {
      return cb(new Error("Please upload an image file."));
    }

    cb(null, true);
  }
});

// ------------------------------
// ADMIN AND PRODUCT HELPERS
// ------------------------------

function requireAdmin(req, res, next) {
  if (req.session && req.session.isAdmin) {
    return next();
  }

  return res.status(401).json({
    error: "Please log in as admin first."
  });
}

function isTrue(value) {
  return (
    value === true ||
    value === 1 ||
    ["true", "1", "on", "yes"].includes(
      String(value).toLowerCase()
    )
  );
}

function cleanProduct(body, existing = {}) {
  const name = String(
    body.name ?? existing.name ?? ""
  ).trim();

  const category = String(
    body.category ?? existing.category ?? ""
  ).trim();

  const price = Number(
    body.price ?? existing.price
  );

  const stock = Number(
    body.stock ?? existing.stock ?? 0
  );

  if (!name) {
    throw new Error("Product name is required.");
  }

  if (!category) {
    throw new Error("Choose a product category.");
  }

  if (!Number.isFinite(price) || price < 0) {
    throw new Error("Enter a valid price.");
  }

  if (!Number.isInteger(stock) || stock < 0) {
    throw new Error(
      "Stock must be a whole number of zero or more."
    );
  }

  const sweetDeal =
    body.sweetDeal === undefined
      ? Boolean(existing.sweetDeal)
      : isTrue(body.sweetDeal);

  let dealPrice = null;

  if (sweetDeal) {
    dealPrice = Number(
      body.dealPrice ?? existing.dealPrice
    );

    if (
      !Number.isFinite(dealPrice) ||
      dealPrice < 0 ||
      dealPrice >= price
    ) {
      throw new Error(
        "A Sweet Deal price must be lower than the regular price."
      );
    }
  }

  const image = String(
    body.image ??
    body.imageUrl ??
    existing.image ??
    existing.imageUrl ??
    ""
  ).trim();

  return {
    ...existing,
    name,
    category,
    price,
    stock,
    description: String(
      body.description ?? existing.description ?? ""
    ).trim(),
    image,
    condition: String(
      body.condition ?? existing.condition ?? "Brand-new"
    ),
    storage: String(
      body.storage ?? existing.storage ?? ""
    ).trim(),
    color: String(
      body.color ?? existing.color ?? ""
    ).trim(),
    sweetDeal,
    dealPrice,
    inStock: stock > 0,
    updatedAt: new Date().toISOString()
  };
}

function publicProduct(product) {
  return {
    ...product,
    image: product.image || product.imageUrl || "",
    inStock: Number(product.stock) > 0
  };
}

// ------------------------------
// PUBLIC API
// ------------------------------

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    service: "SAVITAR GLOBAL ENTERPRISES"
  });
});

app.get("/api/products", (_req, res) => {
  try {
    res.set("Cache-Control", "no-store");

    res.json(
      readProducts().map(publicProduct)
    );
  } catch (error) {
    console.error("Unable to read catalogue:", error);

    res.status(500).json({
      error: "Unable to load products. Check data/products.json."
    });
  }
});

// ------------------------------
// ADMIN SESSION AND STATISTICS
// ------------------------------

app.get("/api/admin/session", (req, res) => {
  res.json({
    loggedIn: Boolean(req.session && req.session.isAdmin)
  });
});

app.get("/api/admin/stats", requireAdmin, (_req, res) => {
  try {
    const stats = readVisitorStats();
    const today = getTodayKey();

    const todayStats = stats.daily[today] || {
      visits: 0,
      visitorIds: []
    };

    res.set("Cache-Control", "no-store");

    res.json({
      totalVisits: stats.totalVisits,
      uniqueVisitors: Object.keys(stats.visitors).length,
      visitsToday: todayStats.visits,
      uniqueVisitorsToday: todayStats.visitorIds.length
    });
  } catch (error) {
    console.error("Unable to load visitor statistics:", error);

    res.status(500).json({
      error: "Unable to load visitor statistics."
    });
  }
});

// ------------------------------
// ADMIN LOGIN AND LOGOUT
// ------------------------------

app.post("/api/admin/login", (req, res, next) => {
  const password = String(req.body.password || "");

  if (password !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({
      error: "Incorrect admin password."
    });
  }

  req.session.regenerate((error) => {
    if (error) return next(error);

    req.session.isAdmin = true;

    req.session.save((saveError) => {
      if (saveError) return next(saveError);

      res.json({
        ok: true,
        message: "Admin login successful."
      });
    });
  });
});

app.post("/api/admin/logout", (req, res, next) => {
  req.session.destroy((error) => {
    if (error) return next(error);

    res.clearCookie("savitar.sid");

    res.json({ ok: true });
  });
});

// ------------------------------
// ADMIN IMAGE UPLOAD
// ------------------------------

app.post(
  "/api/admin/upload",
  requireAdmin,
  upload.single("image"),
  (req, res) => {
    if (!req.file) {
      return res.status(400).json({
        error: "Choose an image to upload."
      });
    }

    res.json({
      image: `/uploads/${req.file.filename}`
    });
  }
);

// ------------------------------
// ADD PRODUCT
// ------------------------------

app.post("/api/admin/products", requireAdmin, (req, res) => {
  try {
    const products = readProducts();
    const product = cleanProduct(req.body);

    product.id = `sav-${crypto.randomBytes(6).toString("hex")}`;
    product.createdAt = new Date().toISOString();

    products.unshift(product);
    saveProducts(products);

    res.status(201).json(publicProduct(product));
  } catch (error) {
    res.status(400).json({
      error: error.message || "Unable to save product."
    });
  }
});

// ------------------------------
// EDIT PRODUCT
// ------------------------------

app.put("/api/admin/products/:id", requireAdmin, (req, res) => {
  try {
    const products = readProducts();

    const index = products.findIndex(
      p => String(p.id) === req.params.id
    );

    if (index === -1) {
      return res.status(404).json({
        error: "Product not found."
      });
    }

    const updated = cleanProduct(
      req.body,
      products[index]
    );

    updated.id = products[index].id;
    updated.createdAt = products[index].createdAt || null;

    products[index] = updated;
    saveProducts(products);

    res.json(publicProduct(updated));
  } catch (error) {
    res.status(400).json({
      error: error.message || "Unable to update product."
    });
  }
});

// ------------------------------
// UPDATE STOCK
// ------------------------------

app.patch(
  "/api/admin/products/:id/stock",
  requireAdmin,
  (req, res) => {
    try {
      const stock = Number(req.body.stock);

      if (!Number.isInteger(stock) || stock < 0) {
        return res.status(400).json({
          error: "Stock must be a whole number of zero or more."
        });
      }

      const products = readProducts();

      const product = products.find(
        p => String(p.id) === req.params.id
      );

      if (!product) {
        return res.status(404).json({
          error: "Product not found."
        });
      }

      product.stock = stock;
      product.inStock = stock > 0;
      product.updatedAt = new Date().toISOString();

      saveProducts(products);

      res.json(publicProduct(product));
    } catch (error) {
      res.status(500).json({
        error: error.message || "Unable to update stock."
      });
    }
  }
);

// ------------------------------
// DELETE PRODUCT
// ------------------------------

app.delete(
  "/api/admin/products/:id",
  requireAdmin,
  (req, res) => {
    try {
      const products = readProducts();

      const remaining = products.filter(
        p => String(p.id) !== req.params.id
      );

      if (remaining.length === products.length) {
        return res.status(404).json({
          error: "Product not found."
        });
      }

      saveProducts(remaining);

      res.json({
        ok: true,
        message: "Product deleted."
      });
    } catch (error) {
      res.status(500).json({
        error: error.message || "Unable to delete product."
      });
    }
  }
);

// ------------------------------
// ERROR HANDLER
// ------------------------------

app.use((error, _req, res, _next) => {
  console.error(error);

  if (
    error instanceof multer.MulterError &&
    error.code === "LIMIT_FILE_SIZE"
  ) {
    return res.status(400).json({
      error: "Image must be 8MB or smaller."
    });
  }

  res.status(400).json({
    error: error.message || "Request failed."
  });
});

// ------------------------------
// START SERVER
// ------------------------------

app.listen(PORT, () => {
  console.log(
    `SAVITAR GLOBAL ENTERPRISES running at http://localhost:${PORT}`
  );
  console.log("Storefront: /");
  console.log("Admin dashboard: /admin.html");
  console.log(`Product count: ${readProducts().length}`);
});