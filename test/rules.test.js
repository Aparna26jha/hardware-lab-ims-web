"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const rules = require("../src/rules");

test("expiry warning uses the months window", () => {
  assert.equal(rules.expiryState("2026-11-01", "2026-11-14", 6), "expired");
  assert.equal(rules.expiryState("2027-05-14", "2026-11-14", 6), "soon");
  assert.equal(rules.expiryState("2027-05-15", "2026-11-14", 6), "");
  assert.equal(rules.expiryState("", "2026-11-14", 6), "");
});

test("addMonths keeps the end of short months valid", () => {
  assert.equal(rules.addMonths("2026-08-31", 6), "2027-02-28");
  assert.equal(rules.addMonths("2026-11-14", 6), "2027-05-14");
});

test("barcode helpers", () => {
  assert.equal(rules.normalizeBarcode(" mb-7800x-009\r\n"), "MB-7800X-009");
  assert.equal(rules.validBarcode("MB-7800X-009"), true);
  assert.equal(rules.validBarcode("AB"), false);
  assert.equal(rules.typeFromPrefix("AIC-NIC-1"), "Add-in Card");
  assert.equal(rules.familyPrefix("MB-7800X-009"), "MB-7800X");
});

test("status moves", () => {
  assert.equal(rules.statusMoveAllowed("Scrapped/Returned", "Available in Lab", "Admin"), false);
  assert.equal(rules.statusMoveAllowed("Scrapped/Returned", "Available in Lab", "Super Admin"), true);
  assert.equal(rules.statusMoveAllowed("Available in Lab", "Assigned to Engineer", "Admin"), true);
});

test("feedback needs a 15-character title and a 25-character description", () => {
  const good = { kind: "Bug", title: "Search box is slow", description: "Typing a barcode takes several seconds." };
  assert.doesNotThrow(() => rules.checkFeedback(good));
  assert.throws(() => rules.checkFeedback({ ...good, title: "Too short" }), /at least 15/);
  assert.throws(() => rules.checkFeedback({ ...good, description: "Short text" }), /at least 25/);
  assert.throws(() => rules.checkFeedback({ ...good, kind: "Praise" }), /type/);
});

test("CSV reading and writing", () => {
  assert.deepEqual(rules.csvCells('EN1, a@b.com, "Name, Jr", IPSi'), ["EN1", "a@b.com", "Name, Jr", "IPSi"]);
  assert.match(rules.csvText([["=SUM(1)"]]), /"'=SUM\(1\)"/);
});
