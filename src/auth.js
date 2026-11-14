"use strict";

const crypto = require("node:crypto");
const config = require("./config");
const db = require("./db");
const { AppError } = require("./rules");

const COOKIE = "ims_sid";
const MAX_FAILURES = 5;
const LOCK_MINUTES = 10;
const failures = new Map();

function hashCode(code) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(code, salt, 32);
  return "s1:" + salt.toString("hex") + ":" + hash.toString("hex");
}

function codeMatches(code, stored) {
  const [version, saltHex, hashHex] = String(stored || "").split(":");
  if (version !== "s1" || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, "hex");
  const actual = crypto.scryptSync(code, Buffer.from(saltHex, "hex"), expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

function tokenHash(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function lockedMinutes(key) {
  const entry = failures.get(key);
  if (!entry || entry.count < MAX_FAILURES) return 0;
  const left = entry.until - Date.now();
  if (left <= 0) {
    failures.delete(key);
    return 0;
  }
  return Math.ceil(left / 60000);
}

function noteFailure(key) {
  const entry = failures.get(key) || { count: 0, until: 0 };
  entry.count += 1;
  if (entry.count >= MAX_FAILURES) entry.until = Date.now() + LOCK_MINUTES * 60000;
  failures.set(key, entry);
}

function clearFailures(key) {
  failures.delete(key);
}

async function startSession(res, empId) {
  const token = crypto.randomBytes(32).toString("hex");
  await db.query(
    "INSERT INTO sessions (token_hash, emp_id, expires_at) VALUES (?, ?, DATE_ADD(NOW(), INTERVAL ? HOUR))",
    [tokenHash(token), empId, config.sessionHours]
  );
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: "strict",
    secure: config.cookieSecure,
    maxAge: config.sessionHours * 3600 * 1000,
    path: "/"
  });
}

async function endSession(req, res) {
  const token = readCookie(req);
  if (token) await db.query("DELETE FROM sessions WHERE token_hash = ?", [tokenHash(token)]);
  res.clearCookie(COOKIE, { path: "/" });
}

async function endAllSessions(empId) {
  await db.query("DELETE FROM sessions WHERE emp_id = ?", [empId]);
}

function readCookie(req) {
  const header = req.headers.cookie || "";
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === COOKIE) return decodeURIComponent(rest.join("="));
  }
  return "";
}

// Finds the signed-in person for this request, or leaves req.user empty.
async function loadUser(req, res, next) {
  req.user = null;
  const token = readCookie(req);
  if (token) {
    req.user = await db.one(
      `SELECT u.emp_id, u.emp_name, u.email, u.role, u.team_id, t.team_name
         FROM sessions s
         JOIN users u ON u.emp_id = s.emp_id
         LEFT JOIN teams t ON t.team_id = u.team_id
        WHERE s.token_hash = ? AND s.expires_at > NOW() AND u.active = 1 AND u.approval = 'Approved'`,
      [tokenHash(token)]
    );
  }
  next();
}

function requireUser(req, res, next) {
  if (!req.user) throw new AppError(401, "Please sign in again.");
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) throw new AppError(401, "Please sign in again.");
    if (!roles.includes(req.user.role)) throw new AppError(403, "Your role cannot do this.");
    next();
  };
}

module.exports = {
  hashCode, codeMatches, startSession, endSession, endAllSessions, loadUser, requireUser, requireRole,
  lockedMinutes, noteFailure, clearFailures
};
