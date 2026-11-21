"use strict";

const express = require("express");
const db = require("../db");
const { requireUser, requireRole } = require("../auth");
const { choiceLists } = require("../choices");
const { fail, clean, normalizeBarcode, checkOther, isCustodian } = require("../rules");
const { findAsset, activeUser, writeLog, startHandover } = require("./assets");

const router = express.Router();
const custodian = requireRole("Super Admin", "Admin");
const KIND_TEXT = { Need: "Needs hardware", Return: "Return" };
const NEED_DETAILS_MIN = 10;
const NOTE_MIN = 5;
const QUANTITY_MAX = 20;

const REQUEST_SELECT = `
  SELECT r.*, u.emp_name, u.email, t.team_name, d.emp_name AS decided_name, a.model, a.asset_type AS item_type,
         (SELECT GROUP_CONCAT(CONCAT(h.barcode, ' (', h.state, ')') ORDER BY h.handover_id SEPARATOR ', ')
            FROM handovers h WHERE h.request_id = r.request_id AND h.state IN ('Waiting', 'Accepted')) AS given
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
    email: row.email || "",
    teamName: row.team_name || "",
    assetType: row.asset_type === "Other" && row.other_text ? "Other: " + row.other_text : row.asset_type || "",
    type: row.asset_type || "",
    quantity: row.quantity || 1,
    given: row.given || "",
    barcode: row.barcode || "",
    item: row.barcode ? [row.item_type, row.model].filter(Boolean).join(" · ") : "",
    details: row.details || "",
    status: row.status,
    decidedBy: row.decided_by ? row.decided_name || row.decided_by : "",
    decidedAt: row.decided_at || "",
    note: row.decision_note || "",
    createdAt: row.created_at
  };
}

async function openRequests() {
  const rows = await db.query(REQUEST_SELECT + " WHERE r.status = 'Open' ORDER BY r.created_at");
  return rows.map(mapRequest);
}

function freeInCage(asset) {
  return asset && !asset.deletedAt && !asset.holderId && asset.status === "Available in Lab" && !asset.pending;
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
    let assetType = clean(req.body.assetType, 40);
    const otherText = clean(req.body.otherText, 80);
    const barcode = normalizeBarcode(req.body.barcode);
    let quantity = Number(req.body.quantity ?? 1);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > QUANTITY_MAX) {
      fail("How many items? Enter a number from 1 to " + QUANTITY_MAX + ".");
    }
    if (barcode) {
      const asset = await findAsset(barcode);
      if (!freeInCage(asset)) fail(barcode + " is not free in the cage any more. Choose another item.");
      assetType = asset.assetType;
      quantity = 1;
    }
    const { assetTypes } = await choiceLists();
    if (assetType && !assetTypes.includes(assetType)) fail("Choose an asset type.");
    checkOther(assetType, otherText, "you need");
    if (details.length < NEED_DETAILS_MIN) {
      fail("Describe what you need and why (at least " + NEED_DETAILS_MIN + " characters).");
    }
    await db.query(
      "INSERT INTO hardware_requests (kind, emp_id, asset_type, other_text, quantity, barcode, details) VALUES ('Need', ?, ?, ?, ?, ?, ?)",
      [req.user.emp_id, assetType || null, assetType === "Other" ? otherText : null, quantity, barcode || null, details]);
    return res.json({ message: "Request sent. An Admin will pick an item and offer it to you." });
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

// Approving a return moves the item back to the cage. Approving a need offers an item to the
// engineer, who then accepts it.
router.post("/requests/:id/approve", custodian, async (req, res) => {
  const note = clean(req.body.note, 300);
  const message = await db.transaction(async (conn) => {
    const request = await lockOpenRequest(conn, req.params.id);
    const remarks = "Approved request #" + request.request_id + (note ? ": " + note : "");
    let barcode = request.barcode;
    let message;
    if (request.kind === "Return") {
      const asset = await findAsset(barcode, conn, true);
      if (!asset || asset.deletedAt || asset.holderId !== request.emp_id) {
        fail(barcode + " is no longer with the person who asked. Reject this request instead.");
      }
      await conn.query("UPDATE assets SET status = 'Available in Lab', holder_emp_id = NULL, revision = revision + 1 WHERE barcode = ?",
        [barcode]);
      await writeLog(conn, {
        barcode, action: "Transfer", fromHolder: asset.holderId, toHolder: "", fromStatus: asset.status,
        toStatus: "Available in Lab", by: req.user.emp_id, remarks
      });
      message = "Approved. " + barcode + " is back in the cage.";
    } else {
      const picked = [...(Array.isArray(req.body.barcodes) ? req.body.barcodes : []), req.body.barcode]
        .map(normalizeBarcode).filter(Boolean);
      const barcodes = [...new Set(picked.length ? picked : [barcode].filter(Boolean))];
      if (!barcodes.length) fail("Choose, scan or type the barcode of the item you are giving.");
      const wanted = request.quantity || 1;
      if (barcodes.length > wanted) fail("This request is for " + wanted + " item(s). You chose " + barcodes.length + ".");
      const receiver = await activeUser(request.emp_id, conn);
      if (!receiver) fail("The person who asked is no longer an active user.");
      for (const code of barcodes) {
        const asset = await findAsset(code, conn, true);
        if (!asset || asset.deletedAt) fail(code + " is not in the lab list.");
        if (!freeInCage(asset)) fail(code + " is not free in the cage (" + asset.status + ").");
        await startHandover(conn, {
          asset, to: receiver, toStatus: "Assigned to Engineer", by: req.user.emp_id, remarks, requestId: request.request_id
        });
      }
      barcode = barcodes[0];
      message = "Approved. Waiting for " + receiver.emp_name + " (" + receiver.email + ") to accept " + barcodes.join(", ")
        + (barcodes.length < wanted ? " (" + barcodes.length + " of " + wanted + " asked for)" : "") + ".";
    }
    await conn.query(
      "UPDATE hardware_requests SET status = 'Approved', barcode = ?, decided_by = ?, decided_at = NOW(), decision_note = ? WHERE request_id = ?",
      [barcode, req.user.emp_id, note || null, request.request_id]
    );
    return message;
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
