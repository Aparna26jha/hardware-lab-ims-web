"use strict";

const express = require("express");
const db = require("../db");
const { requireUser, requireRole } = require("../auth");
const { fail, clean } = require("../rules");
const { findAsset, writeLog } = require("./assets");

const router = express.Router();

const HANDOVER_SELECT = `
  SELECT h.*, a.asset_type, a.model, a.description, a.ownership,
         g.emp_name AS given_name, g.email AS given_email, r.emp_name AS to_name, r.email AS to_email,
         f.emp_name AS from_name
    FROM handovers h
    JOIN assets a ON a.barcode = h.barcode
    LEFT JOIN users g ON g.emp_id = h.given_by
    LEFT JOIN users r ON r.emp_id = h.to_emp_id
    LEFT JOIN users f ON f.emp_id = h.from_emp_id`;

function mapHandover(row) {
  return {
    id: row.handover_id,
    barcode: row.barcode,
    item: [row.asset_type, row.model].filter(Boolean).join(" · "),
    description: row.description || "",
    ownership: row.ownership,
    fromName: row.from_name || "the cage",
    toId: row.to_emp_id,
    toName: row.to_name || row.to_emp_id,
    toEmail: row.to_email || "",
    toStatus: row.to_status,
    givenBy: row.given_name || row.given_by,
    givenByEmail: row.given_email || "",
    remarks: row.remarks || "",
    state: row.state,
    createdAt: row.created_at
  };
}

async function waitingFor(empId) {
  return (await db.query(HANDOVER_SELECT + " WHERE h.state = 'Waiting' AND h.to_emp_id = ? ORDER BY h.created_at", [empId]))
    .map(mapHandover);
}

async function allWaiting() {
  return (await db.query(HANDOVER_SELECT + " WHERE h.state = 'Waiting' ORDER BY h.created_at")).map(mapHandover);
}

// A request for several items stays approved while any of its other items is still offered or accepted.
async function reopenRequest(conn, handover, note) {
  if (!handover.request_id) return;
  const others = await conn.one(
    "SELECT COUNT(*) AS n FROM handovers WHERE request_id = ? AND handover_id <> ? AND state IN ('Waiting', 'Accepted')",
    [handover.request_id, handover.handover_id]);
  if (others.n) {
    await conn.query("UPDATE hardware_requests SET decision_note = CONCAT_WS('. ', decision_note, ?) WHERE request_id = ?",
      [note, handover.request_id]);
    return;
  }
  await conn.query(
    `UPDATE hardware_requests SET status = 'Open', decided_by = NULL, decided_at = NULL, decision_note = ?
      WHERE request_id = ? AND status = 'Approved'`, [note, handover.request_id]);
}

async function lockWaiting(conn, id) {
  const handover = await conn.one("SELECT * FROM handovers WHERE handover_id = ? FOR UPDATE", [Number(id) || 0]);
  if (!handover) fail("This handover was not found.", 404);
  if (handover.state !== "Waiting") fail("This handover is already " + handover.state.toLowerCase() + ".");
  return handover;
}

router.get("/handovers/mine", requireUser, async (req, res) => {
  res.json(await waitingFor(req.user.emp_id));
});

router.post("/handovers/:id/accept", requireUser, async (req, res) => {
  const message = await db.transaction(async (conn) => {
    const handover = await lockWaiting(conn, req.params.id);
    if (handover.to_emp_id !== req.user.emp_id) fail("Only the person receiving the item can accept it.", 403);
    const asset = await findAsset(handover.barcode, conn, true);
    if (!asset || asset.deletedAt) fail(handover.barcode + " is no longer in the lab list.");
    if (asset.holderId !== (handover.from_emp_id || "") || asset.status !== handover.from_status) {
      fail(handover.barcode + " was changed after it was offered to you. Ask an Admin to offer it again.");
    }
    await conn.query("UPDATE assets SET status = ?, holder_emp_id = ?, revision = revision + 1 WHERE barcode = ?",
      [handover.to_status, handover.to_emp_id, handover.barcode]);
    await writeLog(conn, {
      barcode: handover.barcode, action: "Transfer", fromHolder: asset.holderId, toHolder: handover.to_emp_id,
      fromStatus: asset.status, toStatus: handover.to_status, by: handover.given_by,
      remarks: [handover.remarks, "Accepted by " + req.user.emp_name].filter(Boolean).join(". ")
    });
    await conn.query("UPDATE handovers SET state = 'Accepted', decided_by = ?, decided_at = NOW() WHERE handover_id = ?",
      [req.user.emp_id, handover.handover_id]);
    return "You accepted " + handover.barcode + ". It is now in your list.";
  });
  res.json({ message });
});

router.post("/handovers/:id/decline", requireUser, async (req, res) => {
  const note = clean(req.body.note, 300);
  if (note.length < 5) fail("Say why you are rejecting it (at least 5 characters).");
  const message = await db.transaction(async (conn) => {
    const handover = await lockWaiting(conn, req.params.id);
    if (handover.to_emp_id !== req.user.emp_id) fail("Only the person receiving the item can decline it.", 403);
    await conn.query(
      "UPDATE handovers SET state = 'Declined', decided_by = ?, decided_at = NOW(), decision_note = ? WHERE handover_id = ?",
      [req.user.emp_id, note, handover.handover_id]);
    await reopenRequest(conn, handover, "Declined " + handover.barcode + ": " + note);
    return "You rejected " + handover.barcode + ". It stays where it was, and the Admin will see your reason.";
  });
  res.json({ message });
});

router.post("/handovers/:id/cancel", requireRole("Super Admin", "Admin"), async (req, res) => {
  const message = await db.transaction(async (conn) => {
    const handover = await lockWaiting(conn, req.params.id);
    await conn.query(
      "UPDATE handovers SET state = 'Cancelled', decided_by = ?, decided_at = NOW(), decision_note = 'Cancelled by Admin' WHERE handover_id = ?",
      [req.user.emp_id, handover.handover_id]);
    await reopenRequest(conn, handover, "Offer of " + handover.barcode + " cancelled by an Admin");
    return "Cancelled. " + handover.barcode + " stays where it was.";
  });
  res.json({ message });
});

module.exports = { router, waitingFor, allWaiting };
