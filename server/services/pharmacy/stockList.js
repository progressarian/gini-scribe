import ExcelJS from "exceljs";
import pool from "../../config/db.js";

const today = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });

const LANDING = `(
  SELECT pl.purchase_rate, pl.discount_pct, pl.gst_rate_pct, pl.qty_packs, pl.free_packs
    FROM pharmacy_purchase_lines pl
    JOIN pharmacy_purchases pp ON pp.id = pl.purchase_id AND pp.status = 'posted'
   WHERE pl.batch_id = b.id
   ORDER BY pp.posted_at DESC
   LIMIT 1)`;

const BASE = `
  SELECT s.location_id, l.name AS location_name, b.id AS batch_id, b.batch_no, b.expiry_date,
         (b.expiry_date - $1::date) AS days_left, b.rack_no, b.pack_size, b.mrp, b.sale_rate,
         b.gst_rate_pct, s.qty_units,
         m.id AS medicine_id, m.code, m.name AS medicine_name, m.form, m.manufacturer,
         m.pack_label, m.unit_label, v.id AS vendor_id, v.name AS vendor_name,
         COALESCE(lp.purchase_rate, b.purchase_rate) AS ptr,
         ROUND(
           COALESCE(lp.purchase_rate, b.purchase_rate)
           * (1 - COALESCE(lp.discount_pct, 0) / 100)
           * (1 + COALESCE(lp.gst_rate_pct, b.gst_rate_pct) / 100)
           * COALESCE(lp.qty_packs, 1)
           / NULLIF(COALESCE(lp.qty_packs, 1) + COALESCE(lp.free_packs, 0), 0), 2) AS lp
    FROM pharmacy_stock s
    JOIN pharmacy_batches b ON b.id = s.batch_id
    JOIN pharmacy_medicines m ON m.id = b.medicine_id
    JOIN pharmacy_locations l ON l.id = s.location_id
    LEFT JOIN pharmacy_vendors v ON v.id = b.vendor_id
    LEFT JOIN LATERAL ${LANDING} lp ON TRUE`;

const SORTS = {
  medicine_name: "lower(medicine_name)",
  form: "form",
  vendor_name: "lower(vendor_name)",
  batch_no: "batch_no",
  expiry_date: "expiry_date",
  qty_units: "qty_units",
  mrp: "mrp",
  ptr: "ptr",
  lp: "lp",
  margin_pct: "margin_pct",
  location_name: "location_name",
};

const COST_SORTS = ["ptr", "lp", "margin_pct"];

const EXPIRY = {
  all: "TRUE",
  expired: "days_left <= 0",
  30: "days_left > 0 AND days_left <= 30",
  90: "days_left > 0 AND days_left <= 90",
  fresh: "days_left > 90",
};

function query(filters, { withCost }) {
  const params = [today()];
  const add = (value) => {
    params.push(value);
    return `$${params.length}`;
  };
  const where = [filters.include_empty ? "TRUE" : "qty_units > 0", EXPIRY[filters.expiry ?? "all"]];
  if (filters.location_id) where.push(`location_id = ${add(filters.location_id)}`);
  if (filters.form) where.push(`form = ${add(filters.form)}`);
  if (filters.vendor_id) where.push(`vendor_id = ${add(filters.vendor_id)}`);
  if (filters.q) {
    const $ = add(`%${filters.q.toLowerCase()}%`);
    where.push(
      `(lower(medicine_name) LIKE ${$} OR lower(batch_no) LIKE ${$} OR lower(code) LIKE ${$}
        OR lower(COALESCE(vendor_name, '')) LIKE ${$} OR lower(COALESCE(manufacturer, '')) LIKE ${$})`,
    );
  }
  const sortKey =
    SORTS[filters.sort] && (withCost || !COST_SORTS.includes(filters.sort))
      ? filters.sort
      : "medicine_name";
  const dir = filters.dir === "desc" ? "DESC" : "ASC";
  const sql = `
    WITH rows AS (
      SELECT x.*, CASE WHEN x.mrp > 0 AND x.lp IS NOT NULL
                       THEN ROUND((x.mrp - x.lp) / x.mrp * 100, 2) END AS margin_pct
        FROM (${BASE}) x
    )
    SELECT *, count(*) OVER()::int AS total FROM rows
     WHERE ${where.join(" AND ")}
     ORDER BY ${SORTS[sortKey]} ${dir} NULLS LAST, lower(medicine_name), expiry_date, batch_id`;
  return { sql, params };
}

const strip = (row, withCost) => {
  const { total, ...rest } = row;
  if (withCost) return rest;
  const { ptr, lp, margin_pct, ...visible } = rest;
  return visible;
};

export async function stockList(filters = {}, { withCost = false } = {}, db = pool) {
  const { sql, params } = query(filters, { withCost });
  params.push(filters.limit ?? 50, filters.offset ?? 0);
  const { rows } = await db.query(
    `${sql} LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  const { rows: forms } = await db.query(
    `SELECT DISTINCT form FROM pharmacy_medicines WHERE form IS NOT NULL ORDER BY form`,
  );
  return {
    total: rows[0]?.total ?? 0,
    forms: forms.map((f) => f.form),
    rows: rows.map((r) => strip(r, withCost)),
  };
}

const COLUMNS = [
  ["medicine_name", "Item name", 36],
  ["form", "Item type", 10],
  ["vendor_name", "Supplier", 28],
  ["unit", "Unit", 18],
  ["batch_no", "Batch no", 14],
  ["expiry_date", "Expiry", 12],
  ["qty_units", "Stock (units)", 12],
  ["mrp", "MRP / pack", 12],
  ["ptr", "PTR / pack", 12],
  ["lp", "LP / pack", 12],
  ["margin_pct", "Margin %", 10],
  ["rack_no", "Rack", 10],
  ["location_name", "Location", 18],
];

export async function stockListWorkbook(filters = {}, { withCost = false } = {}, db = pool) {
  const { sql, params } = query(filters, { withCost });
  const { rows } = await db.query(`${sql} LIMIT 20000`, params);
  const columns = COLUMNS.filter(([key]) => withCost || !["ptr", "lp", "margin_pct"].includes(key));
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Stock list");
  sheet.columns = columns.map(([key, header, width]) => ({ key, header, width }));
  sheet.getRow(1).font = { bold: true };
  sheet.views = [{ state: "frozen", ySplit: 1 }];
  for (const r of rows) {
    sheet.addRow({
      ...r,
      unit: `${r.pack_label} of ${r.pack_size} ${r.unit_label}`,
      mrp: Number(r.mrp),
      ptr: r.ptr === null ? null : Number(r.ptr),
      lp: r.lp === null ? null : Number(r.lp),
      margin_pct: r.margin_pct === null ? null : Number(r.margin_pct),
    });
  }
  return {
    buffer: Buffer.from(await workbook.xlsx.writeBuffer()),
    filename: `Pharmacy_stock_list_${today()}.xlsx`,
  };
}
