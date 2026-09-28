import ExcelJS from "exceljs";
import pool from "../../config/db.js";
import { paise, rupeesFromPaise } from "../../../shared/labPayment.js";
import {
  DUE_AGES,
  DUE_SORTS,
  DUES_PAGE_SIZE,
  DUES_PAGE_SIZE_MAX,
  YES_NO,
} from "../../../shared/billingVocab.js";
import { indiaToday } from "./categoryResolver.js";
import { cleanDate, cleanMoney, wholeNumber } from "./common.js";
import { httpError } from "./transaction.js";

export const DUE_MONEY = `CROSS JOIN LATERAL (
    SELECT COALESCE((SELECT SUM(c.patient_payable) FROM bills c
                      WHERE c.original_bill_id = b.id AND c.bill_type = 'credit_note'
                        AND c.status = 'final'), 0) AS credited,
           COALESCE((SELECT SUM(x.amount) FROM payments x JOIN bills c ON c.id = x.bill_id
                      WHERE c.original_bill_id = b.id AND c.bill_type = 'credit_note'
                        AND x.direction = 'out'), 0) AS refunded
  ) m`;

export const DUE_OUTSTANDING = `(GREATEST(b.patient_payable - m.credited, 0) - (b.paid_amount - m.refunded))`;

export const DUE_BILLS = `b.status = 'final' AND b.bill_type = 'invoice' AND b.paid_amount < b.patient_payable`;

export const DUE_DAYS = `((NOW() AT TIME ZONE 'Asia/Kolkata')::date - b.bill_date)`;

export const DUES_EXPORT_MAX = 20000;
export const DUES_SEARCH_MAX = 100;
const CODE_MAX = 40;

const DUE_SQL = `
  SELECT b.id, b.bill_no, b.bill_date, b.bill_date::text AS bill_day, b.visit_id, b.pay_later,
         b.scheme_code, b.scheme_label, COALESCE(cs.parent_code, b.scheme_code) AS category,
         b.created_at, p.id AS patient_id, p.name AS patient_name, p.file_no, p.phone,
         b.patient_payable, b.paid_amount, m.credited, m.refunded,
         ${DUE_OUTSTANDING} AS outstanding, ${DUE_DAYS} AS days
    FROM bills b
    JOIN patients p ON p.id = b.patient_id
    LEFT JOIN patient_schemes cs ON cs.code = b.scheme_code
    ${DUE_MONEY}
   WHERE ${DUE_BILLS}`;

const SORT_SQL = {
  oldest: "bill_date, created_at, id",
  largest: "outstanding DESC, bill_date, created_at, id",
};

const given = (value) => value !== undefined && value !== null && String(value).trim() !== "";

function cleanCode(value, label) {
  if (!given(value)) return null;
  const code = String(value).trim();
  if (/\s/.test(code) || code.length > CODE_MAX) {
    throw httpError(400, `${label} must be a code without spaces`);
  }
  return code;
}

function cleanChoice(value, keys, label) {
  if (!given(value)) return null;
  const key = String(value).trim();
  if (!keys.includes(key)) throw httpError(400, `${label} must be one of: ${keys.join(", ")}`);
  return key;
}

const moneyOrNull = (value, label) => (given(value) ? paise(cleanMoney(value, label)) : null);

export function cleanDuesFilters(input = {}) {
  const raw = input && typeof input === "object" ? input : {};
  const q = given(raw.q) ? String(raw.q).trim() : null;
  if (q && q.length > DUES_SEARCH_MAX) {
    throw httpError(400, `The search is too long — keep it under ${DUES_SEARCH_MAX} letters`);
  }
  const from = cleanDate(raw.from, "From");
  const to = cleanDate(raw.to, "To");
  if (from && to && from > to) throw httpError(400, "The start date is after the end date");
  const min = moneyOrNull(raw.min, "The smallest amount due");
  const max = moneyOrNull(raw.max, "The largest amount due");
  if (min !== null && max !== null && min > max) {
    throw httpError(400, "The smallest amount due is more than the largest");
  }
  return {
    q,
    from,
    to,
    age: cleanChoice(
      raw.age,
      DUE_AGES.map((a) => a.key),
      "Age",
    ),
    category: cleanCode(raw.category, "Category"),
    sub_category: cleanCode(raw.sub_category, "Sub-category"),
    min,
    max,
    pay_later: cleanChoice(raw.pay_later, YES_NO, "Pay later"),
    sort:
      cleanChoice(
        raw.sort,
        DUE_SORTS.map((s) => s.key),
        "Sort",
      ) ?? "oldest",
  };
}

function filterSql(f) {
  const where = ["outstanding > 0"];
  const params = [];
  const bind = (value) => {
    params.push(value);
    return `$${params.length}`;
  };
  if (f.q) {
    const text = bind(`%${f.q.replace(/[\\%_]/g, "\\$&")}%`);
    const digits = f.q.replace(/\D/g, "");
    const byPhone =
      digits.length >= 3
        ? ` OR regexp_replace(COALESCE(phone, ''), '\\D', '', 'g') LIKE ${bind(`%${digits}%`)}`
        : "";
    where.push(
      `(patient_name ILIKE ${text} OR file_no ILIKE ${text} OR bill_no ILIKE ${text}${byPhone})`,
    );
  }
  if (f.from) where.push(`bill_date >= ${bind(f.from)}::date`);
  if (f.to) where.push(`bill_date <= ${bind(f.to)}::date`);
  if (f.age) {
    const age = DUE_AGES.find((a) => a.key === f.age);
    where.push(`days >= ${bind(age.min)}::int`);
    if (age.max !== null) where.push(`days <= ${bind(age.max)}::int`);
  }
  if (f.category) where.push(`category = ${bind(f.category)}`);
  if (f.sub_category) where.push(`scheme_code = ${bind(f.sub_category)}`);
  if (f.min !== null) where.push(`outstanding >= ${bind(rupeesFromPaise(f.min))}::numeric`);
  if (f.max !== null) where.push(`outstanding <= ${bind(rupeesFromPaise(f.max))}::numeric`);
  if (f.pay_later) where.push(`pay_later = ${bind(f.pay_later === "yes")}`);
  return { sql: where.join(" AND "), params, bind };
}

export function shapeDue(row) {
  const payable = paise(row.patient_payable);
  const credited = paise(row.credited);
  const paid = paise(row.paid_amount);
  const refunded = paise(row.refunded);
  return {
    bill_id: row.id,
    bill_no: row.bill_no,
    bill_date: row.bill_day,
    visit_id: row.visit_id,
    pay_later: row.pay_later,
    category: row.category,
    sub_category: row.scheme_code,
    category_label: row.scheme_label,
    patient: {
      id: row.patient_id,
      name: row.patient_name,
      file_no: row.file_no,
      phone: row.phone,
    },
    payable,
    credited,
    paid,
    refunded,
    outstanding: Math.max(0, payable - credited) - (paid - refunded),
    days: Number(row.days),
  };
}

const shapeTotals = (row) => ({
  bills: Number(row.bills),
  payable: paise(row.payable),
  credited: paise(row.credited),
  paid: paise(row.paid),
  refunded: paise(row.refunded),
  outstanding: paise(row.outstanding),
});

async function totalsOf(db, where) {
  const { rows } = await db.query(
    `WITH due AS (${DUE_SQL})
     SELECT COUNT(*) AS bills, COALESCE(SUM(patient_payable), 0) AS payable,
            COALESCE(SUM(credited), 0) AS credited, COALESCE(SUM(paid_amount), 0) AS paid,
            COALESCE(SUM(refunded), 0) AS refunded, COALESCE(SUM(outstanding), 0) AS outstanding
       FROM due WHERE ${where.sql}`,
    where.params,
  );
  return shapeTotals(rows[0]);
}

async function optionsOf(db) {
  const { rows } = await db.query(
    `SELECT code, label, parent_code FROM patient_schemes
      ORDER BY sort_order, lower(label), code`,
  );
  return {
    categories: rows
      .filter((row) => !row.parent_code)
      .map((row) => ({ value: row.code, label: row.label })),
    sub_categories: rows
      .filter((row) => row.parent_code)
      .map((row) => ({ value: row.code, label: row.label, parent: row.parent_code })),
  };
}

function cleanPaging(input = {}) {
  const page = wholeNumber(input.page, "Page", { min: 1 }) ?? 1;
  const size =
    wholeNumber(input.page_size, "Page size", { min: 1, max: DUES_PAGE_SIZE_MAX }) ??
    DUES_PAGE_SIZE;
  return { page, size };
}

export async function listDuesRegister(input = {}, db = pool) {
  const filters = cleanDuesFilters(input);
  const { page, size } = cleanPaging(input);
  const where = filterSql(filters);
  const totals = await totalsOf(db, where);
  const limit = where.bind(size);
  const offset = where.bind((page - 1) * size);
  const { rows } = await db.query(
    `WITH due AS (${DUE_SQL})
     SELECT * FROM due WHERE ${where.sql}
      ORDER BY ${SORT_SQL[filters.sort]} LIMIT ${limit} OFFSET ${offset}`,
    where.params,
  );
  return {
    filters,
    rows: rows.map(shapeDue),
    totals,
    page,
    page_size: size,
    pages: Math.max(1, Math.ceil(totals.bills / size)),
    today: indiaToday(),
    options: await optionsOf(db),
  };
}

export async function duesToday(db = pool) {
  const today = indiaToday();
  const where = filterSql({ ...cleanDuesFilters({}), from: today, to: today });
  const { rows } = await db.query(
    `WITH due AS (${DUE_SQL})
     SELECT * FROM due WHERE ${where.sql} ORDER BY ${SORT_SQL.oldest}`,
    where.params,
  );
  const shaped = rows.map(shapeDue);
  return {
    date: today,
    rows: shaped,
    totals: {
      bills: shaped.length,
      outstanding: shaped.reduce((sum, row) => sum + row.outstanding, 0),
    },
  };
}

const COLUMNS = [
  { header: "Bill number", key: "bill_no", width: 20 },
  { header: "Bill date", key: "bill_date", width: 12 },
  { header: "Days", key: "days", width: 8 },
  { header: "Patient", key: "patient_name", width: 28 },
  { header: "UHID", key: "file_no", width: 14 },
  { header: "Phone", key: "phone", width: 14 },
  { header: "Category", key: "category_label", width: 26 },
  { header: "Pay later", key: "pay_later", width: 10 },
  { header: "Payable (₹)", key: "payable", width: 14, style: { numFmt: "#,##0.00" } },
  { header: "Credited (₹)", key: "credited", width: 14, style: { numFmt: "#,##0.00" } },
  { header: "Paid (₹)", key: "paid", width: 14, style: { numFmt: "#,##0.00" } },
  { header: "Refunded (₹)", key: "refunded", width: 14, style: { numFmt: "#,##0.00" } },
  { header: "Due (₹)", key: "outstanding", width: 14, style: { numFmt: "#,##0.00" } },
];

const MONEY_KEYS = ["payable", "credited", "paid", "refunded", "outstanding"];

const sheetMoney = (source) =>
  Object.fromEntries(MONEY_KEYS.map((key) => [key, rupeesFromPaise(source[key])]));

export async function exportDues(input = {}, db = pool) {
  const filters = cleanDuesFilters(input);
  const where = filterSql(filters);
  const totals = await totalsOf(db, where);
  if (totals.bills > DUES_EXPORT_MAX) {
    throw httpError(
      409,
      `The list has ${totals.bills} bills, more than the ${DUES_EXPORT_MAX} a file can hold — narrow the filters`,
    );
  }
  const { rows } = await db.query(
    `WITH due AS (${DUE_SQL})
     SELECT * FROM due WHERE ${where.sql} ORDER BY ${SORT_SQL[filters.sort]}`,
    where.params,
  );
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Gini Scribe";
  const ws = workbook.addWorksheet("Dues", { views: [{ state: "frozen", ySplit: 1 }] });
  ws.columns = COLUMNS;
  ws.getRow(1).font = { bold: true };
  for (const due of rows.map(shapeDue)) {
    ws.addRow({
      bill_no: due.bill_no,
      bill_date: due.bill_date,
      days: due.days,
      patient_name: due.patient.name,
      file_no: due.patient.file_no,
      phone: due.patient.phone,
      category_label: due.category_label,
      pay_later: due.pay_later ? "Yes" : "No",
      ...sheetMoney(due),
    });
  }
  const total = ws.addRow({
    bill_no: "Total",
    patient_name: `${totals.bills} bill${totals.bills === 1 ? "" : "s"}`,
    ...sheetMoney(totals),
  });
  total.font = { bold: true };
  return {
    buffer: Buffer.from(await workbook.xlsx.writeBuffer()),
    fileName: `dues-${indiaToday()}.xlsx`,
    totals,
  };
}
