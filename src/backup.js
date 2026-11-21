"use strict";

const fs = require("node:fs");
const path = require("node:path");
const config = require("./config");
const db = require("./db");

const TABLES = ["teams", "users", "directory", "consignments", "consignment_documents", "assets", "audit_log", "feedback",
  "hardware_requests", "handovers", "choices"];

function stamp() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return now.getFullYear() + pad(now.getMonth() + 1) + pad(now.getDate()) + "_" + pad(now.getHours())
    + pad(now.getMinutes()) + pad(now.getSeconds());
}

// Writes every table to one JSON file in BACKUP_DIR and returns its full path.
async function backupNow(reason) {
  fs.mkdirSync(config.backupDir, { recursive: true });
  const content = { createdAt: new Date().toISOString(), environment: config.appEnv, reason, tables: {} };
  for (const table of TABLES) content.tables[table] = await db.query("SELECT * FROM " + table);
  const file = path.join(config.backupDir, "IMS_backup_" + config.appEnv + "_" + stamp() + ".json");
  fs.writeFileSync(file, JSON.stringify(content, null, 1));
  if (fs.existsSync(config.uploadDir)) {
    fs.cpSync(config.uploadDir, path.join(config.backupDir, "uploads"), { recursive: true, force: false });
  }
  pruneOld();
  return file;
}

function pruneOld() {
  const cutoff = Date.now() - config.backupKeepDays * 24 * 3600 * 1000;
  for (const name of fs.readdirSync(config.backupDir)) {
    if (!/^IMS_backup_.*\.json$/.test(name)) continue;
    const full = path.join(config.backupDir, name);
    if (fs.statSync(full).mtimeMs < cutoff) fs.unlinkSync(full);
  }
}

function latestBackup() {
  if (!fs.existsSync(config.backupDir)) return null;
  const names = fs.readdirSync(config.backupDir).filter((name) => /^IMS_backup_.*\.json$/.test(name));
  if (!names.length) return null;
  const newest = names
    .map((name) => ({ name, time: fs.statSync(path.join(config.backupDir, name)).mtime }))
    .sort((a, b) => b.time - a.time)[0];
  return newest;
}

// Takes one automatic backup a day, at BACKUP_HOUR or the first check after it.
function scheduleDailyBackup(log) {
  const check = async () => {
    const now = new Date();
    if (now.getHours() < config.backupHour) return;
    const newest = latestBackup();
    if (newest && newest.time.toDateString() === now.toDateString()) return;
    try {
      log("Daily backup saved: " + (await backupNow("daily")));
    } catch (error) {
      log("Daily backup failed: " + error.message);
    }
  };
  setInterval(check, 10 * 60 * 1000).unref();
  setTimeout(check, 30 * 1000).unref();
}

module.exports = { backupNow, latestBackup, scheduleDailyBackup };
