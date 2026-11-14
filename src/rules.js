"use strict";

const ROLES = ["Super Admin", "Admin", "Lead Admin", "User"];
const OWNERS = ["AMD-Specific", "Wipro-Specific"];
const STATUSES = ["Available in Lab", "Assigned to Engineer", "Under Maintenance", "Scrapped/Returned"];
const ASSET_TYPES = ["Motherboard", "Add-in Card", "Debugger", "SoC Board", "Power Supply", "Cable", "Other"];
const FEEDBACK_KINDS = ["Issue", "Improvement", "Bug", "Suggestion", "Others"];
const FEEDBACK_STATUSES = ["New", "In review", "Done"];
const FEEDBACK_TITLE_MIN = 15;
const FEEDBACK_DESCRIPTION_MIN = 25;

const PREFIX_TYPES = {
  MB: "Motherboard",
  AIC: "Add-in Card",
  DBG: "Debugger",
  SOC: "SoC Board",
  PSU: "Power Supply",
  CBL: "Cable"
};

// An error whose message is safe to show to the person using the app.
class AppError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function fail(message, status = 400) {
  throw new AppError(status, message);
}

function clean(value, max) {
  const textValue = String(value ?? "").trim();
  return max ? textValue.slice(0, max) : textValue;
}

function normalizeId(value) {
  return String(value ?? "").trim().toUpperCase().replace(/\s+/g, "");
}

function normalizeBarcode(value) {
  return String(value ?? "").toUpperCase().replace(/[\s\r\n\t]+/g, "");
}

function validAlias(alias) {
  return /^[A-Z0-9-]{2,32}$/.test(alias);
}

function validBarcode(code) {
  return /^[A-Z0-9_-]{4,64}$/.test(code);
}

function isMailId(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 120;
}

function isIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value))) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function isoDay(date) {
  const pad = (n) => String(n).padStart(2, "0");
  return date.getFullYear() + "-" + pad(date.getMonth() + 1) + "-" + pad(date.getDate());
}

function addMonths(isoDate, months) {
  const [year, month, day] = isoDate.split("-").map(Number);
  const target = new Date(year, month - 1 + months, 1);
  const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  target.setDate(Math.min(day, lastDay));
  return isoDay(target);
}

// "expired", "soon" (inside the warning window) or "" for a date that is fine or missing.
function expiryState(expiryDate, today, warnMonths) {
  if (!expiryDate || !isIsoDate(expiryDate)) return "";
  if (expiryDate < today) return "expired";
  if (expiryDate <= addMonths(today, warnMonths)) return "soon";
  return "";
}

function typeFromPrefix(barcode) {
  const token = barcode.split("-")[0] || "";
  return PREFIX_TYPES[token] || "";
}

function familyPrefix(barcode) {
  const dash = barcode.lastIndexOf("-");
  return dash > 0 ? barcode.slice(0, dash) : barcode;
}

function statusMoveAllowed(fromStatus, toStatus, role) {
  if (role === "Super Admin") return true;
  if (fromStatus === toStatus) return true;
  if (fromStatus === "Scrapped/Returned") return false;
  const allowed = {
    "Available in Lab": ["Assigned to Engineer", "Under Maintenance", "Scrapped/Returned"],
    "Assigned to Engineer": ["Available in Lab", "Under Maintenance", "Scrapped/Returned"],
    "Under Maintenance": ["Available in Lab", "Assigned to Engineer", "Scrapped/Returned"]
  };
  return (allowed[fromStatus] || []).includes(toStatus);
}

function isCustodian(user) {
  return !!user && (user.role === "Admin" || user.role === "Super Admin");
}

function checkAccessCode(code, confirm) {
  if (code.length < 4 || code.length > 32) fail("The access code must be 4 to 32 characters.");
  if (confirm !== undefined && code !== confirm) fail("The access code and the confirmation do not match.");
}

function checkFeedback({ kind, title, description }) {
  if (!FEEDBACK_KINDS.includes(kind)) fail("Choose a feedback type.");
  if (title.length < FEEDBACK_TITLE_MIN) fail("The title must be at least " + FEEDBACK_TITLE_MIN + " characters.");
  if (description.length < FEEDBACK_DESCRIPTION_MIN) {
    fail("The description must be at least " + FEEDBACK_DESCRIPTION_MIN + " characters.");
  }
}

// Reads one CSV line, allowing "quoted, values".
function csvCells(line) {
  const cells = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { cell += '"'; i += 1; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { cells.push(cell.trim()); cell = ""; }
    else cell += ch;
  }
  cells.push(cell.trim());
  return cells;
}

function csvText(rows) {
  return "\uFEFF" + rows.map((row) => row.map((value) => {
    let textValue = String(value ?? "").replace(/[\r\n]+/g, " ").replace(/"/g, '""');
    if (/^[=+\-@\t\r]/.test(textValue)) textValue = "'" + textValue;
    return '"' + textValue + '"';
  }).join(",")).join("\r\n");
}

module.exports = {
  ROLES, OWNERS, STATUSES, ASSET_TYPES, FEEDBACK_KINDS, FEEDBACK_STATUSES,
  FEEDBACK_TITLE_MIN, FEEDBACK_DESCRIPTION_MIN,
  AppError, fail, clean, normalizeId, normalizeBarcode, validAlias, validBarcode, isMailId,
  isIsoDate, isoDay, addMonths, expiryState, typeFromPrefix, familyPrefix, statusMoveAllowed,
  isCustodian, checkAccessCode, checkFeedback, csvCells, csvText
};
