"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const config = require("./config");
const db = require("./db");
const { hashCode } = require("./auth");

// A one-page PDF that says "Sample invoice ..." so the demo consignments have a document to open.
function samplePdf(text) {
  const stream = "BT /F1 18 Tf 72 720 Td (" + text.replace(/[()\\]/g, "") + ") Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    "<< /Length " + stream.length + " >>\nstream\n" + stream + "\nendstream",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"
  ];
  let body = "%PDF-1.4\n";
  const offsets = objects.map((object, i) => {
    const at = body.length;
    body += (i + 1) + " 0 obj\n" + object + "\nendobj\n";
    return at;
  });
  const xref = body.length;
  body += "xref\n0 " + (objects.length + 1) + "\n0000000000 65535 f \n"
    + offsets.map((at) => String(at).padStart(10, "0") + " 00000 n \n").join("")
    + "trailer\n<< /Size " + (objects.length + 1) + " /Root 1 0 R >>\nstartxref\n" + xref + "\n%%EOF\n";
  return Buffer.from(body, "latin1");
}

function writeSampleDocument(text) {
  const folder = path.join(config.uploadDir, "consignments");
  fs.mkdirSync(folder, { recursive: true });
  const storedName = crypto.randomUUID() + ".pdf";
  const content = samplePdf(text);
  fs.writeFileSync(path.join(folder, storedName), content);
  return { storedName, size: content.length };
}

const TEAMS = [
  { name: "IPSi", lead: "LD200" },
  { name: "Team B (sample)", lead: "LD300" }
];

// [alias, name, role, code, team, approval]
const USERS = [
  ["SA001", "Sample Super Admin", "Super Admin", "1001", null, "Approved"],
  ["AD010", "Sample Inventory Custodian", "Admin", "2001", null, "Approved"],
  ["LD200", "Sample Lead IPSi", "Lead Admin", "4001", "IPSi", "Approved"],
  ["LD300", "Sample Lead Team B", "Lead Admin", "4002", "Team B (sample)", "Approved"],
  ["EN1042", "Sample Validation Engineer", "User", "3001", "IPSi", "Approved"],
  ["EN1108", "Sample Signal Engineer", "User", "3002", "IPSi", "Approved"],
  ["EN1200", "Sample Platform Engineer", "User", "3004", "Team B (sample)", "Approved"],
  ["EN2301", "Sample Requesting Engineer", "User", "3003", "IPSi", "Pending"]
];

const EXTRA_DIRECTORY = [["EN2200", "Sample New Engineer", "IPSi"]];

const CONSIGNMENTS = [
  { key: 1, invoice: "INV-SM-8812", po: "PO-AMD-24011", date: "2026-08-14", expected: 2, owner: "AMD-Specific", supplier: "Supermicro", withDocument: true },
  { key: 2, invoice: "INV-CH-3305", po: "PO-WPR-44190", date: "2026-01-22", expected: 1, owner: "Wipro-Specific", supplier: "Chroma", withDocument: true },
  { key: 3, invoice: "INV-AR-7741", po: "PO-AMD-26001", date: "2026-10-01", expected: 4, owner: "AMD-Specific", supplier: "ASRock Rack" }
];

// [barcode, owner, type, manufacturer, serial, model, rev, description, po, arrival, expiry, location, status, holder, consignment]
const ASSETS = [
  ["MB-7800X-001", "AMD-Specific", "Motherboard", "Supermicro", "SM-H13-10021", "H13SSL", "Rev 1.01", "SP5 validation motherboard for Genoa bring-up", "PO-AMD-24011", "2026-08-14", "2029-08-14", "Bench 4", "Assigned to Engineer", "EN1042", 1],
  ["MB-7800X-002", "AMD-Specific", "Motherboard", "Supermicro", "SM-H13-10022", "H13SSL", "Rev 1.01", "Spare SP5 validation motherboard", "PO-AMD-24011", "2026-08-14", "2029-08-14", "CPU cupboard 1", "Available in Lab", null, 1],
  ["SOC-MI300-014", "AMD-Specific", "SoC Board", "AMD", "MI300-VAL-014", "MI300X-VAL", "A1", "MI300 validation socket board", "PO-AMD-25102", "2026-09-02", "2028-09-02", "Bench 2", "Assigned to Engineer", "EN1108", null],
  ["AIC-NIC-088", "AMD-Specific", "Add-in Card", "Broadcom", "BCM-57508-088", "BCM57508", "PCIe Gen4 x16", "100GbE adapter held for rework", "PO-AMD-23880", "2026-05-19", "2026-12-01", "Repair shelf", "Under Maintenance", null, null],
  ["DBG-HDT-003", "AMD-Specific", "Debugger", "AMD", "HDT-PLUS-003", "HDT+", "FW 9.4", "HDT hardware debugger pod, calibration due", "PO-AMD-19002", "2025-11-03", "2026-10-31", "CPU cupboard 2", "Available in Lab", null, null],
  ["PSU-2K4-021", "Wipro-Specific", "Power Supply", "Chroma", "CH-62012-021", "62012P", "600V / 8A", "Programmable bench supply owned by the Wipro lab bench", "PO-WPR-44190", "2026-01-22", "2031-01-22", "Bench 4", "Assigned to Engineer", "EN1042", 2],
  ["CBL-PCIE-110", "Wipro-Specific", "Cable", "Molex", "MX-G5-110", "PCIe-G5", "1.0 m", "PCIe Gen5 riser cable", "PO-WPR-44102", "2026-03-11", null, "Cable rack A", "Available in Lab", null, null],
  ["DBG-LA-017", "Wipro-Specific", "Debugger", "Tektronix", "TEK-TLA-017", "TLA6404", "Retired", "Logic analyzer returned after failed calibration", "PO-WPR-39811", "2024-06-01", "2026-06-01", null, "Scrapped/Returned", null, null],
  ["SOC-FPGA-006", "Wipro-Specific", "SoC Board", "AMD", "XIL-VCU-006", "VCU118", "Rev 2.0", "FPGA characterization board on the Wipro bench", "PO-WPR-41020", "2026-04-09", "2029-04-09", "Bench 7", "Assigned to Engineer", "EN1200", null],
  ["MB-SP5-044", "AMD-Specific", "Motherboard", "ASRock Rack", "ASR-SIENA-044", "SIENAD8", "Rev A", "Siena reference motherboard", "PO-AMD-26001", "2026-10-01", "2029-10-01", "CPU cupboard 3", "Available in Lab", null, 3],
  ["AIC-GPU-002", "AMD-Specific", "Add-in Card", "AMD", "INST-VAL-002", "Instinct-VAL", "192GB", "Instinct validation accelerator card, loan ends March", "PO-AMD-25550", "2026-09-18", "2027-03-31", "Bench 4", "Assigned to Engineer", "EN1042", null],
  ["CBL-JTAG-009", "AMD-Specific", "Cable", "Blackhawk", "BH-JTAG-009", "JTAG-14", "14-pin", "JTAG scan cable", "PO-AMD-18820", "2025-12-12", null, "Cable rack B", "Available in Lab", null, null]
];

// [when, barcode, action, from, to, fromStatus, toStatus, by, remarks]
const LOG = [
  ["2026-08-14 10:05:00", "MB-7800X-001", "Transfer", null, "EN1042", "Available in Lab", "Assigned to Engineer", "AD010", "Initial issue for Genoa bring-up"],
  ["2026-09-02 15:41:00", "PSU-2K4-021", "Transfer", null, "EN1042", "Available in Lab", "Assigned to Engineer", "AD010", "Bench supply issued with the SP5 board"],
  ["2026-07-30 11:20:00", "DBG-LA-017", "Transfer", "EN1108", null, "Assigned to Engineer", "Scrapped/Returned", "AD010", "Failed calibration and returned to Wipro stores"],
  ["2026-10-20 09:30:00", "SOC-FPGA-006", "Transfer", "EN1108", "EN1200", "Assigned to Engineer", "Assigned to Engineer", "AD010", "Moved to Team B for FPGA characterization"]
];

// [kind, alias, type, barcode, details]
const REQUESTS = [
  ["Return", "EN1042", null, "PSU-2K4-021", "Bench work finished, please collect the supply"],
  ["Need", "EN1108", "Debugger", null, "Need a JTAG debugger for MI300 bring-up this week"]
];

const TABLES = ["sessions", "hardware_requests", "feedback", "audit_log", "assets", "consignment_documents", "consignments", "directory", "users", "teams"];

// Loads the sample lab. With reset=false it only fills an empty database.
async function loadSample(reset) {
  const conn = await db.pool.getConnection();
  try {
    if (!reset) {
      const [[row]] = await conn.query("SELECT COUNT(*) AS n FROM users");
      if (Number(row.n)) return false;
    }
    await conn.query("SET FOREIGN_KEY_CHECKS = 0");
    for (const table of TABLES) {
      if (reset && table === "sessions") continue;
      await conn.query("TRUNCATE TABLE " + table);
    }
    await conn.query("SET FOREIGN_KEY_CHECKS = 1");
    await conn.beginTransaction();
    const teamIds = {};
    for (const team of TEAMS) {
      const [result] = await conn.query("INSERT INTO teams (team_name) VALUES (?)", [team.name]);
      teamIds[team.name] = result.insertId;
    }
    for (const [alias, name, role, code, team, approval] of USERS) {
      const email = alias.toLowerCase() + "@lab.example";
      const teamId = team ? teamIds[team] : null;
      await conn.query(
        `INSERT INTO users (emp_id, emp_name, email, role, requested_role, team_id, approval, active, access_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [alias, name, email, role, role, teamId, approval, approval === "Approved" ? 1 : 0, hashCode(code)]
      );
      await conn.query("INSERT INTO directory (alias, email, emp_name, team_id, added_by) VALUES (?, ?, ?, ?, 'SA001')",
        [alias, email, name, teamId]);
    }
    for (const [alias, name, team] of EXTRA_DIRECTORY) {
      await conn.query("INSERT INTO directory (alias, email, emp_name, team_id, added_by) VALUES (?, ?, ?, ?, 'SA001')",
        [alias, alias.toLowerCase() + "@lab.example", name, teamIds[team]]);
    }
    for (const team of TEAMS) {
      await conn.query("UPDATE teams SET lead_emp_id = ? WHERE team_id = ?", [team.lead, teamIds[team.name]]);
    }
    const consignmentIds = {};
    for (const c of CONSIGNMENTS) {
      const [result] = await conn.query(
        `INSERT INTO consignments (invoice_no, po_number, received_date, expected_items, ownership, supplier, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'AD010', ?)`,
        [c.invoice, c.po, c.date, c.expected, c.owner, c.supplier, c.date + " 09:00:00"]
      );
      consignmentIds[c.key] = result.insertId;
      if (c.withDocument) {
        const doc = writeSampleDocument("Sample invoice " + c.invoice + " / " + c.po + " (demonstration only)");
        await conn.query(
          `INSERT INTO consignment_documents (consignment_id, original_name, stored_name, mime_type, size_bytes, uploaded_by, uploaded_at)
           VALUES (?, ?, ?, 'application/pdf', ?, 'AD010', ?)`,
          [result.insertId, c.invoice + ".pdf", doc.storedName, doc.size, c.date + " 09:10:00"]
        );
      }
    }
    for (const a of ASSETS) {
      const [barcode, owner, type, manufacturer, serial, model, rev, description, po, arrival, expiry, location, status, holder, key] = a;
      await conn.query(
        `INSERT INTO assets (barcode, ownership, asset_type, manufacturer, mfs_serial_no, make, model, capacity_rev, description,
           po_number, arrival_date, expiry_date, location, status, holder_emp_id, consignment_id, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'AD010', ?)`,
        [barcode, owner, type, manufacturer, serial, manufacturer, model, rev, description, po, arrival, expiry, location,
          status, holder, key ? consignmentIds[key] : null, arrival + " 09:30:00"]
      );
      await conn.query(
        `INSERT INTO audit_log (logged_at, barcode, action, to_status, done_by, remarks)
         VALUES (?, ?, 'Inward', 'Available in Lab', 'AD010', 'Inward receipt')`,
        [arrival + " 09:30:00", barcode]
      );
    }
    for (const row of LOG) {
      await conn.query(
        `INSERT INTO audit_log (logged_at, barcode, action, from_holder, to_holder, from_status, to_status, done_by, remarks)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, row);
    }
    for (const [kind, alias, type, barcode, details] of REQUESTS) {
      await conn.query("INSERT INTO hardware_requests (kind, emp_id, asset_type, barcode, details) VALUES (?, ?, ?, ?, ?)",
        [kind, alias, type, barcode, details]);
    }
    await conn.commit();
    return true;
  } catch (error) {
    await conn.rollback().catch(() => {});
    throw error;
  } finally {
    conn.release();
  }
}

module.exports = { loadSample };
