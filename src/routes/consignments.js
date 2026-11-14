"use strict";

const express = require("express");
const db = require("../db");
const { requireRole } = require("../auth");
const { saveUpload, sendUpload } = require("../files");
const { OWNERS, fail, clean, normalizeId, normalizeBarcode, validBarcode, isIsoDate } = require("../rules");
const { findAsset, activeUser, writeLog, serialTaken, readDetails } = require("./assets");

const router = express.Router();
const custodian = requireRole("Super Admin", "Admin");
const DOC_TYPES = ["pdf", "jpg", "png"];
const DOC_MAX_MB = 10;

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

router.get("/consignments", custodian, async (req, res) => {
  const rows = await db.query(CONSIGNMENT_SELECT + " ORDER BY c.received_date DESC, c.consignment_id DESC");
  res.json(rows.map(mapConsignment));
});

router.post("/consignments", custodian, async (req, res) => {
  const invoiceNo = clean(req.body.invoiceNo, 64);
  const poNumber = clean(req.body.poNumber, 64);
  const receivedDate = clean(req.body.receivedDate);
  const expectedItems = Number(req.body.expectedItems);
  const ownership = clean(req.body.ownership);
  if (!invoiceNo) fail("Enter the invoice number.");
  if (!poNumber) fail("Enter the PO number.");
  if (!isIsoDate(receivedDate)) fail("Enter the date the package arrived.");
  if (!Number.isInteger(expectedItems) || expectedItems < 1 || expectedItems > 1000) {
    fail("Number of items must be a whole number from 1 to 1000.");
  }
  if (!OWNERS.includes(ownership)) fail("Choose ownership: AMD-Specific or Wipro-Specific.");
  const duplicate = await db.one("SELECT consignment_id FROM consignments WHERE invoice_no = ? AND po_number = ?",
    [invoiceNo, poNumber]);
  if (duplicate) fail("This invoice and PO number are already recorded. Open the existing consignment.");
  const result = await db.query(
    `INSERT INTO consignments (invoice_no, po_number, received_date, expected_items, ownership, supplier, remarks, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [invoiceNo, poNumber, receivedDate, expectedItems, ownership, clean(req.body.supplier, 120) || null,
      clean(req.body.remarks, 500) || null, req.user.emp_id]
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
            a.deleted_at
       FROM assets a WHERE a.consignment_id = ? ORDER BY a.created_at, a.barcode`, [consignment.id]);
  res.json({
    consignment,
    documents: documents.map((d) => ({
      id: d.doc_id, name: d.original_name, mime: d.mime_type, size: d.size_bytes,
      uploadedBy: d.uploaded_by + (d.emp_name ? " " + d.emp_name : ""), uploadedAt: d.uploaded_at
    })),
    items: items.map((a) => ({
      barcode: a.barcode, assetType: a.asset_type, model: a.model || "", serialNo: a.mfs_serial_no || "",
      status: a.status, holderId: a.holder_emp_id || "", createdBy: a.created_by, createdAt: a.created_at,
      deleted: !!a.deleted_at
    }))
  });
});

router.put("/consignments/:id", custodian, async (req, res) => {
  const consignment = await loadConsignment(req.params.id);
  const expectedItems = Number(req.body.expectedItems);
  if (!Number.isInteger(expectedItems) || expectedItems < 1 || expectedItems > 1000) {
    fail("Number of items must be a whole number from 1 to 1000.");
  }
  if (expectedItems < consignment.scannedItems) {
    fail(consignment.scannedItems + " items are already scanned into this consignment.");
  }
  await db.query("UPDATE consignments SET expected_items = ?, supplier = ?, remarks = ? WHERE consignment_id = ?",
    [expectedItems, clean(req.body.supplier, 120) || null, clean(req.body.remarks, 500) || null, consignment.id]);
  res.json({ message: "Consignment updated." });
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

// Inward: scan one item into the consignment. PO and arrival date come from the consignment.
router.post("/consignments/:id/items", custodian, async (req, res) => {
  const barcode = normalizeBarcode(req.body.barcode);
  if (!validBarcode(barcode)) fail("Barcode must be 4 to 64 letters, digits, hyphens or underscores.");
  const details = readDetails(req.body);
  const holderId = normalizeId(req.body.holderId);
  const message = await db.transaction(async (conn) => {
    const locked = await conn.one("SELECT consignment_id FROM consignments WHERE consignment_id = ? FOR UPDATE",
      [Number(req.params.id) || 0]);
    if (!locked) fail("Consignment not found.", 404);
    const consignment = await loadConsignment(locked.consignment_id, conn);
    if (!consignment.documentCount) fail("Upload the scanned invoice or delivery documents before adding items.");
    if (consignment.scannedItems >= consignment.expectedItems) {
      fail("All " + consignment.expectedItems + " items are already scanned. Change the number of items if more came.");
    }
    const ownership = OWNERS.includes(clean(req.body.ownership)) ? clean(req.body.ownership) : consignment.ownership;
    const existing = await findAsset(barcode, conn);
    if (existing && existing.deletedAt) fail(barcode + " was deleted earlier. A Super Admin can restore it.");
    if (existing) fail(barcode + " is already on file. Open it from the asset list to edit it.");
    if (await serialTaken(details.serialNo, barcode, conn)) {
      fail("Serial number " + details.serialNo + " is already recorded on another asset.");
    }
    let status = "Available in Lab";
    if (holderId) {
      if (!(await activeUser(holderId, conn))) fail(holderId + " is not an active user.");
      status = "Assigned to Engineer";
    }
    await conn.query(
      `INSERT INTO assets (barcode, ownership, asset_type, manufacturer, mfs_serial_no, make, model, capacity_rev,
         description, po_number, arrival_date, expiry_date, location, status, holder_emp_id, consignment_id, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [barcode, ownership, details.assetType, details.manufacturer || null, details.serialNo || null,
        details.make || null, details.model || null, details.capacityRev || null, details.description || null,
        consignment.poNumber, consignment.receivedDate, details.expiryDate || null, details.location || null,
        status, holderId || null, consignment.id, req.user.emp_id]
    );
    await writeLog(conn, {
      barcode, action: "Inward", toHolder: holderId, toStatus: status, by: req.user.emp_id,
      remarks: "Inward on invoice " + consignment.invoiceNo + " / " + consignment.poNumber
    });
    const count = consignment.scannedItems + 1;
    return "Saved " + barcode + ". " + count + " of " + consignment.expectedItems + " items scanned.";
  });
  res.json({ message });
});

module.exports = { router };
