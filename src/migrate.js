"use strict";

// Brings a database made by an older version up to date when the app starts or init-db runs.
// It creates missing tables, renames or widens columns, and adds columns. It never deletes data.
const fs = require("node:fs");
const path = require("node:path");
const { DEFAULT_ASSET_TYPES, DEFAULT_ROOMS } = require("./rules");

const COLUMNS = [
  ["users", "must_change", "TINYINT(1) NOT NULL DEFAULT 0 AFTER access_hash"],
  ["assets", "bond_no", "VARCHAR(40) NULL AFTER po_number"],
  ["assets", "storage_room", "VARCHAR(40) NULL AFTER expiry_date"],
  ["feedback", "other_text", "VARCHAR(80) NULL AFTER kind"],
  ["hardware_requests", "other_text", "VARCHAR(80) NULL AFTER asset_type"],
  ["hardware_requests", "quantity", "TINYINT UNSIGNED NOT NULL DEFAULT 1 AFTER other_text"]
];

const CHOICES = { assetType: DEFAULT_ASSET_TYPES, room: DEFAULT_ROOMS };

function schemaStatements() {
  const text = fs.readFileSync(path.join(__dirname, "..", "db", "schema.sql"), "utf8").replace(/^--.*$/gm, "");
  return text.split(";").map((statement) => statement.trim()).filter(Boolean);
}

async function column(conn, table, name) {
  const [rows] = await conn.query(
    `SELECT DATA_TYPE AS type FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`, [table, name]);
  return rows[0] || null;
}

async function upgradeTables(conn) {
  const changes = [];
  const [before] = await conn.query("SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()");
  const existing = new Set(before.map((row) => row.name));
  for (const statement of schemaStatements()) {
    const table = (/CREATE TABLE IF NOT EXISTS (\w+)/.exec(statement) || [])[1];
    if (!table || existing.has(table)) continue;
    await conn.query(statement);
    changes.push("table " + table);
  }
  if (await column(conn, "directory", "alias")) {
    await conn.query("ALTER TABLE directory RENAME COLUMN alias TO emp_id");
    changes.push("directory.alias renamed to emp_id");
  }
  const kind = await column(conn, "feedback", "kind");
  if (kind && kind.type === "enum") {
    await conn.query("ALTER TABLE feedback MODIFY kind VARCHAR(30) NOT NULL");
    await conn.query("UPDATE feedback SET kind = 'Issue / Bug' WHERE kind IN ('Issue', 'Bug')");
    await conn.query("UPDATE feedback SET kind = 'Other' WHERE kind = 'Others'");
    changes.push("feedback.kind merged Issue and Bug");
  }
  for (const [table, name, definition] of COLUMNS) {
    if (await column(conn, table, name)) continue;
    await conn.query("ALTER TABLE " + table + " ADD COLUMN " + name + " " + definition);
    changes.push(table + "." + name);
  }
  for (const [list, values] of Object.entries(CHOICES)) {
    const [[count]] = await conn.query("SELECT COUNT(*) AS n FROM choices WHERE list_name = ?", [list]);
    if (Number(count.n)) continue;
    for (const value of values) await conn.query("INSERT INTO choices (list_name, value) VALUES (?, ?)", [list, value]);
    changes.push("choices " + list);
  }
  return changes;
}

module.exports = { upgradeTables };
