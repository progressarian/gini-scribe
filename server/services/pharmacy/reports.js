import ExcelJS from "exceljs";
import pool from "../../config/db.js";
import { httpError } from "../billing/transaction.js";
import { DUE_SQL } from "./billDue.js";

const IST = "Asia/Kolkata";
const today = () => new Date().toLocaleDateString("en-CA", { timeZone: IST });
const istDay = (column) => `(${column} AT TIME ZONE '${IST}')::date`;
const SIGN = `CASE WHEN b.bill_type = 'credit_note' THEN -1 ELSE 1 END`;

const money = (key, label) => ({ key, label, type: "money" });
const int = (key, label) => ({ key, label, type: "int" });
const text = (key, label) => ({ key, label, type: "text" });
const date = (key, label) => ({ key, label, type: "date" });

export const REPORTS = {
  sales: {
    label: "Daily sales",
    description: "Bills and returns by day and sale type. Returns are subtracted.",
    dated: true,
    columns: [
      date("day", "Date"),
      text("sale_type", "Sale type"),
      int("bills", "Bills"),
      int("returns", "Returns"),
      money("billed", "Billed"),
      money("returned", "Returned"),
      money("net_sales", "Net sales"),
      money("discount", "Discount given"),
      money("gst", "GST charged"),
      money("folded_gst", "GST inside IPD rates"),
      money("due", "Left as due"),
    ],
    sql: `
      SELECT b.bill_date AS day, b.sale_type,
             count(*) FILTER (WHERE b.bill_type = 'invoice')::int AS bills,
             count(*) FILTER (WHERE b.bill_type = 'credit_note')::int AS returns,
             COALESCE(SUM(b.net_amount) FILTER (WHERE b.bill_type = 'invoice'), 0) AS billed,
             COALESCE(SUM(b.net_amount) FILTER (WHERE b.bill_type = 'credit_note'), 0) AS returned,
             SUM(${SIGN} * b.net_amount) AS net_sales,
             COALESCE(SUM(b.discount_amount) FILTER (WHERE b.bill_type = 'invoice'), 0) AS discount,
             SUM(${SIGN} * (b.cgst_amount + b.sgst_amount)) AS gst,
             SUM(${SIGN} * b.folded_gst_amount) AS folded_gst,
             COALESCE(SUM(${DUE_SQL}) FILTER (WHERE b.bill_type = 'invoice'), 0) AS due
        FROM pharmacy_bills b
       WHERE b.status = 'final' AND b.bill_date BETWEEN $1::date AND $2::date
       GROUP BY b.bill_date, b.sale_type
       ORDER BY b.bill_date, b.sale_type`,
    totals: [
      "bills",
      "returns",
      "billed",
      "returned",
      "net_sales",
      "discount",
      "gst",
      "folded_gst",
      "due",
    ],
  },
  collections: {
    label: "Collections by payment mode",
    description: "Money taken and paid back each day, by mode, at the counter and reception.",
    dated: true,
    columns: [
      date("day", "Date"),
      text("mode", "Mode"),
      int("payments", "Payments"),
      money("received", "Received"),
      money("refunded", "Refunded"),
      money("net", "Net"),
    ],
    sql: `
      SELECT ${istDay("p.received_at")} AS day, p.mode,
             count(*) FILTER (WHERE p.direction = 'in')::int AS payments,
             COALESCE(SUM(p.amount) FILTER (WHERE p.direction = 'in'), 0) AS received,
             COALESCE(SUM(p.amount) FILTER (WHERE p.direction = 'out'), 0) AS refunded,
             SUM(CASE WHEN p.direction = 'in' THEN p.amount ELSE -p.amount END) AS net
        FROM pharmacy_payments p
       WHERE ${istDay("p.received_at")} BETWEEN $1::date AND $2::date AND p.mode <> 'deposit'
       GROUP BY 1, p.mode
       ORDER BY 1, p.mode`,
    totals: ["payments", "received", "refunded", "net"],
  },
  gst: {
    label: "GST summary",
    description:
      "Taxable value and GST by HSN and rate, returns subtracted. IPD lines carry GST inside the rate and are shown on their own rows.",
    dated: true,
    columns: [
      text("hsn_code", "HSN"),
      text("rate", "GST %"),
      text("treatment", "Treatment"),
      money("taxable", "Taxable value"),
      money("cgst", "CGST"),
      money("sgst", "SGST"),
      money("folded_gst", "GST inside rates"),
      money("total", "Total"),
    ],
    sql: `
      SELECT COALESCE(l.hsn_code, 'Not set') AS hsn_code, l.gst_rate_pct::text AS rate,
             CASE WHEN b.gst_folded THEN 'GST inside rate (IPD)' ELSE 'GST charged' END AS treatment,
             SUM(${SIGN} * CASE WHEN b.gst_folded THEN l.total - l.folded_gst ELSE l.taxable END) AS taxable,
             SUM(${SIGN} * l.cgst) AS cgst, SUM(${SIGN} * l.sgst) AS sgst,
             SUM(${SIGN} * l.folded_gst) AS folded_gst, SUM(${SIGN} * l.total) AS total
        FROM pharmacy_bill_lines l
        JOIN pharmacy_bills b ON b.id = l.bill_id
       WHERE b.status = 'final' AND b.bill_date BETWEEN $1::date AND $2::date
       GROUP BY 1, l.gst_rate_pct, b.gst_folded
       ORDER BY 1, l.gst_rate_pct, b.gst_folded`,
    totals: ["taxable", "cgst", "sgst", "folded_gst", "total"],
  },
  purchases: {
    label: "Purchase register",
    description: "Posted goods receipts by vendor invoice.",
    dated: true,
    columns: [
      date("day", "Posted on"),
      text("receipt_no", "Receipt"),
      text("vendor", "Vendor"),
      text("gstin", "Vendor GSTIN"),
      text("invoice_no", "Invoice"),
      date("invoice_date", "Invoice date"),
      money("taxable_amount", "Taxable"),
      money("gst_amount", "GST"),
      money("discount_amount", "Discount"),
      money("net_amount", "Net"),
    ],
    sql: `
      SELECT ${istDay("p.posted_at")} AS day, p.receipt_no,
             CASE WHEN p.kind = 'opening' THEN 'Opening stock' ELSE v.name END AS vendor,
             v.gstin, p.invoice_no, p.invoice_date, p.taxable_amount, p.gst_amount,
             p.discount_amount, p.net_amount
        FROM pharmacy_purchases p
        LEFT JOIN pharmacy_vendors v ON v.id = p.vendor_id
       WHERE p.status = 'posted' AND ${istDay("p.posted_at")} BETWEEN $1::date AND $2::date
       ORDER BY p.posted_at, p.receipt_no`,
    totals: ["taxable_amount", "gst_amount", "discount_amount", "net_amount"],
  },
  h1_register: {
    label: "Schedule H1 / X register",
    description:
      "Every sale of a Schedule H1, X or narcotic medicine, with the patient and prescriber.",
    dated: true,
    columns: [
      date("day", "Date"),
      text("bill_no", "Bill"),
      text("patient", "Patient"),
      text("file_no", "File no"),
      text("address", "Address"),
      text("prescriber", "Prescribed by"),
      text("medicine", "Medicine"),
      text("schedule", "Schedule"),
      text("batch_no", "Batch"),
      int("qty_units", "Quantity (units)"),
    ],
    sql: `
      SELECT b.bill_date AS day, b.bill_no, p.name AS patient, p.file_no, p.address,
             COALESCE(b.prescriber_name, 'Not recorded') AS prescriber, l.medicine_name AS medicine,
             l.schedule, l.batch_no, (${SIGN} * l.qty_units)::int AS qty_units
        FROM pharmacy_bill_lines l
        JOIN pharmacy_bills b ON b.id = l.bill_id
        JOIN patients p ON p.id = b.patient_id
       WHERE b.status = 'final' AND l.schedule IN ('H1', 'X', 'narcotic')
         AND b.bill_date BETWEEN $1::date AND $2::date
       ORDER BY b.bill_date, b.bill_no, l.line_no`,
    totals: [],
  },
  expiry_loss: {
    label: "Expiry and write-off loss",
    description:
      "Stock written off (expired, damaged, lost) and stock returned to vendors, at purchase cost.",
    dated: true,
    columns: [
      date("day", "Date"),
      text("kind", "What happened"),
      text("location", "Location"),
      text("medicine", "Medicine"),
      text("batch_no", "Batch"),
      date("expiry_date", "Expiry"),
      int("units", "Units"),
      money("cost", "Cost value"),
      text("reason", "Note"),
    ],
    sql: `
      SELECT ${istDay("m.at")} AS day,
             CASE m.kind WHEN 'vendor_return' THEN 'Returned to vendor'
                         WHEN 'expiry_writeoff' THEN 'Expired, written off'
                         ELSE 'Adjusted down' END AS kind,
             l.name AS location, md.name AS medicine, b.batch_no, b.expiry_date,
             (-m.delta_units)::int AS units,
             ROUND(-m.delta_units * b.purchase_rate / b.pack_size, 2) AS cost, m.reason
        FROM pharmacy_stock_movements m
        JOIN pharmacy_batches b ON b.id = m.batch_id
        JOIN pharmacy_medicines md ON md.id = m.medicine_id
        JOIN pharmacy_locations l ON l.id = m.location_id
       WHERE ${istDay("m.at")} BETWEEN $1::date AND $2::date
         AND (m.kind IN ('vendor_return', 'expiry_writeoff')
              OR (m.kind = 'adjustment' AND m.delta_units < 0))
       ORDER BY m.at, m.id`,
    totals: ["units", "cost"],
  },
  stock_value: {
    label: "Stock valuation",
    description: "Stock on hand now by location and medicine, at purchase cost and at MRP.",
    dated: false,
    columns: [
      text("location", "Location"),
      text("medicine", "Medicine"),
      int("units", "Units"),
      int("expired_units", "Expired units"),
      money("cost_value", "Cost value"),
      money("mrp_value", "MRP value"),
    ],
    sql: `
      SELECT l.name AS location, md.name AS medicine, SUM(s.qty_units)::int AS units,
             COALESCE(SUM(s.qty_units) FILTER (WHERE b.expiry_date <= $1::date), 0)::int AS expired_units,
             ROUND(SUM(s.qty_units * b.purchase_rate / b.pack_size), 2) AS cost_value,
             ROUND(SUM(s.qty_units * b.mrp / b.pack_size), 2) AS mrp_value
        FROM pharmacy_stock s
        JOIN pharmacy_batches b ON b.id = s.batch_id
        JOIN pharmacy_medicines md ON md.id = b.medicine_id
        JOIN pharmacy_locations l ON l.id = s.location_id
       WHERE s.qty_units > 0 AND $2::date IS NOT NULL
       GROUP BY l.kind, l.name, md.name
       ORDER BY (l.kind = 'main') DESC, l.name, md.name`,
    totals: ["units", "expired_units", "cost_value", "mrp_value"],
  },
  dues: {
    label: "Credit outstanding",
    description: "Pharmacy bills with money still due, oldest first.",
    dated: false,
    columns: [
      date("bill_date", "Bill date"),
      text("bill_no", "Bill"),
      text("patient", "Patient"),
      text("file_no", "File no"),
      text("phone", "Mobile"),
      int("age_days", "Days due"),
      money("net_amount", "Bill total"),
      money("due", "Due"),
    ],
    sql: `
      SELECT * FROM (
        SELECT b.bill_date, b.bill_no, p.name AS patient, p.file_no, p.phone,
               ($1::date - b.bill_date)::int AS age_days, b.net_amount, ${DUE_SQL} AS due
          FROM pharmacy_bills b
          JOIN patients p ON p.id = b.patient_id
         WHERE b.bill_type = 'invoice' AND b.status = 'final' AND b.pay_later
           AND b.paid_amount < b.net_amount
           AND $2::date IS NOT NULL
      ) d WHERE due > 0
      ORDER BY bill_date, bill_no`,
    totals: ["net_amount", "due"],
  },
  darpan: {
    label: "DARPAN reconciliation",
    description:
      "Scribe stock at the main pharmacy beside the latest DARPAN upload, for the medicines DARPAN items are linked to. Use it while both systems run.",
    dated: false,
    columns: [
      text("medicine", "Medicine"),
      text("darpan_items", "DARPAN item(s)"),
      text("darpan_qty", "DARPAN quantity"),
      int("scribe_units", "Scribe units"),
      text("unit", "Scribe unit"),
      text("status", "Status"),
    ],
    sql: `
      WITH darpan AS (
        SELECT k.medicine_key, string_agg(DISTINCT i.item_name, ', ') AS items, SUM(i.qty) AS qty
          FROM pharmacy_stock_items i
          JOIN pharmacy_stock_links k ON k.item_key = i.item_key
         WHERE i.in_latest
         GROUP BY k.medicine_key
      ), scribe AS (
        SELECT md.medicine_key, MIN(md.name) AS name, MIN(md.unit_label) AS unit,
               COALESCE(SUM(s.qty_units) FILTER (WHERE b.expiry_date > $1::date), 0)::int AS units
          FROM pharmacy_medicines md
          LEFT JOIN pharmacy_batches b ON b.medicine_id = md.id
          LEFT JOIN pharmacy_stock s ON s.batch_id = b.id
               AND s.location_id = (SELECT id FROM pharmacy_locations WHERE kind = 'main')
         WHERE md.is_active AND $2::date IS NOT NULL
         GROUP BY md.medicine_key
      )
      SELECT COALESCE(sc.name, d.medicine_key) AS medicine, d.items AS darpan_items,
             COALESCE(d.qty::text, 'Not in DARPAN') AS darpan_qty,
             COALESCE(sc.units, 0) AS scribe_units, sc.unit,
             CASE WHEN d.medicine_key IS NULL THEN 'Only in Scribe'
                  WHEN sc.medicine_key IS NULL THEN 'Not in the Scribe medicine list'
                  WHEN d.qty = sc.units THEN 'Same'
                  ELSE 'Different' END AS status
        FROM darpan d
        FULL JOIN scribe sc ON sc.medicine_key = d.medicine_key
       WHERE d.medicine_key IS NOT NULL OR sc.units > 0
       ORDER BY (CASE WHEN d.medicine_key IS NULL OR sc.medicine_key IS NULL OR d.qty <> sc.units
                      THEN 0 ELSE 1 END), 1`,
    totals: [],
  },
};

export const REPORT_LIST = Object.entries(REPORTS).map(([key, r]) => ({
  key,
  label: r.label,
  description: r.description,
  dated: r.dated,
  columns: r.columns,
}));

const MAX_DAYS = 366;
const MAX_ROWS = 5000;

function range({ from, to }) {
  const end = to ?? today();
  const start = from ?? end;
  if (start > end) throw httpError(400, "The From date must be on or before the To date");
  const days = (Date.parse(end) - Date.parse(start)) / 86400000;
  if (days > MAX_DAYS) throw httpError(400, `Choose at most ${MAX_DAYS} days at a time`);
  return [start, end];
}

const sumOf = (rows, key) =>
  Math.round(rows.reduce((sum, r) => sum + Number(r[key] ?? 0), 0) * 100) / 100;

export async function runReport(key, input = {}, db = pool) {
  const report = REPORTS[key];
  if (!report) throw httpError(404, "Report not found");
  const [from, to] = report.dated ? range(input) : [today(), today()];
  const { rows } = await db.query(`${report.sql} LIMIT ${MAX_ROWS + 1}`, [from, to]);
  if (rows.length > MAX_ROWS) {
    throw httpError(400, `This report has more than ${MAX_ROWS} rows. Choose a shorter period`);
  }
  return {
    key,
    label: report.label,
    description: report.description,
    dated: report.dated,
    from: report.dated ? from : null,
    to: report.dated ? to : null,
    columns: report.columns,
    rows,
    totals: Object.fromEntries(report.totals.map((k) => [k, sumOf(rows, k)])),
  };
}

export async function reportWorkbook(key, input = {}, db = pool) {
  const result = await runReport(key, input, db);
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(result.label.slice(0, 31));
  sheet.columns = result.columns.map((c) => ({
    header: c.label,
    key: c.key,
    width: c.type === "text" ? 28 : 14,
    style: c.type === "money" ? { numFmt: "#,##0.00" } : {},
  }));
  sheet.getRow(1).font = { bold: true };
  sheet.views = [{ state: "frozen", ySplit: 1 }];
  for (const row of result.rows) {
    sheet.addRow(
      Object.fromEntries(
        result.columns.map((c) => [
          c.key,
          c.type === "money" || c.type === "int"
            ? row[c.key] === null || row[c.key] === undefined
              ? null
              : Number(row[c.key])
            : row[c.key],
        ]),
      ),
    );
  }
  if (Object.keys(result.totals).length) {
    const total = sheet.addRow({ [result.columns[0].key]: "Total", ...result.totals });
    total.font = { bold: true };
  }
  const period = result.dated ? `_${result.from}_to_${result.to}` : `_${today()}`;
  return {
    buffer: Buffer.from(await workbook.xlsx.writeBuffer()),
    filename: `Pharmacy_${key}${period}.xlsx`,
  };
}

export async function pharmacyDashboard(db = pool) {
  const day = today();
  const [sales, collected, dues, credit, stock, expiry, recent] = await Promise.all([
    db.query(
      `SELECT count(*) FILTER (WHERE b.bill_type = 'invoice')::int AS bills,
              COALESCE(SUM(${SIGN} * b.net_amount), 0) AS net_sales
         FROM pharmacy_bills b WHERE b.status = 'final' AND b.bill_date = $1::date`,
      [day],
    ),
    db.query(
      `SELECT COALESCE(SUM(CASE WHEN direction = 'in' THEN amount ELSE -amount END), 0) AS net
         FROM pharmacy_payments WHERE ${istDay("received_at")} = $1::date AND mode <> 'deposit'`,
      [day],
    ),
    db.query(
      `SELECT count(*)::int AS bills, COALESCE(SUM(due), 0) AS due FROM (
         SELECT ${DUE_SQL} AS due FROM pharmacy_bills b
          WHERE b.bill_type = 'invoice' AND b.status = 'final' AND b.pay_later
            AND b.paid_amount < b.net_amount) d
        WHERE due > 0`,
    ),
    db.query(
      `SELECT count(*)::int AS pending FROM pharmacy_credit_requests WHERE status = 'pending'`,
    ),
    db.query(
      `SELECT count(*) FILTER (WHERE units = 0)::int AS out_of_stock,
              count(*) FILTER (WHERE units > 0 AND units < min_units)::int AS low
         FROM (
           SELECT md.min_stock_units AS min_units,
                  COALESCE((SELECT SUM(s.qty_units) FROM pharmacy_stock s
                              JOIN pharmacy_batches b ON b.id = s.batch_id
                              JOIN pharmacy_locations l ON l.id = s.location_id AND l.kind = 'main'
                             WHERE b.medicine_id = md.id AND b.expiry_date > $1::date), 0) AS units
             FROM pharmacy_medicines md
            WHERE md.is_active AND md.min_stock_units IS NOT NULL
         ) x`,
      [day],
    ),
    db.query(
      `SELECT count(*) FILTER (WHERE b.expiry_date <= $1::date)::int AS expired,
              count(*) FILTER (WHERE b.expiry_date > $1::date AND b.expiry_date <= $1::date + 30)::int
                AS within_30
         FROM pharmacy_stock s JOIN pharmacy_batches b ON b.id = s.batch_id
        WHERE s.qty_units > 0`,
      [day],
    ),
    db.query(
      `SELECT b.id, b.bill_no, b.bill_type, b.sale_type, b.net_amount, b.finalised_at,
              p.name AS patient_name
         FROM pharmacy_bills b JOIN patients p ON p.id = b.patient_id
        WHERE b.status = 'final'
        ORDER BY b.finalised_at DESC LIMIT 8`,
    ),
  ]);
  return {
    day,
    sales: sales.rows[0],
    collected: collected.rows[0].net,
    dues: dues.rows[0],
    pending_credit: credit.rows[0].pending,
    stock: stock.rows[0],
    expiry: expiry.rows[0],
    recent: recent.rows,
  };
}

const TOP_SORTS = {
  medicine_name: "lower(medicine_name)",
  company: "lower(company)",
  vendor_name: "lower(vendor_name)",
  sold_qty: "sold_qty",
  returned_qty: "returned_qty",
  net_qty: "net_qty",
  sale_amount: "sale_amount",
  return_amount: "return_amount",
  net_amount: "net_amount",
};

function topItemsQuery(input) {
  const [from, to] = range(input);
  const params = [from, to];
  const add = (value) => {
    params.push(value);
    return `$${params.length}`;
  };
  const where = ["b.status = 'final'", "b.bill_date BETWEEN $1::date AND $2::date"];
  if (input.location_id) where.push(`b.location_id = ${add(input.location_id)}`);
  if (input.sale_type) where.push(`b.sale_type = ${add(input.sale_type)}`);
  if (input.form) where.push(`m.form = ${add(input.form)}`);
  if (input.vendor_id) where.push(`bt.vendor_id = ${add(input.vendor_id)}`);
  if (input.q) {
    const $ = add(`%${input.q.toLowerCase()}%`);
    where.push(
      `(lower(m.name) LIKE ${$} OR lower(COALESCE(m.manufacturer, '')) LIKE ${$}
        OR lower(COALESCE(v.name, '')) LIKE ${$} OR lower(m.code) LIKE ${$})`,
    );
  }
  const split = input.group === "vendor";
  const vendorColumns = split
    ? "v.id AS vendor_id, MIN(v.name) AS vendor_name,"
    : "NULL::int AS vendor_id, string_agg(DISTINCT v.name, ', ' ORDER BY v.name) AS vendor_name,";
  const sort = TOP_SORTS[input.sort] ?? "net_amount";
  const dir = input.dir === "asc" ? "ASC" : "DESC";
  const sql = `
    WITH sold AS (
      SELECT m.id AS medicine_id, MIN(m.name) AS medicine_name, MIN(m.code) AS code,
             MIN(m.form) AS form, MIN(m.manufacturer) AS company, ${vendorColumns}
             MIN(m.unit_label) AS unit_label,
             COALESCE(SUM(l.qty_units) FILTER (WHERE b.bill_type = 'invoice'), 0)::int AS sold_qty,
             COALESCE(SUM(l.qty_units) FILTER (WHERE b.bill_type = 'credit_note'), 0)::int AS returned_qty,
             COALESCE(SUM(l.total) FILTER (WHERE b.bill_type = 'invoice'), 0) AS sale_amount,
             COALESCE(SUM(l.total) FILTER (WHERE b.bill_type = 'credit_note'), 0) AS return_amount
        FROM pharmacy_bill_lines l
        JOIN pharmacy_bills b ON b.id = l.bill_id
        JOIN pharmacy_medicines m ON m.id = l.medicine_id
        JOIN pharmacy_batches bt ON bt.id = l.batch_id
        LEFT JOIN pharmacy_vendors v ON v.id = bt.vendor_id
       WHERE ${where.join(" AND ")}
       GROUP BY ${split ? "m.id, v.id" : "m.id"}
    )
    SELECT *, (sold_qty - returned_qty) AS net_qty,
           (sale_amount - return_amount)::numeric(14, 2) AS net_amount,
           count(*) OVER()::int AS total,
           SUM(sold_qty) OVER() AS sum_sold_qty, SUM(returned_qty) OVER() AS sum_returned_qty,
           SUM(sale_amount) OVER() AS sum_sale_amount,
           SUM(return_amount) OVER() AS sum_return_amount
      FROM sold
     ORDER BY ${sort} ${dir} NULLS LAST, lower(medicine_name)`;
  return { sql, params, from, to };
}

export async function topItems(input = {}, db = pool) {
  const { sql, params, from, to } = topItemsQuery(input);
  params.push(input.limit ?? 50, input.offset ?? 0);
  const { rows } = await db.query(
    `${sql} LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  const first = rows[0];
  const sold = Number(first?.sum_sold_qty ?? 0);
  const returned = Number(first?.sum_returned_qty ?? 0);
  const sale = Number(first?.sum_sale_amount ?? 0);
  const back = Number(first?.sum_return_amount ?? 0);
  return {
    from,
    to,
    total: first?.total ?? 0,
    totals: {
      sold_qty: sold,
      returned_qty: returned,
      net_qty: sold - returned,
      sale_amount: sale.toFixed(2),
      return_amount: back.toFixed(2),
      net_amount: (sale - back).toFixed(2),
    },
    rows: rows.map(
      ({ total, sum_sold_qty, sum_returned_qty, sum_sale_amount, sum_return_amount, ...r }) => r,
    ),
  };
}

export async function topItemsWorkbook(input = {}, db = pool) {
  const { sql, params, from, to } = topItemsQuery(input);
  const { rows } = await db.query(`${sql} LIMIT 20000`, params);
  const split = input.group === "vendor";
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Top selling items");
  sheet.columns = [
    { key: "sno", header: "Sr no", width: 7 },
    { key: "medicine_name", header: "Item name", width: 36 },
    { key: "company", header: "Company", width: 22 },
    { key: "vendor_name", header: split ? "Supplier" : "Suppliers", width: 26 },
    { key: "sold_qty", header: "Sales quantity", width: 12 },
    { key: "returned_qty", header: "Return quantity", width: 12 },
    { key: "net_qty", header: "Net sales quantity", width: 14 },
    { key: "sale_amount", header: "Sale amount", width: 14, style: { numFmt: "#,##0.00" } },
    { key: "return_amount", header: "Return amount", width: 14, style: { numFmt: "#,##0.00" } },
    { key: "net_amount", header: "Net sales amount", width: 14, style: { numFmt: "#,##0.00" } },
  ];
  sheet.getRow(1).font = { bold: true };
  sheet.views = [{ state: "frozen", ySplit: 1 }];
  rows.forEach((r, i) =>
    sheet.addRow({
      ...r,
      sno: i + 1,
      sale_amount: Number(r.sale_amount),
      return_amount: Number(r.return_amount),
      net_amount: Number(r.net_amount),
    }),
  );
  return {
    buffer: Buffer.from(await workbook.xlsx.writeBuffer()),
    filename: `Pharmacy_top_items_${from}_to_${to}.xlsx`,
  };
}
