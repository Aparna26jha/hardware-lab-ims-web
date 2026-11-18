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

let server;
let base;

async function session(login, code) {
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
  if (login) {
    const result = await call("POST", "/api/login", { login, code });
    assert.equal(result.status, 200, "sign-in for " + login + ": " + JSON.stringify(result.data));
  }
  return call;
}

test.before(async () => {
  const conn = await mysql.createConnection({ ...config.db, multipleStatements: true });
  const tables = ["sessions", "hardware_requests", "feedback", "audit_log", "assets", "consignment_documents", "consignments", "directory", "users", "teams"];
  await conn.query("SET FOREIGN_KEY_CHECKS = 0; " + tables.map((t) => "DROP TABLE IF EXISTS " + t + ";").join(" ") + " SET FOREIGN_KEY_CHECKS = 1;");
  await conn.query(fs.readFileSync(path.join(config.root, "db", "schema.sql"), "utf8"));
  // Start from the version 2.1 layout to check that an existing database is upgraded in place.
  await conn.query("ALTER TABLE assets DROP COLUMN bond_no, DROP COLUMN storage_room");
  assert.deepEqual(await upgradeTables(conn), ["assets.bond_no", "assets.storage_room"]);
  assert.deepEqual(await upgradeTables(conn), [], "running the upgrade again changes nothing");
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

test("sign-in by alias or mail, wrong code refused, changes need the app header", async () => {
  await session("SA001", "1001");
  await session("ad010@lab.example", "2001");
  const anon = await session();
  const wrong = await anon("POST", "/api/login", { login: "SA001", code: "9999" });
  assert.equal(wrong.status, 401);
  const pending = await anon("POST", "/api/login", { login: "EN2301", code: "3003" });
  assert.match(pending.data.error, /waiting/);
  const settings = (await anon("GET", "/api/settings")).data;
  assert.equal(settings.version, require("../package.json").version);
  const blocked = await fetch(base + "/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  assert.equal(blocked.status, 403);
});

test("each role sees the right hardware", async () => {
  const admin = await session("AD010", "2001");
  const lead = await session("LD200", "4001");
  const user = await session("EN1042", "3001");
  const all = (await admin("GET", "/api/assets")).data;
  const leadList = (await lead("GET", "/api/assets")).data;
  const mine = (await user("GET", "/api/assets")).data;
  assert.equal(all.length, 13);
  assert.equal(all.find((a) => a.barcode === "MB-7800X-001").place, "Lab (with EN1042)");
  assert.equal(all.find((a) => a.barcode === "MB-7800X-002").place, "2A Inventory Room, CPU cupboard 1");
  assert.ok(mine.every((a) => a.holderId === "EN1042"));
  assert.equal(mine.length, 3);
  assert.ok(leadList.some((a) => a.holderId === "EN1108"), "lead sees team member");
  assert.ok(leadList.some((a) => !a.holderId && a.status === "Available in Lab"), "lead sees the cage");
  assert.ok(!leadList.some((a) => a.holderId === "EN1200"), "lead does not see another team");
  assert.equal(mine[0].teamName, "IPSi");
  const hidden = await user("GET", "/api/assets/SOC-FPGA-006");
  assert.equal(hidden.status, 404);
  const leadDetail = await lead("GET", "/api/assets/MB-7800X-001");
  assert.equal(leadDetail.data.history, null, "leads do not see history");
  assert.equal((await user("GET", "/api/consignments")).status, 403);
});

test("dashboard shows team totals, cage and 6-month expiry warnings", async () => {
  const admin = await session("SA001", "1001");
  const dash = (await admin("GET", "/api/dashboard")).data;
  const ipsi = dash.teams.find((t) => t.team === "IPSi");
  const cage = dash.teams.find((t) => t.teamId === "cage");
  assert.equal(ipsi.held, 4);
  assert.equal(cage.held, 7);
  const texts = dash.attention.map((a) => a.text).join(" | ");
  assert.match(texts, /EN2301/);
  assert.match(texts, /DBG-HDT-003 expired/);
  assert.match(texts, /AIC-GPU-002 expires 2027-03-31/);
  assert.match(texts, /INV-AR-7741: 1 of 4 items scanned, documents missing/);
  const user = await session("EN1042", "3001");
  const own = (await user("GET", "/api/dashboard")).data;
  assert.equal(own.teams, null);
  assert.deepEqual(own.attention.map((a) => a.tag).sort(), ["Expiring", "Request"]);
  assert.match(texts, /EN1108 Sample Signal Engineer: needs Debugger/);
});

test("inward by consignment: documents first, auto-fill, item limit", async () => {
  const admin = await session("AD010", "2001");
  const created = await admin("POST", "/api/consignments", {
    invoiceNo: "INV-T-1", poNumber: "PO-T-1", receivedDate: "2026-11-14", expectedItems: 2, ownership: "AMD-Specific"
  });
  assert.equal(created.status, 200, JSON.stringify(created.data));
  const id = created.data.id;
  const duplicate = await admin("POST", "/api/consignments", {
    invoiceNo: "INV-T-1", poNumber: "PO-T-1", receivedDate: "2026-11-14", expectedItems: 1, ownership: "AMD-Specific"
  });
  assert.match(duplicate.data.error, /already recorded/);
  const item = { barcode: "MB-7800X-009", assetType: "Motherboard", serialNo: "SM-H13-10099", room: "2A Inventory Room" };
  const noRoom = await admin("POST", "/api/consignments/" + id + "/items", { ...item, room: "" });
  assert.match(noRoom.data.error, /storage room/);
  const early = await admin("POST", "/api/consignments/" + id + "/items", item);
  assert.match(early.data.error, /Upload the scanned/);
  const shortReason = await admin("POST", "/api/consignments/" + id + "/items", { ...item, noDocumentReason: "later" });
  assert.match(shortReason.data.error, /at least 10/);
  const badFile = await admin("POST", "/api/consignments/" + id + "/documents", { file: { name: "x.exe", data: Buffer.from("MZ....").toString("base64") } });
  assert.match(badFile.data.error, /Only PDF/);
  const upload = await admin("POST", "/api/consignments/" + id + "/documents", { file: { name: "invoice.pdf", data: PDF } });
  assert.equal(upload.status, 200);
  const suggest = (await admin("GET", "/api/assets/suggest?barcode=mb-7800x-009")).data;
  assert.equal(suggest.fill.model, "H13SSL");
  assert.equal(suggest.fill.assetType, "Motherboard");
  const saved = await admin("POST", "/api/consignments/" + id + "/items", { ...item, model: "H13SSL", holderId: "EN1108" });
  assert.match(saved.data.message, /1 of 2/);
  const again = await admin("POST", "/api/consignments/" + id + "/items", item);
  assert.match(again.data.error, /already on file/);
  const dupSerial = await admin("POST", "/api/consignments/" + id + "/items", { barcode: "MB-7800X-010", assetType: "Motherboard", serialNo: "SM-H13-10099", room: "Store Room" });
  assert.match(dupSerial.data.error, /already recorded/);
  await admin("POST", "/api/consignments/" + id + "/items", { barcode: "MB-7800X-010", assetType: "Motherboard", room: "Store Room" });
  const over = await admin("POST", "/api/consignments/" + id + "/items", { barcode: "MB-7800X-011", assetType: "Motherboard", room: "Store Room" });
  assert.match(over.data.error, /All 2 items/);
  const detail = (await admin("GET", "/api/consignments/" + id)).data;
  assert.equal(detail.items.length, 2);
  assert.equal(detail.documents.length, 1);
  const asset = (await admin("GET", "/api/assets/MB-7800X-009")).data.asset;
  assert.equal(asset.poNumber, "PO-T-1");
  assert.equal(asset.invoiceNo, "INV-T-1");
  const doc = await fetch(base + "/api/documents/" + detail.documents[0].id);
  assert.equal(doc.status, 401, "documents need sign-in");
  const lead = await session("LD200", "4001");
  assert.ok((await lead("GET", "/api/assets")).data.some((a) => a.barcode === "MB-7800X-009"), "lead sees new team item");
});

test("AMD EMBLAB labels, bond number, and inward before the document arrives", async () => {
  const admin = await session("AD010", "2001");
  const make = async (invoiceNo, ownership) => (await admin("POST", "/api/consignments", {
    invoiceNo, poNumber: "PO-L-1", receivedDate: "2026-11-18", expectedItems: 3, ownership
  })).data.id;
  const amd = await make("INV-L-1", "AMD-Specific");
  const wipro = await make("INV-L-2", "Wipro-Specific");
  const label = {
    barcode: "*emblab 70001*", assetType: "Peripheral", make: "Dell", description: "Dell Keyboard with Mouse",
    bondNo: "NA", room: "Store Room", location: "Shelf 2", noDocumentReason: "Invoice is with the purchase team"
  };
  const wrongOwner = await admin("POST", "/api/consignments/" + wipro + "/items", label);
  assert.match(wrongOwner.data.error, /EMBLAB70001 is an AMD asset label/);
  const saved = await admin("POST", "/api/consignments/" + amd + "/items", label);
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  const asset = (await admin("GET", "/api/assets/EMBLAB70001")).data;
  assert.equal(asset.asset.ownership, "AMD-Specific");
  assert.equal(asset.asset.bondNo, "NA");
  assert.equal(asset.asset.place, "Store Room, Shelf 2");
  assert.match(asset.history[0].remarks, /No document yet: Invoice is with the purchase team/);
  const suggest = (await admin("GET", "/api/assets/suggest?barcode=EMBLAB70002&consignment=" + amd)).data;
  assert.equal(suggest.fill.description, "Dell Keyboard with Mouse");
  assert.equal(suggest.fill.room, "Store Room");
  assert.match(suggest.source, /EMBLAB70001/);
  const found = (await admin("GET", "/api/assets?search=store%20room")).data;
  assert.ok(found.some((a) => a.barcode === "EMBLAB70001"), "search finds the room");
  const dash = (await admin("GET", "/api/dashboard")).data;
  assert.ok(dash.attention.some((a) => /INV-L-1: 1 of 3 items scanned, documents missing/.test(a.text)));
  const csv = (await admin("GET", "/api/export/inventory.csv")).data;
  assert.match(csv, /"Bond No"/);
});

test("transfer rules and history", async () => {
  const admin = await session("AD010", "2001");
  const load = async () => (await admin("GET", "/api/assets/CBL-JTAG-009")).data.asset;
  let asset = await load();
  const nobody = await admin("POST", "/api/assets/CBL-JTAG-009/transfer", { status: "Assigned to Engineer", holderId: "EN9999", revision: asset.revision });
  assert.match(nobody.data.error, /not an active user/);
  const scrap = await admin("POST", "/api/assets/CBL-JTAG-009/transfer", { status: "Scrapped/Returned", revision: asset.revision });
  assert.match(scrap.data.error, /remarks/);
  const ok = await admin("POST", "/api/assets/CBL-JTAG-009/transfer", { status: "Assigned to Engineer", holderId: "en1200", revision: asset.revision });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  const stale = await admin("POST", "/api/assets/CBL-JTAG-009/transfer", { status: "Available in Lab", revision: asset.revision });
  assert.equal(stale.status, 409);
  asset = await load();
  const same = await admin("POST", "/api/assets/CBL-JTAG-009/transfer", { status: "Assigned to Engineer", holderId: "EN1200", revision: asset.revision });
  assert.match(same.data.error, /does not change/);
  assert.equal(asset.teamName, "Team B (sample)");
  const history = (await admin("GET", "/api/assets/CBL-JTAG-009")).data.history;
  assert.equal(history[0].action, "Transfer");
  assert.match(history[0].to, /EN1200/);
});

test("edit details is logged; only Super Admin can delete and restore", async () => {
  const admin = await session("AD010", "2001");
  const sa = await session("SA001", "1001");
  const asset = (await admin("GET", "/api/assets/MB-SP5-044")).data.asset;
  const edit = await admin("PUT", "/api/assets/MB-SP5-044", { ...asset, location: "CPU cupboard 9", revision: asset.revision });
  assert.equal(edit.status, 200, JSON.stringify(edit.data));
  assert.equal(edit.data.asset.location, "CPU cupboard 9");
  assert.equal((await admin("POST", "/api/assets/MB-SP5-044/delete", { reason: "Testing delete" })).status, 403);
  const short = await sa("POST", "/api/assets/MB-SP5-044/delete", { reason: "x" });
  assert.match(short.data.error, /reason/);
  assert.equal((await sa("POST", "/api/assets/MB-SP5-044/delete", { reason: "Entered twice by mistake" })).status, 200);
  assert.ok(!(await admin("GET", "/api/assets")).data.some((a) => a.barcode === "MB-SP5-044"));
  assert.equal((await sa("GET", "/api/assets/deleted")).data[0].barcode, "MB-SP5-044");
  assert.equal((await sa("POST", "/api/assets/MB-SP5-044/restore")).status, 200);
  const history = (await admin("GET", "/api/assets/MB-SP5-044")).data.history.map((r) => r.action);
  assert.deepEqual(history.slice(0, 3), ["Restore", "Delete", "Edit"]);
});

test("feedback: rules, saved with name and mail, screenshot, admin list", async () => {
  const user = await session("EN1042", "3001");
  const short = await user("POST", "/api/feedback", { kind: "Bug", title: "Short", description: "This description is long enough." });
  assert.match(short.data.error, /at least 15/);
  const sent = await user("POST", "/api/feedback", {
    kind: "Improvement", title: "Show the location on the list", description: "It would help to see the cupboard number.",
    screenshot: { name: "s.png", data: PNG }, screen: "dashboard"
  });
  assert.equal(sent.status, 200, JSON.stringify(sent.data));
  assert.equal((await user("GET", "/api/feedback")).status, 403);
  const admin = await session("AD010", "2001");
  const list = (await admin("GET", "/api/feedback")).data;
  assert.equal(list[0].email, "en1042@lab.example");
  assert.ok(list[0].hasScreenshot);
  const shot = await admin("GET", "/api/feedback/" + list[0].id + "/screenshot");
  assert.equal(shot.status, 200);
  assert.equal((await admin("PUT", "/api/feedback/" + list[0].id, { status: "Done" })).status, 200);
});

test("request access, approve with a team, directory import, teams", async () => {
  const anon = await session();
  const mismatch = await anon("POST", "/api/register", { alias: "EN2200", name: "Sample New Engineer", email: "wrong@lab.example", code: "5000", confirm: "5000" });
  assert.match(mismatch.data.error, /does not match/);
  const ok = await anon("POST", "/api/register", { alias: "en2200", name: "sample new engineer", email: "EN2200@lab.example", code: "5000", confirm: "5000" });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  const sa = await session("SA001", "1001");
  const users = (await sa("GET", "/api/users")).data;
  assert.equal(users[0].state, "Pending");
  const teams = (await sa("GET", "/api/teams")).data;
  const ipsi = teams.find((t) => t.name === "IPSi");
  assert.equal((await sa("PUT", "/api/users/EN2200", { role: "User", teamId: ipsi.id, active: true })).status, 200);
  await session("EN2200", "5000");
  const selfOff = await sa("PUT", "/api/users/SA001", { role: "Super Admin", teamId: "", active: false });
  assert.match(selfOff.data.error, /own account/);
  const imported = await sa("POST", "/api/directory/import", {
    text: "alias, mail, name, team\nEN3001, a.one@company.com, Person One, IPSi\nEN3002, bad-mail, Person Two\nEN3003, c.three@company.com, Person Three, Unknown Team"
  });
  assert.match(imported.data.message, /^1 people saved/);
  assert.equal(imported.data.problems.length, 2);
  const badLead = await sa("POST", "/api/teams", { name: "Platform", leadId: "EN1042" });
  assert.match(badLead.data.error, /not an active Lead Admin/);
  assert.equal((await sa("POST", "/api/teams", { name: "Platform", leadId: "LD300" })).status, 200);
  assert.equal((await sa("POST", "/api/teams", { name: "Admin-led team", leadId: "AD010" })).status, 200);
});

test("hardware requests: engineers ask, Admin approval makes the transfer", async () => {
  const user = await session("EN1042", "3001");
  const notMine = await user("POST", "/api/requests", { kind: "Return", barcode: "SOC-FPGA-006" });
  assert.match(notMine.data.error, /assigned to you/);
  const twice = await user("POST", "/api/requests", { kind: "Return", barcode: "PSU-2K4-021" });
  assert.match(twice.data.error, /already an open request/);
  assert.equal((await user("POST", "/api/requests", { kind: "Return", barcode: "MB-7800X-001", details: "Done with it" })).status, 200);
  const vague = await user("POST", "/api/requests", { kind: "Need", details: "board" });
  assert.match(vague.data.error, /at least 10/);
  const mine = (await user("GET", "/api/requests")).data;
  assert.ok(mine.length === 2 && mine.every((r) => r.empId === "EN1042"));
  assert.equal((await user("POST", "/api/requests/" + mine[0].id + "/approve", {})).status, 403);

  const admin = await session("AD010", "2001");
  const open = (await admin("GET", "/api/requests")).data.filter((r) => r.status === "Open");
  const need = open.find((r) => r.kind === "Need" && r.empId === "EN1108");
  const busy = await admin("POST", "/api/requests/" + need.id + "/approve", { barcode: "SOC-MI300-014" });
  assert.match(busy.data.error, /not free in the cage/);
  const given = await admin("POST", "/api/requests/" + need.id + "/approve", { barcode: "mb-7800x-002", note: "Use bench 5" });
  assert.match(given.data.message, /MB-7800X-002 is now assigned to EN1108/);
  const asset = (await admin("GET", "/api/assets/MB-7800X-002")).data;
  assert.equal(asset.asset.holderId, "EN1108");
  assert.match(asset.history[0].remarks, /Approved request #\d+: Use bench 5/);
  assert.match((await admin("POST", "/api/requests/" + need.id + "/approve", { barcode: "MB-7800X-010" })).data.error, /already approved/);

  const psu = open.find((r) => r.barcode === "PSU-2K4-021");
  assert.match((await admin("POST", "/api/requests/" + psu.id + "/approve", {})).data.message, /back in the cage/);
  assert.equal((await admin("GET", "/api/assets/PSU-2K4-021")).data.asset.status, "Available in Lab");
  const board = (await admin("GET", "/api/requests")).data.find((r) => r.barcode === "MB-7800X-001" && r.status === "Open");
  assert.match((await admin("POST", "/api/requests/" + board.id + "/reject", { note: "no" })).data.error, /reason/);
  assert.equal((await admin("POST", "/api/requests/" + board.id + "/reject", { note: "Keep it until the test run ends" })).status, 200);

  const created = await user("POST", "/api/requests", { kind: "Need", assetType: "Cable", details: "Need a PCIe Gen5 riser cable" });
  assert.equal(created.status, 200);
  const cable = (await user("GET", "/api/requests")).data.find((r) => r.status === "Open");
  assert.equal((await user("POST", "/api/requests/" + cable.id + "/cancel")).status, 200);
  assert.equal((await user("POST", "/api/requests/" + cable.id + "/cancel")).status, 400);
});

test("change own code, backup, and sample reset", async () => {
  const user = await session("EN1108", "3002");
  assert.match((await user("POST", "/api/me/code", { current: "0000", next: "7777", confirm: "7777" })).data.error, /not correct/);
  assert.equal((await user("POST", "/api/me/code", { current: "3002", next: "7777", confirm: "7777" })).status, 200);
  await session("EN1108", "7777");
  const sa = await session("SA001", "1001");
  const backup = await sa("POST", "/api/backup");
  assert.match(backup.data.message, /Backup saved/);
  assert.equal(fs.readdirSync(process.env.BACKUP_DIR).filter((n) => n.endsWith(".json")).length, 1);
  assert.equal((await sa("POST", "/api/dev/reset", { confirm: "no" })).status, 400);
  assert.equal((await sa("POST", "/api/dev/reset", { confirm: "RESET" })).status, 200);
  await session("EN1108", "3002");
});

test("too many wrong codes lock the sign-in for a while", async () => {
  const anon = await session();
  for (let i = 0; i < 5; i += 1) await anon("POST", "/api/login", { login: "LD300", code: "0000" });
  const locked = await anon("POST", "/api/login", { login: "LD300", code: "4002" });
  assert.equal(locked.status, 429);
});
