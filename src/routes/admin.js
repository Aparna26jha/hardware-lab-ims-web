"use strict";

const express = require("express");
const db = require("../db");
const config = require("../config");
const { requireUser, requireRole } = require("../auth");
const { backupNow, latestBackup } = require("../backup");
const { saveUpload, sendUpload } = require("../files");
const { loadSample } = require("../sample");
const { choiceLists, addChoice } = require("../choices");
const {
  ROLES, OWNERS, STATUSES, FEEDBACK_KINDS, FEEDBACK_STATUSES, FEEDBACK_TITLE_MIN, FEEDBACK_DESCRIPTION_MIN,
  OTHER_MIN, PASSWORD_MIN, fail, clean, isCustodian, checkFeedback
} = require("../rules");
const { scopedAssets, recentActivity } = require("./assets");
const { openRequests } = require("./requests");
const { waitingFor, allWaiting } = require("./handovers");
const { personText } = require("./people");

const router = express.Router();
const custodian = requireRole("Super Admin", "Admin");

router.get("/settings", async (req, res) => {
  const lists = await choiceLists();
  res.json({
    version: config.version,
    environment: config.appEnv,
    showSampleAccounts: config.isDevelopment,
    expiryWarnMonths: config.expiryWarnMonths,
    feedbackTitleMin: FEEDBACK_TITLE_MIN,
    feedbackDescriptionMin: FEEDBACK_DESCRIPTION_MIN,
    otherMin: OTHER_MIN,
    passwordMin: PASSWORD_MIN,
    roles: ROLES, owners: OWNERS, statuses: STATUSES, assetTypes: lists.assetTypes, rooms: lists.rooms,
    feedbackKinds: FEEDBACK_KINDS, feedbackStatuses: FEEDBACK_STATUSES
  });
});

// Adds a new asset type or storage room from the "+ Add new" choice in a dropdown.
router.post("/choices", custodian, async (req, res) => {
  const value = await addChoice(clean(req.body.list), req.body.value, req.user.emp_id);
  res.json({ message: "Added " + value + ".", value, ...(await choiceLists()) });
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
    `SELECT t.team_id, t.team_name, l.emp_name AS lead_name, l.email AS lead_email,
            COUNT(a.barcode) AS held,
            COALESCE(SUM(a.ownership = 'AMD-Specific'), 0) AS amd,
            COALESCE(SUM(a.ownership = 'Wipro-Specific'), 0) AS wipro,
            COALESCE(SUM(a.status = 'Under Maintenance'), 0) AS maintenance
       FROM teams t
       LEFT JOIN users l ON l.emp_id = t.lead_emp_id
       LEFT JOIN users m ON m.team_id = t.team_id
       LEFT JOIN assets a ON a.holder_emp_id = m.emp_id AND a.deleted_at IS NULL
      GROUP BY t.team_id, t.team_name, l.emp_name, l.email
      ORDER BY t.team_name`);
  const rows = teams.map((t) => ({
    teamId: t.team_id, team: t.team_name, lead: personText(t.lead_name, t.lead_email) || "Not set",
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
  if (isCustodian(user)) {
    const consignments = await db.query(
      `SELECT c.consignment_id, c.invoice_no, c.po_number, c.expected_items,
              (SELECT COUNT(*) FROM assets a WHERE a.consignment_id = c.consignment_id) AS scanned,
              (SELECT COUNT(*) FROM consignment_documents d WHERE d.consignment_id = c.consignment_id) AS docs
         FROM consignments c ORDER BY c.received_date`);
    consignments.filter((c) => !Number(c.docs)).forEach((c) => attention.push({
      tag: "No document", kind: "bad", go: "inward", id: c.consignment_id,
      text: "Invoice " + c.invoice_no + " / " + c.po_number + ": no document uploaded yet (" + c.scanned + " of "
        + c.expected_items + " items scanned)"
    }));
    consignments.filter((c) => Number(c.docs) && Number(c.scanned) < c.expected_items).forEach((c) => attention.push({
      tag: "Inward", kind: "warn", go: "inward", id: c.consignment_id,
      text: "Invoice " + c.invoice_no + ": " + c.scanned + " of " + c.expected_items + " items scanned"
    }));
  }
  if (user.role === "Super Admin") {
    const pending = await db.query("SELECT emp_name, email FROM users WHERE approval = 'Pending' ORDER BY created_at");
    pending.forEach((p) => attention.push({ tag: "Waiting", kind: "warn", text: personText(p.emp_name, p.email) + " asked for access", go: "accounts" }));
  }
  const requests = await openRequests();
  requests.filter((r) => isCustodian(user) || r.empId === user.emp_id).forEach((r) => attention.push({
    tag: "Request", kind: "warn", go: "requests",
    text: (isCustodian(user) ? r.empName + ": " : "Your request: ")
      + (r.kind === "Return" ? "return " + r.barcode : "needs " + (r.assetType || "hardware") + " - " + r.details)
      + (isCustodian(user) ? "" : " (waiting for an Admin)")
  }));
  if (isCustodian(user)) {
    (await allWaiting()).forEach((h) => attention.push({
      tag: "Accept?", kind: "warn", barcode: h.barcode,
      text: "Waiting for " + h.toName + " to accept " + h.barcode + " (" + h.item + ")"
    }));
    const fresh = await db.one("SELECT COUNT(*) AS n FROM feedback WHERE status = 'New'");
    if (Number(fresh.n)) attention.push({ tag: "Feedback", kind: "warn", go: "feedback", text: fresh.n + " new feedback item(s)" });
  }
  assets.filter((a) => a.expiry).sort((a, b) => a.expiryDate.localeCompare(b.expiryDate)).forEach((a) => attention.push({
    tag: a.expiry === "expired" ? "Expired" : "Expiring", kind: a.expiry === "expired" ? "bad" : "warn", barcode: a.barcode,
    text: a.barcode + " " + (a.expiry === "expired" ? "expired " : "expires ") + a.expiryDate + " · " + (a.model || a.assetType)
      + " · " + (a.holderId ? "held by " + a.holderName : "in the cage")
  }));
  res.json({
    counts: countAssets(assets),
    attention,
    handovers: await waitingFor(user.emp_id),
    activity: isCustodian(user) ? await recentActivity(12) : null,
    teams: isCustodian(user) ? await teamSummary() : null,
    lastBackup: user.role === "Super Admin" ? (latestBackup() || {}).time || null : null
  });
});

// What changed since the last check, for the pop-up notifications. `since` is the server time
// returned by the previous call; the browser skips items it has already shown.
router.get("/updates", requireUser, async (req, res) => {
  const now = (await db.one("SELECT NOW() AS now")).now;
  const since = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(String(req.query.since || "")) ? req.query.since : null;
  if (!since) return res.json({ now, items: [] });
  const me = req.user;
  const items = [];
  const add = (key, kind, title, text, go, extra) => items.push({ key, kind, title, text, go: go || "", ...extra });
  for (const h of await db.query(
    `SELECT h.handover_id, h.barcode, h.request_id, g.emp_name AS given_name, a.asset_type, a.model FROM handovers h
       JOIN assets a ON a.barcode = h.barcode LEFT JOIN users g ON g.emp_id = h.given_by
      WHERE h.state = 'Waiting' AND h.to_emp_id = ? AND h.created_at >= ?`, [me.emp_id, since])) {
    add("ho-new-" + h.handover_id, "info", h.request_id ? "Your request was approved" : "Item waiting for you",
      (h.given_name || "An Admin") + " is giving you " + h.barcode + " (" + [h.asset_type, h.model].filter(Boolean).join(" · ")
        + "). Accept it when you have it in hand.", "dashboard", { handoverId: h.handover_id, barcode: h.barcode });
  }
  for (const h of await db.query(
    `SELECT h.handover_id, h.barcode, h.state, h.decision_note, r.emp_name AS to_name FROM handovers h
       LEFT JOIN users r ON r.emp_id = h.to_emp_id
      WHERE h.given_by = ? AND h.state IN ('Accepted', 'Declined') AND h.decided_at >= ?`, [me.emp_id, since])) {
    add("ho-done-" + h.handover_id, h.state === "Accepted" ? "good" : "bad", "Handover " + h.state.toLowerCase(),
      h.to_name + " " + h.state.toLowerCase() + " " + h.barcode + (h.decision_note ? ": " + h.decision_note : "") + ".");
  }
  const custodian = isCustodian(me);
  const logs = await db.query(
    `SELECT l.log_id, l.barcode, l.action, l.to_holder, l.from_holder, l.to_status, b.emp_name AS by_name, n.emp_name AS to_name
       FROM audit_log l LEFT JOIN users b ON b.emp_id = l.done_by LEFT JOIN users n ON n.emp_id = l.to_holder
      WHERE l.logged_at >= ? AND l.done_by <> ?` + (custodian ? "" : " AND (l.to_holder = ? OR l.from_holder = ?)")
      + " ORDER BY l.log_id LIMIT 30",
    custodian ? [since, me.emp_id] : [since, me.emp_id, me.emp_id, me.emp_id]);
  const done = { Inward: "added to the lab", Edit: "edited", Delete: "deleted", Restore: "restored" };
  for (const l of logs) {
    const what = l.action === "Transfer" ? (l.to_name ? "now with " + l.to_name : "now " + l.to_status) : done[l.action];
    add("log-" + l.log_id, "info", l.action === "Inward" ? "New item" : "Item updated",
      l.barcode + " " + what + " by " + (l.by_name || "someone") + ".");
  }
  if (custodian) {
    for (const r of await db.query(
      `SELECT r.request_id, r.kind, u.emp_name FROM hardware_requests r LEFT JOIN users u ON u.emp_id = r.emp_id
        WHERE r.created_at >= ? AND r.emp_id <> ?`, [since, me.emp_id])) {
      add("rq-" + r.request_id, "info", "New request", r.emp_name + (r.kind === "Return" ? " wants to return an item." : " needs hardware."), "requests");
    }
    for (const f of await db.query("SELECT feedback_id, title, emp_name FROM feedback WHERE created_at >= ? AND emp_id <> ?", [since, me.emp_id])) {
      add("fb-" + f.feedback_id, "info", "New feedback", f.emp_name + ": " + f.title, "feedback");
    }
  }
  for (const r of await db.query(
    `SELECT request_id, status FROM hardware_requests WHERE emp_id = ? AND decided_at >= ? AND decided_by <> ?
        AND NOT (kind = 'Need' AND status = 'Approved')`,
    [me.emp_id, since, me.emp_id])) {
    add("rq-done-" + r.request_id + "-" + r.status, r.status === "Rejected" ? "bad" : "good", "Your request",
      "Request #" + r.request_id + " was " + r.status.toLowerCase() + ".", "requests");
  }
  if (me.role === "Super Admin") {
    for (const u of await db.query("SELECT emp_id, emp_name FROM users WHERE approval = 'Pending' AND created_at >= ?", [since])) {
      add("user-" + u.emp_id, "info", "Access request", u.emp_name + " asked for access.", "accounts");
    }
  }
  res.json({ now, items });
});

// ---- Feedback ----

router.post("/feedback", requireUser, async (req, res) => {
  const entry = {
    kind: clean(req.body.kind),
    otherText: clean(req.body.otherText, 80),
    title: clean(req.body.title, 150),
    description: clean(req.body.description, 4000)
  };
  checkFeedback(entry);
  const shot = req.body.screenshot ? saveUpload(req.body.screenshot, "feedback", ["png", "jpg"], 5) : null;
  await db.query(
    `INSERT INTO feedback (kind, other_text, title, description, screen, screenshot_name, screenshot_mime, emp_id, emp_name, email, role)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [entry.kind, entry.kind === "Other" ? entry.otherText : null, entry.title, entry.description,
      clean(req.body.screen, 40) || null, shot ? shot.storedName : null, shot ? shot.mime : null,
      req.user.emp_id, req.user.emp_name, req.user.email, req.user.role]
  );
  res.json({ message: "Thank you. Your feedback was sent." });
});

router.get("/feedback", custodian, async (req, res) => {
  const rows = await db.query("SELECT * FROM feedback ORDER BY (status = 'Done'), created_at DESC");
  res.json(rows.map((f) => ({
    id: f.feedback_id, kind: f.kind === "Other" && f.other_text ? "Other: " + f.other_text : f.kind, title: f.title,
    description: f.description, screen: f.screen || "", hasScreenshot: !!f.screenshot_name, person: f.emp_name,
    email: f.email, role: f.role, status: f.status, createdAt: f.created_at
  })));
});

router.put("/feedback/:id", custodian, async (req, res) => {
  const status = clean(req.body.status);
  if (!FEEDBACK_STATUSES.includes(status)) fail("Choose a status.");
  const result = await db.query("UPDATE feedback SET status = ? WHERE feedback_id = ?", [status, Number(req.params.id) || 0]);
  if (!result.affectedRows) fail("Feedback not found.", 404);
  res.json({ message: "Feedback marked " + status + "." });
});

router.get("/feedback/:id/screenshot", custodian, async (req, res) => {
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
