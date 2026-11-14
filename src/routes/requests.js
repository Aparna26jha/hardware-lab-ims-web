"use strict";

const express = require("express");
const db = require("../db");
const { requireUser, requireRole } = require("../auth");
const { ASSET_TYPES, fail, clean, normalizeBarcode, isCustodian } = require("../rules");
const { findAsset, activeUser, writeLog } = require("./assets");

const router = express.Router();
const custodian = requireRole("Super Admin", "Admin");
const KIND_TEXT = { Need: "Needs hardware", Return: "Return" };
const NEED_DETAILS_MIN = 10;
const NOTE_MIN = 5;

const REQUEST_SELECT = `
  SELECT r.*, u.emp_name, t.team_name, d.emp_name AS decided_name, a.model, a.asset_type AS item_type
    FROM hardware_requests r
    LEFT JOIN users u ON u.emp_id = r.emp_id
    LEFT JOIN teams t ON t.team_id = u.team_id
    LEFT JOIN users d ON d.emp_id = r.decided_by
    LEFT JOIN assets a ON a.barcode = r.barcode`;

function mapRequest(row) {
  return {
    id: row.request_id,
    kind: row.kind,
    kindText: KIND_TEXT[row.kind],
    empId: row.emp_id,
    empName: row.emp_name || "",
    teamName: row.team_name || "",
    assetType: row.asset_type || "",
    barcode: row.barcode || "",
    item: row.barcode ? [row.item_type, row.model].filter(Boolean).join(" · ") : "",
    details: row.details || "",
    status: row.status,
    decidedBy: row.decided_by ? row.decided_by + " " + (row.decided_name || "") : "",
    decidedAt: row.decided_at || "",
    note: row.decision_note || "",
    createdAt: row.created_at
  };
}

async function openRequests() {
  const rows = await db.query(REQUEST_SELECT + " WHERE r.status = 'Open' ORDER BY r.created_at");
  return rows.map(mapRequest);
}

router.get("/requests", requireUser, async (req, res) => {
  const rows = isCustodian(req.user)
    ? await db.query(REQUEST_SELECT + " ORDER BY (r.status = 'Open') DESC, r.created_at DESC LIMIT 300")
    : await db.query(REQUEST_SELECT + " WHERE r.emp_id = ? ORDER BY (r.status = 'Open') DESC, r.created_at DESC LIMIT 100",
      [req.user.emp_id]);
  res.json(rows.map(mapRequest));
});

router.post("/requests", requireUser, async (req, res) => {
  const kind = clean(req.body.kind);
  const details = clean(req.body.details, 500);
  if (kind === "Return") {
    const barcode = normalizeBarcode(req.body.barcode);
    const asset = await findAsset(barcode);
    if (!asset || asset.deletedAt || asset.holderId !== req.user.emp_id) fail("Choose an item that is assigned to you.");
    const waiting = await db.one("SELECT request_id FROM hardware_requests WHERE barcode = ? AND status = 'Open'", [barcode]);
    if (waiting) fail("There is already an open request for " + barcode + ".");
    await db.query("INSERT INTO hardware_requests (kind, emp_id, barcode, details) VALUES ('Return', ?, ?, ?)",
      [req.user.emp_id, barcode, details]);
    return res.json({ message: "Return request sent for " + barcode + ". An Admin will collect it and confirm." });
  }
  if (kind === "Need") {
    const assetType = clean(req.body.assetType);
    if (assetType && !ASSET_TYPES.includes(assetType)) fail("Choose an asset type.");
    if (details.length < NEED_DETAILS_MIN) {
      fail("Describe what you need and why (at least " + NEED_DETAILS_MIN + " characters).");
    }
    await db.query("INSERT INTO hardware_requests (kind, emp_id, asset_type, details) VALUES ('Need', ?, ?, ?)",
      [req.user.emp_id, assetType || null, details]);
    return res.json({ message: "Request sent. An Admin will pick an item and assign it to you." });
  }
  fail("Choose the type of request.");
});

router.post("/requests/:id/cancel", requireUser, async (req, res) => {
  const result = await db.query(
    "UPDATE hardware_requests SET status = 'Cancelled', decided_by = ?, decided_at = NOW() WHERE request_id = ? AND emp_id = ? AND status = 'Open'",
    [req.user.emp_id, Number(req.params.id) || 0, req.user.emp_id]
  );
  if (!result.affectedRows) fail("Only your own open requests can be cancelled.");
  res.json({ message: "Request cancelled." });
});

async function lockOpenRequest(conn, id) {
  const request = await conn.one("SELECT * FROM hardware_requests WHERE request_id = ? FOR UPDATE", [Number(id) || 0]);
  if (!request) fail("Request not found.", 404);
  if (request.status !== "Open") fail("This request is already " + request.status.toLowerCase() + ".");
  return request;
}

// Approving does the transfer, so the request and the move are saved together.
router.post("/requests/:id/approve", custodian, async (req, res) => {
  const note = clean(req.body.note, 300);
  const message = await db.transaction(async (conn) => {
    const request = await lockOpenRequest(conn, req.params.id);
    const remarks = "Approved request #" + request.request_id + (note ? ": " + note : "");
    let barcode = request.barcode;
    if (request.kind === "Return") {
      const asset = await findAsset(barcode, conn, true);
      if (!asset || asset.deletedAt || asset.holderId !== request.emp_id) {
        fail(barcode + " is no longer with " + request.emp_id + ". Reject this request instead.");
      }
      await conn.query("UPDATE assets SET status = 'Available in Lab', holder_emp_id = NULL, revision = revision + 1 WHERE barcode = ?",
        [barcode]);
      await writeLog(conn, {
        barcode, action: "Transfer", fromHolder: asset.holderId, toHolder: "", fromStatus: asset.status,
        toStatus: "Available in Lab", by: req.user.emp_id, remarks
      });
    } else {
      barcode = normalizeBarcode(req.body.barcode);
      if (!barcode) fail("Scan or type the barcode of the item you are giving.");
      const asset = await findAsset(barcode, conn, true);
      if (!asset || asset.deletedAt) fail(barcode + " is not in the lab list.");
      if (asset.holderId || asset.status !== "Available in Lab") fail(barcode + " is not free in the cage (" + asset.status + ").");
      if (!(await activeUser(request.emp_id, conn))) fail(request.emp_id + " is no longer an active user.");
      await conn.query("UPDATE assets SET status = 'Assigned to Engineer', holder_emp_id = ?, revision = revision + 1 WHERE barcode = ?",
        [request.emp_id, barcode]);
      await writeLog(conn, {
        barcode, action: "Transfer", fromHolder: "", toHolder: request.emp_id, fromStatus: asset.status,
        toStatus: "Assigned to Engineer", by: req.user.emp_id, remarks
      });
    }
    await conn.query(
      "UPDATE hardware_requests SET status = 'Approved', barcode = ?, decided_by = ?, decided_at = NOW(), decision_note = ? WHERE request_id = ?",
      [barcode, req.user.emp_id, note || null, request.request_id]
    );
    return request.kind === "Return"
      ? "Approved. " + barcode + " is back in the cage."
      : "Approved. " + barcode + " is now assigned to " + request.emp_id + ".";
  });
  res.json({ message });
});

router.post("/requests/:id/reject", custodian, async (req, res) => {
  const note = clean(req.body.note, 300);
  if (note.length < NOTE_MIN) fail("Enter the reason for rejecting (at least " + NOTE_MIN + " characters).");
  await db.transaction(async (conn) => {
    const request = await lockOpenRequest(conn, req.params.id);
    await conn.query(
      "UPDATE hardware_requests SET status = 'Rejected', decided_by = ?, decided_at = NOW(), decision_note = ? WHERE request_id = ?",
      [req.user.emp_id, note, request.request_id]
    );
  });
  res.json({ message: "Request rejected." });
});

module.exports = { router, openRequests };
