import ExcelJS from "exceljs";
import { httpError } from "../billing/transaction.js";
import { SHEET_MAX_ROWS } from "./sheetImport.js";
import { cellValue, number, text } from "./stockParse.js";

export const STOCK_IMPORT_COLUMNS = [
  { field: "name", header: "Medicine name", aliases: ["Item name"], width: 40, required: true },
  { field: "hsn_code", header: "HSN code", width: 12 },
  { field: "unit", header: "Unit", width: 8 },
  { field: "batch_no", header: "Batch", aliases: ["Batch No"], width: 14, required: true },
  { field: "pack_size", header: "Units per pack", aliases: ["Pack Size"], width: 12 },
  { field: "mrp", header: "MRP per pack", aliases: ["MRP"], width: 12, required: true },
  {
    field: "qty_packs",
    header: "Qty (packs)",
    aliases: ["Total Stock"],
    width: 12,
    required: true,
  },
  { field: "vendor", header: "Vendor name", aliases: ["Supplier Name"], width: 30 },
  {
    field: "sale_rate",
    header: "Sale rate per pack",
    aliases: ["S.Rate"],
    width: 14,
    required: true,
  },
  { field: "purchase_rate", header: "Purchase rate per pack", aliases: ["P.Rate"], width: 14 },
  { field: "landing_rate", header: "Landing rate per pack", aliases: ["LP.Rate"], width: 14 },
  {
    field: "expiry",
    header: "Expiry (DD/MM/YYYY or MM/YYYY)",
    aliases: ["Expiry Date", "Expiry"],
    width: 18,
    required: true,
  },
  { field: "gst_rate_pct", header: "GST %", aliases: ["GST"], width: 8 },
  { field: "manufacturer", header: "Manufacturer", aliases: ["Company Name"], width: 24 },
  { field: "type", header: "Type", aliases: ["Item Category"], width: 12 },
  { field: "item_type", header: "Item Type", width: 12 },
  {
    field: "generic_name",
    header: "Generic name / composition",
    aliases: ["Generic Name"],
    width: 36,
  },
];

const HEADER_SCAN_ROWS = 30;

const normal = (v) =>
  String(v ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

const BY_HEADER = new Map(
  STOCK_IMPORT_COLUMNS.flatMap((c) =>
    [c.header, ...(c.aliases ?? [])].map((h) => [normal(h), c.field]),
  ),
);

function positionsOf(row) {
  const positions = {};
  row.eachCell({ includeEmpty: false }, (cell, col) => {
    const field = BY_HEADER.get(normal(cellValue(cell)));
    if (field && !positions[field]) positions[field] = col;
  });
  return positions;
}

const REQUIRED = STOCK_IMPORT_COLUMNS.filter((c) => c.required);
const NUMERIC = ["mrp", "qty_packs", "sale_rate", "purchase_rate", "landing_rate", "gst_rate_pct"];

function rawValue(cell) {
  const v = cellValue(cell);
  if (v instanceof Date) return v;
  if (v && typeof v === "object" && "hyperlink" in v) return v.text ?? null;
  return v;
}

export async function readStockImport(buffer) {
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(buffer);
  } catch {
    throw httpError(400, "This file could not be opened. Upload the stock sheet as an .xlsx file.");
  }
  const sheet = workbook.worksheets.find((ws) => ws.actualRowCount > 0);
  if (!sheet) throw httpError(400, "The file has no rows in it.");

  let positions = null;
  let headerRow = 0;
  for (let r = 1; r <= Math.min(sheet.rowCount, HEADER_SCAN_ROWS) && !positions; r += 1) {
    const found = positionsOf(sheet.getRow(r));
    if (found.name && found.batch_no) {
      positions = found;
      headerRow = r;
    }
  }
  if (!positions) {
    throw httpError(
      400,
      'Could not find the header row. The sheet needs "Medicine name" (or "Item name") and "Batch" (or "Batch No") columns.',
    );
  }
  const missing = REQUIRED.filter((c) => !positions[c.field]);
  if (missing.length) {
    throw httpError(
      400,
      `The ${missing.map((c) => `"${c.header}"`).join(", ")} column${missing.length > 1 ? "s are" : " is"} missing. Download the template and fill that in.`,
    );
  }

  const rows = [];
  for (let r = headerRow + 1; r <= sheet.rowCount; r += 1) {
    const excelRow = sheet.getRow(r);
    const values = {};
    for (const [field, col] of Object.entries(positions)) {
      const v = rawValue(excelRow.getCell(col));
      values[field] = v instanceof Date ? v : NUMERIC.includes(field) ? number(v) : text(v);
    }
    if (!values.name || /^TOTAL$/i.test(values.name)) continue;
    rows.push({ row: r, values });
    if (rows.length > SHEET_MAX_ROWS) {
      throw httpError(
        400,
        `The sheet has more than ${SHEET_MAX_ROWS} rows; split it into smaller files.`,
      );
    }
  }
  if (!rows.length) throw httpError(400, "No stock rows found under the header row.");
  return rows;
}

const MEASURE = /\d\s*(ML|GM|GMS|G|KG|L|LTR|MG|MCG)\b/i;

export function packSizeOf(value) {
  if (typeof value === "number")
    return Number.isInteger(value) && value >= 1 ? Math.min(value, 10000) : 1;
  const s = String(value ?? "").trim();
  if (!s || MEASURE.test(s)) return 1;
  const parts = s.match(/\d+(\.\d+)?/g) ?? [];
  if (!parts.length || parts.some((p) => p.includes("."))) return 1;
  const size = parts.map(Number).reduce((a, b) => a * b, 1);
  return size >= 1 && size <= 10000 ? size : 1;
}
