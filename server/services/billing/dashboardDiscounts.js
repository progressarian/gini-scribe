import { paise } from "../../../shared/labPayment.js";
import { BILL_COLUMNS, bucketOf } from "./dashboardSql.js";
import { FINAL, LINE_CONSULTANT, SCHEME_JOIN, VISIT_JOIN } from "./reports.js";
import { reportScope } from "./reportsFilters.js";

export const DISCOUNT_METHODS = [
  { key: "auto", label: "Automatic" },
  { key: "code", label: "Code" },
  { key: "manual", label: "Manual" },
];
export const TOP_RULES = 10;
export const TOP_DISCOUNTED_BILLS = 20;

const INVOICE = `${FINAL} AND b.bill_type = 'invoice'`;
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

async function chargedFacts(filters, db) {
  const scope = reportScope(filters, BILL_COLUMNS);
  const { rows } = await db.query(
    `WITH lined AS (
       SELECT ${bucketOf(filters.period, "b.bill_date")} AS bucket, b.bill_type,
              lower(l.group_code) AS gkey, l.actual_amount, l.discount
         FROM ${FROM_LINES}
        WHERE ${FINAL} AND ${scope.sql}
     )
     SELECT bucket::text AS bucket_text, gkey, GROUPING(bucket) AS gb, GROUPING(gkey) AS gg,
            COALESCE(SUM(actual_amount) FILTER (WHERE bill_type = 'invoice'), 0) AS charges,
            COALESCE(SUM(discount) FILTER (WHERE bill_type = 'credit_note'), 0) AS credited
       FROM lined
      GROUP BY GROUPING SETS ((bucket), (gkey), ())`,
    scope.params,
  );
  return rows;
}

async function topBills(filters, db) {
  const scope = reportScope(filters, BILL_COLUMNS);
  const { rows } = await db.query(
    `WITH given AS (
       SELECT l.bill_id, SUM(d.amount) AS amount,
              string_agg(DISTINCT COALESCE(u.short_name, u.name), ', ') AS applied_by
         FROM ${FROM_STEPS}
         LEFT JOIN doctors u ON u.id = d.applied_by
        WHERE ${INVOICE} AND ${scope.sql}
        GROUP BY l.bill_id
        ORDER BY SUM(d.amount) DESC, l.bill_id
        LIMIT ${TOP_DISCOUNTED_BILLS}
     )
     SELECT g.bill_id, g.amount, g.applied_by, b.bill_no, b.bill_date::text AS bill_date,
            b.actual_amount, b.patient_id, b.visit_id, p.name AS patient_name, p.file_no,
            p.health_id
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
    charges: paise(row.actual_amount),
    discount: paise(row.amount),
    pct: pctOf(paise(row.amount), paise(row.actual_amount)),
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

export async function discountsFor(filters, buckets, db) {
  const [given, charged, bills] = await Promise.all([
    givenFacts(filters, db),
    chargedFacts(filters, db),
    topBills(filters, db),
  ]);
  const sets = {
    byMethod: given.filter((r) => r.gb === 0 && r.gm === 0),
    rules: given.filter((r) => r.gr === 0 && r.gm === 0),
    groups: given.filter((r) => r.gg === 0),
    users: given.filter((r) => r.ga === 0),
    consultants: given.filter((r) => r.gc === 0),
    total: given.find((r) => r.gb && r.gm && r.gr && r.gg && r.ga && r.gc),
  };
  const chargedBy = new Map(
    charged.filter((r) => r.gb === 0).map((r) => [r.bucket_text, paise(r.charges)]),
  );
  const chargedGroups = new Map(
    charged.filter((r) => r.gg === 0).map((r) => [r.gkey, paise(r.charges)]),
  );
  const chargedTotal = charged.find((r) => r.gb && r.gg);
  const rows = buckets.map((bucket) => {
    const row = { bucket: bucket.bucket, start: bucket.start, end: bucket.end };
    for (const method of DISCOUNT_METHODS) row[method.key] = 0;
    if (bucket.week !== undefined) row.week = bucket.week;
    row.partial = bucket.partial;
    for (const part of sets.byMethod.filter((r) => r.bucket_text === bucket.bucket)) {
      row[part.method] = paise(part.amount);
    }
    row.given = DISCOUNT_METHODS.reduce((sum, method) => sum + row[method.key], 0);
    row.charges = chargedBy.get(bucket.bucket) ?? 0;
    row.pct = pctOf(row.given, row.charges);
    return row;
  });
  const total = Object.fromEntries(
    DISCOUNT_METHODS.map((method) => [
      method.key,
      rows.reduce((sum, row) => sum + row[method.key], 0),
    ]),
  );
  total.given = paise(sets.total?.amount ?? 0);
  total.charges = paise(chargedTotal?.charges ?? 0);
  total.pct = pctOf(total.given, total.charges);
  total.credited = paise(chargedTotal?.credited ?? 0);
  const named = (list, key, label, fallback) =>
    list.map((r) => ({
      key: r[key],
      label: r[label] ?? fallback(r),
      amount: paise(r.amount),
      steps: Number(r.steps),
    }));
  return {
    methods: DISCOUNT_METHODS,
    rows,
    total,
    rules: topWithOther(
      sets.rules.map((r) => ({
        key: `${r.rule_id ?? "manual"}-${r.method}`,
        label: ruleLabel(r),
        code: r.code,
        method: METHOD_LABEL[r.method] ?? r.method,
        amount: paise(r.amount),
        steps: Number(r.steps),
      })),
      TOP_RULES,
      "Other rules",
    ),
    groups: sets.groups.map((r) => {
      const charges = chargedGroups.get(r.gkey) ?? 0;
      return {
        key: r.gkey,
        label: r.group_name ?? r.group_code ?? "No group",
        amount: paise(r.amount),
        steps: Number(r.steps),
        charges,
        pct: pctOf(paise(r.amount), charges),
      };
    }),
    users: named(sets.users, "applied_by", "applied_by_name", () => "Not recorded"),
    consultants: named(sets.consultants, "consultant", "consultant_name", () => "No consultant"),
    top_bills: bills,
  };
}
