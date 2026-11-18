"use strict";

// Adds columns that newer versions need to a database created by an older version.
// Only ever adds; never changes or removes existing data.
const COLUMNS = [
  ["assets", "bond_no", "VARCHAR(40) NULL AFTER po_number"],
  ["assets", "storage_room", "VARCHAR(40) NULL AFTER expiry_date"]
];

async function upgradeTables(conn) {
  const added = [];
  for (const [table, column, definition] of COLUMNS) {
    const [rows] = await conn.query(
      "SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?",
      [table, column]);
    if (rows.length) continue;
    await conn.query("ALTER TABLE " + table + " ADD COLUMN " + column + " " + definition);
    added.push(table + "." + column);
  }
  return added;
}

module.exports = { upgradeTables };
