"use strict";

const path = require("node:path");

const root = path.resolve(__dirname, "..");

function text(name, fallback) {
  const value = process.env[name];
  return value === undefined || value === "" ? fallback : value;
}

function number(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && process.env[name] !== "" ? value : fallback;
}

function folder(name, fallback) {
  return path.resolve(root, text(name, fallback));
}

const appEnv = text("APP_ENV", "development").toLowerCase();

module.exports = {
  root,
  version: require("../package.json").version,
  appEnv,
  isDevelopment: appEnv !== "production",
  port: number("PORT", 8080),
  host: text("HOST", "0.0.0.0"),
  db: {
    host: text("DB_HOST", "127.0.0.1"),
    port: number("DB_PORT", 3306),
    database: text("DB_NAME", "ims_dev"),
    user: text("DB_USER", "ims_app"),
    password: text("DB_PASSWORD", "")
  },
  uploadDir: folder("UPLOAD_DIR", "./data/uploads"),
  backupDir: folder("BACKUP_DIR", "./data/backups"),
  backupHour: number("BACKUP_HOUR", 1),
  backupKeepDays: number("BACKUP_KEEP_DAYS", 30),
  sessionHours: number("SESSION_HOURS", 10),
  cookieSecure: text("COOKIE_SECURE", "false").toLowerCase() === "true",
  expiryWarnMonths: number("EXPIRY_WARN_MONTHS", 6)
};
