import pool from "../../config/db.js";
import { paise } from "../../../shared/labPayment.js";
import { NOTE_REQUIRED_REFUND_REASON, refundReasonLabel } from "../../../shared/refundReasons.js";
import { indiaToday } from "./categoryResolver.js";
import { cleanDate, likePattern, readNumber } from "./common.js";
import { MONEY_COLUMNS, moneyFrom, noteDue } from "./payments.js";
import { refundPreviewOf } from "./billingRequests.js";
import { httpError } from "./transaction.js";
import { AS_PAID } from "../../../shared/billingVocab.js";

export const REFUND_GROUPS = ["to_pay", "waiting", "rejected", "paid"];
const BOARD_LIMIT = 100;
const BOARD_LIMIT_MAX = 200;
const SEARCH_MAX = 100;
const IST_DAY = (column) => `(${column} AT TIME ZONE 'Asia/Kolkata')::date`;

const BOARD_SQL = `
  SELECT r.id, r.status, r.reason, r.reason_code, r.requested_mode, r.approved_mode,
         r.mode_reason, r.decision_note, r.requested_at, r.decided_at, r.refund_lines,
         r.bill_id, r.credit_note_id, r.requested_by, r.decided_by,
         COALESCE(r.visit_id, b.visit_id) AS visit_id,
         p.id AS patient_id, p.name AS patient_name, p.file_no,
         v.visit_date::text AS visit_date,
         b.bill_no, b.bill_date::text AS bill_date, b.pay_later,
         cn.bill_no AS credit_note_no, cn.version AS credit_note_version,
         cn.patient_payable AS note_payable, cn.paid_amount AS note_paid,
         rq.name AS requested_by_name, dq.name AS decided_by_name,
         po.paid_at, po.paid_by_name,
         ${IST_DAY("COALESCE(po.paid_at, r.decided_at)")}::text AS done_day,
         m.patient_payable, m.paid_in, m.credited, m.paid_out
    FROM billing_requests r
    JOIN bills b ON b.id = r.bill_id
    LEFT JOIN patients p ON p.id = COALESCE(r.patient_id, b.patient_id)
    LEFT JOIN giniflow_visits v ON v.id = COALESCE(r.visit_id, b.visit_id)
    LEFT JOIN bills cn ON cn.id = r.credit_note_id
    LEFT JOIN doctors rq ON rq.id = r.requested_by
    LEFT JOIN doctors dq ON dq.id = r.decided_by
    LEFT JOIN LATERAL (
      SELECT x.received_at AS paid_at, d.name AS paid_by_name
        FROM payments x LEFT JOIN doctors d ON d.id = x.received_by
       WHERE x.bill_id = cn.id
       ORDER BY x.received_at DESC, x.id DESC
       LIMIT 1
    ) po ON TRUE
    CROSS JOIN LATERAL (SELECT ${MONEY_COLUMNS} FROM bills b WHERE b.id = r.bill_id) m
   WHERE r.kind = 'refund'
     AND (r.status = 'pending'
          OR (r.status = 'approved' AND cn.id IS NOT NULL
              AND (cn.paid_amount < cn.patient_payable
                   OR ${IST_DAY("COALESCE(po.paid_at, r.decided_at)")} BETWEEN $1::date AND $2::date))
          OR (r.status = 'rejected' AND ${IST_DAY("r.decided_at")} BETWEEN $1::date AND $2::date))
     AND ($3::text IS NULL OR p.name ILIKE $3 OR p.file_no ILIKE $3 OR b.bill_no ILIKE $3
          OR cn.bill_no ILIKE $3)
   ORDER BY r.requested_at, r.id`;

const DISCOUNT_SQL = `
  SELECT NULL::uuid AS id, 'approved' AS status,
         'Discount after the bill was final: '
           || CASE WHEN cn.manual_discount_kind = 'percent'
                   THEN trim(trailing '.' FROM trim(trailing '0' FROM cn.manual_discount_value::text)) || '%'
                   ELSE '₹' || cn.manual_discount_value::text END
           || COALESCE(' — ' || cn.manual_discount_reason, '') AS reason,
         NULL::text AS reason_code, '${AS_PAID}' AS requested_mode, '${AS_PAID}' AS approved_mode,
         NULL::text AS mode_reason, NULL::text AS decision_note,
         cn.created_at AS requested_at, cn.created_at AS decided_at, NULL::jsonb AS refund_lines,
         b.id AS bill_id, cn.id AS credit_note_id,
         cn.manual_discount_by AS requested_by, cn.manual_discount_by AS decided_by,
         b.visit_id,
         p.id AS patient_id, p.name AS patient_name, p.file_no,
         v.visit_date::text AS visit_date,
         b.bill_no, b.bill_date::text AS bill_date, b.pay_later,
         cn.bill_no AS credit_note_no, cn.version AS credit_note_version,
         cn.patient_payable AS note_payable, cn.paid_amount AS note_paid,
         gv.name AS requested_by_name, gv.name AS decided_by_name,
         po.paid_at, po.paid_by_name,
         ${IST_DAY("COALESCE(po.paid_at, cn.created_at)")}::text AS done_day,
         m.patient_payable, m.paid_in, m.credited, m.paid_out
    FROM bills cn
    JOIN bills b ON b.id = cn.original_bill_id
    LEFT JOIN patients p ON p.id = b.patient_id
    LEFT JOIN giniflow_visits v ON v.id = b.visit_id
    LEFT JOIN doctors gv ON gv.id = cn.manual_discount_by
    LEFT JOIN LATERAL (
      SELECT x.received_at AS paid_at, d.name AS paid_by_name
        FROM payments x LEFT JOIN doctors d ON d.id = x.received_by
       WHERE x.bill_id = cn.id
       ORDER BY x.received_at DESC, x.id DESC
       LIMIT 1
    ) po ON TRUE
    CROSS JOIN LATERAL (SELECT ${MONEY_COLUMNS} FROM bills b WHERE b.id = cn.original_bill_id) m
   WHERE cn.bill_type = 'credit_note' AND cn.credit_kind = 'discount'
     AND (cn.paid_amount < cn.patient_payable
          OR ${IST_DAY("COALESCE(po.paid_at, cn.created_at)")} BETWEEN $1::date AND $2::date)
     AND ($3::text IS NULL OR p.name ILIKE $3 OR p.file_no ILIKE $3 OR b.bill_no ILIKE $3
          OR cn.bill_no ILIKE $3)
   ORDER BY cn.created_at, cn.id`;

const isDiscount = (row) => !row.id && Boolean(row.credit_note_id);

function cleanLimit(value) {
  const limit = readNumber(value, "Limit must be a whole number");
  if (limit === undefined) return BOARD_LIMIT;
  if (!Number.isInteger(limit) || limit <= 0) throw httpError(400, "Limit must be a whole number");
  return Math.min(limit, BOARD_LIMIT_MAX);
}

function cleanSearch(value) {
  const text = typeof value === "string" ? value.trim() : "";
  if (text.length > SEARCH_MAX) throw httpError(400, `Keep the search under ${SEARCH_MAX} letters`);
  return text.length >= 2 ? text : "";
}

function reasonOf(row) {
  const text = row.reason ?? "";
  const code = row.reason_code ?? null;
  if (!code) return { code: null, label: null, note: text || null, text };
  const label = refundReasonLabel(code);
  if (code === NOTE_REQUIRED_REFUND_REASON) return { code, label, note: text || null, text };
  const prefix = `${label} — `;
  const note = text.startsWith(prefix) ? text.slice(prefix.length) : text === label ? "" : text;
  return { code, label, note: note || null, text };
}

const person = (id, name) => (id === null || id === undefined ? null : { id, name: name ?? null });

function amountsOf(row) {
  if (!row.credit_note_id) return { credited: 0, paid_back: 0, to_pay: 0, against_balance: 0 };
  const credited = paise(row.note_payable);
  const paidBack = paise(row.note_paid);
  const toPay = noteDue(
    { patient_payable: row.note_payable, paid_amount: row.note_paid },
    moneyFrom(row),
  );
  return {
    credited,
    paid_back: paidBack,
    to_pay: toPay,
    against_balance: Math.max(0, credited - paidBack - toPay),
  };
}

function groupOf(row, amounts, range) {
  if (row.status === "pending") return "waiting";
  if (row.status === "rejected") return "rejected";
  if (amounts.to_pay > 0) return "to_pay";
  return row.done_day >= range.from && row.done_day <= range.to ? "paid" : null;
}

function shapeRow(row, group, amounts) {
  return {
    key: row.id ?? row.credit_note_id,
    kind: isDiscount(row) ? "discount" : "refund",
    request_id: row.id,
    status: row.status,
    group,
    patient: { id: row.patient_id, name: row.patient_name, file_no: row.file_no },
    visit_id: row.visit_id,
    visit_date: row.visit_date,
    bill_id: row.bill_id,
    bill_no: row.bill_no,
    bill_date: row.bill_date,
    pay_later: Boolean(row.pay_later),
    reason: reasonOf(row),
    requested_mode: row.requested_mode,
    approved_mode: row.approved_mode ?? null,
    mode_reason: row.mode_reason ?? null,
    requested_by: person(row.requested_by, row.requested_by_name),
    requested_at: row.requested_at,
    decided_by: person(row.decided_by, row.decided_by_name),
    decided_at: row.decided_at ?? null,
    decision_note: row.decision_note ?? null,
    credit_note: row.credit_note_id
      ? { id: row.credit_note_id, bill_no: row.credit_note_no, version: row.credit_note_version }
      : null,
    amounts,
    paid_at: row.paid_at ?? null,
    paid_by: row.paid_by_name ?? null,
    preview: null,
    preview_error: null,
  };
}

async function withPreview(entry, row, db) {
  const found = await refundPreviewOf(
    {
      bill_id: row.bill_id,
      refund: { lines: row.refund_lines, requested_mode: row.requested_mode },
    },
    db,
  );
  const due = found.preview?.refund.due ?? 0;
  const credited = found.preview?.totals.payable ?? 0;
  return {
    ...entry,
    preview: found.preview,
    preview_error: found.preview_error,
    amounts: {
      credited,
      paid_back: 0,
      to_pay: due,
      against_balance: found.preview?.refund.against_balance ?? 0,
    },
  };
}

const NEWEST_DECISION = (a, b) =>
  String(b.decided_at ?? "").localeCompare(String(a.decided_at ?? ""));
const NEWEST_PAID = (a, b) =>
  String(b.paid_at ?? b.decided_at ?? "").localeCompare(String(a.paid_at ?? a.decided_at ?? ""));
const OLDEST_DECISION = (a, b) =>
  String(a.decided_at ?? "").localeCompare(String(b.decided_at ?? ""));

const ORDER = {
  to_pay: OLDEST_DECISION,
  waiting: null,
  rejected: NEWEST_DECISION,
  paid: NEWEST_PAID,
};

export async function refundBoard(filters = {}, db = pool) {
  const today = indiaToday();
  const from = cleanDate(filters.from, "The start date") || today;
  const to = cleanDate(filters.to, "The end date") || (from > today ? from : today);
  if (from > to) throw httpError(400, "The start date is after the end date");
  const q = cleanSearch(filters.q);
  const limit = cleanLimit(filters.limit);
  const params = [from, to, q ? likePattern(q) : null];
  const [{ rows: requested }, { rows: discounts }] = await Promise.all([
    db.query(BOARD_SQL, params),
    db.query(DISCOUNT_SQL, params),
  ]);
  const rows = [...requested, ...discounts];

  const grouped = Object.fromEntries(REFUND_GROUPS.map((key) => [key, []]));
  for (const row of rows) {
    const amounts = amountsOf(row);
    if (isDiscount(row) && !amounts.to_pay && !amounts.paid_back) continue;
    const group = groupOf(row, amounts, { from, to });
    if (group) grouped[group].push({ row, entry: shapeRow(row, group, amounts) });
  }

  const toPayTotal = grouped.to_pay.reduce((sum, { entry }) => sum + entry.amounts.to_pay, 0);
  const groups = {};
  const counts = {};
  const more = {};
  for (const key of REFUND_GROUPS) {
    const sorted = ORDER[key]
      ? [...grouped[key]].sort((a, b) => ORDER[key](a.entry, b.entry))
      : grouped[key];
    counts[key] = sorted.length;
    more[key] = sorted.length > limit;
    groups[key] = sorted.slice(0, limit);
  }

  const waiting = [];
  for (const { row, entry } of groups.waiting) waiting.push(await withPreview(entry, row, db));

  return {
    from,
    to,
    q,
    counts,
    more,
    to_pay_total: toPayTotal,
    groups: {
      to_pay: groups.to_pay.map(({ entry }) => entry),
      waiting,
      rejected: groups.rejected.map(({ entry }) => entry),
      paid: groups.paid.map(({ entry }) => entry),
    },
  };
}
