"use strict";

const express = require("express");
const db = require("../db");
const config = require("../config");
const { requireUser, requireRole } = require("../auth");
const { backupNow, latestBackup } = require("../backup");
const { saveUpload, sendUpload } = require("../files");
const { loadSample } = require("../sample");
const {
  ROLES, OWNERS, STATUSES, ASSET_TYPES, FEEDBACK_KINDS, FEEDBACK_STATUSES, FEEDBACK_TITLE_MIN,
  FEEDBACK_DESCRIPTION_MIN, fail, clean, isCustodian, checkFeedback
} = require("../rules");
const { scopedAssets, recentActivity } = require("./assets");
const { openRequests } = require("./requests");

const router = express.Router();

router.get("/settings", (req, res) => {
  res.json({
    version: config.version,
    environment: config.appEnv,
    showSampleAccounts: config.isDevelopment,
    expiryWarnMonths: config.expiryWarnMonths,
    feedbackTitleMin: FEEDBACK_TITLE_MIN,
    feedbackDescriptionMin: FEEDBACK_DESCRIPTION_MIN,
    roles: ROLES, owners: OWNERS, statuses: STATUSES, assetTypes: ASSET_TYPES,
    feedbackKinds: FEEDBACK_KINDS, feedbackStatuses: FEEDBACK_STATUSES
  });
});

function countAssets(assets) {
  const counts = { total: assets.length, available: 0, assigned: 0, maintenance: 0, scrapped: 0, amd: 0, wipro: 0 };
  for (const asset of assets) {
    if (asset.status === "Available in Lab") counts.available += 1;
    if (asset.status === "Assigned to Engineer") counts.assigned += 1;
    if (asset.status === "Under Maintenance") counts.maintenance += 1;
    if (asset.status === "Scrapped/Returned") counts.scrapped += 1;
    if (asset.ownership === "AMD-Specific") counts.amd += 1;
    if (asset.ownership === "Wipro-Specific") counts.wipro += 1;
  }
  return counts;
}

async function teamSummary() {
  const teams = await db.query(
    `SELECT t.team_id, t.team_name, t.lead_emp_id, l.emp_name AS lead_name,
            COUNT(a.barcode) AS held,
            COALESCE(SUM(a.ownership = 'AMD-Specific'), 0) AS amd,
            COALESCE(SUM(a.ownership = 'Wipro-Specific'), 0) AS wipro,
            COALESCE(SUM(a.status = 'Under Maintenance'), 0) AS maintenance
       FROM teams t
       LEFT JOIN users l ON l.emp_id = t.lead_emp_id
       LEFT JOIN users m ON m.team_id = t.team_id
       LEFT JOIN assets a ON a.holder_emp_id = m.emp_id AND a.deleted_at IS NULL
      GROUP BY t.team_id, t.team_name, t.lead_emp_id, l.emp_name
      ORDER BY t.team_name`);
  const rows = teams.map((t) => ({
    teamId: t.team_id, team: t.team_name, lead: t.lead_emp_id ? t.lead_emp_id + " " + (t.lead_name || "") : "Not set",
    held: Number(t.held), amd: Number(t.amd), wipro: Number(t.wipro), maintenance: Number(t.maintenance)
  }));
  const loose = await db.one(
    `SELECT COUNT(*) AS held, COALESCE(SUM(a.ownership = 'AMD-Specific'), 0) AS amd,
            COALESCE(SUM(a.ownership = 'Wipro-Specific'), 0) AS wipro,
            COALESCE(SUM(a.status = 'Under Maintenance'), 0) AS maintenance
       FROM assets a JOIN users u ON u.emp_id = a.holder_emp_id
      WHERE a.deleted_at IS NULL AND u.team_id IS NULL`);
  if (Number(loose.held)) {
    rows.push({ teamId: "none", team: "No team", lead: "", held: Number(loose.held), amd: Number(loose.amd),
      wipro: Number(loose.wipro), maintenance: Number(loose.maintenance) });
  }
  const cage = await db.one(
    `SELECT COUNT(*) AS held, COALESCE(SUM(ownership = 'AMD-Specific'), 0) AS amd,
            COALESCE(SUM(ownership = 'Wipro-Specific'), 0) AS wipro,
            COALESCE(SUM(status = 'Under Maintenance'), 0) AS maintenance
       FROM assets WHERE deleted_at IS NULL AND holder_emp_id IS NULL AND status <> 'Scrapped/Returned'`);
  rows.push({ teamId: "cage", team: "In cage (not assigned)", lead: "", held: Number(cage.held), amd: Number(cage.amd),
    wipro: Number(cage.wipro), maintenance: Number(cage.maintenance) });
  return rows;
}

router.get("/dashboard", requireUser, async (req, res) => {
  const user = req.user;
  const assets = await scopedAssets(user);
  const attention = [];
  if (user.role === "Super Admin") {
    const pending = await db.query("SELECT emp_id, emp_name FROM users WHERE approval = 'Pending' ORDER BY created_at");
    pending.forEach((p) => attention.push({ tag: "Waiting", kind: "warn", text: p.emp_id + " " + p.emp_name + " asked for access", go: "accounts" }));
  }
  const requests = await openRequests();
  requests.filter((r) => isCustodian(user) || r.empId === user.emp_id).forEach((r) => attention.push({
    tag: "Request", kind: "warn", go: "requests",
    text: (isCustodian(user) ? r.empId + " " + r.empName + ": " : "Your request: ")
      + (r.kind === "Return" ? "return " + r.barcode : "needs " + (r.assetType || "hardware") + " - " + r.details)
      + (isCustodian(user) ? "" : " (waiting for an Admin)")
  }));
  if (isCustodian(user)) {
    const open = await db.query(
      `SELECT c.consignment_id, c.invoice_no, c.expected_items,
              (SELECT COUNT(*) FROM assets a WHERE a.consignment_id = c.consignment_id) AS scanned,
              (SELECT COUNT(*) FROM consignment_documents d WHERE d.consignment_id = c.consignment_id) AS docs
         FROM consignments c ORDER BY c.received_date`);
    open.filter((c) => Number(c.scanned) < c.expected_items || !Number(c.docs)).forEach((c) => attention.push({
      tag: "Inward", kind: "warn", go: "inward", id: c.consignment_id,
      text: "Invoice " + c.invoice_no + ": " + c.scanned + " of " + c.expected_items + " items scanned"
        + (Number(c.docs) ? "" : ", documents missing")
    }));
    const fresh = await db.one("SELECT COUNT(*) AS n FROM feedback WHERE status = 'New'");
    if (Number(fresh.n)) attention.push({ tag: "Feedback", kind: "warn", go: "feedback", text: fresh.n + " new feedback item(s)" });
  }
  assets.filter((a) => a.expiry).sort((a, b) => a.expiryDate.localeCompare(b.expiryDate)).forEach((a) => attention.push({
    tag: a.expiry === "expired" ? "Expired" : "Expiring", kind: a.expiry === "expired" ? "bad" : "warn", barcode: a.barcode,
    text: a.barcode + " " + (a.expiry === "expired" ? "expired " : "expires ") + a.expiryDate + " · " + (a.model || a.assetType)
      + " · " + (a.holderId ? "held by " + a.holderId : "in the cage")
  }));
  res.json({
    counts: countAssets(assets),
    attention,
    activity: isCustodian(user) ? await recentActivity(12) : null,
    teams: isCustodian(user) ? await teamSummary() : null,
    lastBackup: user.role === "Super Admin" ? (latestBackup() || {}).time || null : null
  });
});

// ---- Feedback ----

router.post("/feedback", requireUser, async (req, res) => {
  const entry = {
    kind: clean(req.body.kind),
    title: clean(req.body.title, 150),
    description: clean(req.body.description, 4000)
  };
  checkFeedback(entry);
  const shot = req.body.screenshot ? saveUpload(req.body.screenshot, "feedback", ["png", "jpg"], 5) : null;
  await db.query(
    `INSERT INTO feedback (kind, title, description, screen, screenshot_name, screenshot_mime, emp_id, emp_name, email, role)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [entry.kind, entry.title, entry.description, clean(req.body.screen, 40) || null, shot ? shot.storedName : null,
      shot ? shot.mime : null, req.user.emp_id, req.user.emp_name, req.user.email, req.user.role]
  );
  res.json({ message: "Thank you. Your feedback was sent." });
});

router.get("/feedback", requireRole("Super Admin", "Admin"), async (req, res) => {
  const rows = await db.query("SELECT * FROM feedback ORDER BY (status = 'Done'), created_at DESC");
  res.json(rows.map((f) => ({
    id: f.feedback_id, kind: f.kind, title: f.title, description: f.description, screen: f.screen || "",
    hasScreenshot: !!f.screenshot_name, person: f.emp_id + " " + f.emp_name, email: f.email, role: f.role,
    status: f.status, createdAt: f.created_at
  })));
});

router.put("/feedback/:id", requireRole("Super Admin", "Admin"), async (req, res) => {
  const status = clean(req.body.status);
  if (!FEEDBACK_STATUSES.includes(status)) fail("Choose a status.");
  const result = await db.query("UPDATE feedback SET status = ? WHERE feedback_id = ?", [status, Number(req.params.id) || 0]);
  if (!result.affectedRows) fail("Feedback not found.", 404);
  res.json({ message: "Feedback marked " + status + "." });
});

router.get("/feedback/:id/screenshot", requireRole("Super Admin", "Admin"), async (req, res) => {
  const row = await db.one("SELECT screenshot_name, screenshot_mime FROM feedback WHERE feedback_id = ?", [Number(req.params.id) || 0]);
  if (!row || !row.screenshot_name) fail("No screenshot.", 404);
  sendUpload(res, "feedback", row.screenshot_name, row.screenshot_mime, "feedback-" + req.params.id + "." + row.screenshot_name.split(".").pop());
});

// ---- Backup and sample data ----

router.post("/backup", requireRole("Super Admin"), async (req, res) => {
  const file = await backupNow("manual by " + req.user.emp_id);
  res.json({ message: "Backup saved: " + file });
});

router.post("/dev/reset", requireRole("Super Admin"), async (req, res) => {
  if (!config.isDevelopment) fail("Reset is switched off on the production copy.", 403);
  if (clean(req.body.confirm).toUpperCase() !== "RESET") fail("Type RESET to restore the sample data.");
  const file = await backupNow("before reset by " + req.user.emp_id);
  await loadSample(true);
  res.json({ message: "Sample data restored. A backup was saved first: " + file });
});

module.exports = { router };
