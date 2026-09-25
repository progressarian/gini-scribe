import pool from "../../config/db.js";
import { paise } from "../../../shared/labPayment.js";
import { BILLING_ROLES } from "../../../shared/billingVocab.js";
import { ROLES } from "../../../shared/permissions.js";
import { KINDS as REQUEST_KINDS } from "./billingRequests.js";
import { PAYMENT_MODES } from "./cashShifts.js";
import { indiaToday } from "./categoryResolver.js";
import { httpError } from "./transaction.js";
import {
  cleanFilters,
  dayOfInstant,
  FILTER_LABELS,
  IST,
  PERIODS,
  periodOf,
  RANGE_DAYS_MAX,
  reportScope,
} from "./reportsFilters.js";

export const ROW_CAP = 2000;

const SIGN = `(CASE WHEN b.bill_type = 'credit_note' THEN -1 ELSE 1 END)`;
const FINAL = `b.status = 'final'`;
const SCHEME_JOIN = `LEFT JOIN patient_schemes cs ON cs.code = b.scheme_code`;
const VISIT_JOIN = `LEFT JOIN giniflow_visits v ON v.id = b.visit_id
  LEFT JOIN appointments a ON a.id = b.appointment_id`;
const CATEGORY = `COALESCE(cs.parent_code, b.scheme_code)`;
const LINE_CONSULTANT = `COALESCE(l.doctor_id, a.doctor_id, v.assigned_doctor_id)`;
const BILL_CONSULTANT = `COALESCE(
  (SELECT x.doctor_id FROM bill_lines x
    WHERE x.bill_id = COALESCE(b.original_bill_id, b.id) AND x.doctor_id IS NOT NULL
    ORDER BY x.line_no LIMIT 1),
  a.doctor_id, v.assigned_doctor_id)`;
const TODAY = `(NOW() AT TIME ZONE '${IST}')::date`;

const LINE_COLUMNS = {
  day: { date: "b.bill_date" },
  category: CATEGORY,
  sub_category: "b.scheme_code",
  group: "l.group_code",
  subgroup: "l.subgroup_code",
  consultant: LINE_CONSULTANT,
  user: "b.finalised_by",
};

const LINES_FROM = `bills b JOIN bill_lines l ON l.bill_id = b.id ${SCHEME_JOIN} ${VISIT_JOIN}`;

const LINE_AMOUNTS = `
  ${SIGN} * l.quantity AS quantity,
  CASE WHEN b.bill_type = 'invoice' THEN l.actual_amount ELSE 0 END AS invoiced,
  CASE WHEN b.bill_type = 'credit_note' THEN l.actual_amount ELSE 0 END AS credited,
  ${SIGN} * l.actual_amount AS actual,
  ${SIGN} * l.discount AS discount,
  ${SIGN} * (l.cgst + l.sgst) AS tax,
  ${SIGN} * l.patient_payable AS patient,
  ${SIGN} * l.claim_amount AS claim,
  ${SIGN} * l.adjustment_amount AS adjustment`;

const LINE_SUMS = `
  COUNT(*) AS lines,
  SUM(quantity) AS quantity,
  SUM(invoiced) AS invoiced,
  SUM(credited) AS credited,
  SUM(actual) AS actual,
  SUM(discount) AS discount,
  SUM(tax) AS tax,
  SUM(patient) AS patient,
  SUM(claim) AS claim,
  SUM(adjustment) AS adjustment`;

const col = (key, label, kind = "money") => ({ key, label, kind });

const LINE_MONEY = [
  col("invoiced", "Billed"),
  col("credited", "Credited back"),
  col("actual", "Actual (net)"),
  col("discount", "Discount"),
  col("tax", "Tax"),
  col("patient", "Patient share"),
  col("claim", "To be claimed"),
  col("adjustment", "Adjusted"),
];

const READ = {
  money: (value) => paise(value),
  count: (value) => Number(value ?? 0),
  quantity: (value) => Number(value ?? 0),
  days: (value) => (value === null || value === undefined ? null : Number(value)),
  limit: (value) => (value === null || value === undefined ? null : Number(value)),
  percent: (value) => (value === null || value === undefined ? null : Number(value)),
  text: (value) => value ?? null,
  date: (value) => value ?? null,
  instant: (value) => value ?? null,
  flag: (value) => Boolean(value),
};

function shapeRow(row, columns) {
  const out = {};
  for (const column of columns) out[column.key] = READ[column.kind](row[column.key]);
  if (row.depth !== undefined) out.depth = row.depth;
  return out;
}

const TOTALLED = new Set(["money", "count", "quantity"]);

function section(key, title, columns, rows, total, extra = {}) {
  return {
    key,
    title,
    columns,
    rows: rows.map((row) => shapeRow(row, columns)),
    total: total
      ? shapeRow(
          total,
          columns.filter((column) => TOTALLED.has(column.kind)),
        )
      : null,
    ...extra,
  };
}

const rolledFlags = (dims) => dims.map((dim) => `GROUPING(${dim}) AS ${dim}_rolled`).join(", ");

const openDims = (row, dims) => dims.filter((dim) => Number(row[`${dim}_rolled`]) === 0);

function splitSets(rows, dims) {
  const sets = new Map();
  let total = null;
  for (const row of rows) {
    const open = openDims(row, dims);
    if (!open.length) {
      total = row;
      continue;
    }
    const key = open.join("+");
    if (!sets.has(key)) sets.set(key, []);
    sets.get(key).push(row);
  }
  return { sets, total };
}

function splitRollup(rows, dims) {
  let total = null;
  const kept = [];
  for (const row of rows) {
    const depth = openDims(row, dims).length;
    if (depth === 0) total = row;
    else kept.push({ ...row, depth });
  }
  return { rows: kept, total };
}

function rollupOrder(dims, sortKeys) {
  return dims
    .map((dim, index) => `r.${dim}_rolled${index ? " DESC" : ""}, ${sortKeys[dim]}`)
    .join(", ");
}

const NAMED = {
  category: (row) => (row.category === null ? "No category" : (row.category_label ?? row.category)),
  sub_category: (row) =>
    row.sub_category === null
      ? "No category"
      : row.sub_category === row.category
        ? `${row.category_label ?? row.category} (no sub-category)`
        : (row.sub_category_label ?? row.sub_category),
  consultant: (row) =>
    row.consultant === null ? "No consultant" : (row.consultant_name ?? `#${row.consultant}`),
  user: (row, key = "user") =>
    row[key] === null ? "Nobody recorded" : (row[`${key}_name`] ?? `#${row[key]}`),
};

async function revenueItems(filters, db) {
  const scope = reportScope(filters, LINE_COLUMNS);
  const byPeriod = filters.period !== "none";
  const dims = [...(byPeriod ? ["period"] : []), "gkey", "skey", "item"];
  const { rows } = await db.query(
    `WITH base AS (
       SELECT ${periodOf(filters, "b.bill_date")} AS period,
              lower(l.group_code) AS gkey, l.group_code,
              lower(l.subgroup_code) AS skey, l.subgroup_code,
              l.service_item_id AS item, l.item_code, l.bill_name, ${LINE_AMOUNTS}
         FROM ${LINES_FROM}
        WHERE ${FINAL} AND ${scope.sql}
     ), rolled AS (
       SELECT ${dims.join(", ")}, ${rolledFlags(dims)},
              MAX(group_code) AS group_code, MAX(subgroup_code) AS subgroup_code,
              MAX(item_code) AS item_code, MAX(bill_name) AS item_name, ${LINE_SUMS}
         FROM base
        GROUP BY ROLLUP (${dims.join(", ")})
     )
     SELECT r.*, ${byPeriod ? "r.period::text" : "NULL"} AS period_start,
            g.name AS group_name, s.name AS subgroup_name
       FROM rolled r
       LEFT JOIN service_groups g ON lower(g.code) = r.gkey
       LEFT JOIN service_subgroups s ON lower(s.code) = r.skey
      ORDER BY ${rollupOrder(dims, {
        period: "r.period",
        gkey: "lower(COALESCE(g.name, r.gkey)), r.gkey",
        skey: "lower(COALESCE(s.name, r.skey)), r.skey",
        item: "lower(r.item_name), r.item",
      })}`,
    scope.params,
  );
  const split = splitRollup(rows, dims);
  const levels = byPeriod ? ["period", "group", "subgroup", "item"] : ["group", "subgroup", "item"];
  const labelled = split.rows.map((row) => {
    const level = levels[row.depth - 1];
    const label = {
      period: row.period_start,
      group: row.group_name ?? row.group_code ?? "No group",
      subgroup: row.subgroup_name ?? row.subgroup_code ?? "No subgroup",
      item: row.item_name,
    }[level];
    return {
      ...row,
      level,
      label,
      code:
        { group: row.group_code, subgroup: row.subgroup_code, item: row.item_code }[level] ?? null,
    };
  });
  return [
    section(
      "items",
      "Group › subgroup › item",
      [
        col("level", "Level", "text"),
        ...(byPeriod ? [col("period_start", periodLabel(filters.period), "date")] : []),
        col("label", "Name", "text"),
        col("code", "Code", "text"),
        col("group_code", "Group code", "text"),
        col("subgroup_code", "Subgroup code", "text"),
        col("lines", "Lines", "count"),
        col("quantity", "Quantity", "quantity"),
        ...LINE_MONEY,
      ],
      labelled,
      split.total,
    ),
  ];
}

const periodLabel = (period) => ({ day: "Day", week: "Week of", month: "Month" })[period];

async function revenueConsultants(filters, db) {
  const scope = reportScope(filters, LINE_COLUMNS);
  const dims = ["consultant"];
  const { rows } = await db.query(
    `WITH base AS (
       SELECT ${LINE_CONSULTANT} AS consultant, ${LINE_AMOUNTS},
              CASE WHEN si.kind = 'consultation' THEN 'consultation'
                   WHEN l.lab_order_id IS NOT NULL OR si.kind = 'test' THEN 'test'
                   ELSE 'other' END AS kind
         FROM ${LINES_FROM}
         LEFT JOIN service_items si ON si.id = l.service_item_id
        WHERE ${FINAL} AND ${scope.sql}
     ), rolled AS (
       SELECT consultant, ${rolledFlags(dims)}, ${LINE_SUMS},
              SUM(actual) FILTER (WHERE kind = 'consultation') AS consultations,
              SUM(actual) FILTER (WHERE kind = 'test') AS tests,
              SUM(actual) FILTER (WHERE kind = 'other') AS other
         FROM base
        GROUP BY ROLLUP (consultant)
     )
     SELECT r.*, d.name AS consultant_name
       FROM rolled r LEFT JOIN doctors d ON d.id = r.consultant
      ORDER BY ${rollupOrder(dims, { consultant: "r.consultant IS NULL, lower(d.name), r.consultant" })}`,
    scope.params,
  );
  const split = splitRollup(rows, dims);
  return [
    section(
      "consultants",
      "By consultant",
      [
        col("label", "Consultant", "text"),
        col("lines", "Lines", "count"),
        col("consultations", "Consultations"),
        col("tests", "Tests"),
        col("other", "Other items"),
        ...LINE_MONEY,
      ],
      split.rows.map((row) => ({ ...row, label: NAMED.consultant(row) })),
      split.total,
    ),
  ];
}

const BILL_COLUMNS = {
  day: { date: "b.bill_date" },
  category: CATEGORY,
  sub_category: "b.scheme_code",
  user: "b.finalised_by",
};

const COLLECTED_NOTE =
  "Collected is what was paid on these bills, less what went back on their credit notes, whenever it was paid — the Collections report counts money on the day it was taken";

async function revenueCategories(filters, db) {
  const scope = reportScope(filters, BILL_COLUMNS);
  const dims = ["category", "sub_category"];
  const { rows } = await db.query(
    `WITH picked AS (
       SELECT b.id, b.bill_type, ${CATEGORY} AS category, b.scheme_code AS sub_category,
              ${SIGN} AS sign, b.round_off, b.patient_payable
         FROM bills b ${SCHEME_JOIN}
        WHERE ${FINAL} AND ${scope.sql}
     ), lined AS (
       SELECT l.bill_id, SUM(l.actual_amount) AS actual, SUM(l.discount) AS discount,
              SUM(l.cgst + l.sgst) AS tax, SUM(l.patient_payable) AS patient,
              SUM(l.claim_amount) AS claim, SUM(l.adjustment_amount) AS adjustment
         FROM bill_lines l JOIN picked p ON p.id = l.bill_id
        GROUP BY l.bill_id
     ), paid AS (
       SELECT m.bill_id, SUM(m.amount) AS amount
         FROM payments m JOIN picked p ON p.id = m.bill_id
        GROUP BY m.bill_id
     ), rolled AS (
       SELECT p.category, p.sub_category, GROUPING(p.category) AS category_rolled,
              GROUPING(p.sub_category) AS sub_category_rolled,
              COUNT(*) FILTER (WHERE p.bill_type = 'invoice') AS bills,
              COUNT(*) FILTER (WHERE p.bill_type = 'credit_note') AS credit_notes,
              SUM(p.sign * COALESCE(ln.actual, 0)) AS actual,
              SUM(p.sign * COALESCE(ln.discount, 0)) AS discount,
              SUM(p.sign * COALESCE(ln.tax, 0)) AS tax,
              SUM(p.sign * p.round_off) AS round_off,
              SUM(p.sign * COALESCE(ln.patient, 0)) AS patient_lines,
              SUM(p.sign * p.patient_payable) AS patient,
              SUM(p.sign * COALESCE(pd.amount, 0)) AS collected,
              SUM(p.sign * COALESCE(ln.claim, 0)) AS claim,
              SUM(p.sign * COALESCE(ln.adjustment, 0)) AS adjustment
         FROM picked p
         LEFT JOIN lined ln ON ln.bill_id = p.id
         LEFT JOIN paid pd ON pd.bill_id = p.id
        GROUP BY ROLLUP (p.category, p.sub_category)
     )
     SELECT r.*, c.label AS category_label, s.label AS sub_category_label
       FROM rolled r
       LEFT JOIN patient_schemes c ON c.code = r.category
       LEFT JOIN patient_schemes s ON s.code = r.sub_category
      ORDER BY ${rollupOrder(dims, {
        category: "r.category IS NULL, lower(COALESCE(c.label, r.category)), r.category",
        sub_category:
          "r.sub_category IS NULL, lower(COALESCE(s.label, r.sub_category)), r.sub_category",
      })}`,
    scope.params,
  );
  const split = splitRollup(rows, dims);
  return [
    section(
      "categories",
      "Category › sub-category",
      [
        col("level", "Level", "text"),
        col("label", "Category", "text"),
        col("code", "Code", "text"),
        col("bills", "Bills", "count"),
        col("credit_notes", "Credit notes", "count"),
        col("actual", "Actual (net)"),
        col("discount", "Discount"),
        col("tax", "Tax"),
        col("round_off", "Round off"),
        col("patient", "Patient share"),
        col("collected", "Collected"),
        col("claim", "To be claimed"),
        col("adjustment", "Adjusted"),
        col("patient_lines", "Patient share on lines"),
      ],
      split.rows.map((row) => ({
        ...row,
        level: row.depth === 1 ? "category" : "sub_category",
        label: row.depth === 1 ? NAMED.category(row) : NAMED.sub_category(row),
        code: row.depth === 1 ? row.category : row.sub_category,
      })),
      split.total,
      { note: COLLECTED_NOTE },
    ),
  ];
}

const MODE_LABELS = { cash: "Cash", card: "Card", upi: "UPI" };

const PAYMENT_COLUMNS = {
  day: { instant: "m.received_at" },
  category: CATEGORY,
  sub_category: "b.scheme_code",
  user: "m.received_by",
};

const MONEY_MOVED = [
  col("payments_in", "Payments in", "count"),
  col("received", "Received"),
  col("payments_out", "Refunds out", "count"),
  col("paid_back", "Paid back"),
  col("net", "Net collected"),
];

async function collections(filters, db) {
  const scope = reportScope(filters, PAYMENT_COLUMNS);
  const dims = ["day", "mode", "received_by", "shift_id"];
  const { rows } = await db.query(
    `WITH base AS (
       SELECT ${dayOfInstant("m.received_at")} AS day, m.mode, m.received_by, m.shift_id,
              m.direction, m.amount
         FROM payments m JOIN bills b ON b.id = m.bill_id ${SCHEME_JOIN}
        WHERE ${scope.sql}
     ), rolled AS (
       SELECT day, mode, received_by, shift_id, ${rolledFlags(dims)},
              COUNT(*) FILTER (WHERE direction = 'in') AS payments_in,
              COALESCE(SUM(amount) FILTER (WHERE direction = 'in'), 0) AS received,
              COUNT(*) FILTER (WHERE direction = 'out') AS payments_out,
              COALESCE(SUM(amount) FILTER (WHERE direction = 'out'), 0) AS paid_back,
              COALESCE(SUM(amount) FILTER (WHERE direction = 'in'), 0)
                - COALESCE(SUM(amount) FILTER (WHERE direction = 'out'), 0) AS net
         FROM base
        GROUP BY GROUPING SETS ((day), (mode), (received_by), (shift_id), ())
     )
     SELECT r.*, r.day::text AS day_text, u.name AS received_by_name,
            s.user_id AS shift_user, su.name AS shift_user_name, s.opened_at, s.closed_at
       FROM rolled r
       LEFT JOIN doctors u ON u.id = r.received_by
       LEFT JOIN cash_shifts s ON s.id = r.shift_id
       LEFT JOIN doctors su ON su.id = s.user_id
      ORDER BY r.day, array_position($${scope.params.length + 1}::text[], r.mode),
               lower(u.name), s.opened_at, r.shift_id`,
    [...scope.params, PAYMENT_MODES],
  );
  const { sets, total } = splitSets(rows, dims);
  const pick = (key) => sets.get(key) ?? [];
  return [
    section(
      "modes",
      "By payment mode",
      [col("label", "Mode", "text"), ...MONEY_MOVED],
      pick("mode").map((row) => ({ ...row, label: MODE_LABELS[row.mode] ?? row.mode })),
      total,
    ),
    section(
      "users",
      "By user",
      [col("label", "Received by", "text"), ...MONEY_MOVED],
      pick("received_by").map((row) => ({ ...row, label: NAMED.user(row, "received_by") })),
      total,
    ),
    section(
      "shifts",
      "By shift",
      [
        col("label", "Shift", "text"),
        col("opened_at", "Opened", "instant"),
        col("closed_at", "Closed", "instant"),
        ...MONEY_MOVED,
      ],
      pick("shift_id").map((row) => ({
        ...row,
        label: row.shift_id === null ? "No shift (card / UPI)" : (row.shift_user_name ?? "Shift"),
      })),
      total,
    ),
    section("days", "By day", [col("day_text", "Day", "date"), ...MONEY_MOVED], pick("day"), total),
  ];
}

async function payLaterOn(db) {
  const { rows } = await db.query(
    `SELECT COALESCE((SELECT allow_pay_later FROM billing_settings LIMIT 1), FALSE)
            OR EXISTS (SELECT 1 FROM patient_schemes WHERE allow_pay_later) AS on`,
  );
  return rows[0].on;
}

const DUES_COLUMNS = [
  col("bill_no", "Bill", "text"),
  col("bill_date", "Bill date", "date"),
  col("days", "Days", "days"),
  col("patient_name", "Patient", "text"),
  col("file_no", "UHID", "text"),
  col("category_label", "Category", "text"),
  col("payable", "Payable"),
  col("credited", "Credited"),
  col("paid", "Paid"),
  col("refunded", "Refunded"),
  col("outstanding", "Outstanding"),
];

const payLaterOffNote = (listed) =>
  listed
    ? "Pay later is off now — these balances were left while it was on"
    : "Pay later is off, so no bill can be left with a balance";

async function dues(filters, db, { cap }) {
  const payLater = await payLaterOn(db);
  const scope = reportScope(filters, BILL_COLUMNS);
  const base = `
    WITH due AS (
      SELECT b.id, b.bill_no, b.bill_date::text AS bill_date, b.scheme_label AS category_label,
             p.name AS patient_name, p.file_no, b.patient_payable AS payable, m.credited,
             b.paid_amount AS paid, m.refunded,
             GREATEST(b.patient_payable - m.credited, 0) - (b.paid_amount - m.refunded)
               AS outstanding,
             ${TODAY} - b.bill_date AS days, b.created_at
        FROM bills b
        JOIN patients p ON p.id = b.patient_id
        ${SCHEME_JOIN}
        CROSS JOIN LATERAL (
          SELECT COALESCE((SELECT SUM(c.patient_payable) FROM bills c
                            WHERE c.original_bill_id = b.id AND c.status = 'final'), 0) AS credited,
                 COALESCE((SELECT SUM(x.amount) FROM payments x JOIN bills c ON c.id = x.bill_id
                            WHERE c.original_bill_id = b.id AND x.direction = 'out'), 0) AS refunded
        ) m
       WHERE ${FINAL} AND b.bill_type = 'invoice' AND b.paid_amount < b.patient_payable
         AND ${scope.sql}
    )`;
  const { rows } = await db.query(
    `${base} SELECT * FROM due WHERE outstanding > 0
      ORDER BY bill_date, created_at, id LIMIT ${cap + 1}`,
    scope.params,
  );
  const { rows: totals } = await db.query(
    `${base} SELECT COUNT(*) AS bills, SUM(payable) AS payable, SUM(credited) AS credited,
                    SUM(paid) AS paid, SUM(refunded) AS refunded, SUM(outstanding) AS outstanding
               FROM due WHERE outstanding > 0`,
    scope.params,
  );
  return [
    section("dues", "Dues", DUES_COLUMNS, rows, totals[0], {
      bills: Number(totals[0].bills),
      ...(payLater ? {} : { note: payLaterOffNote(rows.length > 0) }),
    }),
  ];
}

async function discounts(filters, db) {
  const scope = reportScope(filters, LINE_COLUMNS);
  const dims = ["rule_id", "method", "category", "sub_category", "consultant", "applied_by"];
  const { rows } = await db.query(
    `WITH base AS (
       SELECT d.rule_id, d.method, d.code, d.amount, d.applied_by, b.id AS bill_id,
              ${CATEGORY} AS category, b.scheme_code AS sub_category,
              ${LINE_CONSULTANT} AS consultant
         FROM bill_line_discounts d
         JOIN bill_lines l ON l.id = d.bill_line_id
         JOIN bills b ON b.id = l.bill_id ${SCHEME_JOIN} ${VISIT_JOIN}
        WHERE ${FINAL} AND b.bill_type = 'invoice' AND ${scope.sql}
     ), rolled AS (
       SELECT ${dims.join(", ")}, ${rolledFlags(dims)},
              MAX(code) AS code, COUNT(*) AS steps, COUNT(DISTINCT bill_id) AS bills,
              SUM(amount) AS amount
         FROM base
        GROUP BY GROUPING SETS ((rule_id), (method), (category, sub_category), (category),
                                (consultant), (applied_by), ())
     )
     SELECT r.*, dr.name AS rule_name, c.label AS category_label, s.label AS sub_category_label,
            doc.name AS consultant_name, u.name AS applied_by_name
       FROM rolled r
       LEFT JOIN discount_rules dr ON dr.id = r.rule_id
       LEFT JOIN patient_schemes c ON c.code = r.category
       LEFT JOIN patient_schemes s ON s.code = r.sub_category
       LEFT JOIN doctors doc ON doc.id = r.consultant
       LEFT JOIN doctors u ON u.id = r.applied_by
      ORDER BY r.amount DESC NULLS LAST, lower(dr.name), r.method, r.category, r.sub_category_rolled DESC,
               r.sub_category, lower(doc.name), lower(u.name)`,
    scope.params,
  );
  const { sets, total } = splitSets(rows, dims);
  const pick = (key) => sets.get(key) ?? [];
  const given = [
    col("steps", "Times applied", "count"),
    col("bills", "Bills", "count"),
    col("amount", "Discount"),
  ];
  const byCategory = [...pick("category"), ...pick("category+sub_category")]
    .map((row) => ({ ...row, depth: row.sub_category_rolled === 0 ? 2 : 1 }))
    .sort(
      (a, b) =>
        String(a.category_label ?? a.category ?? "~").localeCompare(
          String(b.category_label ?? b.category ?? "~"),
        ) ||
        String(a.category ?? "").localeCompare(String(b.category ?? "")) ||
        a.depth - b.depth ||
        String(a.sub_category_label ?? "").localeCompare(String(b.sub_category_label ?? "")),
    );
  return [
    section(
      "rules",
      "By rule and code",
      [
        col("label", "Rule", "text"),
        col("code", "Code", "text"),
        col("method", "Method", "text"),
        ...given,
      ],
      pick("rule_id").map((row) => ({
        ...row,
        label: row.rule_name ?? (row.rule_id === null ? "No rule" : `#${row.rule_id}`),
        method: row.code ? "code" : "auto",
      })),
      total,
    ),
    section(
      "methods",
      "By method",
      [col("label", "Method", "text"), ...given],
      pick("method").map((row) => ({ ...row, label: METHOD_LABELS[row.method] ?? row.method })),
      total,
    ),
    section(
      "categories",
      "By category › sub-category",
      [col("level", "Level", "text"), col("label", "Category", "text"), ...given],
      byCategory.map((row) => ({
        ...row,
        level: row.depth === 1 ? "category" : "sub_category",
        label: row.depth === 1 ? NAMED.category(row) : NAMED.sub_category(row),
      })),
      total,
    ),
    section(
      "consultants",
      "By consultant",
      [col("label", "Consultant", "text"), ...given],
      pick("consultant").map((row) => ({ ...row, label: NAMED.consultant(row) })),
      total,
    ),
    section(
      "users",
      "By user who applied it",
      [col("label", "Applied by", "text"), ...given],
      pick("applied_by").map((row) => ({ ...row, label: NAMED.user(row, "applied_by") })),
      total,
    ),
    await discountGroups(filters, db),
  ];
}

const METHOD_LABELS = { auto: "Automatic", code: "Code" };

async function discountGroups(filters, db) {
  const scope = reportScope(filters, LINE_COLUMNS);
  const dims = ["gkey"];
  const { rows } = await db.query(
    `WITH given AS (
       SELECT bill_line_id, SUM(amount) AS amount FROM bill_line_discounts GROUP BY bill_line_id
     ), base AS (
       SELECT lower(l.group_code) AS gkey, l.group_code, b.bill_type, l.actual_amount, l.discount,
              COALESCE(g.amount, 0) AS given
         FROM ${LINES_FROM}
         LEFT JOIN given g ON g.bill_line_id = l.id
        WHERE ${FINAL} AND ${scope.sql}
     ), rolled AS (
       SELECT gkey, ${rolledFlags(dims)}, MAX(group_code) AS group_code,
              COALESCE(SUM(actual_amount) FILTER (WHERE bill_type = 'invoice'), 0) AS actual,
              COALESCE(SUM(given) FILTER (WHERE bill_type = 'invoice'), 0) AS amount,
              COALESCE(SUM(actual_amount) FILTER (WHERE bill_type = 'credit_note'), 0)
                AS credited_actual,
              COALESCE(SUM(discount) FILTER (WHERE bill_type = 'credit_note'), 0)
                AS credited_discount
         FROM base
        GROUP BY ROLLUP (gkey)
     )
     SELECT r.*, gr.name AS group_name,
            ROUND(100 * r.amount / NULLIF(r.actual, 0), 2) AS percent,
            r.amount - r.credited_discount AS net_discount,
            ROUND(100 * (r.amount - r.credited_discount)
                  / NULLIF(r.actual - r.credited_actual, 0), 2) AS net_percent
       FROM rolled r LEFT JOIN service_groups gr ON lower(gr.code) = r.gkey
      ORDER BY ${rollupOrder(dims, { gkey: "lower(COALESCE(gr.name, r.gkey)), r.gkey" })}`,
    scope.params,
  );
  const split = splitRollup(rows, dims);
  return section(
    "groups",
    "Discount as a % of actual, by group",
    [
      col("label", "Group", "text"),
      col("group_code", "Code", "text"),
      col("actual", "Actual billed"),
      col("amount", "Discount given"),
      col("percent", "Discount %", "percent"),
      col("credited_discount", "Discount credited back"),
      col("net_discount", "Net discount"),
      col("net_percent", "Net discount %", "percent"),
    ],
    split.rows.map((row) => ({ ...row, label: row.group_name ?? row.group_code ?? "No group" })),
    split.total,
  );
}

export const AGEING = [
  { key: "0-30", label: "0–30 days", upTo: 30 },
  { key: "31-60", label: "31–60 days", upTo: 60 },
  { key: "61-90", label: "61–90 days", upTo: 90 },
  { key: "90+", label: "Over 90 days", upTo: null },
];

const BUCKET_SQL = `CASE ${AGEING.filter((b) => b.upTo !== null)
  .map((b) => `WHEN days <= ${b.upTo} THEN '${b.key}'`)
  .join(" ")} ELSE '${AGEING.at(-1).key}' END`;

async function settlementsRecorded(db) {
  const { rows } = await db.query(
    `SELECT to_regclass('public.claim_settlements') IS NOT NULL
            AND to_regclass('public.claim_settlement_bills') IS NOT NULL AS ready`,
  );
  return rows[0].ready;
}

async function receivables(filters, db) {
  const scope = reportScope(filters, { ...LINE_COLUMNS, user: undefined });
  const dims = ["category", "sub_category", "consultant", "bucket"];
  const { rows } = await db.query(
    `WITH pending AS (
       SELECT b.id AS bill_id, ${CATEGORY} AS category, b.scheme_code AS sub_category,
              ${LINE_CONSULTANT} AS consultant, ${TODAY} - b.bill_date AS days,
              l.claim_amount - COALESCE(cr.claim, 0) AS claim
         FROM ${LINES_FROM}
         LEFT JOIN LATERAL (
           SELECT SUM(x.claim_amount) AS claim
             FROM bill_lines x JOIN bills xb ON xb.id = x.bill_id AND xb.status = 'final'
            WHERE x.credited_line_id = l.id
         ) cr ON TRUE
        WHERE ${FINAL} AND b.bill_type = 'invoice' AND b.claim_status = 'pending'
          AND l.claim_amount > 0 AND ${scope.sql}
     ), base AS (
       SELECT *, ${BUCKET_SQL} AS bucket FROM pending WHERE claim > 0
     ), rolled AS (
       SELECT ${dims.join(", ")}, ${rolledFlags(dims)},
              COUNT(DISTINCT bill_id) AS bills, SUM(claim) AS amount, MAX(days) AS oldest
         FROM base
        GROUP BY GROUPING SETS ((category, sub_category), (category), (consultant), (bucket), ())
     )
     SELECT r.*, c.label AS category_label, s.label AS sub_category_label,
            d.name AS consultant_name
       FROM rolled r
       LEFT JOIN patient_schemes c ON c.code = r.category
       LEFT JOIN patient_schemes s ON s.code = r.sub_category
       LEFT JOIN doctors d ON d.id = r.consultant
      ORDER BY r.category IS NULL, lower(COALESCE(c.label, r.category)), r.category,
               r.sub_category_rolled DESC, lower(COALESCE(s.label, r.sub_category)),
               r.consultant IS NULL, lower(d.name), r.consultant`,
    scope.params,
  );
  const { sets, total } = splitSets(rows, dims);
  const pick = (key) => sets.get(key) ?? [];
  const pending = [
    col("bills", "Bills", "count"),
    col("amount", "Pending claim"),
    col("oldest", "Oldest (days)", "days"),
  ];
  const buckets = new Map(pick("bucket").map((row) => [row.bucket, row]));
  return [
    section(
      "sub_categories",
      "Pending by category › sub-category",
      [col("level", "Level", "text"), col("label", "Category", "text"), ...pending],
      [...pick("category"), ...pick("category+sub_category")]
        .map((row) => ({ ...row, depth: row.sub_category_rolled === 0 ? 2 : 1 }))
        .sort(
          (a, b) =>
            String(a.category_label ?? a.category ?? "~").localeCompare(
              String(b.category_label ?? b.category ?? "~"),
            ) ||
            a.depth - b.depth ||
            String(a.sub_category_label ?? "").localeCompare(String(b.sub_category_label ?? "")),
        )
        .map((row) => ({
          ...row,
          level: row.depth === 1 ? "category" : "sub_category",
          label: row.depth === 1 ? NAMED.category(row) : NAMED.sub_category(row),
        })),
      total,
    ),
    section(
      "consultants",
      "Pending by consultant",
      [col("label", "Consultant", "text"), ...pending],
      pick("consultant").map((row) => ({ ...row, label: NAMED.consultant(row) })),
      total,
    ),
    section(
      "ageing",
      "Ageing",
      [col("label", "Age", "text"), ...pending],
      AGEING.map((bucket) => ({
        ...(buckets.get(bucket.key) ?? { bills: 0, amount: 0, oldest: null }),
        label: bucket.label,
      })),
      total,
    ),
    await clearedByMonth(filters, db),
  ];
}

const CLEARED_COLUMNS = [
  col("month_start", "Month", "date"),
  col("settlements", "Settlements", "count"),
  col("bills", "Bills", "count"),
  col("amount", "Cleared"),
];

async function clearedByMonth(filters, db) {
  if (!(await settlementsRecorded(db))) {
    return section("cleared", "Cleared per month", CLEARED_COLUMNS, [], null, {
      note: "Cleared amounts appear here once the CGHS register records settlements",
    });
  }
  const scope = reportScope(filters, {
    day: { date: "cs_s.received_on" },
    category: CATEGORY,
    sub_category: "b.scheme_code",
    consultant: BILL_CONSULTANT,
  });
  const dims = ["month"];
  const { rows } = await db.query(
    `WITH base AS (
       SELECT date_trunc('month', cs_s.received_on)::date AS month, cs_s.id AS settlement_id,
              sb.bill_id, sb.amount
         FROM claim_settlements cs_s
         JOIN claim_settlement_bills sb ON sb.settlement_id = cs_s.id
         JOIN bills b ON b.id = sb.bill_id ${SCHEME_JOIN} ${VISIT_JOIN}
        WHERE cs_s.voided_at IS NULL AND sb.voided_at IS NULL AND ${scope.sql}
     ), rolled AS (
       SELECT month, ${rolledFlags(dims)}, COUNT(DISTINCT settlement_id) AS settlements,
              COUNT(DISTINCT bill_id) AS bills, SUM(amount) AS amount
         FROM base GROUP BY ROLLUP (month)
     )
     SELECT r.*, r.month::text AS month_start FROM rolled r ORDER BY r.month_rolled, r.month`,
    scope.params,
  );
  const split = splitRollup(rows, dims);
  return section("cleared", "Cleared per month", CLEARED_COLUMNS, split.rows, split.total);
}

async function coupons(filters, db) {
  const scope = reportScope(filters, {
    day: { date: "b.bill_date" },
    consultant: "l.doctor_id",
  });
  const used = `
    WITH used AS (
      SELECT DISTINCT d.rule_id, b.id AS bill_id, b.bill_date, l.doctor_id
        FROM bill_line_discounts d
        JOIN bill_lines l ON l.id = d.bill_line_id
        JOIN bills b ON b.id = l.bill_id
       WHERE ${FINAL} AND l.is_live AND d.method = 'code' AND ${scope.sql}
    )`;
  const perDay = await db.query(
    `${used}, uses AS (SELECT DISTINCT rule_id, bill_id, bill_date FROM used),
     rolled AS (
       SELECT rule_id, bill_date, GROUPING(rule_id) AS rule_id_rolled, COUNT(*) AS uses
         FROM uses GROUP BY ROLLUP ((rule_id, bill_date))
     )
     SELECT r.*, r.bill_date::text AS day, dr.code, dr.name, dr.max_uses_per_day AS day_limit,
            r.uses > dr.max_uses_per_day AS over_limit
       FROM rolled r LEFT JOIN discount_rules dr ON dr.id = r.rule_id
      ORDER BY r.rule_id_rolled, lower(dr.code), r.bill_date`,
    scope.params,
  );
  const perDoctor = await db.query(
    `${used}, uses AS (SELECT DISTINCT rule_id, bill_id, bill_date, doctor_id FROM used),
     rolled AS (
       SELECT rule_id, bill_date, doctor_id, GROUPING(rule_id) AS rule_id_rolled, COUNT(*) AS uses
         FROM uses GROUP BY ROLLUP ((rule_id, bill_date, doctor_id))
     )
     SELECT r.*, r.bill_date::text AS day, dr.code, dr.name,
            dr.max_uses_per_doctor_per_day AS doctor_day_limit,
            r.uses > dr.max_uses_per_doctor_per_day AS over_limit, doc.name AS consultant_name,
            r.doctor_id AS consultant
       FROM rolled r
       LEFT JOIN discount_rules dr ON dr.id = r.rule_id
       LEFT JOIN doctors doc ON doc.id = r.doctor_id
      ORDER BY r.rule_id_rolled, lower(dr.code), r.bill_date, lower(doc.name)`,
    scope.params,
  );
  const perCode = await db.query(
    `${used}, uses AS (SELECT DISTINCT rule_id, bill_id FROM used),
     rolled AS (
       SELECT rule_id, GROUPING(rule_id) AS rule_id_rolled, COUNT(*) AS uses
         FROM uses GROUP BY ROLLUP (rule_id)
     )
     SELECT r.*, dr.code, dr.name, dr.max_uses_total AS total_limit, ever.uses AS ever,
            ever.uses > dr.max_uses_total AS over_limit
       FROM rolled r
       LEFT JOIN discount_rules dr ON dr.id = r.rule_id
       LEFT JOIN LATERAL (
         SELECT COUNT(DISTINCT eb.id) AS uses
           FROM bill_line_discounts ed
           JOIN bill_lines el ON el.id = ed.bill_line_id
           JOIN bills eb ON eb.id = el.bill_id
          WHERE ed.rule_id = r.rule_id AND eb.status = 'final' AND el.is_live
       ) ever ON r.rule_id IS NOT NULL
      ORDER BY r.rule_id_rolled, lower(dr.code)`,
    scope.params,
  );
  const label = (row) => row.code ?? row.name ?? `#${row.rule_id}`;
  const split = (result) => ({
    rows: result.rows.filter((row) => Number(row.rule_id_rolled) === 0),
    total: result.rows.find((row) => Number(row.rule_id_rolled) === 1) ?? null,
  });
  const codes = split(perCode);
  const days = split(perDay);
  const doctors = split(perDoctor);
  return [
    section(
      "codes",
      "Uses per code",
      [
        col("label", "Code", "text"),
        col("name", "Name", "text"),
        col("uses", "Uses in range", "count"),
        col("ever", "Uses in all", "count"),
        col("total_limit", "Total limit", "limit"),
        col("over_limit", "Over the limit", "flag"),
      ],
      codes.rows.map((row) => ({ ...row, label: label(row) })),
      codes.total,
    ),
    section(
      "days",
      "Uses per code per day",
      [
        col("label", "Code", "text"),
        col("day", "Day", "date"),
        col("uses", "Uses", "count"),
        col("day_limit", "Daily limit", "limit"),
        col("over_limit", "Over the limit", "flag"),
      ],
      days.rows.map((row) => ({ ...row, label: label(row) })),
      days.total,
    ),
    section(
      "doctors",
      "Uses per code per doctor per day",
      [
        col("label", "Code", "text"),
        col("day", "Day", "date"),
        col("doctor", "Doctor", "text"),
        col("uses", "Uses", "count"),
        col("doctor_day_limit", "Limit per doctor per day", "limit"),
        col("over_limit", "Over the limit", "flag"),
      ],
      doctors.rows.map((row) => ({
        ...row,
        label: label(row),
        doctor: NAMED.consultant(row),
      })),
      doctors.total,
    ),
  ];
}

const CANCELLED_COLUMNS = {
  day: { instant: "b.cancelled_at" },
  category: CATEGORY,
  sub_category: "b.scheme_code",
  user: "b.cancelled_by",
};

const CANCEL_AMOUNTS = [
  col("bills", "Bills", "count"),
  col("actual", "Actual"),
  col("patient", "Patient share"),
  col("claim", "Claim"),
];

async function cancellations(filters, db, { cap }) {
  const scope = reportScope(filters, CANCELLED_COLUMNS);
  const where = `b.status = 'cancelled' AND ${scope.sql}`;
  const { rows: bills } = await db.query(
    `SELECT b.id, b.bill_no, b.bill_date::text AS bill_date, b.cancelled_at, b.cancel_reason,
            b.scheme_label AS category_label, p.name AS patient_name, p.file_no,
            u.name AS cancelled_by_name, b.actual_amount AS actual,
            b.patient_payable AS patient, b.claim_amount AS claim
       FROM bills b
       JOIN patients p ON p.id = b.patient_id
       ${SCHEME_JOIN}
       LEFT JOIN doctors u ON u.id = b.cancelled_by
      WHERE ${where}
      ORDER BY b.cancelled_at DESC, b.id
      LIMIT ${cap + 1}`,
    scope.params,
  );
  const dims = ["cancelled_by", "reason_key"];
  const { rows } = await db.query(
    `WITH base AS (
       SELECT b.cancelled_by, lower(regexp_replace(btrim(b.cancel_reason), '\\s+', ' ', 'g'))
                AS reason_key,
              b.cancel_reason, b.actual_amount, b.patient_payable, b.claim_amount
         FROM bills b ${SCHEME_JOIN}
        WHERE ${where}
     ), rolled AS (
       SELECT cancelled_by, reason_key, ${rolledFlags(dims)}, MIN(cancel_reason) AS reason,
              COUNT(*) AS bills, SUM(actual_amount) AS actual,
              SUM(patient_payable) AS patient, SUM(claim_amount) AS claim
         FROM base GROUP BY GROUPING SETS ((cancelled_by), (reason_key), ())
     )
     SELECT r.*, u.name AS cancelled_by_name
       FROM rolled r LEFT JOIN doctors u ON u.id = r.cancelled_by
      ORDER BY r.bills DESC, lower(u.name), r.reason_key`,
    scope.params,
  );
  const { sets, total } = splitSets(rows, dims);
  return [
    section(
      "bills",
      "Cancelled bills",
      [
        col("bill_no", "Bill", "text"),
        col("bill_date", "Bill date", "date"),
        col("cancelled_at", "Cancelled", "instant"),
        col("patient_name", "Patient", "text"),
        col("file_no", "UHID", "text"),
        col("category_label", "Category", "text"),
        col("cancelled_by_name", "Cancelled by", "text"),
        col("cancel_reason", "Reason", "text"),
        col("actual", "Actual"),
        col("patient", "Patient share"),
        col("claim", "Claim"),
      ],
      bills,
      total,
    ),
    section(
      "reasons",
      "By reason",
      [col("reason", "Reason", "text"), ...CANCEL_AMOUNTS],
      sets.get("reason_key") ?? [],
      total,
    ),
    section(
      "users",
      "By user",
      [col("label", "Cancelled by", "text"), ...CANCEL_AMOUNTS],
      (sets.get("cancelled_by") ?? []).map((row) => ({
        ...row,
        label: NAMED.user(row, "cancelled_by"),
      })),
      total,
    ),
  ];
}

const REQUEST_COUNTS = [
  col("asked", "Asked", "count"),
  col("pending", "Waiting", "count"),
  col("approved", "Approved", "count"),
  col("rejected", "Rejected", "count"),
];

async function requests(filters, db) {
  const scope = reportScope(filters, {
    day: { instant: "q.requested_at" },
    user: "q.requested_by",
  });
  const dims = ["requested_by", "kind"];
  const { rows } = await db.query(
    `WITH rolled AS (
       SELECT q.requested_by, q.kind, GROUPING(q.requested_by) AS requested_by_rolled,
              GROUPING(q.kind) AS kind_rolled, COUNT(*) AS asked,
              COUNT(*) FILTER (WHERE q.status = 'pending') AS pending,
              COUNT(*) FILTER (WHERE q.status IN ('approved', 'used')) AS approved,
              COUNT(*) FILTER (WHERE q.status = 'rejected') AS rejected
         FROM billing_requests q
        WHERE ${scope.sql}
        GROUP BY GROUPING SETS ((q.requested_by, q.kind), (q.requested_by), (q.kind), ())
     )
     SELECT r.*, u.name AS requested_by_name
       FROM rolled r LEFT JOIN doctors u ON u.id = r.requested_by
      ORDER BY lower(u.name), r.requested_by, r.kind_rolled DESC, r.kind`,
    scope.params,
  );
  const { sets, total } = splitSets(rows, dims);
  const kindLabel = (kind) => REQUEST_KINDS[kind] ?? kind;
  return [
    section(
      "users",
      "By user",
      [col("level", "Level", "text"), col("label", "Asked by", "text"), ...REQUEST_COUNTS],
      [...(sets.get("requested_by") ?? []), ...(sets.get("requested_by+kind") ?? [])]
        .map((row) => ({ ...row, depth: Number(row.kind_rolled) === 1 ? 1 : 2 }))
        .sort(
          (a, b) =>
            String(a.requested_by_name ?? "~").localeCompare(String(b.requested_by_name ?? "~")) ||
            Number(a.requested_by ?? 0) - Number(b.requested_by ?? 0) ||
            a.depth - b.depth ||
            String(a.kind).localeCompare(String(b.kind)),
        )
        .map((row) => ({
          ...row,
          level: row.depth === 1 ? "user" : "kind",
          label: row.depth === 1 ? NAMED.user(row, "requested_by") : kindLabel(row.kind),
        })),
      total,
    ),
    section(
      "kinds",
      "By kind",
      [col("label", "Kind", "text"), ...REQUEST_COUNTS],
      (sets.get("kind") ?? []).map((row) => ({ ...row, label: kindLabel(row.kind) })),
      total,
    ),
  ];
}

const LINE_FILTERS = ["category", "sub_category", "group", "subgroup", "consultant", "user"];

export const REPORTS = {
  revenue_items: {
    title: "Revenue by service",
    filters: ["period", ...LINE_FILTERS],
    period: "none",
    run: revenueItems,
  },
  revenue_consultants: {
    title: "Revenue by consultant",
    filters: LINE_FILTERS,
    run: revenueConsultants,
  },
  revenue_categories: {
    title: "Revenue by category",
    filters: ["category", "sub_category", "user"],
    run: revenueCategories,
  },
  collections: {
    title: "Collections",
    filters: ["category", "sub_category", "user"],
    run: collections,
  },
  dues: {
    title: "Dues",
    filters: ["category", "sub_category", "user"],
    openStart: true,
    run: dues,
  },
  discounts: {
    title: "Discounts",
    filters: LINE_FILTERS,
    run: discounts,
  },
  receivables: {
    title: "CGHS receivables",
    filters: ["category", "sub_category", "consultant"],
    openStart: true,
    run: receivables,
  },
  coupons: {
    title: "Coupon usage",
    filters: ["consultant"],
    run: coupons,
  },
  cancellations: {
    title: "Cancellations",
    filters: ["category", "sub_category", "user"],
    run: cancellations,
  },
  requests: {
    title: "Desk requests",
    filters: ["user"],
    run: requests,
  },
};

export const REPORT_KEYS = Object.keys(REPORTS);

export function reportFor(key) {
  const report = Object.hasOwn(REPORTS, key) ? REPORTS[key] : null;
  if (!report) throw httpError(404, "There is no such billing report");
  return report;
}

export async function runReport(key, input = {}, db = pool, { cap = ROW_CAP } = {}) {
  const report = reportFor(key);
  const filters = cleanFilters(input, report);
  const sections = await report.run(filters, db, { cap });
  return {
    key,
    title: report.title,
    filters,
    generated_at: new Date().toISOString(),
    sections: sections.map((part) => ({
      ...part,
      rows: part.rows.slice(0, cap),
      row_count: part.rows.length,
      truncated: part.rows.length > cap,
    })),
  };
}

export async function reportCatalog(db = pool) {
  const [groups, subgroups, categories, consultants, users, payLater] = await Promise.all([
    db.query(`SELECT code, name FROM service_groups ORDER BY sort_order, lower(name), id`),
    db.query(
      `SELECT s.code, s.name, g.code AS group_code
         FROM service_subgroups s JOIN service_groups g ON g.id = s.group_id
        ORDER BY g.sort_order, lower(g.name), s.sort_order, lower(s.name), s.id`,
    ),
    db.query(
      `SELECT code, label, parent_code, is_active FROM patient_schemes
        ORDER BY sort_order, lower(label), code`,
    ),
    db.query(
      `SELECT id, name FROM doctors
        WHERE role = $1 OR id IN (SELECT doctor_id FROM service_items WHERE doctor_id IS NOT NULL)
        ORDER BY lower(name), id`,
      [ROLES.CONSULTANT],
    ),
    db.query(
      `SELECT id, name, role FROM doctors WHERE role = ANY($1::text[]) ORDER BY lower(name), id`,
      [BILLING_ROLES],
    ),
    payLaterOn(db),
  ]);
  return {
    reports: REPORT_KEYS.map((key) => ({
      key,
      title: REPORTS[key].title,
      filters: REPORTS[key].filters,
      period: REPORTS[key].period ?? null,
      open_start: Boolean(REPORTS[key].openStart),
    })),
    filter_labels: FILTER_LABELS,
    periods: PERIODS,
    range_days_max: RANGE_DAYS_MAX,
    today: indiaToday(),
    pay_later: payLater,
    options: {
      groups: groups.rows,
      subgroups: subgroups.rows,
      categories: categories.rows,
      consultants: consultants.rows,
      users: users.rows,
    },
  };
}
