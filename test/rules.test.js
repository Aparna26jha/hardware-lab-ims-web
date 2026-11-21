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
  assert.equal(rules.normalizeBarcode("*EMBLAB30890*"), "EMBLAB30890");
  assert.ok(rules.isAmdLabel("EMBLAB33836"));
  assert.ok(!rules.isAmdLabel("EMBLAB-33836"));
  assert.ok(!rules.isAmdLabel("MB-SP5-045"));
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

test("feedback needs a 15-character title, a 25-character description, and words for Other", () => {
  const good = { kind: "Issue / Bug", otherText: "", title: "Search box is slow", description: "Typing a barcode takes several seconds." };
  assert.doesNotThrow(() => rules.checkFeedback(good));
  assert.throws(() => rules.checkFeedback({ ...good, title: "Too short" }), /at least 15/);
  assert.throws(() => rules.checkFeedback({ ...good, description: "Short text" }), /at least 25/);
  assert.throws(() => rules.checkFeedback({ ...good, kind: "Bug" }), /type/);
  assert.throws(() => rules.checkFeedback({ ...good, kind: "Other" }), /You chose Other/);
  assert.doesNotThrow(() => rules.checkFeedback({ ...good, kind: "Other", otherText: "Training" }));
});

test("mail IDs, passwords and the next barcode number", () => {
  assert.equal(rules.cleanEmail("Sample P s <Sample.PS@Company.com>"), "sample.ps@company.com");
  assert.equal(rules.cleanEmail(" Name.Surname@Company.com "), "name.surname@company.com");
  assert.throws(() => rules.checkPassword("1234"), /8 to 64/);
  assert.throws(() => rules.checkPassword("Lab@12345", "Lab@12346"), /do not match/);
  assert.doesNotThrow(() => rules.checkPassword("Lab@12345", "Lab@12345"));
  assert.equal(rules.nextBarcode("EMBLAB30890"), "EMBLAB30891");
  assert.equal(rules.nextBarcode("MB-SP5-009"), "MB-SP5-010");
  assert.equal(rules.nextBarcode("EMBLAB99"), "EMBLAB100");
  assert.equal(rules.nextBarcode("CABLE-A"), "");
  assert.ok(rules.validEmpId("20990001"));
  assert.ok(!rules.validEmpId("a b"));
});

test("CSV reading and writing", () => {
  assert.deepEqual(rules.csvCells('EN1, a@b.com, "Name, Jr", IPSi'), ["EN1", "a@b.com", "Name, Jr", "IPSi"]);
  assert.deepEqual(rules.csvCells("1\tName, Jr\tQA-APU\t2099\tx@y.com"), ["1", "Name, Jr", "QA-APU", "2099", "x@y.com"]);
  assert.match(rules.csvText([["=SUM(1)"]]), /"'=SUM\(1\)"/);
});
