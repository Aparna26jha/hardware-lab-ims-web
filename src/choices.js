"use strict";

const db = require("./db");
const { fail, clean } = require("./rules");

const LISTS = { assetType: "asset type", room: "storage room" };

// The current asset types and storage rooms, in the order they were added, with "Other" last.
async function choiceLists(conn = db) {
  const rows = await conn.query("SELECT list_name, value FROM choices ORDER BY (value = 'Other'), choice_id");
  const pick = (list) => rows.filter((row) => row.list_name === list).map((row) => row.value);
  return { assetTypes: pick("assetType"), rooms: pick("room") };
}

async function addChoice(list, value, empId) {
  if (!LISTS[list]) fail("This list cannot be extended.");
  const name = clean(value, 40).replace(/\s+/g, " ");
  if (name.length < 2) fail("Type the new " + LISTS[list] + " (at least 2 characters).");
  if (name === "Other") fail("Other is already on the list.");
  const same = await db.one("SELECT value FROM choices WHERE list_name = ? AND value = ?", [list, name]);
  if (same) fail(same.value + " is already on the list.");
  await db.query("INSERT INTO choices (list_name, value, added_by) VALUES (?, ?, ?)", [list, name, empId]);
  return name;
}

module.exports = { choiceLists, addChoice };
