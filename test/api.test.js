"use strict";

// End-to-end checks against a separate test database (TEST_DB_NAME, default ims_test).
// The test database is wiped and loaded with the sample lab each run.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ims-test-"));
process.env.DB_NAME = process.env.TEST_DB_NAME || "ims_test";
if (!/test/i.test(process.env.DB_NAME)) throw new Error("The test database name must contain 'test'; it is wiped on every run.");
process.env.APP_ENV = "development";
process.env.UPLOAD_DIR = path.join(scratch, "uploads");
process.env.BACKUP_DIR = path.join(scratch, "backups");

const mysql = require("mysql2/promise");
const config = require("../src/config");
const db = require("../src/db");
const { loadSample } = require("../src/sample");
const { createApp } = require("../src/server");
const { upgradeTables } = require("../src/migrate");

const PDF = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF").toString("base64");
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]).toString("base64");
const PASSWORDS = {
  SA001: "Lab@1001", AD010: "Lab@2001", LD200: "Lab@4001", LD300: "Lab@4002",
  EN1042: "Lab@3001", EN1108: "Lab@3002", EN1200: "Lab@3004", EN2301: "Lab@3003"
};
const TABLES = ["sessions", "handovers", "choices", "hardware_requests", "feedback", "audit_log", "assets",
  "consignment_documents", "consignments", "directory", "users", "teams"];

let server;
let base;

const mail = (empId) => empId.toLowerCase() + "@lab.example";

async function session(email, password) {
  let cookie = "";
  const call = async (method, url, body, extraHeaders = {}) => {
    const headers = { "X-IMS": "1", ...extraHeaders };
    if (cookie) headers.Cookie = cookie;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const response = await fetch(base + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const setCookie = response.headers.get("set-cookie");
    if (setCookie) cookie = setCookie.split(";")[0];
    const type = response.headers.get("content-type") || "";
    const data = type.includes("json") ? await response.json() : await response.text();
    return { status: response.status, data };
  };
  if (email) {
    const result = await call("POST", "/api/login", { email, password });
    assert.equal(result.status, 200, "sign-in for " + email + ": " + JSON.stringify(result.data));
  }
  return call;
}

const as = (empId, password) => session(mail(empId), password || PASSWORDS[empId]);

test.before(async () => {
  const conn = await mysql.createConnection({ ...config.db, multipleStatements: true });
  await conn.query("SET FOREIGN_KEY_CHECKS = 0; " + TABLES.map((t) => "DROP TABLE IF EXISTS " + t + ";").join(" ") + " SET FOREIGN_KEY_CHECKS = 1;");
  await upgradeTables(conn);
  // Turn the tables back into the version 2.1 layout to check that an older database is upgraded in place.
  await conn.query(`DROP TABLE handovers; DROP TABLE choices;
    ALTER TABLE assets DROP COLUMN bond_no, DROP COLUMN storage_room;
    ALTER TABLE directory RENAME COLUMN emp_id TO alias;
    ALTER TABLE feedback DROP COLUMN other_text, MODIFY kind ENUM('Issue','Improvement','Bug','Suggestion','Others') NOT NULL;
    ALTER TABLE hardware_requests DROP COLUMN other_text, DROP COLUMN quantity;
    INSERT INTO feedback (kind, title, description, emp_id, emp_name, email, role) VALUES ('Bug', 'Old bug report title', 'Old description that is long enough', 'X', 'X', 'x@x', 'User');`);
  assert.deepEqual(await upgradeTables(conn), [
    "table handovers", "table choices", "directory.alias renamed to emp_id", "feedback.kind merged Issue and Bug",
    "assets.bond_no", "assets.storage_room", "feedback.other_text", "hardware_requests.other_text",
    "hardware_requests.quantity", "choices assetType", "choices room"
  ]);
  assert.deepEqual(await upgradeTables(conn), [], "running the upgrade again changes nothing");
  const [[old]] = await conn.query("SELECT kind FROM feedback");
  assert.equal(old.kind, "Issue / Bug");
  await conn.end();
  await loadSample(true);
  server = createApp().listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  base = "http://127.0.0.1:" + server.address().port;
});

test.after(async () => {
  server.close();
  await db.pool.end();
  fs.rmSync(scratch, { recursive: true, force: true });
});

test("sign-in by mail ID and password only; wrong password refused; changes need the app header", async () => {
  await session("SA001@Lab.Example", "Lab@1001");
  const anon = await session();
  const byId = await anon("POST", "/api/login", { email: "SA001", password: "Lab@1001" });
  assert.equal(byId.status, 401, "the old alias sign-in is gone");
  const wrong = await anon("POST", "/api/login", { email: mail("SA001"), password: "Lab@9999" });
  assert.equal(wrong.status, 401);
  assert.match(wrong.data.error, /Mail ID or password/);
  const pending = await anon("POST", "/api/login", { email: mail("EN2301"), password: "Lab@3003" });
  assert.match(pending.data.error, /waiting/);
  const settings = (await anon("GET", "/api/settings")).data;
  assert.equal(settings.version, require("../package.json").version);
  assert.deepEqual(settings.rooms, ["2A Inventory Room", "Store Room"]);
  assert.equal(settings.assetTypes.at(-1), "Other");
  assert.deepEqual(settings.feedbackKinds, ["Issue / Bug", "Improvement", "Suggestion", "Other"]);
  const blocked = await fetch(base + "/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  assert.equal(blocked.status, 403);
});

test("each role sees the right hardware", async () => {
  const admin = await as("AD010");
  const lead = await as("LD200");
  const user = await as("EN1042");
  const all = (await admin("GET", "/api/assets")).data;
  const leadList = (await lead("GET", "/api/assets")).data;
  const mine = (await user("GET", "/api/assets")).data;
  assert.equal(all.length, 13);
  const held = all.find((a) => a.barcode === "MB-7800X-001");
  assert.equal(held.place, "Lab (with Sample Validation Engineer)");
  assert.equal(held.holderEmail, "en1042@lab.example");
  assert.equal(all.find((a) => a.barcode === "MB-7800X-002").place, "2A Inventory Room, CPU cupboard 1");
  assert.equal(all.find((a) => a.barcode === "CBL-PCIE-110").pending.email, "en1200@lab.example");
  assert.ok(mine.every((a) => a.holderId === "EN1042"));
  assert.equal(mine.length, 3);
  assert.ok(leadList.some((a) => a.holderId === "EN1108"), "lead sees team member");
  assert.ok(leadList.some((a) => !a.holderId && a.status === "Available in Lab"), "lead sees the cage");
  assert.ok(!leadList.some((a) => a.holderId === "EN1200"), "lead does not see another team");
  assert.equal(mine[0].teamName, "IPSi");
  assert.equal((await user("GET", "/api/assets/SOC-FPGA-006")).status, 404);
  assert.equal((await lead("GET", "/api/assets/MB-7800X-001")).data.history, null, "leads do not see history");
  assert.equal((await user("GET", "/api/consignments")).status, 403);
  const free = (await user("GET", "/api/assets/available")).data;
  assert.ok(free.some((a) => a.barcode === "MB-7800X-002"), "engineers can pick from the free items");
  assert.ok(!free.some((a) => a.barcode === "CBL-PCIE-110"), "an item already offered to someone is not free");
});

test("dashboard: team totals, red no-document consignments, expiry, waiting handovers", async () => {
  const admin = await as("SA001");
  const dash = (await admin("GET", "/api/dashboard")).data;
  const ipsi = dash.teams.find((t) => t.team === "IPSi");
  const cage = dash.teams.find((t) => t.teamId === "cage");
  assert.equal(ipsi.held, 4);
  assert.equal(ipsi.lead, "Sample Lead IPSi (ld200@lab.example)");
  assert.equal(cage.held, 7);
  const texts = dash.attention.map((a) => a.text).join(" | ");
  assert.match(texts, /Sample Requesting Engineer \(en2301@lab.example\) asked for access/);
  assert.match(texts, /DBG-HDT-003 expired/);
  assert.match(texts, /AIC-GPU-002 expires 2027-03-31/);
  const noDoc = dash.attention.find((a) => a.tag === "No document");
  assert.equal(noDoc.kind, "bad");
  assert.match(noDoc.text, /INV-AR-7741 \/ PO-AMD-26001: no document uploaded yet \(1 of 4 items scanned\)/);
  assert.match(texts, /Waiting for Sample Platform Engineer to accept CBL-PCIE-110/);
  assert.match(texts, /Sample Signal Engineer: needs Debugger/);
  const user = await as("EN1042");
  const own = (await user("GET", "/api/dashboard")).data;
  assert.equal(own.teams, null);
  assert.deepEqual(own.attention.map((a) => a.tag).sort(), ["Expiring", "Request"]);
  const receiver = (await (await as("EN1200"))("GET", "/api/dashboard")).data;
  assert.equal(receiver.handovers[0].barcode, "CBL-PCIE-110");
});

test("transfer by mail ID waits for the person to accept", async () => {
  const admin = await as("AD010");
  const load = async () => (await admin("GET", "/api/assets/CBL-JTAG-009")).data.asset;
  let asset = await load();
  const nobody = await admin("POST", "/api/assets/CBL-JTAG-009/transfer", { status: "Assigned to Engineer", holderEmail: "nobody@lab.example", revision: asset.revision });
  assert.match(nobody.data.error, /nobody@lab.example is not an active user/);
  const noMail = await admin("POST", "/api/assets/CBL-JTAG-009/transfer", { status: "Assigned to Engineer", revision: asset.revision });
  assert.match(noMail.data.error, /mail ID/);
  const scrap = await admin("POST", "/api/assets/CBL-JTAG-009/transfer", { status: "Scrapped/Returned", revision: asset.revision });
  assert.match(scrap.data.error, /remarks/);
  const offer = await admin("POST", "/api/assets/CBL-JTAG-009/transfer", { status: "Assigned to Engineer", holderEmail: "EN1200@lab.example", remarks: "For the bench", revision: asset.revision });
  assert.equal(offer.status, 200, JSON.stringify(offer.data));
  assert.match(offer.data.message, /Waiting for Sample Platform Engineer \(en1200@lab.example\) to accept CBL-JTAG-009/);
  asset = await load();
  assert.equal(asset.holderId, "", "nothing moves before the person accepts");
  assert.equal(asset.pending.empId, "EN1200");
  const again = await admin("POST", "/api/assets/CBL-JTAG-009/transfer", { status: "Under Maintenance", revision: asset.revision });
  assert.match(again.data.error, /Cancel that first/);
  const someoneElse = await as("EN1042");
  const mine = (await (await as("EN1200"))("GET", "/api/handovers/mine")).data;
  const offerId = mine.find((h) => h.barcode === "CBL-JTAG-009").id;
  assert.equal((await someoneElse("POST", "/api/handovers/" + offerId + "/accept")).status, 403);
  const receiver = await as("EN1200");
  assert.match((await receiver("POST", "/api/handovers/" + offerId + "/decline", { note: "no" })).data.error, /at least 5/);
  const accepted = await receiver("POST", "/api/handovers/" + offerId + "/accept");
  assert.equal(accepted.status, 200, JSON.stringify(accepted.data));
  asset = await load();
  assert.equal(asset.holderId, "EN1200");
  assert.equal(asset.teamName, "Team B (sample)");
  assert.equal(asset.pending, null);
  const history = (await admin("GET", "/api/assets/CBL-JTAG-009")).data.history;
  assert.equal(history[0].action, "Transfer");
  assert.match(history[0].to, /Sample Platform Engineer \(en1200@lab.example\)/);
  assert.match(history[0].by, /Sample Inventory Custodian/);
  assert.equal(history[0].remarks, "For the bench. Accepted by Sample Platform Engineer");
  const stale = await admin("POST", "/api/assets/CBL-JTAG-009/transfer", { status: "Available in Lab", revision: 0 });
  assert.equal(stale.status, 409);
  const back = await admin("POST", "/api/assets/CBL-JTAG-009/transfer", { status: "Available in Lab", revision: asset.revision });
  assert.match(back.data.message, /Transfer recorded/, "back to the cage needs no acceptance");

  const sampleOffer = (await receiver("GET", "/api/handovers/mine")).data.find((h) => h.barcode === "CBL-PCIE-110");
  assert.equal((await receiver("POST", "/api/handovers/" + sampleOffer.id + "/decline", { note: "Not needed any more" })).status, 200);
  assert.equal((await admin("GET", "/api/assets/CBL-PCIE-110")).data.asset.holderId, "");
  const updates = (await admin("GET", "/api/updates?since=2000-01-01 00:00:00")).data;
  assert.ok(updates.items.some((u) => /declined CBL-PCIE-110: Not needed any more/.test(u.text)), "the giver hears about the decline");
});

test("inward by consignment: document optional but flagged, next barcode, items given by mail ID", async () => {
  const admin = await as("AD010");
  const created = await admin("POST", "/api/consignments", {
    invoiceNo: "INV-T-1", poNumber: "PO-T-1", receivedDate: "2026-11-14", expectedItems: 3, ownership: "AMD-Specific"
  });
  assert.equal(created.status, 200, JSON.stringify(created.data));
  const id = created.data.id;
  const duplicate = await admin("POST", "/api/consignments", {
    invoiceNo: "INV-T-1", poNumber: "PO-T-1", receivedDate: "2026-11-14", expectedItems: 1, ownership: "AMD-Specific"
  });
  assert.match(duplicate.data.error, /already recorded/);
  const item = { barcode: "MB-7800X-009", assetType: "Motherboard", serialNo: "SM-H13-10099", room: "2A Inventory Room" };
  assert.match((await admin("POST", "/api/consignments/" + id + "/items", { ...item, room: "" })).data.error, /storage room \(at least one option\)/);
  assert.match((await admin("POST", "/api/consignments/" + id + "/items", { ...item, assetType: "Toaster" })).data.error, /asset type/);
  const suggest = (await admin("GET", "/api/assets/suggest?barcode=mb-7800x-009")).data;
  assert.equal(suggest.fill.model, "H13SSL");
  const saved = await admin("POST", "/api/consignments/" + id + "/items", { ...item, model: "H13SSL", holderEmail: "en1108@lab.example" });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  assert.match(saved.data.message, /1 of 3 items scanned. Waiting for Sample Signal Engineer/);
  const newAsset = (await admin("GET", "/api/assets/MB-7800X-009")).data;
  assert.equal(newAsset.asset.status, "Available in Lab");
  assert.equal(newAsset.asset.pending.empId, "EN1108");
  assert.equal(newAsset.history[0].remarks, "Inward on invoice INV-T-1 / PO-T-1. No document yet");
  assert.equal((await admin("GET", "/api/assets/next-barcode?consignment=" + id)).data.barcode, "MB-7800X-010");
  assert.equal((await admin("GET", "/api/assets/next-barcode?after=EMBLAB09")).data.barcode, "EMBLAB10");
  const again = await admin("POST", "/api/consignments/" + id + "/items", item);
  assert.match(again.data.error, /already on file/);
  const dupSerial = await admin("POST", "/api/consignments/" + id + "/items", { barcode: "MB-7800X-010", assetType: "Motherboard", serialNo: "SM-H13-10099", room: "Store Room" });
  assert.match(dupSerial.data.error, /already recorded/);
  const badFile = await admin("POST", "/api/consignments/" + id + "/documents", { file: { name: "x.exe", data: Buffer.from("MZ....").toString("base64") } });
  assert.match(badFile.data.error, /Only PDF/);
  assert.equal((await admin("POST", "/api/consignments/" + id + "/documents", { file: { name: "invoice.pdf", data: PDF } })).status, 200);
  await admin("POST", "/api/consignments/" + id + "/items", { barcode: "MB-7800X-010", assetType: "Motherboard", room: "Store Room" });
  const third = (await admin("GET", "/api/assets/MB-7800X-010")).data.history[0].remarks;
  assert.equal(third, "Inward on invoice INV-T-1 / PO-T-1", "after the upload there is no no-document note");
  await admin("POST", "/api/consignments/" + id + "/items", { barcode: "MB-7800X-011", assetType: "Motherboard", room: "Store Room" });
  const over = await admin("POST", "/api/consignments/" + id + "/items", { barcode: "MB-7800X-012", assetType: "Motherboard", room: "Store Room" });
  assert.match(over.data.error, /All 3 items/);
  const detail = (await admin("GET", "/api/consignments/" + id)).data;
  assert.equal(detail.items.length, 3);
  assert.equal(detail.items[0].pendingName, "Sample Signal Engineer");
  const doc = await fetch(base + "/api/documents/" + detail.documents[0].id);
  assert.equal(doc.status, 401, "documents need sign-in");
});

test("editing a consignment, reading many barcodes at once, AMD labels", async () => {
  const admin = await as("AD010");
  const make = async (invoiceNo, ownership, expectedItems) => (await admin("POST", "/api/consignments", {
    invoiceNo, poNumber: "PO-L-1", receivedDate: "2026-11-18", expectedItems, ownership
  })).data.id;
  const amd = await make("INV-L-1", "AMD-Specific", 4);
  const wipro = await make("INV-L-2", "Wipro-Specific", 2);
  const label = { assetType: "Peripheral", make: "Dell", description: "Dell Keyboard with Mouse", bondNo: "NA", room: "Store Room", location: "Shelf 2" };
  const wrongOwner = await admin("POST", "/api/consignments/" + wipro + "/items", { ...label, barcode: "*emblab 70001*" });
  assert.match(wrongOwner.data.error, /EMBLAB70001 is an AMD asset label/);
  const bulk = await admin("POST", "/api/consignments/" + amd + "/items/bulk", {
    ...label, barcodes: ["EMBLAB70001", "*EMBLAB70002*", "EMBLAB70001", "MB-7800X-001", "EMBLAB70003"], noDocumentReason: "Invoice is with the purchase team"
  });
  assert.equal(bulk.status, 200, JSON.stringify(bulk.data));
  assert.deepEqual(bulk.data.added, ["EMBLAB70001", "EMBLAB70002", "EMBLAB70003"]);
  assert.equal(bulk.data.skipped.length, 1);
  assert.match(bulk.data.skipped[0], /MB-7800X-001: .*already on file/);
  const asset = (await admin("GET", "/api/assets/EMBLAB70002")).data;
  assert.equal(asset.asset.bondNo, "NA");
  assert.equal(asset.asset.place, "Store Room, Shelf 2");
  assert.match(asset.history[0].remarks, /No document yet: Invoice is with the purchase team/);
  const full = await admin("POST", "/api/consignments/" + amd + "/items/bulk", { ...label, barcodes: ["EMBLAB70004", "EMBLAB70005"] });
  assert.deepEqual(full.data.added, ["EMBLAB70004"]);
  assert.match(full.data.skipped[0], /All 4 items/);
  const suggest = (await admin("GET", "/api/assets/suggest?barcode=EMBLAB70009&consignment=" + amd)).data;
  assert.equal(suggest.fill.description, "Dell Keyboard with Mouse");
  assert.match(suggest.source, /EMBLAB7000\d/);

  const header = { invoiceNo: "INV-L-1A", poNumber: "PO-L-9", receivedDate: "2026-11-19", expectedItems: 4, ownership: "AMD-Specific", supplier: "Dell" };
  assert.match((await admin("PUT", "/api/consignments/" + amd, { ...header, ownership: "Wipro-Specific" })).data.error, /Ownership cannot change/);
  assert.match((await admin("PUT", "/api/consignments/" + amd, { ...header, expectedItems: 2 })).data.error, /already scanned/);
  const edited = await admin("PUT", "/api/consignments/" + amd, header);
  assert.match(edited.data.message, /PO number and arrival date of 4 item\(s\) were updated/);
  const moved = (await admin("GET", "/api/assets/EMBLAB70001")).data;
  assert.equal(moved.asset.poNumber, "PO-L-9");
  assert.equal(moved.asset.arrivalDate, "2026-11-19");
  assert.match(moved.history[0].remarks, /Changed PO number and arrival date on invoice INV-L-1A/);
  const lead = await as("LD200");
  assert.equal((await lead("PUT", "/api/consignments/" + amd, header)).status, 403, "only Admins edit inward");
  const dash = (await admin("GET", "/api/dashboard")).data;
  assert.ok(dash.attention.some((a) => a.kind === "bad" && /INV-L-1A \/ PO-L-9: no document uploaded yet/.test(a.text)));
  const csv = (await admin("GET", "/api/export/inventory.csv")).data;
  assert.match(csv, /"Holder Mail ID"/);
});

test("asset types and storage rooms can be added from the dropdown", async () => {
  const admin = await as("AD010");
  const added = await admin("POST", "/api/choices", { list: "room", value: "  Lab  3B   Rack " });
  assert.equal(added.status, 200, JSON.stringify(added.data));
  assert.ok(added.data.rooms.includes("Lab 3B Rack"));
  assert.match((await admin("POST", "/api/choices", { list: "room", value: "store room" })).data.error, /already on the list/);
  const type = await admin("POST", "/api/choices", { list: "assetType", value: "Oscilloscope" });
  assert.equal(type.data.assetTypes.at(-1), "Other", "Other stays last");
  assert.ok(type.data.assetTypes.includes("Oscilloscope"));
  assert.match((await admin("POST", "/api/choices", { list: "status", value: "Lost" })).data.error, /cannot be extended/);
  const user = await as("EN1042");
  assert.equal((await user("POST", "/api/choices", { list: "room", value: "My desk" })).status, 403);
  const asset = (await admin("GET", "/api/assets/MB-SP5-044")).data.asset;
  const edit = await admin("PUT", "/api/assets/MB-SP5-044", { ...asset, assetType: "Oscilloscope", room: "Lab 3B Rack", revision: asset.revision });
  assert.equal(edit.status, 200, JSON.stringify(edit.data));
  assert.equal((await admin("GET", "/api/assets?type=Oscilloscope")).data.length, 1);
});

test("edit is logged; only Super Admin deletes; delete history shows deletions and restores", async () => {
  const admin = await as("AD010");
  const sa = await as("SA001");
  const asset = (await admin("GET", "/api/assets/DBG-HDT-003")).data.asset;
  const edit = await admin("PUT", "/api/assets/DBG-HDT-003", { ...asset, location: "CPU cupboard 9", revision: asset.revision });
  assert.equal(edit.status, 200, JSON.stringify(edit.data));
  assert.equal((await admin("POST", "/api/assets/DBG-HDT-003/delete", { reason: "Testing delete" })).status, 403);
  assert.match((await sa("POST", "/api/assets/DBG-HDT-003/delete", { reason: "x" })).data.error, /reason/);
  assert.equal((await sa("POST", "/api/assets/DBG-HDT-003/delete", { reason: "Entered twice by mistake" })).status, 200);
  assert.ok(!(await admin("GET", "/api/assets")).data.some((a) => a.barcode === "DBG-HDT-003"));
  let deletions = (await sa("GET", "/api/assets/delete-history")).data;
  assert.equal(deletions[0].barcode, "DBG-HDT-003");
  assert.equal(deletions[0].stillDeleted, true);
  assert.equal(deletions[0].reason, "Entered twice by mistake");
  assert.equal((await admin("GET", "/api/assets/delete-history")).status, 403);
  assert.equal((await sa("POST", "/api/assets/DBG-HDT-003/restore")).status, 200);
  deletions = (await sa("GET", "/api/assets/delete-history")).data;
  assert.equal(deletions[0].stillDeleted, false);
  assert.match(deletions[0].restoredBy, /Sample Super Admin/);
  const history = (await admin("GET", "/api/assets/DBG-HDT-003")).data.history.map((r) => r.action);
  assert.deepEqual(history.slice(0, 3), ["Restore", "Delete", "Edit"]);
});

test("feedback: merged Issue / Bug, Other needs a description, admin list", async () => {
  const user = await as("EN1042");
  const short = await user("POST", "/api/feedback", { kind: "Issue / Bug", title: "Short", description: "This description is long enough." });
  assert.match(short.data.error, /at least 15/);
  assert.match((await user("POST", "/api/feedback", { kind: "Bug", title: "Show the location on the list", description: "It would help to see the cupboard number." })).data.error, /feedback type/);
  const vague = await user("POST", "/api/feedback", { kind: "Other", title: "Show the location on the list", description: "It would help to see the cupboard number." });
  assert.match(vague.data.error, /You chose Other/);
  const sent = await user("POST", "/api/feedback", {
    kind: "Other", otherText: "Training", title: "Show the location on the list", description: "It would help to see the cupboard number.",
    screenshot: { name: "s.png", data: PNG }, screen: "dashboard"
  });
  assert.equal(sent.status, 200, JSON.stringify(sent.data));
  assert.equal((await user("GET", "/api/feedback")).status, 403);
  const admin = await as("AD010");
  const list = (await admin("GET", "/api/feedback")).data;
  assert.equal(list[0].email, "en1042@lab.example");
  assert.equal(list[0].kind, "Other: Training");
  assert.ok(list[0].hasScreenshot);
  assert.equal((await admin("GET", "/api/feedback/" + list[0].id + "/screenshot")).status, 200);
  assert.equal((await admin("PUT", "/api/feedback/" + list[0].id, { status: "Done" })).status, 200);
});

test("request access by mail ID, approve with a team, Excel import, team members and new leads", async () => {
  const anon = await session();
  const unknown = await anon("POST", "/api/register", { email: "stranger@lab.example", password: "Secret@12", confirm: "Secret@12" });
  assert.match(unknown.data.error, /not on the lab directory/);
  const weak = await anon("POST", "/api/register", { email: "en2200@lab.example", password: "5000", confirm: "5000" });
  assert.match(weak.data.error, /at least|8 to 64/);
  const ok = await anon("POST", "/api/register", { email: "EN2200@lab.example", password: "Secret@12", confirm: "Secret@12" });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  const sa = await as("SA001");
  const users = (await sa("GET", "/api/users")).data;
  assert.equal(users[0].state, "Pending");
  const ipsi = (await sa("GET", "/api/teams")).data.find((t) => t.name === "IPSi");
  assert.equal((await sa("PUT", "/api/users/EN2200", { role: "User", teamId: ipsi.id, active: true })).status, 200);
  await session("en2200@lab.example", "Secret@12");
  const selfOff = await sa("PUT", "/api/users/SA001", { role: "Super Admin", teamId: "", active: false });
  assert.match(selfOff.data.error, /own account/);

  const excel = [
    "S.No\tName\tTeam\tEmp ID\tEmail Address",
    "1\tPerson One\tQA -APU\t20990001\tperson.one@company.com",
    "2\tPerson Two\tQA-APU\t20990002\tPerson Two <person.two@company.com>",
    "3\tPerson Three\t\t20990003\tbad-mail",
    "",
    "4\tPerson Four\tSOC val\t20990004\tperson.four@company.com"
  ].join("\n");
  const imported = await sa("POST", "/api/directory/import", { text: excel });
  assert.match(imported.data.message, /^3 people saved. New teams: QA-APU, SOC val. 1 lines skipped/);
  const directory = (await sa("GET", "/api/directory")).data;
  assert.equal(directory.find((d) => d.empId === "20990002").email, "person.two@company.com");
  assert.equal(directory.find((d) => d.empId === "20990001").teamName, "QA-APU");
  const plain = await sa("POST", "/api/directory/import", { text: "20990005, five@company.com, Person Five, SOC val" });
  assert.match(plain.data.message, /^1 people saved\.$/);

  const teams = (await sa("GET", "/api/teams")).data;
  const soc = teams.find((t) => t.name === "SOC val");
  assert.equal(soc.members, 2);
  assert.equal((await sa("POST", "/api/teams/" + soc.id + "/members", { add: ["20990001", "EN1042"] })).status, 200);
  assert.equal((await sa("GET", "/api/users")).data.find((u) => u.empId === "EN1042").teamName, "SOC val");
  assert.equal((await sa("POST", "/api/teams/" + soc.id + "/members", { remove: ["EN1042"] })).status, 200);
  await sa("POST", "/api/teams/" + soc.id + "/members", { add: ["EN1042"] });
  await sa("PUT", "/api/users/EN1042", { role: "User", teamId: ipsi.id, active: true });

  const noAccount = await sa("POST", "/api/users/make-lead", { empId: "20990004" });
  assert.match(noAccount.data.error, /no account yet/);
  const newLead = await sa("POST", "/api/users/make-lead", { empId: "20990004", password: "First@Pass1" });
  assert.equal(newLead.status, 200, JSON.stringify(newLead.data));
  assert.equal((await sa("PUT", "/api/teams/" + soc.id, { name: "SOC val", leadId: "20990004" })).status, 200);
  const leadSession = await session("person.four@company.com", "First@Pass1");
  assert.deepEqual((await leadSession("GET", "/api/me")).data.ledTeams, ["SOC val"]);
  const promoted = await sa("POST", "/api/users/make-lead", { empId: "EN1108" });
  assert.match(promoted.data.message, /now an active Lead Admin/);
  await sa("PUT", "/api/users/EN1108", { role: "User", teamId: ipsi.id, active: true });

  const badLead = await sa("POST", "/api/teams", { name: "Platform", leadId: "EN1042" });
  assert.match(badLead.data.error, /not an active Lead Admin/);
  const team = await sa("POST", "/api/teams", { name: "Platform", leadId: "LD300" });
  assert.equal(team.data.name, "Platform");
  assert.ok(team.data.id > 0);
});

test("hardware requests: pick a free item, Other, approval offers the item", async () => {
  const user = await as("EN1042");
  assert.match((await user("POST", "/api/requests", { kind: "Return", barcode: "SOC-FPGA-006" })).data.error, /assigned to you/);
  assert.match((await user("POST", "/api/requests", { kind: "Return", barcode: "PSU-2K4-021" })).data.error, /already an open request/);
  assert.equal((await user("POST", "/api/requests", { kind: "Return", barcode: "MB-7800X-001", details: "Done with it" })).status, 200);
  assert.match((await user("POST", "/api/requests", { kind: "Need", details: "board" })).data.error, /at least 10/);
  assert.match((await user("POST", "/api/requests", { kind: "Need", assetType: "Other", details: "Need an adapter for the bench" })).data.error, /You chose Other/);
  assert.equal((await user("POST", "/api/requests", { kind: "Need", assetType: "Other", otherText: "USB-C hub", details: "Need an adapter for the bench" })).status, 200);
  const picked = await user("POST", "/api/requests", { kind: "Need", barcode: "emblab90001", details: "Need a keyboard for the bench PC" });
  assert.equal(picked.status, 200, JSON.stringify(picked.data));
  const mine = (await user("GET", "/api/requests")).data;
  assert.ok(mine.some((r) => r.assetType === "Other: USB-C hub"));
  const keyboard = mine.find((r) => r.barcode === "EMBLAB90001");
  assert.equal(keyboard.assetType, "Peripheral");

  const admin = await as("AD010");
  const open = (await admin("GET", "/api/requests")).data.filter((r) => r.status === "Open");
  const need = open.find((r) => r.kind === "Need" && r.empId === "EN1108");
  assert.match((await admin("POST", "/api/requests/" + need.id + "/approve", { barcode: "SOC-MI300-014" })).data.error, /not free in the cage/);
  const given = await admin("POST", "/api/requests/" + need.id + "/approve", { barcode: "mb-7800x-002", note: "Use bench 5" });
  assert.match(given.data.message, /Approved. Waiting for Sample Signal Engineer \(en1108@lab.example\) to accept MB-7800X-002/);
  assert.equal((await admin("GET", "/api/assets/MB-7800X-002")).data.asset.holderId, "");
  const engineer = await as("EN1108");
  const offer = (await engineer("GET", "/api/handovers/mine")).data.find((h) => h.barcode === "MB-7800X-002");
  assert.equal((await engineer("POST", "/api/handovers/" + offer.id + "/accept")).status, 200);
  const asset = (await admin("GET", "/api/assets/MB-7800X-002")).data;
  assert.equal(asset.asset.holderId, "EN1108");
  assert.match(asset.history[0].remarks, /Approved request #\d+: Use bench 5. Accepted by Sample Signal Engineer/);
  assert.match((await admin("POST", "/api/requests/" + need.id + "/approve", { barcode: "MB-7800X-010" })).data.error, /already approved/);

  const keyboardRequest = open.find((r) => r.barcode === "EMBLAB90001");
  assert.match((await admin("POST", "/api/requests/" + keyboardRequest.id + "/approve", {})).data.message, /to accept EMBLAB90001/);
  const keyboardOffer = (await user("GET", "/api/handovers/mine")).data.find((h) => h.barcode === "EMBLAB90001");
  assert.equal((await user("POST", "/api/handovers/" + keyboardOffer.id + "/decline", { note: "Found one on my desk" })).status, 200);
  const reopened = (await admin("GET", "/api/requests")).data.find((r) => r.id === keyboardRequest.id);
  assert.equal(reopened.status, "Open", "a declined offer reopens the request");
  assert.match(reopened.note, /Declined EMBLAB90001: Found one on my desk/);

  const psu = open.find((r) => r.barcode === "PSU-2K4-021");
  assert.match((await admin("POST", "/api/requests/" + psu.id + "/approve", {})).data.message, /back in the cage/);
  assert.equal((await admin("GET", "/api/assets/PSU-2K4-021")).data.asset.status, "Available in Lab");
  const board = (await admin("GET", "/api/requests")).data.find((r) => r.barcode === "MB-7800X-001" && r.status === "Open");
  assert.match((await admin("POST", "/api/requests/" + board.id + "/reject", { note: "no" })).data.error, /reason/);
  assert.equal((await admin("POST", "/api/requests/" + board.id + "/reject", { note: "Keep it until the test run ends" })).status, 200);
  const cable = (await user("GET", "/api/requests")).data.find((r) => r.status === "Open");
  assert.equal((await user("POST", "/api/requests/" + cable.id + "/cancel")).status, 200);
  assert.equal((await user("POST", "/api/requests/" + cable.id + "/cancel")).status, 400);
});

test("a request for several items: approve with items of that type, the person gets Accept / Reject", async () => {
  const user = await as("EN1200");
  const free = (await user("GET", "/api/assets/available")).data.filter((a) => a.barcode !== "CBL-JTAG-009");
  const counts = {};
  free.forEach((a) => { counts[a.assetType] = (counts[a.assetType] || 0) + 1; });
  const type = Object.keys(counts).find((t) => counts[t] >= 2);
  assert.ok(type, "the sample has two free items of one type");
  const items = free.filter((a) => a.assetType === type).slice(0, 2).map((a) => a.barcode);
  assert.match((await user("POST", "/api/requests", { kind: "Need", assetType: type, quantity: 0, details: "Two for the new bench" })).data.error, /1 to 20/);
  const start = (await user("GET", "/api/updates")).data.now;
  assert.equal((await user("POST", "/api/requests", { kind: "Need", assetType: type, quantity: 2, details: "Two for the new bench" })).status, 200);
  const admin = await as("SA001");
  const request = (await admin("GET", "/api/requests")).data.find((r) => r.status === "Open" && r.empId === "EN1200");
  assert.equal(request.quantity, 2);
  assert.equal(request.type, type);
  const extra = free.find((a) => !items.includes(a.barcode)).barcode;
  assert.match((await admin("POST", "/api/requests/" + request.id + "/approve", { barcodes: [...items, extra] })).data.error, /for 2 item/);
  const approved = await admin("POST", "/api/requests/" + request.id + "/approve", { barcodes: items });
  assert.equal(approved.status, 200, JSON.stringify(approved.data));
  assert.match(approved.data.message, new RegExp("to accept " + items.join(", ")));

  const updates = (await user("GET", "/api/updates?since=" + encodeURIComponent(start))).data.items;
  const offers = updates.filter((u) => u.handoverId);
  assert.equal(offers.length, 2, "one pop-up with Accept / Reject for each item");
  assert.equal(offers[0].title, "Your request was approved");
  const first = offers.find((u) => u.barcode === items[0]);
  const second = offers.find((u) => u.barcode === items[1]);
  assert.equal((await user("POST", "/api/handovers/" + first.handoverId + "/accept")).status, 200);
  assert.equal((await user("POST", "/api/handovers/" + second.handoverId + "/decline", { note: "Only need one now" })).status, 200);
  const after = (await admin("GET", "/api/requests")).data.find((r) => r.id === request.id);
  assert.equal(after.status, "Approved", "one item was accepted, so the request stays approved");
  assert.match(after.given, new RegExp(items[0] + " \\(Accepted\\)"));
  assert.match(after.note, /Declined .*Only need one now/);
  assert.equal((await admin("GET", "/api/assets/" + items[0])).data.asset.holderId, "EN1200");
  assert.equal((await admin("GET", "/api/assets/" + items[1])).data.asset.holderId, "");
});

test("pop-up updates only show what concerns each person", async () => {
  const user = await as("EN1042");
  const first = (await user("GET", "/api/updates")).data;
  assert.match(first.now, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  assert.deepEqual(first.items, []);
  const admin = await as("AD010");
  const asset = (await admin("GET", "/api/assets/CBL-JTAG-009")).data.asset;
  await admin("POST", "/api/assets/CBL-JTAG-009/transfer", { status: "Assigned to Engineer", holderEmail: mail("EN1042"), revision: asset.revision });
  const later = (await user("GET", "/api/updates?since=" + encodeURIComponent(first.now))).data;
  assert.ok(later.items.some((u) => u.title === "Item waiting for you" && /CBL-JTAG-009/.test(u.text)));
  const other = await as("EN1200");
  const otherItems = (await other("GET", "/api/updates?since=" + encodeURIComponent(first.now))).data.items;
  assert.ok(!otherItems.some((u) => /CBL-JTAG-009/.test(u.text)), "other engineers do not see it");
});

test("change own password, backup, and sample reset", async () => {
  const user = await as("EN1108");
  assert.match((await user("POST", "/api/me/password", { current: "Wrong@123", next: "New@Pass77", confirm: "New@Pass77" })).data.error, /not correct/);
  assert.match((await user("POST", "/api/me/password", { current: "Lab@3002", next: "short", confirm: "short" })).data.error, /8 to 64/);
  assert.equal((await user("POST", "/api/me/password", { current: "Lab@3002", next: "New@Pass77", confirm: "New@Pass77" })).status, 200);
  await as("EN1108", "New@Pass77");
  const sa = await as("SA001");
  const backup = await sa("POST", "/api/backup");
  assert.match(backup.data.message, /Backup saved/);
  const file = fs.readdirSync(process.env.BACKUP_DIR).find((n) => n.endsWith(".json"));
  assert.ok(JSON.parse(fs.readFileSync(path.join(process.env.BACKUP_DIR, file))).tables.handovers.length > 0);
  assert.equal((await sa("POST", "/api/dev/reset", { confirm: "no" })).status, 400);
  assert.equal((await sa("POST", "/api/dev/reset", { confirm: "RESET" })).status, 200);
  await as("EN1108");
  const settings = (await sa("GET", "/api/settings")).data;
  assert.ok(settings.rooms.includes("Lab 3B Rack"), "rooms added by Admins survive a sample reset");
});

test("too many wrong passwords lock the sign-in for a while", async () => {
  const anon = await session();
  for (let i = 0; i < 5; i += 1) await anon("POST", "/api/login", { email: mail("LD300"), password: "Wrong@000" });
  const locked = await anon("POST", "/api/login", { email: mail("LD300"), password: "Lab@4002" });
  assert.equal(locked.status, 429);
});
