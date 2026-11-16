import ExcelJS from "exceljs";
import pool from "../../config/db.js";
import { paise, rupeesFromPaise } from "../../../shared/labPayment.js";
import {
  AUDIT_BILL_KINDS,
  AUDIT_BILL_SORTS,
  AUDIT_CLAIM_STATUSES,
  AUDIT_DOCUMENTS,
  AUDIT_EXPORT_MAX,
  AUDIT_ITEM_KINDS,
  AUDIT_ITEM_SORTS,
  AUDIT_LINE_SOURCES,
  AUDIT_PAGE_SIZE,
  AUDIT_PAGE_SIZES,
  AUDIT_PAYMENT_MODES,
  AUDIT_PAYMENT_STATES,
  AUDIT_SEARCH_MAX,
  AUDIT_STATUSES,
  TIME_TEXT,
  auditRangeProblem,
  labelOf,
} from "../../../shared/billingAudit.js";
import { BILL_CONSULTANT_SQL } from "./billConsultant.js";
import { indiaToday } from "./categoryResolver.js";
import { cleanDate, cleanMoney, likePattern, wholeNumber } from "./common.js";
import { DUE_MONEY, DUE_OUTSTANDING } from "./dues.js";
import { generateBillPdf } from "./billPdf.js";
import { httpError } from "./transaction.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CODE_MAX = 40;
const BILL_AT = `COALESCE(b.finalised_at, b.created_at)`;
const LINE_ON_BILL = (l, b) =>
  `(${l}.is_live OR (${b}.status = 'cancelled' AND ${l}.updated_at = ${b}.cancelled_at))`;
const IST_DAY_TEXT = (col) => `to_char(${col} AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD HH24:MI')`;

const given = (value) => value !== undefined && value !== null && String(value).trim() !== "";

function cleanCode(value, label) {
  if (!given(value)) return null;
  const code = String(value).trim();
  if (/\s/.test(code) || code.length > CODE_MAX) {
    throw httpError(400, `${label} must be a code without spaces`);
  }
  return code;
}

function cleanChoice(value, list, label) {
  if (!given(value)) return null;
  const key = String(value).trim();
  if (!list.some((o) => o.value === key))
    throw httpError(400, `${label} is not one of the choices`);
  return key;
}

function cleanText(value, label, max = AUDIT_SEARCH_MAX) {
  if (!given(value)) return null;
  const text = String(value).trim();
  if (text.length > max)
    throw httpError(400, `${label} is too long — keep it under ${max} letters`);
  return text;
}

const cleanId = (value, label) => (given(value) ? wholeNumber(value, label, { min: 1 }) : null);

const moneyOrNull = (value, label) => (given(value) ? paise(cleanMoney(value, label)) : null);

function cleanTime(value, label) {
  if (!given(value)) return null;
  const time = String(value).trim();
  if (!TIME_TEXT.test(time)) throw httpError(400, `${label} must be a time like 09:30`);
  return time;
}

function cleanCommon(raw) {
  const today = indiaToday();
  const from = cleanDate(raw.from, "Start date") ?? today;
  const to = cleanDate(raw.to, "End date") ?? today;
  const range = {
    from,
    to,
    from_time: cleanTime(raw.from_time, "Start time"),
    to_time: cleanTime(raw.to_time, "End time"),
  };
  const problem = auditRangeProblem(range);
  if (problem) throw httpError(400, problem);
  const min = moneyOrNull(raw.min, "The smallest amount");
  const max = moneyOrNull(raw.max, "The largest amount");
  if (min !== null && max !== null && min > max) {
    throw httpError(400, "The smallest amount is more than the largest");
  }
  return {
    ...range,
    q: cleanText(raw.q, "The search"),
    group: cleanCode(raw.group, "Department"),
    document: cleanChoice(raw.document, AUDIT_DOCUMENTS, "Document"),
    status: cleanChoice(raw.status, AUDIT_STATUSES, "Bill status"),
    category: cleanCode(raw.category, "Category"),
    sub_category: cleanCode(raw.sub_category, "Sub-category"),
    min,
    max,
  };
}

export function cleanAuditBillFilters(input = {}) {
  const raw = input && typeof input === "object" ? input : {};
  return {
    ...cleanCommon(raw),
    kind: cleanChoice(raw.kind, AUDIT_BILL_KINDS, "Bill type"),
    payment: cleanChoice(raw.payment, AUDIT_PAYMENT_STATES, "Payment status"),
    consultant: cleanId(raw.consultant, "Doctor"),
    created_by: cleanId(raw.created_by, "Created by"),
    finalised_by: cleanId(raw.finalised_by, "Finalised by"),
    payer: cleanText(raw.payer, "Payer", 120),
    claim: cleanChoice(raw.claim, AUDIT_CLAIM_STATUSES, "Claim status"),
    mode: cleanChoice(raw.mode, AUDIT_PAYMENT_MODES, "Payment mode"),
    bill_no: cleanText(raw.bill_no, "Bill number", 60),
    sort: cleanChoice(raw.sort, AUDIT_BILL_SORTS, "Sort") ?? "newest",
  };
}

export function cleanAuditItemFilters(input = {}) {
  const raw = input && typeof input === "object" ? input : {};
  return {
    ...cleanCommon(raw),
    item: cleanText(raw.item, "Item"),
    kind: cleanChoice(raw.kind, AUDIT_ITEM_KINDS, "Item type"),
    subgroup: cleanCode(raw.subgroup, "Sub-department"),
    source: cleanChoice(raw.source, AUDIT_LINE_SOURCES, "Item source"),
    doctor: cleanId(raw.doctor, "Doctor"),
    sort: cleanChoice(raw.sort, AUDIT_ITEM_SORTS, "Sort") ?? "newest",
  };
}

function cleanPaging(input = {}) {
  const page = (given(input.page) && wholeNumber(input.page, "Page", { min: 1 })) || 1;
  const size = given(input.page_size)
    ? wholeNumber(input.page_size, "Rows per page", { min: 1 })
    : AUDIT_PAGE_SIZE;
  if (!AUDIT_PAGE_SIZES.includes(size)) {
    throw httpError(400, `Rows per page must be one of ${AUDIT_PAGE_SIZES.join(", ")}`);
  }
  return { page, size };
}

function binder() {
  const params = [];
  const bind = (value) => {
    params.push(value);
    return `$${params.length}`;
  };
  return { params, bind };
}

function rangeSql(f, bind) {
  const where = [`b.bill_date >= ${bind(f.from)}::date`, `b.bill_date <= ${bind(f.to)}::date`];
  if (f.from_time) {
    where.push(
      `${BILL_AT} >= ((${bind(f.from)}::date + ${bind(f.from_time)}::time) AT TIME ZONE 'Asia/Kolkata')`,
    );
  }
  if (f.to_time) {
    where.push(
      `${BILL_AT} < ((${bind(f.to)}::date + ${bind(f.to_time)}::time + interval '1 minute') AT TIME ZONE 'Asia/Kolkata')`,
    );
  }
  return where;
}

const BILL_NO_LIKE = (param) =>
  `EXISTS (SELECT 1 FROM unnest(COALESCE(bill_nos, '{}')) bn WHERE bn ILIKE ${param})`;

function searchSql(q, bind, { billNos = false } = {}) {
  const text = bind(likePattern(q));
  const digits = q.replace(/\D/g, "");
  const byPhone =
    digits.length >= 3
      ? ` OR regexp_replace(COALESCE(phone, ''), '\\D', '', 'g') LIKE ${bind(`%${digits}%`)}`
      : "";
  const byBill = billNos ? BILL_NO_LIKE(text) : `bill_no ILIKE ${text}`;
  return `(patient_name ILIKE ${text} OR file_no ILIKE ${text} OR health_id ILIKE ${text} OR ${byBill}${byPhone})`;
}

const PAYMENT_STATE_SQL = `CASE
  WHEN b.bill_type <> 'invoice' OR b.status <> 'final' THEN 'not_applicable'
  WHEN GREATEST(b.patient_payable - m.credited, 0) <= 0 AND b.paid_amount - m.refunded <= 0 THEN 'no_charge'
  WHEN ${DUE_OUTSTANDING} <= 0 THEN 'paid'
  WHEN b.paid_amount - m.refunded > 0 THEN 'partial'
  ELSE 'unpaid' END`;

const SCRIBE_SQL = (range) => `
  SELECT b.id, b.bill_no, b.bill_date::text AS bill_day, ${IST_DAY_TEXT(BILL_AT)} AS bill_at,
         b.patient_id AS pid, b.bill_date AS bday,
         b.bill_type, b.status, b.original_bill_id, ob.bill_no AS original_bill_no,
         b.pay_later, b.scheme_code, b.scheme_label, COALESCE(cs.parent_code, b.scheme_code) AS category,
         b.payer_name, b.claim_amount, b.claim_status, b.patient_age,
         b.actual_amount, b.discount_amount, b.manual_discount_reason, b.tax_amount, b.round_off,
         b.patient_payable, b.paid_amount, m.credited, m.refunded,
         CASE WHEN b.bill_type = 'invoice' AND b.status = 'final'
              THEN GREATEST(${DUE_OUTSTANDING}, 0) ELSE 0 END AS due,
         ${PAYMENT_STATE_SQL} AS scribe_payment_state,
         cons.id AS consultant_id, cons.name AS consultant_name,
         NULLIF(btrim(a.referred_by_doctor_name), '') AS referred_by,
         b.created_by, cb.name AS created_by_name, b.finalised_by, fb.name AS finalised_by_name,
         ub.name AS updated_by_name, xb.name AS cancelled_by_name, b.cancel_reason,
         ${IST_DAY_TEXT("b.cancelled_at")} AS cancelled_at,
         COALESCE(k.groups, '{}') AS groups, k.departments,
         CASE WHEN COALESCE(cardinality(k.kinds), 0) = 0 THEN 'none'
              WHEN cardinality(k.kinds) = 1 THEN k.kinds[1] ELSE 'mixed' END AS scribe_kind,
         COALESCE(pm.modes, '{}') AS modes, COALESCE(k.kinds, '{}') AS kind_list,
         COALESCE(k.dept_list, '{}') AS dept_list, b.created_at
    FROM bills b
    LEFT JOIN bills ob ON ob.id = b.original_bill_id
    LEFT JOIN patient_schemes cs ON cs.code = b.scheme_code
    LEFT JOIN appointments a ON a.id = b.appointment_id
    LEFT JOIN doctors cons ON cons.id = ${BILL_CONSULTANT_SQL("b")}
    LEFT JOIN doctors cb ON cb.id = b.created_by
    LEFT JOIN doctors fb ON fb.id = b.finalised_by
    LEFT JOIN doctors ub ON ub.id = b.updated_by
    LEFT JOIN doctors xb ON xb.id = b.cancelled_by
    ${DUE_MONEY}
    LEFT JOIN LATERAL (
      SELECT array_agg(DISTINCT COALESCE(si.kind, 'other')) AS kinds,
             array_agg(DISTINCT lower(l.group_code)) FILTER (WHERE l.group_code IS NOT NULL) AS groups,
             string_agg(DISTINCT sg.name, ', ') AS departments,
             array_agg(DISTINCT sg.name) FILTER (WHERE sg.name IS NOT NULL) AS dept_list
        FROM bill_lines l
        LEFT JOIN service_items si ON si.id = l.service_item_id
        LEFT JOIN service_groups sg ON lower(sg.code) = lower(l.group_code)
       WHERE l.bill_id = b.id AND ${LINE_ON_BILL("l", "b")}
    ) k ON TRUE
    LEFT JOIN LATERAL (
      SELECT array_agg(DISTINCT x.mode) AS modes FROM payments x
       WHERE x.bill_id = b.id AND x.voided_at IS NULL
    ) pm ON TRUE
   WHERE ${range.join(" AND ")}`;

const KIND_OF = (kinds) => `CASE WHEN COALESCE(cardinality(${kinds}), 0) = 0 THEN 'none'
  WHEN cardinality(${kinds}) = 1 THEN (${kinds})[1] ELSE 'mixed' END`;

const ONLY_ONE = (col) => `CASE WHEN COUNT(DISTINCT ${col}) = 1 THEN MIN(${col}) END`;
const NAMES_OF = (col) => `string_agg(DISTINCT ${col}, ', ')`;
const ALL_IN = (states) =>
  `bool_and(scribe_payment_state IN (${states.map((s) => `'${s}'`).join(", ")}))`;

const DAY_PAYMENT_STATE = `CASE
  WHEN ${ALL_IN(["not_applicable"])} THEN 'not_applicable'
  WHEN ${ALL_IN(["not_applicable", "no_charge"])} THEN 'no_charge'
  WHEN ${ALL_IN(["not_applicable", "no_charge", "paid"])} THEN 'paid'
  WHEN ${ALL_IN(["not_applicable", "no_charge", "unpaid"])} THEN 'unpaid'
  ELSE 'partial' END`;

const SCRIBE_DAY_SQL = `
  SELECT pid, bday, COUNT(*)::int AS scribe_count,
         json_agg(json_build_object('id', id, 'bill_no', bill_no, 'status', status, 'document', bill_type,
                                    'original_bill_no', original_bill_no, 'bill_at', bill_at,
                                    'payable', patient_payable)
                  ORDER BY bill_at, created_at, id) AS bill_list,
         array_remove(array_agg(bill_no ORDER BY bill_at, created_at, id), NULL) AS bill_nos,
         MIN(bill_at) AS first_at, MAX(bill_at) AS last_at,
         ${ONLY_ONE("bill_type")} AS bill_type, ${ONLY_ONE("status")} AS status,
         ${NAMES_OF("original_bill_no")} AS original_bill_no,
         bool_or(pay_later) AS pay_later, MAX(patient_age) AS patient_age,
         ${ONLY_ONE("category")} AS category, ${ONLY_ONE("scheme_code")} AS scheme_code,
         ${NAMES_OF("scheme_label")} AS scheme_label, ${NAMES_OF("payer_name")} AS payer_name,
         ${ONLY_ONE("claim_status")} AS claim_status,
         ${NAMES_OF("consultant_name")} AS consultant_name, ${NAMES_OF("referred_by")} AS referred_by,
         ${NAMES_OF("created_by_name")} AS created_by_name, ${NAMES_OF("finalised_by_name")} AS finalised_by_name,
         ${NAMES_OF("updated_by_name")} AS updated_by_name, ${NAMES_OF("cancelled_by_name")} AS cancelled_by_name,
         ${NAMES_OF("cancel_reason")} AS cancel_reason, MAX(cancelled_at) AS cancelled_at,
         ${NAMES_OF("manual_discount_reason")} AS manual_discount_reason,
         SUM(actual_amount) AS actual_amount, SUM(discount_amount) AS discount_amount,
         SUM(tax_amount) AS tax_amount, SUM(round_off) AS round_off,
         SUM(patient_payable) AS patient_payable, SUM(paid_amount) AS paid_amount,
         SUM(claim_amount) AS claim_amount, SUM(credited) AS credited, SUM(refunded) AS refunded,
         SUM(due) AS due,
         SUM(CASE WHEN bill_type = 'invoice' AND status <> 'cancelled' THEN patient_payable ELSE 0 END) AS day_payable,
         ${DAY_PAYMENT_STATE} AS scribe_payment_state
    FROM sb GROUP BY pid, bday`;

const SCRIBE_LISTS_SQL = `
  SELECT sb.pid, sb.bday,
         array_agg(DISTINCT x.v) FILTER (WHERE x.t = 'k') AS kinds,
         string_agg(DISTINCT x.v, ', ') FILTER (WHERE x.t = 'd') AS departments,
         array_agg(DISTINCT x.v) FILTER (WHERE x.t = 'm') AS modes
    FROM sb
    CROSS JOIN LATERAL (
      SELECT 'k' AS t, v FROM unnest(sb.kind_list) v
      UNION ALL SELECT 'd', v FROM unnest(sb.dept_list) v
      UNION ALL SELECT 'm', v FROM unnest(sb.modes) v
    ) x
   GROUP BY sb.pid, sb.bday`;

const AUDIT_ROWS_SQL = (range, scribeWhere) => `
  WITH sb AS MATERIALIZED (SELECT * FROM (${SCRIBE_SQL(range)}) s WHERE ${scribeWhere}),
  sd AS (${SCRIBE_DAY_SQL}),
  sl AS (${SCRIBE_LISTS_SQL})
  SELECT sd.*, sl.departments, COALESCE(sl.modes, '{}') AS modes,
         sd.pid || ':' || sd.bday AS row_key,
         p.id AS patient_id, p.name AS patient_name, p.file_no, p.health_id, p.sex, p.phone, p.address,
         COALESCE(sd.patient_age, p.age) AS age,
         sd.bday::text AS day_text,
         sd.scribe_payment_state AS payment_state,
         ${KIND_OF("sl.kinds")} AS bill_kind,
         sd.consultant_name AS doctor_name,
         sd.patient_payable AS primary_amount,
         sd.last_at AS sort_at, sd.first_at AS sort_first,
         sd.bill_nos[1] AS bill_no
    FROM sd
    LEFT JOIN sl ON sl.pid = sd.pid AND sl.bday = sd.bday
    JOIN patients p ON p.id = sd.pid`;

function scribeFilterSql(f, bind) {
  const where = [];
  if (f.group) where.push(`${bind(f.group.toLowerCase())} = ANY(groups)`);
  if (f.document) where.push(`bill_type = ${bind(f.document)}`);
  if (f.status) where.push(`status = ${bind(f.status)}`);
  if (f.category) where.push(`category = ${bind(f.category)}`);
  if (f.sub_category) where.push(`scheme_code = ${bind(f.sub_category)}`);
  if (f.consultant) where.push(`consultant_id = ${bind(f.consultant)}`);
  if (f.created_by) where.push(`created_by = ${bind(f.created_by)}`);
  if (f.finalised_by) where.push(`finalised_by = ${bind(f.finalised_by)}`);
  if (f.payer) where.push(`payer_name ILIKE ${bind(likePattern(f.payer))}`);
  if (f.claim) where.push(`claim_status = ${bind(f.claim)}`);
  if (f.mode) where.push(`${bind(f.mode)} = ANY(modes)`);
  return where;
}

function billFilterSql(f, bind) {
  const where = ["TRUE"];
  if (f.q) where.push(searchSql(f.q, bind, { billNos: true }));
  if (f.bill_no) where.push(BILL_NO_LIKE(bind(likePattern(f.bill_no))));
  if (f.kind) where.push(`bill_kind = ${bind(f.kind)}`);
  if (f.payment) where.push(`payment_state = ${bind(f.payment)}`);
  if (f.min !== null) where.push(`primary_amount >= ${bind(rupeesFromPaise(f.min))}::numeric`);
  if (f.max !== null) where.push(`primary_amount <= ${bind(rupeesFromPaise(f.max))}::numeric`);
  return where.join(" AND ");
}

const BILL_SORT = {
  newest: "sort_at DESC, row_key",
  oldest: "sort_first, row_key",
  payable: "primary_amount DESC NULLS LAST, sort_at DESC, row_key",
  due: "due DESC NULLS LAST, sort_at DESC, row_key",
};

function billQuery(f) {
  const { params, bind } = binder();
  const range = rangeSql(f, bind);
  const scribe = scribeFilterSql(f, bind);
  const where = billFilterSql(f, bind);
  const scribeWhere = scribe.length ? scribe.join(" AND ") : "TRUE";
  return {
    base: `SELECT * FROM (${AUDIT_ROWS_SQL(range, scribeWhere)}) audit WHERE ${where}`,
    params,
    bind,
  };
}

const money = (value) => paise(value ?? 0);
const moneyOrNone = (value) => (value === null || value === undefined ? null : paise(value));

const shapeBillOfDay = (bill) => ({
  id: bill.id,
  bill_no: bill.bill_no,
  status: bill.status,
  document: bill.document,
  original_bill_no: bill.original_bill_no,
  bill_at: bill.bill_at,
  payable: money(bill.payable),
});

export function shapeAuditBill(row) {
  const billsOfDay = (row.bill_list ?? []).map(shapeBillOfDay);
  return {
    row_key: row.row_key,
    bill_id: billsOfDay[0]?.id ?? null,
    bill_no: row.bill_no ?? null,
    bills: billsOfDay,
    bill_count: billsOfDay.length,
    bill_date: row.day_text,
    bill_at: row.first_at,
    last_bill_at: row.last_at,
    document: row.bill_type,
    original_bill_no: row.original_bill_no,
    status: row.status,
    payment_state: row.payment_state,
    bill_kind: row.bill_kind,
    departments: row.departments,
    pay_later: !!row.pay_later,
    category: row.category,
    sub_category: row.scheme_code,
    category_label: row.scheme_label,
    payer_name: row.payer_name,
    claim_status: row.claim_status,
    patient: {
      id: row.patient_id,
      name: row.patient_name,
      file_no: row.file_no,
      health_id: row.health_id,
      age: row.age,
      sex: row.sex,
      phone: row.phone,
      address: row.address,
    },
    consultant: row.doctor_name,
    referred_by: row.referred_by,
    created_by: row.created_by_name,
    finalised_by: row.finalised_by_name,
    updated_by: row.updated_by_name,
    cancelled_by: row.cancelled_by_name,
    cancelled_at: row.cancelled_at,
    cancel_reason: row.cancel_reason,
    discount_reason: row.manual_discount_reason,
    payment_modes: row.modes ?? [],
    amounts: {
      basic: money(row.actual_amount),
      discount: money(row.discount_amount),
      tax: money(row.tax_amount),
      round_off: money(row.round_off),
      payable: money(row.patient_payable),
      claim: money(row.claim_amount),
      paid: money(row.paid_amount),
      credited: money(row.credited),
      refunded: money(row.refunded),
      due: money(row.due),
    },
  };
}

const BILL_TOTALS_SQL = `COUNT(*) AS bills,
  COALESCE(SUM(scribe_count), 0) AS scribe_bills,
  COUNT(*) FILTER (WHERE scribe_count > 1) AS merged_days,
  COALESCE(SUM(actual_amount), 0) AS basic, COALESCE(SUM(discount_amount), 0) AS discount,
  COALESCE(SUM(tax_amount), 0) AS tax, COALESCE(SUM(patient_payable), 0) AS payable,
  COALESCE(SUM(paid_amount), 0) AS paid, COALESCE(SUM(credited), 0) AS credited,
  COALESCE(SUM(refunded), 0) AS refunded, COALESCE(SUM(due), 0) AS due`;

const shapeBillTotals = (row) => ({
  bills: Number(row.bills),
  scribe_bills: Number(row.scribe_bills),
  merged_days: Number(row.merged_days),
  basic: money(row.basic),
  discount: money(row.discount),
  tax: money(row.tax),
  payable: money(row.payable),
  paid: money(row.paid),
  credited: money(row.credited),
  refunded: money(row.refunded),
  due: money(row.due),
});

async function billPage(db, q, sort, { limit, offset = 0 }) {
  const sql = `WITH audit AS MATERIALIZED (${q.base}),
    page AS (SELECT * FROM audit ORDER BY ${sort} LIMIT ${q.bind(limit)} OFFSET ${q.bind(offset)})
    SELECT (SELECT row_to_json(t) FROM (SELECT ${BILL_TOTALS_SQL} FROM audit) t) AS totals,
           COALESCE((SELECT json_agg(page ORDER BY ${sort}) FROM page), '[]'::json) AS rows`;
  const { rows } = await db.query(sql, q.params);
  return { totals: shapeBillTotals(rows[0].totals), rows: rows[0].rows };
}

const OPTIONS_TTL_MS = 60 * 1000;
let optionsCache = { at: 0, value: null };

async function optionsOf(db) {
  if (db !== pool) return loadOptions(db);
  if (optionsCache.value && Date.now() - optionsCache.at < OPTIONS_TTL_MS) {
    return optionsCache.value;
  }
  const value = await loadOptions(db);
  optionsCache = { at: Date.now(), value };
  return value;
}

async function loadOptions(db) {
  const [schemes, groups, subgroups, doctors, staff] = await Promise.all([
    db.query(
      `SELECT code, label, parent_code FROM patient_schemes ORDER BY sort_order, lower(label), code`,
    ),
    db.query(`SELECT code, name FROM service_groups ORDER BY sort_order, lower(name), code`),
    db.query(
      `SELECT s.code, s.name, g.code AS group_code FROM service_subgroups s
         JOIN service_groups g ON g.id = s.group_id ORDER BY s.sort_order, lower(s.name), s.code`,
    ),
    db.query(
      `SELECT DISTINCT d.id, d.name FROM doctors d
        WHERE d.role = 'consultant' OR d.id IN (SELECT consultant_id FROM bills WHERE consultant_id IS NOT NULL)
        ORDER BY d.name`,
    ),
    db.query(
      `SELECT DISTINCT d.id, d.name FROM doctors d
        WHERE d.id IN (SELECT created_by FROM bills WHERE created_by IS NOT NULL
                       UNION SELECT finalised_by FROM bills WHERE finalised_by IS NOT NULL)
        ORDER BY d.name`,
    ),
  ]);
  return {
    categories: schemes.rows
      .filter((r) => !r.parent_code)
      .map((r) => ({ value: r.code, label: r.label })),
    sub_categories: schemes.rows
      .filter((r) => r.parent_code)
      .map((r) => ({ value: r.code, label: r.label, parent: r.parent_code })),
    groups: groups.rows.map((r) => ({ value: r.code, label: r.name })),
    subgroups: subgroups.rows.map((r) => ({ value: r.code, label: r.name, parent: r.group_code })),
    doctors: doctors.rows.map((r) => ({ value: String(r.id), label: r.name })),
    staff: staff.rows.map((r) => ({ value: String(r.id), label: r.name })),
  };
}

export async function listAuditBills(input = {}, db = pool) {
  const filters = cleanAuditBillFilters(input);
  const { page, size } = cleanPaging(input);
  const q = billQuery(filters);
  const [{ totals, rows }, options] = await Promise.all([
    billPage(db, q, BILL_SORT[filters.sort], { limit: size, offset: (page - 1) * size }),
    optionsOf(db),
  ]);
  return {
    filters,
    rows: rows.map(shapeAuditBill),
    totals,
    page,
    page_size: size,
    pages: Math.max(1, Math.ceil(totals.bills / size)),
    today: indiaToday(),
    options,
  };
}

const ITEMS_SQL = (range) => `
  SELECT l.id, l.bill_id, b.bill_no, b.bill_date::text AS bill_day, ${IST_DAY_TEXT(BILL_AT)} AS bill_at,
         b.bill_type, b.status, b.scheme_code, COALESCE(cs.parent_code, b.scheme_code) AS category,
         b.scheme_label, p.name AS patient_name, p.file_no, p.health_id, p.phone,
         l.bill_name, l.item_code, l.group_code, sg.name AS group_name, l.subgroup_code,
         ssg.name AS subgroup_name, COALESCE(si.kind, 'other') AS kind, l.source,
         l.doctor_id, d.name AS doctor_name, l.quantity, l.rate, l.actual_amount, l.discount,
         (COALESCE(l.cgst, 0) + COALESCE(l.sgst, 0)) AS tax, l.patient_payable, l.claim_amount
    FROM bill_lines l
    JOIN bills b ON b.id = l.bill_id
    JOIN patients p ON p.id = b.patient_id
    LEFT JOIN patient_schemes cs ON cs.code = b.scheme_code
    LEFT JOIN service_items si ON si.id = l.service_item_id
    LEFT JOIN service_groups sg ON lower(sg.code) = lower(l.group_code)
    LEFT JOIN service_subgroups ssg ON lower(ssg.code) = lower(l.subgroup_code) AND ssg.group_id = sg.id
    LEFT JOIN doctors d ON d.id = l.doctor_id
   WHERE ${LINE_ON_BILL("l", "b")} AND ${range.join(" AND ")}`;

function itemFilterSql(f, bind) {
  const where = ["TRUE"];
  if (f.q) where.push(searchSql(f.q, bind));
  if (f.item) {
    const text = bind(likePattern(f.item));
    where.push(`(bill_name ILIKE ${text} OR item_code ILIKE ${text})`);
  }
  if (f.kind) where.push(`kind = ${bind(f.kind)}`);
  if (f.group) where.push(`lower(group_code) = ${bind(f.group.toLowerCase())}`);
  if (f.subgroup) where.push(`lower(subgroup_code) = ${bind(f.subgroup.toLowerCase())}`);
  if (f.source) where.push(`source = ${bind(f.source)}`);
  if (f.doctor) where.push(`doctor_id = ${bind(f.doctor)}`);
  if (f.document) where.push(`bill_type = ${bind(f.document)}`);
  if (f.status) where.push(`status = ${bind(f.status)}`);
  if (f.category) where.push(`category = ${bind(f.category)}`);
  if (f.sub_category) where.push(`scheme_code = ${bind(f.sub_category)}`);
  if (f.min !== null) where.push(`patient_payable >= ${bind(rupeesFromPaise(f.min))}::numeric`);
  if (f.max !== null) where.push(`patient_payable <= ${bind(rupeesFromPaise(f.max))}::numeric`);
  return where.join(" AND ");
}

const ITEM_SORT = {
  newest: "bill_at DESC, bill_no DESC NULLS LAST, id",
  oldest: "bill_at, bill_no NULLS LAST, id",
  amount: "actual_amount DESC, bill_at DESC, id",
};

function itemQuery(f) {
  const { params, bind } = binder();
  const range = rangeSql(f, bind);
  const where = itemFilterSql(f, bind);
  return {
    base: `WITH audit AS (${ITEMS_SQL(range)}) SELECT * FROM audit WHERE ${where}`,
    params,
    bind,
  };
}

export function shapeAuditItem(row) {
  return {
    line_id: row.id,
    bill_id: row.bill_id,
    bill_no: row.bill_no,
    bill_date: row.bill_day,
    bill_at: row.bill_at,
    document: row.bill_type,
    status: row.status,
    category: row.category,
    category_label: row.scheme_label,
    patient: {
      name: row.patient_name,
      file_no: row.file_no,
      health_id: row.health_id,
      phone: row.phone,
    },
    item: row.bill_name,
    item_code: row.item_code,
    group: row.group_code,
    group_name: row.group_name,
    subgroup: row.subgroup_code,
    subgroup_name: row.subgroup_name,
    kind: row.kind,
    source: row.source,
    doctor: row.doctor_name,
    quantity: Number(row.quantity),
    amounts: {
      rate: money(row.rate),
      gross: money(row.actual_amount),
      discount: money(row.discount),
      tax: money(row.tax),
      payable: money(row.patient_payable),
      claim: money(row.claim_amount),
    },
  };
}

const ITEM_TOTALS_SQL = `COUNT(*) AS items, COUNT(DISTINCT bill_id) AS bills,
  COALESCE(SUM(quantity), 0) AS quantity, COALESCE(SUM(actual_amount), 0) AS gross,
  COALESCE(SUM(discount), 0) AS discount, COALESCE(SUM(tax), 0) AS tax,
  COALESCE(SUM(patient_payable), 0) AS payable, COALESCE(SUM(claim_amount), 0) AS claim`;

const shapeItemTotals = (row) => ({
  items: Number(row.items),
  bills: Number(row.bills),
  quantity: Number(row.quantity),
  gross: money(row.gross),
  discount: money(row.discount),
  tax: money(row.tax),
  payable: money(row.payable),
  claim: money(row.claim),
});

export async function listAuditItems(input = {}, db = pool) {
  const filters = cleanAuditItemFilters(input);
  const { page, size } = cleanPaging(input);
  const q = itemQuery(filters);
  const totalsRow = await db.query(`SELECT ${ITEM_TOTALS_SQL} FROM (${q.base}) t`, q.params);
  const totals = shapeItemTotals(totalsRow.rows[0]);
  const limit = q.bind(size);
  const offset = q.bind((page - 1) * size);
  const { rows } = await db.query(
    `${q.base} ORDER BY ${ITEM_SORT[filters.sort]} LIMIT ${limit} OFFSET ${offset}`,
    q.params,
  );
  return {
    filters,
    rows: rows.map(shapeAuditItem),
    totals,
    page,
    page_size: size,
    pages: Math.max(1, Math.ceil(totals.items / size)),
    today: indiaToday(),
    options: await optionsOf(db),
  };
}

const MONEY_FMT = { numFmt: "#,##0.00" };
const rupees = (value) => rupeesFromPaise(value ?? 0);

const BILL_COLUMNS = [
  { header: "Bill numbers", key: "bill_no", width: 24 },
  { header: "Bills", key: "bill_count", width: 8 },
  { header: "Bill date", key: "bill_date", width: 12 },
  { header: "Bill time (IST)", key: "bill_at", width: 18 },
  { header: "Document", key: "document", width: 12 },
  { header: "Original bill", key: "original_bill_no", width: 20 },
  { header: "Bill status", key: "status", width: 12 },
  { header: "Payment status", key: "payment_state", width: 14 },
  { header: "Bill type", key: "bill_kind", width: 18 },
  { header: "Department", key: "departments", width: 28 },
  { header: "UHID", key: "file_no", width: 14 },
  { header: "Health ID", key: "health_id", width: 18 },
  { header: "Patient", key: "patient_name", width: 26 },
  { header: "Age", key: "age", width: 6 },
  { header: "Sex", key: "sex", width: 8 },
  { header: "Contact", key: "phone", width: 14 },
  { header: "Address", key: "address", width: 32 },
  { header: "Doctor", key: "consultant", width: 22 },
  { header: "Referred by", key: "referred_by", width: 22 },
  { header: "Category", key: "category_label", width: 24 },
  { header: "Payer", key: "payer_name", width: 22 },
  { header: "Claim status", key: "claim_status", width: 14 },
  { header: "Payment modes", key: "payment_modes", width: 18 },
  { header: "Total amount (₹)", key: "basic", width: 14, style: MONEY_FMT },
  { header: "Discount (₹)", key: "discount", width: 13, style: MONEY_FMT },
  { header: "Discount %", key: "discount_pct", width: 11 },
  { header: "Tax (₹)", key: "tax", width: 12, style: MONEY_FMT },
  { header: "Payable (₹)", key: "payable", width: 13, style: MONEY_FMT },
  { header: "Claim (₹)", key: "claim", width: 12, style: MONEY_FMT },
  { header: "Paid (₹)", key: "paid", width: 12, style: MONEY_FMT },
  { header: "Credited (₹)", key: "credited", width: 13, style: MONEY_FMT },
  { header: "Refunded (₹)", key: "refunded", width: 13, style: MONEY_FMT },
  { header: "Due (₹)", key: "due", width: 12, style: MONEY_FMT },
  { header: "Discount reason", key: "discount_reason", width: 26 },
  { header: "Created by", key: "created_by", width: 18 },
  { header: "Finalised by", key: "finalised_by", width: 18 },
  { header: "Updated by", key: "updated_by", width: 18 },
  { header: "Cancelled by", key: "cancelled_by", width: 18 },
  { header: "Cancelled at", key: "cancelled_at", width: 18 },
  { header: "Cancel reason", key: "cancel_reason", width: 26 },
];

const BILL_MONEY = [
  "basic",
  "discount",
  "tax",
  "payable",
  "claim",
  "paid",
  "credited",
  "refunded",
  "due",
];

const ITEM_COLUMNS = [
  { header: "Bill number", key: "bill_no", width: 20 },
  { header: "Bill date", key: "bill_date", width: 12 },
  { header: "Bill time (IST)", key: "bill_at", width: 18 },
  { header: "Document", key: "document", width: 12 },
  { header: "Bill status", key: "status", width: 12 },
  { header: "UHID", key: "file_no", width: 14 },
  { header: "Patient", key: "patient_name", width: 26 },
  { header: "Item", key: "item", width: 32 },
  { header: "Item code", key: "item_code", width: 14 },
  { header: "Department", key: "group_name", width: 22 },
  { header: "Sub-department", key: "subgroup_name", width: 22 },
  { header: "Item type", key: "kind", width: 16 },
  { header: "Source", key: "source", width: 14 },
  { header: "Doctor", key: "doctor", width: 22 },
  { header: "Category", key: "category_label", width: 22 },
  { header: "Qty", key: "quantity", width: 6 },
  { header: "Rate (₹)", key: "rate", width: 12, style: MONEY_FMT },
  { header: "Gross (₹)", key: "gross", width: 12, style: MONEY_FMT },
  { header: "Discount (₹)", key: "discount", width: 13, style: MONEY_FMT },
  { header: "Discount %", key: "discount_pct", width: 11 },
  { header: "Tax (₹)", key: "tax", width: 12, style: MONEY_FMT },
  { header: "Payable (₹)", key: "payable", width: 13, style: MONEY_FMT },
  { header: "Claim (₹)", key: "claim", width: 12, style: MONEY_FMT },
];

const ITEM_MONEY = ["rate", "gross", "discount", "tax", "payable", "claim"];

const billKinds = (row, field, list) =>
  [...new Set(row.bills.map((b) => labelOf(list, b[field])))].join(", ");

function percentText(discount, total) {
  if (!discount || !total || total <= 0) return "";
  return `${Number(((discount * 100) / total).toFixed(1))}%`;
}

const sheetMoney = (source, keys) => Object.fromEntries(keys.map((k) => [k, rupees(source[k])]));

async function workbookOf(sheetName, columns, rows) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Gini Scribe";
  const ws = workbook.addWorksheet(sheetName, { views: [{ state: "frozen", ySplit: 1 }] });
  ws.columns = columns;
  ws.getRow(1).font = { bold: true };
  for (const row of rows) ws.addRow(row);
  return { ws, workbook };
}

const tooMany = (count, noun) =>
  httpError(
    409,
    `The report has ${count} ${noun}, more than the ${AUDIT_EXPORT_MAX} a file can hold — narrow the filters`,
  );

export async function exportAuditBills(input = {}, db = pool) {
  const filters = cleanAuditBillFilters(input);
  const q = billQuery(filters);
  const { totals, rows } = await billPage(db, q, BILL_SORT[filters.sort], {
    limit: AUDIT_EXPORT_MAX,
  });
  if (totals.bills > AUDIT_EXPORT_MAX) throw tooMany(totals.bills, "bills");
  const data = rows.map(shapeAuditBill).map((bill) => ({
    bill_no: bill.bills.map((b) => b.bill_no ?? "Draft").join(", "),
    bill_count: bill.bill_count,
    bill_date: bill.bill_date,
    bill_at: bill.bill_at,
    document: bill.document
      ? labelOf(AUDIT_DOCUMENTS, bill.document)
      : billKinds(bill, "document", AUDIT_DOCUMENTS),
    original_bill_no: bill.original_bill_no,
    status: bill.status
      ? labelOf(AUDIT_STATUSES, bill.status)
      : billKinds(bill, "status", AUDIT_STATUSES),
    payment_state: labelOf(AUDIT_PAYMENT_STATES, bill.payment_state),
    bill_kind: labelOf(AUDIT_BILL_KINDS, bill.bill_kind),
    departments: bill.departments,
    file_no: bill.patient.file_no,
    health_id: bill.patient.health_id,
    patient_name: bill.patient.name,
    age: bill.patient.age,
    sex: bill.patient.sex,
    phone: bill.patient.phone,
    address: bill.patient.address,
    consultant: bill.consultant,
    referred_by: bill.referred_by,
    category_label: bill.category_label,
    payer_name: bill.payer_name,
    claim_status: labelOf(AUDIT_CLAIM_STATUSES, bill.claim_status),
    payment_modes: bill.payment_modes.map((m) => labelOf(AUDIT_PAYMENT_MODES, m)).join(", "),
    discount_reason: bill.discount_reason,
    created_by: bill.created_by,
    finalised_by: bill.finalised_by,
    updated_by: bill.updated_by,
    cancelled_by: bill.cancelled_by,
    cancelled_at: bill.cancelled_at,
    cancel_reason: bill.cancel_reason,
    ...sheetMoney(bill.amounts, BILL_MONEY),
    discount_pct: percentText(bill.amounts.discount, bill.amounts.basic),
  }));
  const { ws, workbook } = await workbookOf("Bills", BILL_COLUMNS, data);
  const total = ws.addRow({
    bill_no: "Total",
    bill_count: totals.scribe_bills,
    patient_name: `${totals.bills} row${totals.bills === 1 ? "" : "s"}`,
    discount_pct: percentText(totals.discount, totals.basic),
    ...sheetMoney(
      totals,
      BILL_MONEY.filter((k) => k !== "claim"),
    ),
  });
  total.font = { bold: true };
  return {
    buffer: Buffer.from(await workbook.xlsx.writeBuffer()),
    fileName: `billing-audit-bills-${filters.from}-to-${filters.to}.xlsx`,
    count: totals.bills,
    filters,
  };
}

export async function exportAuditItems(input = {}, db = pool) {
  const filters = cleanAuditItemFilters(input);
  const q = itemQuery(filters);
  const totalsRow = await db.query(`SELECT ${ITEM_TOTALS_SQL} FROM (${q.base}) t`, q.params);
  const totals = shapeItemTotals(totalsRow.rows[0]);
  if (totals.items > AUDIT_EXPORT_MAX) throw tooMany(totals.items, "items");
  const { rows } = await db.query(`${q.base} ORDER BY ${ITEM_SORT[filters.sort]}`, q.params);
  const data = rows.map(shapeAuditItem).map((line) => ({
    bill_no: line.bill_no ?? "Draft",
    bill_date: line.bill_date,
    bill_at: line.bill_at,
    document: labelOf(AUDIT_DOCUMENTS, line.document),
    status: labelOf(AUDIT_STATUSES, line.status),
    file_no: line.patient.file_no,
    patient_name: line.patient.name,
    item: line.item,
    item_code: line.item_code,
    group_name: line.group_name ?? line.group,
    subgroup_name: line.subgroup_name ?? line.subgroup,
    kind: labelOf(AUDIT_ITEM_KINDS, line.kind),
    source: labelOf(AUDIT_LINE_SOURCES, line.source),
    doctor: line.doctor,
    category_label: line.category_label,
    quantity: line.quantity,
    ...sheetMoney(line.amounts, ITEM_MONEY),
    discount_pct: percentText(line.amounts.discount, line.amounts.gross),
  }));
  const { ws, workbook } = await workbookOf("Bill items", ITEM_COLUMNS, data);
  const total = ws.addRow({
    bill_no: "Total",
    item: `${totals.items} item${totals.items === 1 ? "" : "s"} on ${totals.bills} bill${totals.bills === 1 ? "" : "s"}`,
    quantity: totals.quantity,
    ...sheetMoney(totals, ["gross", "discount", "tax", "payable", "claim"]),
  });
  total.font = { bold: true };
  return {
    buffer: Buffer.from(await workbook.xlsx.writeBuffer()),
    fileName: `billing-audit-items-${filters.from}-to-${filters.to}.xlsx`,
    count: totals.items,
    filters,
  };
}

export async function auditBillPdf(billId, db = pool) {
  if (!UUID.test(String(billId || ""))) throw httpError(400, "That is not a bill id");
  const { rows } = await db.query(`SELECT id FROM bills WHERE id = $1`, [billId]);
  if (!rows.length) throw httpError(404, "Bill not found");
  return generateBillPdf(billId, {}, db);
}

const LOGGED_FILTERS = (filters = {}) =>
  Object.fromEntries(
    Object.entries(filters).filter(
      ([key, value]) => key !== "q" && value !== null && value !== undefined,
    ),
  );

export function logAuditAccess(doctorId, action, details = {}, db = pool) {
  const payload = {
    ...details,
    filters: details.filters ? LOGGED_FILTERS(details.filters) : undefined,
  };
  return db
    .query(
      `INSERT INTO audit_log (doctor_id, action, entity_type, entity_id, details)
       VALUES ($1, $2, 'bill', NULL, $3)`,
      [doctorId || null, action, JSON.stringify(payload)],
    )
    .catch(() => {});
}
