import ExcelJS from "exceljs";
import pool from "../../config/db.js";
import { httpError } from "../billing/transaction.js";
import { readableZodError } from "../../middleware/validate.js";
import { pharmacyPurchaseLineSchema } from "../../schemas/pharmacyPurchases.js";
import { cellValue, number, text } from "./stockParse.js";
import { getPurchase, updatePurchase } from "./purchases.js";

export const MAX_RECEIPT_UPLOAD_BYTES = 5 * 1024 * 1024;
const MAX_ROWS = 2000;

const COLUMNS = [
  { field: "code", header: "Medicine code", width: 14 },
  { field: "name", header: "Medicine name", width: 40 },
  { field: "pack", header: "Pack", width: 16 },
  { field: "batch_no", header: "Batch", width: 14 },
  { field: "expiry_date", header: "Expiry (DD/MM/YYYY or MM/YYYY)", width: 18 },
  { field: "mfg_date", header: "MFG date", width: 14 },
  { field: "qty_packs", header: "Qty (packs)", width: 12 },
  { field: "free_packs", header: "Free (packs)", width: 12 },
  { field: "purchase_rate", header: "Purchase rate per pack", width: 14 },
  { field: "discount_pct", header: "Discount %", width: 11 },
  { field: "gst_rate_pct", header: "GST %", width: 8 },
  { field: "mrp", header: "MRP per pack", width: 12 },
  { field: "sale_rate", header: "Sale rate per pack", width: 14 },
  { field: "rack_no", header: "Rack", width: 10 },
];

const HEADER_TO_FIELD = new Map(COLUMNS.map((c) => [c.header.toLowerCase(), c.field]));

export async function receiptTemplate(db = pool) {
  const { rows } = await db.query(
    `SELECT code, name, pack_label, pack_size, unit_label, gst_rate_pct, default_mrp,
            default_sale_rate, default_rack
       FROM pharmacy_medicines WHERE is_active ORDER BY lower(name)`,
  );
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Stock");
  sheet.columns = COLUMNS.map((c) => ({ header: c.header, key: c.field, width: c.width }));
  sheet.getRow(1).font = { bold: true };
  sheet.views = [{ state: "frozen", ySplit: 1 }];
  for (const m of rows) {
    sheet.addRow({
      code: m.code,
      name: m.name,
      pack: `${m.pack_label} of ${m.pack_size} ${m.unit_label}`,
      gst_rate_pct: Number(m.gst_rate_pct),
      mrp: m.default_mrp === null ? null : Number(m.default_mrp),
      sale_rate: m.default_sale_rate === null ? null : Number(m.default_sale_rate),
      rack_no: m.default_rack,
      free_packs: 0,
      discount_pct: 0,
    });
  }
  const help = workbook.addWorksheet("How to fill");
  help.getColumn(1).width = 110;
  [
    "One row per batch. Copy a medicine's row if you hold more than one batch of it.",
    "Leave Batch empty on medicines you do not stock; those rows are skipped.",
    "Quantities and rates are per pack, as on the vendor invoice. Free packs cost nothing.",
    "Expiry can be 31/12/2027, 2027-12-31 or 12/2027 (taken as the last day of that month).",
    "Do not change the Medicine code column: it is how each row finds its medicine.",
  ].forEach((line) => help.addRow([line]));
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

const pad = (n) => String(n).padStart(2, "0");

function isoDate(value) {
  if (value === null || value === undefined || value === "") return null;
  if (value instanceof Date) {
    return `${value.getUTCFullYear()}-${pad(value.getUTCMonth() + 1)}-${pad(value.getUTCDate())}`;
  }
  const s = String(value).trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (m) return `${m[1]}-${pad(m[2])}-${pad(m[3])}`;
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(s);
  if (m) return `${m[3]}-${pad(m[2])}-${pad(m[1])}`;
  m = /^(\d{1,2})[/.-](\d{4})$/.exec(s);
  if (m) {
    const last = new Date(Date.UTC(Number(m[2]), Number(m[1]), 0)).getUTCDate();
    return `${m[2]}-${pad(m[1])}-${pad(last)}`;
  }
  return s;
}

async function readRows(buffer) {
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(buffer);
  } catch {
    throw httpError(
      400,
      "This file could not be opened. Upload the filled template as an .xlsx file.",
    );
  }
  const sheet = workbook.worksheets[0];
  if (!sheet || sheet.actualRowCount < 2) throw httpError(400, "The file has no rows in it.");
  const columns = {};
  sheet.getRow(1).eachCell({ includeEmpty: false }, (cell, col) => {
    const field = HEADER_TO_FIELD.get(
      String(cellValue(cell) ?? "")
        .trim()
        .toLowerCase(),
    );
    if (field) columns[field] = col;
  });
  for (const needed of ["code", "batch_no", "expiry_date", "qty_packs", "mrp", "sale_rate"]) {
    if (!columns[needed]) {
      const header = COLUMNS.find((c) => c.field === needed).header;
      throw httpError(
        400,
        `The "${header}" column is missing. Download a fresh template and fill that in.`,
      );
    }
  }
  const rows = [];
  for (let r = 2; r <= sheet.rowCount; r += 1) {
    const row = sheet.getRow(r);
    const read = (field) => (columns[field] ? cellValue(row.getCell(columns[field])) : null);
    const batch = text(read("batch_no"));
    const qty = number(read("qty_packs"));
    if (!batch && !qty) continue;
    rows.push({ row: r, read });
    if (rows.length > MAX_ROWS)
      throw httpError(400, `The file has more than ${MAX_ROWS} filled rows.`);
  }
  return rows;
}

const asNumber = (v, fallback = null) => {
  const n = number(v);
  return n === null ? fallback : n;
};

export async function importReceiptLines(id, buffer, { version }, ctx = {}, db = pool) {
  const purchase = await getPurchase(id, db);
  if (purchase.status !== "draft") {
    throw httpError(409, `This receipt is already ${purchase.status} and can no longer be changed`);
  }
  if (purchase.version !== version) {
    throw httpError(409, "Someone else changed this receipt. Reload it and import again");
  }
  const rows = await readRows(buffer);
  if (!rows.length)
    throw httpError(400, "No filled rows found. Enter a batch and quantity on each row you stock.");

  const { rows: medicines } = await db.query(
    `SELECT id, code, is_active, name FROM pharmacy_medicines`,
  );
  const byCode = new Map(medicines.map((m) => [m.code, m]));

  const existing = purchase.lines.map((l) => ({
    medicine_id: l.medicine_id,
    batch_no: l.batch_no,
    expiry_date: l.expiry_date,
    mfg_date: l.mfg_date,
    qty_packs: l.qty_packs,
    free_packs: l.free_packs,
    purchase_rate: Number(l.purchase_rate),
    discount_pct: Number(l.discount_pct),
    gst_rate_pct: Number(l.gst_rate_pct),
    mrp: Number(l.mrp),
    sale_rate: Number(l.sale_rate),
    rack_no: l.rack_no,
  }));
  const seen = new Set(existing.map((l) => `${l.medicine_id}|${l.batch_no}|${l.expiry_date}`));
  const added = [];
  const skipped = [];

  for (const { row, read } of rows) {
    const code = text(read("code"))?.toUpperCase();
    const medicine = code ? byCode.get(code) : null;
    if (!medicine) {
      skipped.push({
        row,
        reason: code ? `No medicine has the code ${code}` : "The medicine code is empty",
      });
      continue;
    }
    if (!medicine.is_active) {
      skipped.push({ row, reason: `${medicine.name} is deactivated` });
      continue;
    }
    const parsed = pharmacyPurchaseLineSchema.safeParse({
      medicine_id: medicine.id,
      batch_no: text(read("batch_no")) ?? "",
      expiry_date: isoDate(read("expiry_date")),
      mfg_date: isoDate(read("mfg_date")),
      qty_packs: asNumber(read("qty_packs"), 0),
      free_packs: asNumber(read("free_packs"), 0),
      purchase_rate: asNumber(read("purchase_rate"), 0),
      discount_pct: asNumber(read("discount_pct"), 0),
      gst_rate_pct: asNumber(read("gst_rate_pct"), 0),
      mrp: asNumber(read("mrp")),
      sale_rate: asNumber(read("sale_rate")),
      rack_no: text(read("rack_no")),
    });
    if (!parsed.success) {
      skipped.push({ row, reason: readableZodError(parsed.error) });
      continue;
    }
    const key = `${parsed.data.medicine_id}|${parsed.data.batch_no}|${parsed.data.expiry_date}`;
    if (seen.has(key)) {
      skipped.push({
        row,
        reason: `Batch ${parsed.data.batch_no} of ${medicine.name} is already on this receipt`,
      });
      continue;
    }
    seen.add(key);
    added.push(parsed.data);
  }

  if (!added.length) {
    return { purchase, added: 0, skipped };
  }
  const saved = await updatePurchase(
    id,
    {
      version,
      vendor_id: purchase.vendor_id,
      invoice_no: purchase.invoice_no,
      invoice_date: purchase.invoice_date,
      notes: purchase.notes,
      lines: [...existing, ...added],
    },
    ctx,
    db,
  );
  return { purchase: saved, added: added.length, skipped };
}
