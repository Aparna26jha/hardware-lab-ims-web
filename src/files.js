"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const config = require("./config");
const { fail } = require("./rules");

const KINDS = {
  pdf: { mime: "application/pdf", magic: [0x25, 0x50, 0x44, 0x46] },
  png: { mime: "image/png", magic: [0x89, 0x50, 0x4e, 0x47] },
  jpg: { mime: "image/jpeg", magic: [0xff, 0xd8, 0xff] }
};

function detectKind(buffer) {
  for (const [ext, kind] of Object.entries(KINDS)) {
    if (kind.magic.every((byte, i) => buffer[i] === byte)) return { ext, mime: kind.mime };
  }
  return null;
}

// Checks an upload sent as { name, data: base64 } and writes it under UPLOAD_DIR/<area>.
function saveUpload(upload, area, allowed, maxMegabytes) {
  if (!upload || typeof upload.data !== "string") fail("Choose a file to upload.");
  const buffer = Buffer.from(upload.data, "base64");
  if (!buffer.length) fail("The file is empty.");
  if (buffer.length > maxMegabytes * 1024 * 1024) fail("The file is larger than " + maxMegabytes + " MB.");
  const kind = detectKind(buffer);
  if (!kind || !allowed.includes(kind.ext)) {
    fail("Only " + allowed.map((ext) => ext.toUpperCase()).join(", ") + " files can be uploaded.");
  }
  const folder = path.join(config.uploadDir, area);
  fs.mkdirSync(folder, { recursive: true });
  const storedName = crypto.randomUUID() + "." + kind.ext;
  fs.writeFileSync(path.join(folder, storedName), buffer);
  const originalName = String(upload.name || "document." + kind.ext).replace(/[\\/:*?"<>|\r\n]+/g, "_").slice(0, 200);
  return { storedName, originalName, mime: kind.mime, size: buffer.length };
}

function uploadPath(area, storedName) {
  if (!/^[0-9a-f-]{36}\.(pdf|png|jpg)$/.test(storedName)) fail("File not found.", 404);
  return path.join(config.uploadDir, area, storedName);
}

function sendUpload(res, area, storedName, mime, downloadName) {
  const fullPath = uploadPath(area, storedName);
  if (!fs.existsSync(fullPath)) fail("File not found.", 404);
  res.setHeader("Content-Type", mime);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Content-Disposition", 'inline; filename="' + String(downloadName).replace(/[^\x20-\x7E]|"/g, "_") + '"');
  res.sendFile(fullPath);
}

module.exports = { saveUpload, sendUpload };
