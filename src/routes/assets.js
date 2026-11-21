"use strict";

const express = require("express");
const db = require("../db");
const config = require("../config");
const { requireUser, requireRole } = require("../auth");
const { choiceLists } = require("../choices");
const {
  OWNERS, STATUSES, fail, clean, normalizeBarcode, validBarcode, cleanEmail, isIsoDate, nextBarcode,
  isoDay, expiryState, typeFromPrefix, familyPrefix, statusMoveAllowed, isCustodian, csvText
} = require("../rules");

const router = express.Router();
const custodian = requireRole("Super Admin", "Admin");

const ASSET_SELECT = `
  SELECT a.*, h.emp_name AS holder_name, h.email AS holder_email, t.team_id, t.team_name, c.invoice_no,
         ho.handover_id, ho.to_emp_id AS pending_id, pu.emp_name AS pending_name, pu.email AS pending_email
    FROM assets a
    LEFT JOIN users h ON h.emp_id = a.holder_emp_id
    LEFT JOIN teams t ON t.team_id = h.team_id
    LEFT JOIN consignments c ON c.consignment_id = a.consignment_id
    LEFT JOIN handovers ho ON ho.barcode = a.barcode AND ho.state = 'Waiting'
    LEFT JOIN users pu ON pu.emp_id = ho.to_emp_id`;

// Which assets a person may see. Leads see their team's hardware and what is free in the cage.
function scopeSql(user) {
  if (isCustodian(user)) return { sql: "1 = 1", params: [] };
  if (user.role === "Lead Admin") {
    return {
      sql: "(a.holder_emp_id = ? OR t.lead_emp_id = ? OR (a.holder_emp_id IS NULL AND a.status = 'Available in Lab'))",
      params: [user.emp_id, user.emp_id]
    };
  }
  return { sql: "a.holder_emp_id = ?", params: [user.emp_id] };
}

// Where the item is now: with its user in the lab, or in its storage room.
function placeOf(row) {
  if (row.holder_emp_id) return "Lab (with " + (row.holder_name || row.holder_emp_id) + ")";
  return [row.storage_room, row.location].filter(Boolean).join(", ");
}

function mapAsset(row) {
  const today = isoDay(new Date());
  return {
    barcode: row.barcode,
    ownership: row.ownership,
    assetType: row.asset_type,
    manufacturer: row.manufacturer || "",
    serialNo: row.mfs_serial_no || "",
    make: row.make || "",
    model: row.model || "",
    capacityRev: row.capacity_rev || "",
    description: row.description || "",
    poNumber: row.po_number || "",
    arrivalDate: row.arrival_date || "",
    expiryDate: row.expiry_date || "",
    expiry: row.status === "Scrapped/Returned" ? "" : expiryState(row.expiry_date, today, config.expiryWarnMonths),
    bondNo: row.bond_no || "",
    room: row.storage_room || "",
    location: row.location || "",
    place: placeOf(row),
    status: row.status,
    holderId: row.holder_emp_id || "",
    holderName: row.holder_name || "",
    holderEmail: row.holder_email || "",
    pending: row.handover_id
      ? { id: row.handover_id, empId: row.pending_id, name: row.pending_name || "", email: row.pending_email || "" }
      : null,
    teamId: row.team_id || null,
    teamName: row.holder_emp_id ? (row.team_name || "No team") : "In cage",
    consignmentId: row.consignment_id || null,
    invoiceNo: row.invoice_no || "",
    revision: row.revision,
    createdBy: row.created_by,
    createdAt: row.created_at,
    deletedAt: row.deleted_at || "",
    deletedBy: row.deleted_by || "",
    deleteReason: row.delete_reason || ""
  };
}

async function scopedAssets(user, filters = {}) {
  const scope = scopeSql(user);
  const where = ["a.deleted_at IS NULL", scope.sql];
  const params = [...scope.params];
  if (OWNERS.includes(filters.owner)) { where.push("a.ownership = ?"); params.push(filters.owner); }
  if (STATUSES.includes(filters.status)) { where.push("a.status = ?"); params.push(filters.status); }
  const type = clean(filters.type, 40);
  if (type) { where.push("a.asset_type = ?"); params.push(type); }
  if (filters.team === "cage") where.push("a.holder_emp_id IS NULL");
  else if (filters.team === "none") where.push("a.holder_emp_id IS NOT NULL AND h.team_id IS NULL");
  else if (/^\d+$/.test(String(filters.team || ""))) { where.push("h.team_id = ?"); params.push(Number(filters.team)); }
  const search = clean(filters.search, 80);
  if (search) {
    where.push(`CONCAT_WS(' ', a.barcode, a.model, a.make, a.manufacturer, a.mfs_serial_no, a.description,
      a.po_number, a.bond_no, a.storage_room, a.location, h.email, h.emp_name, t.team_name, c.invoice_no) LIKE ?`);
    params.push("%" + search.replace(/[\\%_]/g, "\\$&") + "%");
  }
  const rows = await db.query(ASSET_SELECT + " WHERE " + where.join(" AND ") + " ORDER BY a.barcode", params);
  return rows.map(mapAsset);
}

async function findAsset(barcode, conn = db, lock = false) {
  const row = await conn.one(ASSET_SELECT + " WHERE a.barcode = ?" + (lock ? " FOR UPDATE OF a" : ""), [barcode]);
  return row ? mapAsset(row) : null;
}

const ACTIVE_USER = "SELECT emp_id, emp_name, email FROM users WHERE active = 1 AND approval = 'Approved'";

async function activeUser(empId, conn = db) {
  return conn.one(ACTIVE_USER + " AND emp_id = ?", [empId]);
}

// The active person with this mail ID, or a clear message when there is none.
async function activeUserByEmail(value, conn = db) {
  const email = cleanEmail(value);
  const user = await conn.one(ACTIVE_USER + " AND email = ?", [email]);
  if (!user) fail(email + " is not an active user. Check the mail ID.");
  return user;
}

async function writeLog(conn, entry) {
  await conn.query(
    `INSERT INTO audit_log (barcode, action, from_holder, to_holder, from_status, to_status, done_by, remarks)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [entry.barcode, entry.action, entry.fromHolder || null, entry.toHolder || null, entry.fromStatus || null,
      entry.toStatus || null, entry.by, entry.remarks || null]
  );
}

// Offers an item to a person. Nothing moves until they accept it.
async function startHandover(conn, { asset, to, toStatus, by, remarks, requestId }) {
  if (asset.pending) fail("Waiting for " + asset.pending.name + " to accept " + asset.barcode + ". Cancel that first.");
  await conn.query(
    `INSERT INTO handovers (barcode, from_emp_id, from_status, to_emp_id, to_status, remarks, request_id, given_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [asset.barcode, asset.holderId || null, asset.status, to.emp_id, toStatus, remarks || null, requestId || null, by]
  );
  return "Waiting for " + to.emp_name + " (" + to.email + ") to accept " + asset.barcode + ". It moves to them when they accept.";
}

async function cancelWaitingHandovers(conn, barcode, by, note) {
  await conn.query(
    `UPDATE handovers SET state = 'Cancelled', decided_by = ?, decided_at = NOW(), decision_note = ?
      WHERE barcode = ? AND state = 'Waiting'`, [by, note, barcode]);
}

function person(name, email, id) {
  if (!id) return "Not assigned";
  return name ? name + (email ? " (" + email + ")" : "") : id;
}

async function logRows(sql, params) {
  const rows = await db.query(
    `SELECT l.*, f.emp_name AS from_name, f.email AS from_email, n.emp_name AS to_name, n.email AS to_email,
            b.emp_name AS by_name, b.email AS by_email
       FROM audit_log l
       LEFT JOIN users f ON f.emp_id = l.from_holder
       LEFT JOIN users n ON n.emp_id = l.to_holder
       LEFT JOIN users b ON b.emp_id = l.done_by ` + sql, params);
  return rows.map((row) => ({
    id: row.log_id,
    when: row.logged_at,
    barcode: row.barcode,
    action: row.action,
    from: person(row.from_name, row.from_email, row.from_holder),
    to: person(row.to_name, row.to_email, row.to_holder),
    fromStatus: row.from_status || "",
    toStatus: row.to_status || "",
    by: person(row.by_name, row.by_email, row.done_by),
    byName: row.by_name || row.done_by,
    remarks: row.remarks || ""
  }));
}

function recentActivity(limit) {
  return logRows("ORDER BY l.logged_at DESC, l.log_id DESC LIMIT " + Number(limit), []);
}

// Reads the editable description fields shared by inward and edit.
async function readDetails(body, conn = db) {
  const details = {
    assetType: clean(body.assetType, 40),
    manufacturer: clean(body.manufacturer, 80),
    serialNo: clean(body.serialNo, 80),
    make: clean(body.make, 80),
    model: clean(body.model, 80),
    capacityRev: clean(body.capacityRev, 80),
    description: clean(body.description, 500),
    expiryDate: clean(body.expiryDate),
    bondNo: clean(body.bondNo, 40),
    room: clean(body.room, 40),
    location: clean(body.location, 80)
  };
  const lists = await choiceLists(conn);
  if (!lists.assetTypes.includes(details.assetType)) fail("Choose an asset type.");
  if (!lists.rooms.includes(details.room)) fail("Choose the storage room (at least one option).");
  if (details.expiryDate && !isIsoDate(details.expiryDate)) fail("Expiry date must be a real date.");
  return details;
}

async function serialTaken(serialNo, barcode, conn = db) {
  if (!serialNo) return false;
  const row = await conn.one("SELECT barcode FROM assets WHERE mfs_serial_no = ? AND barcode <> ?", [serialNo, barcode]);
  return !!row;
}

// The next free number after `code` (EMBLAB30890 -> EMBLAB30891), skipping numbers already used.
async function nextFreeBarcode(code, conn = db) {
  let candidate = nextBarcode(code);
  for (let tries = 0; candidate && tries < 500; tries += 1) {
    if (!(await conn.one("SELECT barcode FROM assets WHERE barcode = ?", [candidate]))) return candidate;
    candidate = nextBarcode(candidate);
  }
  return "";
}

router.get("/assets", requireUser, async (req, res) => {
  res.json(await scopedAssets(req.user, req.query));
});

// Free items in the cage, so anyone can pick one when asking for hardware.
router.get("/assets/available", requireUser, async (req, res) => {
  const rows = await db.query(ASSET_SELECT + ` WHERE a.deleted_at IS NULL AND a.holder_emp_id IS NULL
    AND a.status = 'Available in Lab' AND ho.handover_id IS NULL ORDER BY a.asset_type, a.barcode`);
  res.json(rows.map(mapAsset).map((a) => ({
    barcode: a.barcode, ownership: a.ownership, assetType: a.assetType, model: a.model, make: a.make,
    description: a.description, place: a.place
  })));
});

router.get("/assets/suggest", custodian, async (req, res) => {
  const barcode = normalizeBarcode(req.query.barcode);
  if (!validBarcode(barcode)) fail("Barcode must be 4 to 64 letters, digits, hyphens or underscores.");
  const existing = await findAsset(barcode);
  if (existing) return res.json({ barcode, existing });
  const columns = "barcode, asset_type, manufacturer, make, model, capacity_rev, description, bond_no, storage_room, location";
  const family = familyPrefix(barcode);
  let source = "";
  // Barcodes like MB-SP5-045 share a family prefix; EMBLAB labels are plain numbers, so use the
  // item scanned last into the same consignment instead.
  let sibling = family !== barcode ? await db.one(
    `SELECT ${columns} FROM assets WHERE barcode LIKE ? AND barcode <> ? ORDER BY created_at DESC LIMIT 1`,
    [family.replace(/[\\%_]/g, "\\$&") + "-%", barcode]
  ) : null;
  if (sibling) source = "the latest " + family + " item";
  const consignmentId = Number(req.query.consignment) || 0;
  if (!sibling && consignmentId) {
    sibling = await db.one(
      `SELECT ${columns} FROM assets WHERE consignment_id = ? ORDER BY created_at DESC, barcode DESC LIMIT 1`,
      [consignmentId]);
    if (sibling) source = sibling.barcode + ", the last item in this consignment";
  }
  const from = (key) => (sibling ? sibling[key] || "" : "");
  const fill = {
    assetType: typeFromPrefix(barcode) || from("asset_type"),
    manufacturer: from("manufacturer"),
    make: from("make"),
    model: from("model"),
    capacityRev: from("capacity_rev"),
    description: from("description"),
    bondNo: from("bond_no"),
    room: from("storage_room"),
    location: from("location")
  };
  res.json({ barcode, existing: null, fill, source });
});

// Suggests the barcode for the next item: one after `after`, else after the last item of the
// consignment, else after the newest item with the same ownership.
router.get("/assets/next-barcode", custodian, async (req, res) => {
  let basis = normalizeBarcode(req.query.after);
  const consignmentId = Number(req.query.consignment) || 0;
  if (!basis && consignmentId) {
    const last = await db.one("SELECT barcode FROM assets WHERE consignment_id = ? ORDER BY created_at DESC, barcode DESC LIMIT 1",
      [consignmentId]);
    if (last) basis = last.barcode;
    else {
      const consignment = await db.one("SELECT ownership FROM consignments WHERE consignment_id = ?", [consignmentId]);
      const newest = consignment ? await db.one(
        `SELECT barcode FROM assets WHERE ownership = ? AND barcode REGEXP '[0-9]$' ORDER BY created_at DESC, barcode DESC LIMIT 1`,
        [consignment.ownership]) : null;
      if (newest) basis = newest.barcode;
    }
  }
  res.json({ barcode: basis ? await nextFreeBarcode(basis) : "", after: basis });
});

router.get("/assets/model-suggest", custodian, async (req, res) => {
  const model = clean(req.query.model, 80);
  const row = model ? await db.one(
    "SELECT asset_type, manufacturer, make, capacity_rev FROM assets WHERE model = ? ORDER BY created_at DESC LIMIT 1",
    [model]
  ) : null;
  res.json(row ? {
    assetType: row.asset_type, manufacturer: row.manufacturer || "", make: row.make || "", capacityRev: row.capacity_rev || ""
  } : null);
});

// Every deletion, with whether the item is still deleted or was restored later.
router.get("/assets/delete-history", requireRole("Super Admin"), async (req, res) => {
  const deletions = await logRows(`WHERE l.action = 'Delete' ORDER BY l.logged_at DESC, l.log_id DESC LIMIT 500`, []);
  const restores = await logRows(`WHERE l.action = 'Restore' ORDER BY l.logged_at, l.log_id`, []);
  const assets = new Map((await db.query(ASSET_SELECT + " WHERE a.deleted_at IS NOT NULL OR a.barcode IN (SELECT barcode FROM audit_log WHERE action = 'Delete')"))
    .map((row) => [row.barcode, mapAsset(row)]));
  res.json(deletions.map((entry) => {
    const asset = assets.get(entry.barcode);
    const restore = restores.find((r) => r.barcode === entry.barcode && r.when >= entry.when && r.id > entry.id);
    return {
      id: entry.id, barcode: entry.barcode, when: entry.when, by: entry.by, reason: entry.remarks,
      assetType: asset ? asset.assetType : "", model: asset ? asset.model : "",
      stillDeleted: !!(asset && asset.deletedAt) && !restore,
      restoredAt: restore ? restore.when : "", restoredBy: restore ? restore.by : ""
    };
  }));
});

router.get("/assets/:barcode", requireUser, async (req, res) => {
  const barcode = normalizeBarcode(req.params.barcode);
  const scope = scopeSql(req.user);
  const row = await db.one(ASSET_SELECT + " WHERE a.barcode = ? AND a.deleted_at IS NULL AND " + scope.sql,
    [barcode, ...scope.params]);
  if (!row) fail("Barcode " + barcode + " is not in your list.", 404);
  const asset = mapAsset(row);
  const history = isCustodian(req.user)
    ? await logRows("WHERE l.barcode = ? ORDER BY l.logged_at DESC, l.log_id DESC", [barcode])
    : null;
  res.json({ asset, history });
});

router.put("/assets/:barcode", custodian, async (req, res) => {
  const barcode = normalizeBarcode(req.params.barcode);
  const details = await readDetails(req.body);
  const ownership = clean(req.body.ownership);
  if (!OWNERS.includes(ownership)) fail("Choose ownership: AMD-Specific or Wipro-Specific.");
  const result = await db.transaction(async (conn) => {
    const asset = await findAsset(barcode, conn, true);
    if (!asset || asset.deletedAt) fail("Barcode " + barcode + " is not in the lab list.", 404);
    if (asset.revision !== Number(req.body.revision)) fail("Someone else saved this asset. Open it again and retry.", 409);
    if (await serialTaken(details.serialNo, barcode, conn)) {
      fail("Serial number " + details.serialNo + " is already recorded on another asset.");
    }
    const labels = {
      ownership: "ownership", assetType: "type", manufacturer: "manufacturer", serialNo: "serial", make: "make",
      model: "model", capacityRev: "capacity/rev", description: "description", expiryDate: "expiry", bondNo: "bond no",
      room: "room", location: "location"
    };
    const next = { ...details, ownership };
    const changed = Object.keys(labels).filter((key) => String(asset[key] || "") !== String(next[key] || ""));
    if (!changed.length) fail("Nothing was changed.");
    await conn.query(
      `UPDATE assets SET ownership = ?, asset_type = ?, manufacturer = ?, mfs_serial_no = ?, make = ?, model = ?,
         capacity_rev = ?, description = ?, expiry_date = ?, bond_no = ?, storage_room = ?, location = ?,
         revision = revision + 1
       WHERE barcode = ?`,
      [ownership, details.assetType, details.manufacturer || null, details.serialNo || null, details.make || null,
        details.model || null, details.capacityRev || null, details.description || null, details.expiryDate || null,
        details.bondNo || null, details.room, details.location || null, barcode]
    );
    await writeLog(conn, {
      barcode, action: "Edit", fromHolder: asset.holderId, toHolder: asset.holderId, fromStatus: asset.status,
      toStatus: asset.status, by: req.user.emp_id, remarks: "Changed " + changed.map((key) => labels[key]).join(", ")
    });
    return findAsset(barcode, conn);
  });
  res.json({ message: "Details saved for " + barcode + ".", asset: result });
});

// Giving an item to someone else waits for them to accept. Moving it back to the cage, to
// maintenance or to scrap happens at once.
router.post("/assets/:barcode/transfer", custodian, async (req, res) => {
  const barcode = normalizeBarcode(req.params.barcode);
  const newStatus = clean(req.body.status);
  const email = cleanEmail(req.body.holderEmail);
  const remarks = clean(req.body.remarks, 500);
  if (!STATUSES.includes(newStatus)) fail("Choose a status.");
  const message = await db.transaction(async (conn) => {
    const asset = await findAsset(barcode, conn, true);
    if (!asset || asset.deletedAt) fail("Barcode " + barcode + " is not in the lab list.", 404);
    if (asset.revision !== Number(req.body.revision)) fail("Someone else saved this asset. Scan it again and retry.", 409);
    if (asset.pending) fail("Waiting for " + asset.pending.name + " to accept " + barcode + ". Cancel that first.");
    if (!statusMoveAllowed(asset.status, newStatus, req.user.role)) {
      fail("Status cannot move from " + asset.status + " to " + newStatus + ".");
    }
    if (newStatus === "Scrapped/Returned" && !remarks) fail("Enter remarks when scrapping or returning an asset.");
    let receiver = null;
    if (newStatus === "Assigned to Engineer") {
      if (!email) fail("Enter the mail ID of the person receiving it.");
      receiver = await activeUserByEmail(email, conn);
    } else if (newStatus === "Available in Lab" || newStatus === "Scrapped/Returned") {
      if (email) fail("Clear the mail ID when returning an item to the cage or scrapping it.");
    } else if (email) {
      receiver = await activeUserByEmail(email, conn);
    }
    const holder = receiver ? receiver.emp_id : newStatus === "Under Maintenance" ? asset.holderId : "";
    if (newStatus === asset.status && holder === asset.holderId) fail("This transfer does not change the holder or the status.");
    if (receiver && receiver.emp_id !== asset.holderId && receiver.emp_id !== req.user.emp_id) {
      return startHandover(conn, { asset, to: receiver, toStatus: newStatus, by: req.user.emp_id, remarks });
    }
    await conn.query("UPDATE assets SET status = ?, holder_emp_id = ?, revision = revision + 1 WHERE barcode = ?",
      [newStatus, holder || null, barcode]);
    await writeLog(conn, {
      barcode, action: "Transfer", fromHolder: asset.holderId, toHolder: holder, fromStatus: asset.status,
      toStatus: newStatus, by: req.user.emp_id, remarks
    });
    return "Transfer recorded for " + barcode + ".";
  });
  res.json({ message });
});

router.post("/assets/:barcode/delete", requireRole("Super Admin"), async (req, res) => {
  const barcode = normalizeBarcode(req.params.barcode);
  const reason = clean(req.body.reason, 300);
  if (reason.length < 5) fail("Enter the reason for deleting (at least 5 characters).");
  await db.transaction(async (conn) => {
    const asset = await findAsset(barcode, conn, true);
    if (!asset || asset.deletedAt) fail("Barcode " + barcode + " is not in the lab list.", 404);
    await cancelWaitingHandovers(conn, barcode, req.user.emp_id, "Item deleted");
    await conn.query(
      "UPDATE assets SET deleted_at = NOW(), deleted_by = ?, delete_reason = ?, revision = revision + 1 WHERE barcode = ?",
      [req.user.emp_id, reason, barcode]
    );
    await writeLog(conn, {
      barcode, action: "Delete", fromHolder: asset.holderId, toHolder: asset.holderId, fromStatus: asset.status,
      toStatus: asset.status, by: req.user.emp_id, remarks: reason
    });
  });
  res.json({ message: barcode + " was deleted. It is listed in Delete history, where it can be restored." });
});

router.post("/assets/:barcode/restore", requireRole("Super Admin"), async (req, res) => {
  const barcode = normalizeBarcode(req.params.barcode);
  await db.transaction(async (conn) => {
    const asset = await findAsset(barcode, conn, true);
    if (!asset || !asset.deletedAt) fail(barcode + " is not in the deleted list.", 404);
    await conn.query(
      "UPDATE assets SET deleted_at = NULL, deleted_by = NULL, delete_reason = NULL, revision = revision + 1 WHERE barcode = ?",
      [barcode]
    );
    await writeLog(conn, {
      barcode, action: "Restore", fromHolder: asset.holderId, toHolder: asset.holderId, fromStatus: asset.status,
      toStatus: asset.status, by: req.user.emp_id, remarks: "Restored after: " + asset.deleteReason
    });
  });
  res.json({ message: barcode + " was restored." });
});

router.get("/export/inventory.csv", requireUser, async (req, res) => {
  const rows = await scopedAssets(req.user, req.query);
  const header = ["Barcode", "Ownership", "Asset Type", "Model", "Status", "Holder Name", "Holder Mail ID", "Team",
    "Where now", "Storage Room", "Cupboard / Shelf", "Invoice No", "PO Number", "Bond No", "Manufacturer", "Serial No",
    "Make", "Capacity / Rev", "Description", "Arrival Date", "Expiry Date"];
  const body = rows.map((a) => [a.barcode, a.ownership, a.assetType, a.model, a.status, a.holderName, a.holderEmail,
    a.teamName, a.place, a.room, a.location, a.invoiceNo, a.poNumber, a.bondNo, a.manufacturer, a.serialNo, a.make,
    a.capacityRev, a.description, a.arrivalDate, a.expiryDate]);
  sendCsv(res, "LabInventory", [header, ...body]);
});

router.get("/export/audit.csv", custodian, async (req, res) => {
  const rows = await logRows("ORDER BY l.logged_at, l.log_id", []);
  const header = ["Log ID", "When", "Barcode", "Action", "From", "To", "From Status", "To Status", "By", "Remarks"];
  sendCsv(res, "LabAudit", [header, ...rows.map((r) => [r.id, r.when, r.barcode, r.action, r.from, r.to,
    r.fromStatus, r.toStatus, r.by, r.remarks])]);
});

function sendCsv(res, name, rows) {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "");
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", 'attachment; filename="' + name + "_" + stamp + '.csv"');
  res.send(csvText(rows));
}

module.exports = {
  router, scopedAssets, findAsset, activeUser, activeUserByEmail, writeLog, serialTaken, readDetails, recentActivity,
  mapAsset, startHandover, cancelWaitingHandovers, nextFreeBarcode, logRows
};
