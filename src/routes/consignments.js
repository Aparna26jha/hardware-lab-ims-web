"use strict";

const express = require("express");
const db = require("../db");
const { requireRole } = require("../auth");
const { saveUpload, sendUpload } = require("../files");
const {
  OWNERS, AppError, fail, clean, cleanEmail, normalizeBarcode, isAmdLabel, validBarcode, isIsoDate
} = require("../rules");
const {
  findAsset, activeUserByEmail, writeLog, serialTaken, readDetails, startHandover
} = require("./assets");

const router = express.Router();
const custodian = requireRole("Super Admin", "Admin");
const DOC_TYPES = ["pdf", "jpg", "png"];
const DOC_MAX_MB = 10;
const BULK_MAX = 200;

function mapConsignment(row) {
  return {
    id: row.consignment_id,
    invoiceNo: row.invoice_no,
    poNumber: row.po_number,
    receivedDate: row.received_date,
    expectedItems: row.expected_items,
    scannedItems: Number(row.scanned_items || 0),
    documentCount: Number(row.document_count || 0),
    ownership: row.ownership,
    supplier: row.supplier || "",
    remarks: row.remarks || "",
    createdBy: row.created_by,
    createdByName: row.created_by_name || "",
    createdAt: row.created_at
  };
}

const CONSIGNMENT_SELECT = `
  SELECT c.*, u.emp_name AS created_by_name,
         (SELECT COUNT(*) FROM assets a WHERE a.consignment_id = c.consignment_id) AS scanned_items,
         (SELECT COUNT(*) FROM consignment_documents d WHERE d.consignment_id = c.consignment_id) AS document_count
    FROM consignments c
    LEFT JOIN users u ON u.emp_id = c.created_by`;

async function loadConsignment(id, conn = db) {
  const row = await conn.one(CONSIGNMENT_SELECT + " WHERE c.consignment_id = ?", [Number(id) || 0]);
  if (!row) fail("Consignment not found.", 404);
  return mapConsignment(row);
}

function readHeader(body) {
  const header = {
    invoiceNo: clean(body.invoiceNo, 64),
    poNumber: clean(body.poNumber, 64),
    receivedDate: clean(body.receivedDate),
    expectedItems: Number(body.expectedItems),
    ownership: clean(body.ownership),
    supplier: clean(body.supplier, 120),
    remarks: clean(body.remarks, 500)
  };
  if (!header.invoiceNo) fail("Enter the invoice number.");
  if (!header.poNumber) fail("Enter the PO number.");
  if (!isIsoDate(header.receivedDate)) fail("Enter the date the package arrived.");
  if (!Number.isInteger(header.expectedItems) || header.expectedItems < 1 || header.expectedItems > 1000) {
    fail("Number of items must be a whole number from 1 to 1000.");
  }
  if (!OWNERS.includes(header.ownership)) fail("Choose ownership: AMD-Specific or Wipro-Specific.");
  return header;
}

router.get("/consignments", custodian, async (req, res) => {
  const rows = await db.query(CONSIGNMENT_SELECT + " ORDER BY c.received_date DESC, c.consignment_id DESC");
  res.json(rows.map(mapConsignment));
});

router.post("/consignments", custodian, async (req, res) => {
  const c = readHeader(req.body);
  const duplicate = await db.one("SELECT consignment_id FROM consignments WHERE invoice_no = ? AND po_number = ?",
    [c.invoiceNo, c.poNumber]);
  if (duplicate) fail("This invoice and PO number are already recorded. Open the existing consignment.");
  const result = await db.query(
    `INSERT INTO consignments (invoice_no, po_number, received_date, expected_items, ownership, supplier, remarks, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [c.invoiceNo, c.poNumber, c.receivedDate, c.expectedItems, c.ownership, c.supplier || null, c.remarks || null, req.user.emp_id]
  );
  res.json({ message: "Consignment created. Upload the scanned documents next.", id: result.insertId });
});

router.get("/consignments/:id", custodian, async (req, res) => {
  const consignment = await loadConsignment(req.params.id);
  const documents = await db.query(
    `SELECT d.doc_id, d.original_name, d.mime_type, d.size_bytes, d.uploaded_by, d.uploaded_at, u.emp_name
       FROM consignment_documents d LEFT JOIN users u ON u.emp_id = d.uploaded_by
      WHERE d.consignment_id = ? ORDER BY d.doc_id`, [consignment.id]);
  const items = await db.query(
    `SELECT a.barcode, a.asset_type, a.model, a.mfs_serial_no, a.status, a.holder_emp_id, a.created_by, a.created_at,
            a.deleted_at, a.storage_room, a.location, a.bond_no, h.emp_name AS holder_name, c.emp_name AS created_name,
            p.emp_name AS pending_name
       FROM assets a
       LEFT JOIN users h ON h.emp_id = a.holder_emp_id
       LEFT JOIN users c ON c.emp_id = a.created_by
       LEFT JOIN handovers ho ON ho.barcode = a.barcode AND ho.state = 'Waiting'
       LEFT JOIN users p ON p.emp_id = ho.to_emp_id
      WHERE a.consignment_id = ? ORDER BY a.created_at, a.barcode`, [consignment.id]);
  res.json({
    consignment,
    documents: documents.map((d) => ({
      id: d.doc_id, name: d.original_name, mime: d.mime_type, size: d.size_bytes,
      uploadedBy: d.emp_name || d.uploaded_by, uploadedAt: d.uploaded_at
    })),
    items: items.map((a) => ({
      barcode: a.barcode, assetType: a.asset_type, model: a.model || "", serialNo: a.mfs_serial_no || "",
      status: a.status, holderName: a.holder_name || "", pendingName: a.pending_name || "",
      place: [a.storage_room, a.location].filter(Boolean).join(", "), bondNo: a.bond_no || "",
      createdBy: a.created_name || a.created_by, createdAt: a.created_at, deleted: !!a.deleted_at
    }))
  });
});

// Edits the package details. PO number and date are copied onto the items already scanned.
router.put("/consignments/:id", custodian, async (req, res) => {
  const c = readHeader(req.body);
  const message = await db.transaction(async (conn) => {
    const locked = await conn.one("SELECT consignment_id FROM consignments WHERE consignment_id = ? FOR UPDATE",
      [Number(req.params.id) || 0]);
    if (!locked) fail("Consignment not found.", 404);
    const before = await loadConsignment(locked.consignment_id, conn);
    if (c.expectedItems < before.scannedItems) fail(before.scannedItems + " items are already scanned into this consignment.");
    if (c.ownership !== before.ownership && before.scannedItems) {
      fail("Ownership cannot change after items are scanned. Edit the items one by one instead.");
    }
    const clash = await conn.one("SELECT consignment_id FROM consignments WHERE invoice_no = ? AND po_number = ? AND consignment_id <> ?",
      [c.invoiceNo, c.poNumber, before.id]);
    if (clash) fail("Another consignment already has this invoice and PO number.");
    await conn.query(
      `UPDATE consignments SET invoice_no = ?, po_number = ?, received_date = ?, expected_items = ?, ownership = ?,
         supplier = ?, remarks = ? WHERE consignment_id = ?`,
      [c.invoiceNo, c.poNumber, c.receivedDate, c.expectedItems, c.ownership, c.supplier || null, c.remarks || null, before.id]);
    const changed = [];
    if (c.poNumber !== before.poNumber) changed.push("PO number");
    if (c.receivedDate !== before.receivedDate) changed.push("arrival date");
    if (changed.length && before.scannedItems) {
      const items = await conn.query("SELECT barcode, holder_emp_id, status FROM assets WHERE consignment_id = ?", [before.id]);
      await conn.query("UPDATE assets SET po_number = ?, arrival_date = ?, revision = revision + 1 WHERE consignment_id = ?",
        [c.poNumber, c.receivedDate, before.id]);
      for (const item of items) {
        await writeLog(conn, {
          barcode: item.barcode, action: "Edit", fromHolder: item.holder_emp_id, toHolder: item.holder_emp_id,
          fromStatus: item.status, toStatus: item.status, by: req.user.emp_id,
          remarks: "Changed " + changed.join(" and ") + " on invoice " + c.invoiceNo
        });
      }
    }
    return "Consignment saved." + (changed.length && before.scannedItems ? " The " + changed.join(" and ") + " of "
      + before.scannedItems + " item(s) were updated too." : "");
  });
  res.json({ message });
});

router.post("/consignments/:id/documents", custodian, async (req, res) => {
  const consignment = await loadConsignment(req.params.id);
  const saved = saveUpload(req.body.file, "consignments", DOC_TYPES, DOC_MAX_MB);
  await db.query(
    `INSERT INTO consignment_documents (consignment_id, original_name, stored_name, mime_type, size_bytes, uploaded_by)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [consignment.id, saved.originalName, saved.storedName, saved.mime, saved.size, req.user.emp_id]
  );
  res.json({ message: "Uploaded " + saved.originalName + "." });
});

router.get("/documents/:docId", custodian, async (req, res) => {
  const doc = await db.one("SELECT * FROM consignment_documents WHERE doc_id = ?", [Number(req.params.docId) || 0]);
  if (!doc) fail("Document not found.", 404);
  sendUpload(res, "consignments", doc.stored_name, doc.mime_type, doc.original_name);
});

// Adds one item to a locked consignment. Items given to someone wait for that person to accept.
async function insertItem(conn, consignment, barcode, details, receiver, noDocumentReason, user) {
  if (!validBarcode(barcode)) fail("Barcode must be 4 to 64 letters, digits, hyphens or underscores.");
  if (consignment.scannedItems >= consignment.expectedItems) {
    fail("All " + consignment.expectedItems + " items are already scanned. Change the number of items if more came.");
  }
  if (isAmdLabel(barcode) && consignment.ownership !== "AMD-Specific") {
    fail(barcode + " is an AMD asset label, but this consignment is " + consignment.ownership + ". Check the consignment.");
  }
  const existing = await findAsset(barcode, conn);
  if (existing && existing.deletedAt) fail(barcode + " was deleted earlier. A Super Admin can restore it.");
  if (existing) fail(barcode + " is already on file. Open it from the asset list to edit it.");
  if (await serialTaken(details.serialNo, barcode, conn)) {
    fail("Serial number " + details.serialNo + " is already recorded on another asset.");
  }
  const toSelf = receiver && receiver.emp_id === user.emp_id;
  const status = toSelf ? "Assigned to Engineer" : "Available in Lab";
  await conn.query(
    `INSERT INTO assets (barcode, ownership, asset_type, manufacturer, mfs_serial_no, make, model, capacity_rev,
       description, po_number, bond_no, arrival_date, expiry_date, storage_room, location, status, holder_emp_id,
       consignment_id, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [barcode, consignment.ownership, details.assetType, details.manufacturer || null, details.serialNo || null,
      details.make || null, details.model || null, details.capacityRev || null, details.description || null,
      consignment.poNumber, details.bondNo || null, consignment.receivedDate, details.expiryDate || null,
      details.room, details.location || null, status, toSelf ? user.emp_id : null, consignment.id, user.emp_id]
  );
  const noDocument = consignment.documentCount ? "" : ". No document yet" + (noDocumentReason ? ": " + noDocumentReason : "");
  await writeLog(conn, {
    barcode, action: "Inward", toHolder: toSelf ? user.emp_id : "", toStatus: status, by: user.emp_id,
    remarks: "Inward on invoice " + consignment.invoiceNo + " / " + consignment.poNumber + noDocument
  });
  consignment.scannedItems += 1;
  if (receiver && !toSelf) {
    const asset = await findAsset(barcode, conn, true);
    return startHandover(conn, { asset, to: receiver, toStatus: "Assigned to Engineer", by: user.emp_id,
      remarks: "Given at inward" });
  }
  return "";
}

async function lockConsignment(conn, id) {
  const locked = await conn.one("SELECT consignment_id FROM consignments WHERE consignment_id = ? FOR UPDATE", [Number(id) || 0]);
  if (!locked) fail("Consignment not found.", 404);
  return loadConsignment(locked.consignment_id, conn);
}

// Inward: scan or type one item into the consignment. PO and arrival date come from the consignment.
// Without a document the item is still saved; the consignment shows in red until one is uploaded.
router.post("/consignments/:id/items", custodian, async (req, res) => {
  const barcode = normalizeBarcode(req.body.barcode);
  const details = await readDetails(req.body);
  const email = cleanEmail(req.body.holderEmail);
  const noDocumentReason = clean(req.body.noDocumentReason, 200);
  const message = await db.transaction(async (conn) => {
    const consignment = await lockConsignment(conn, req.params.id);
    const receiver = email ? await activeUserByEmail(email, conn) : null;
    const handover = await insertItem(conn, consignment, barcode, details, receiver, noDocumentReason, req.user);
    return "Saved " + barcode + ". " + consignment.scannedItems + " of " + consignment.expectedItems + " items scanned."
      + (handover ? " " + handover : "");
  });
  res.json({ message });
});

// Adds many barcodes at once (read from a document or pasted), all with the same details.
router.post("/consignments/:id/items/bulk", custodian, async (req, res) => {
  const barcodes = [...new Set((Array.isArray(req.body.barcodes) ? req.body.barcodes : []).map(normalizeBarcode).filter(Boolean))];
  if (!barcodes.length) fail("There are no barcodes to add.");
  if (barcodes.length > BULK_MAX) fail("Add at most " + BULK_MAX + " barcodes at a time.");
  const details = await readDetails({ ...req.body, serialNo: "" });
  const noDocumentReason = clean(req.body.noDocumentReason, 200);
  const result = await db.transaction(async (conn) => {
    const consignment = await lockConsignment(conn, req.params.id);
    const added = [];
    const skipped = [];
    for (const barcode of barcodes) {
      try {
        await insertItem(conn, consignment, barcode, details, null, noDocumentReason, req.user);
        added.push(barcode);
      } catch (error) {
        if (!(error instanceof AppError)) throw error;
        skipped.push(barcode + ": " + error.message);
      }
    }
    return { added, skipped, scanned: consignment.scannedItems, expected: consignment.expectedItems };
  });
  res.json({
    message: "Added " + result.added.length + " item(s). " + result.scanned + " of " + result.expected + " items scanned."
      + (result.skipped.length ? " " + result.skipped.length + " skipped." : ""),
    ...result
  });
});

module.exports = { router };
