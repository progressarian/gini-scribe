import { paise } from "../../../shared/labPayment.js";
import {
  BILL_COLUMNS,
  BILLED,
  bucketOf,
  CATEGORY_REDUCTION,
  CONCESSION,
  GROSS,
} from "./dashboardSql.js";
import { LINE_CONSULTANT, SCHEME_JOIN, VISIT_JOIN } from "./reports.js";
import { reportScope } from "./reportsFilters.js";

export const DISCOUNT_METHODS = [
  { key: "auto", label: "Automatic" },
  { key: "code", label: "Code" },
  { key: "manual", label: "Manual" },
  { key: "category", label: "Category rate" },
  { key: "written_off", label: "Written off" },
];
const STEP_METHODS = ["auto", "code", "manual"];
export const TOP_RULES = 10;
export const TOP_DISCOUNTED_BILLS = 20;

const INVOICE = `${BILLED} AND b.bill_type = 'invoice'`;
const FROM_LINES = `bills b JOIN bill_lines l ON l.bill_id = b.id ${SCHEME_JOIN} ${VISIT_JOIN}`;
const FROM_STEPS = `bill_line_discounts d JOIN bill_lines l ON l.id = d.bill_line_id
         JOIN bills b ON b.id = l.bill_id ${SCHEME_JOIN} ${VISIT_JOIN}`;

const pctOf = (part, whole) => (whole ? Math.round((10000 * part) / whole) / 100 : null);

async function givenFacts(filters, db) {
  const scope = reportScope(filters, BILL_COLUMNS);
  const { rows } = await db.query(
    `WITH given AS (
       SELECT ${bucketOf(filters.period, "b.bill_date")} AS bucket, d.method, d.rule_id, d.code,
              lower(l.group_code) AS gkey, l.group_code, d.applied_by,
              ${LINE_CONSULTANT} AS consultant, d.amount
         FROM ${FROM_STEPS}
        WHERE ${INVOICE} AND ${scope.sql}
     ), rolled AS (
       SELECT bucket, method, rule_id, gkey, applied_by, consultant,
              GROUPING(bucket) AS gb, GROUPING(method) AS gm, GROUPING(rule_id) AS gr,
              GROUPING(gkey) AS gg, GROUPING(applied_by) AS ga, GROUPING(consultant) AS gc,
              MAX(code) AS code, MAX(group_code) AS group_code, COUNT(*) AS steps,
              COALESCE(SUM(amount), 0) AS amount
         FROM given
        GROUP BY GROUPING SETS ((bucket, method), (rule_id, method), (gkey), (applied_by),
                               (consultant), ())
     )
     SELECT r.*, r.bucket::text AS bucket_text, dr.name AS rule_name, sg.name AS group_name,
            u.name AS applied_by_name, doc.name AS consultant_name
       FROM rolled r
       LEFT JOIN discount_rules dr ON dr.id = r.rule_id AND r.gr = 0
       LEFT JOIN service_groups sg ON lower(sg.code) = r.gkey AND r.gg = 0
       LEFT JOIN doctors u ON u.id = r.applied_by AND r.ga = 0
       LEFT JOIN doctors doc ON doc.id = r.consultant AND r.gc = 0
      ORDER BY r.amount DESC`,
    scope.params,
  );
  return rows;
}

async function lineFacts(filters, db) {
  const scope = reportScope(filters, BILL_COLUMNS);
  const { rows } = await db.query(
    `WITH lined AS (
       SELECT ${bucketOf(filters.period, "b.bill_date")} AS bucket, b.bill_type,
              lower(l.group_code) AS gkey, l.group_code, ${LINE_CONSULTANT} AS consultant,
              b.scheme_code AS scheme, ${GROSS} AS gross, ${CATEGORY_REDUCTION} AS category,
              l.adjustment_amount AS written_off, ${CONCESSION} AS concession
         FROM ${FROM_LINES}
        WHERE ${BILLED} AND ${scope.sql}
     ), rolled AS (
       SELECT bucket, gkey, consultant, scheme,
              GROUPING(bucket) AS gb, GROUPING(gkey) AS gg, GROUPING(consultant) AS gc,
              GROUPING(scheme) AS gs, MAX(group_code) AS group_code,
              COALESCE(SUM(gross) FILTER (WHERE bill_type = 'invoice'), 0) AS charges,
              COALESCE(SUM(category) FILTER (WHERE bill_type = 'invoice'), 0) AS category,
              COUNT(*) FILTER (WHERE bill_type = 'invoice' AND category > 0) AS category_lines,
              COALESCE(SUM(written_off) FILTER (WHERE bill_type = 'invoice'), 0) AS written_off,
              COUNT(*) FILTER (WHERE bill_type = 'invoice' AND written_off > 0) AS written_off_lines,
              COALESCE(SUM(concession) FILTER (WHERE bill_type = 'credit_note'), 0) AS credited
         FROM lined
        GROUP BY GROUPING SETS ((bucket), (gkey), (consultant), (scheme), ())
     )
     SELECT r.*, r.bucket::text AS bucket_text, sg.name AS group_name,
            doc.name AS consultant_name, ps.label AS scheme_label
       FROM rolled r
       LEFT JOIN service_groups sg ON lower(sg.code) = r.gkey AND r.gg = 0
       LEFT JOIN doctors doc ON doc.id = r.consultant AND r.gc = 0
       LEFT JOIN patient_schemes ps ON ps.code = r.scheme AND r.gs = 0`,
    scope.params,
  );
  return rows;
}

async function topBills(filters, db) {
  const scope = reportScope(filters, BILL_COLUMNS);
  const { rows } = await db.query(
    `WITH given AS (
       SELECT l.bill_id, SUM(${CONCESSION}) AS amount, SUM(${GROSS}) AS charges
         FROM ${FROM_LINES}
        WHERE ${INVOICE} AND ${scope.sql}
        GROUP BY l.bill_id
       HAVING SUM(${CONCESSION}) > 0
        ORDER BY SUM(${CONCESSION}) DESC, l.bill_id
        LIMIT ${TOP_DISCOUNTED_BILLS}
     )
     SELECT g.bill_id, g.amount, g.charges, b.bill_no, b.bill_date::text AS bill_date,
            b.patient_id, b.visit_id, b.scheme_label, p.name AS patient_name, p.file_no,
            p.health_id,
            (SELECT string_agg(DISTINCT COALESCE(u.short_name, u.name), ', ')
               FROM bill_line_discounts d
               JOIN bill_lines x ON x.id = d.bill_line_id
               JOIN doctors u ON u.id = d.applied_by
              WHERE x.bill_id = g.bill_id) AS applied_by
       FROM given g
       JOIN bills b ON b.id = g.bill_id
       JOIN patients p ON p.id = b.patient_id
      ORDER BY g.amount DESC, b.bill_no`,
    scope.params,
  );
  return rows.map((row) => ({
    bill_id: row.bill_id,
    bill_no: row.bill_no,
    bill_date: row.bill_date,
    patient_id: row.patient_id,
    visit_id: row.visit_id,
    patient_name: row.patient_name,
    file_no: row.file_no,
    health_id: row.health_id,
    category: row.scheme_label,
    charges: paise(row.charges),
    discount: paise(row.amount),
    pct: pctOf(paise(row.amount), paise(row.charges)),
    applied_by: row.applied_by,
  }));
}

const ruleLabel = (row) =>
  row.rule_id === null
    ? "Manual discounts (line and bill)"
    : (row.rule_name ?? `Rule #${row.rule_id}`);

const METHOD_LABEL = Object.fromEntries(DISCOUNT_METHODS.map((m) => [m.key, m.label]));

function topWithOther(rows, size, label) {
  if (rows.length <= size) return rows;
  const rest = rows.slice(size);
  return [
    ...rows.slice(0, size),
    {
      key: "other",
      label,
      amount: rest.reduce((sum, row) => sum + row.amount, 0),
      steps: rest.reduce((sum, row) => sum + row.steps, 0),
    },
  ];
}

function merge(stepRows, lineRows, key, label) {
  const merged = new Map();
  const entry = (k, name) => {
    if (!merged.has(k)) merged.set(k, { key: k, label: name, amount: 0, steps: 0, charges: 0 });
    return merged.get(k);
  };
  for (const r of stepRows) {
    const e = entry(r[key], label(r));
    e.amount += paise(r.amount);
    e.steps += Number(r.steps);
  }
  for (const r of lineRows) {
    const e = entry(r[key], label(r));
    e.amount += paise(r.category) + paise(r.written_off);
    e.steps += Number(r.category_lines) + Number(r.written_off_lines);
    e.charges += paise(r.charges);
  }
  return [...merged.values()]
    .filter((e) => e.amount)
    .map((e) => ({ ...e, pct: pctOf(e.amount, e.charges) }))
    .sort((a, b) => b.amount - a.amount);
}

export async function discountsFor(filters, buckets, db) {
  const [given, lines, bills] = await Promise.all([
    givenFacts(filters, db),
    lineFacts(filters, db),
    topBills(filters, db),
  ]);
  const steps = {
    byMethod: given.filter((r) => r.gb === 0 && r.gm === 0),
    rules: given.filter((r) => r.gr === 0 && r.gm === 0),
    groups: given.filter((r) => r.gg === 0),
    users: given.filter((r) => r.ga === 0),
    consultants: given.filter((r) => r.gc === 0),
  };
  const lineSets = {
    buckets: new Map(lines.filter((r) => r.gb === 0).map((r) => [r.bucket_text, r])),
    groups: lines.filter((r) => r.gg === 0),
    consultants: lines.filter((r) => r.gc === 0),
    schemes: lines.filter((r) => r.gs === 0),
    total: lines.find((r) => r.gb && r.gg && r.gc && r.gs),
  };
  const rows = buckets.map((bucket) => {
    const row = { bucket: bucket.bucket, start: bucket.start, end: bucket.end };
    if (bucket.week !== undefined) row.week = bucket.week;
    row.partial = bucket.partial;
    for (const method of STEP_METHODS) row[method] = 0;
    for (const part of steps.byMethod.filter((r) => r.bucket_text === bucket.bucket)) {
      row[part.method] = paise(part.amount);
    }
    const line = lineSets.buckets.get(bucket.bucket);
    row.category = paise(line?.category ?? 0);
    row.written_off = paise(line?.written_off ?? 0);
    row.given = DISCOUNT_METHODS.reduce((sum, method) => sum + row[method.key], 0);
    row.charges = paise(line?.charges ?? 0);
    row.pct = pctOf(row.given, row.charges);
    return row;
  });
  const total = Object.fromEntries(
    DISCOUNT_METHODS.map((method) => [
      method.key,
      rows.reduce((sum, row) => sum + row[method.key], 0),
    ]),
  );
  total.given = DISCOUNT_METHODS.reduce((sum, method) => sum + total[method.key], 0);
  total.charges = paise(lineSets.total?.charges ?? 0);
  total.pct = pctOf(total.given, total.charges);
  total.credited = paise(lineSets.total?.credited ?? 0);
  const schemeRows = lineSets.schemes.flatMap((r) => {
    const name = r.scheme_label ?? r.scheme ?? "No category";
    return [
      {
        key: `category-${r.scheme}`,
        label: `${name} rates`,
        code: null,
        method: "Category rate",
        amount: paise(r.category),
        steps: Number(r.category_lines),
      },
      {
        key: `written-off-${r.scheme}`,
        label: `${name} — written off`,
        code: null,
        method: "Written off",
        amount: paise(r.written_off),
        steps: Number(r.written_off_lines),
      },
    ].filter((rule) => rule.amount);
  });
  const ruleRows = [
    ...steps.rules.map((r) => ({
      key: `${r.rule_id ?? "manual"}-${r.method}`,
      label: ruleLabel(r),
      code: r.code,
      method: METHOD_LABEL[r.method] ?? r.method,
      amount: paise(r.amount),
      steps: Number(r.steps),
    })),
    ...schemeRows,
  ].sort((a, b) => b.amount - a.amount);
  return {
    methods: DISCOUNT_METHODS,
    rows,
    total,
    rules: topWithOther(ruleRows, TOP_RULES, "Other rules"),
    groups: merge(
      steps.groups,
      lineSets.groups,
      "gkey",
      (r) => r.group_name ?? r.group_code ?? "No group",
    ),
    users: steps.users.map((r) => ({
      key: r.applied_by,
      label: r.applied_by_name ?? "Not recorded",
      amount: paise(r.amount),
      steps: Number(r.steps),
    })),
    consultants: merge(
      steps.consultants,
      lineSets.consultants,
      "consultant",
      (r) => r.consultant_name ?? "No consultant",
    ),
    top_bills: bills,
  };
}
