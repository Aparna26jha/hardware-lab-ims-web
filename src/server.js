"use strict";

const path = require("node:path");
const express = require("express");
const config = require("./config");
const db = require("./db");
const { loadUser } = require("./auth");
const { AppError } = require("./rules");
const { scheduleDailyBackup } = require("./backup");
const { upgradeTables } = require("./migrate");

function log(message) {
  console.log(new Date().toISOString().replace("T", " ").slice(0, 19) + "  " + message);
}

function createApp() {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", false);

  app.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "same-origin");
    res.setHeader("Content-Security-Policy",
      "default-src 'self'; img-src 'self' data: blob:; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    next();
  });

  // Uploads arrive as base64 inside JSON, so the limit is above the 10 MB document size.
  app.use("/api", express.json({ limit: "15mb" }));

  // Every change must come from this app's own pages.
  app.use("/api", (req, res, next) => {
    if (req.method !== "GET" && req.get("X-IMS") !== "1") throw new AppError(403, "Request blocked.");
    next();
  });

  app.use("/api", loadUser);
  app.use("/api", require("./routes/people").router);
  app.use("/api", require("./routes/assets").router);
  app.use("/api", require("./routes/consignments").router);
  app.use("/api", require("./routes/requests").router);
  app.use("/api", require("./routes/handovers").router);
  app.use("/api", require("./routes/admin").router);
  app.use("/api", (req, res) => res.status(404).json({ error: "Not found." }));

  app.use(express.static(path.join(config.root, "public"), { index: "index.html", maxAge: 0 }));

  app.use((error, req, res, next) => {
    if (error instanceof AppError) return res.status(error.status).json({ error: error.message });
    if (error.type === "entity.too.large") return res.status(413).json({ error: "The file is too large." });
    if (error.code === "ER_DUP_ENTRY") return res.status(409).json({ error: "That value is already recorded on another entry." });
    log("Error on " + req.method + " " + req.path + ": " + (error.stack || error.message));
    res.status(500).json({ error: "Something went wrong on the server. Please try again, or report it with the feedback form." });
  });
  return app;
}

async function start() {
  await db.query("SELECT 1");
  const changes = await upgradeTables(db.pool);
  if (changes.length) log("Database brought up to date: " + changes.join(", ") + ".");
  await db.query("DELETE FROM sessions WHERE expires_at < NOW()");
  const app = createApp();
  app.listen(config.port, config.host, () => {
    log("Hardware Lab IMS v" + config.version + " (" + config.appEnv + ") is running on port " + config.port
      + ". Database: " + config.db.database + " on " + config.db.host + ".");
  });
  scheduleDailyBackup(log);
}

if (require.main === module) {
  start().catch((error) => {
    log("Could not start: " + error.message);
    log("Check the DB_ settings in the .env file and that the MySQL service is running.");
    process.exit(1);
  });
}

module.exports = { createApp };
