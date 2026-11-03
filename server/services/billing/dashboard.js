import pool from "../../config/db.js";
import { paise } from "../../../shared/labPayment.js";
import { DEPOSIT_MODE, HEALTHRAY_MODE, PREPAID_MODE } from "../../../shared/billingVocab.js";
import { indiaToday } from "./categoryResolver.js";
import { bucketsOf, cleanDashboardFilters, previousRange } from "./dashboardPeriods.js";
import { DUE_BILLS, DUE_MONEY, DUE_OUTSTANDING } from "./dues.js";
import { chargeColumns, lineKind, misColumnJoin, PHARMACY_COLUMN } from "./misColumns.js";
import { CATEGORY, FINAL, LINE_CONSULTANT, SCHEME_JOIN, SIGN, VISIT_JOIN } from "./reports.js";
import { dayOfInstant, reportScope } from "./reportsFilters.js";
import { BILL_COLUMNS, bucketOf, narrowed, PAYMENT_COLUMNS } from "./dashboardSql.js";
import { discountsFor } from "./dashboardDiscounts.js";

export const MONEY_COLUMNS = [
  { key: "cash", label: "Cash" },
  { key: "card", label: "Swipe" },
  { key: "upi_bharatpe", label: "BharatPe (QR Code)" },
  { key: "upi_paytm", label: "Paytm" },
  { key: "upi_other", label: "Other UPI" },
  { key: "upi_unknown", label: "UPI (app not recorded)" },
  { key: "neft", label: "NEFT / CHEQUE" },
  { key: HEALTHRAY_MODE, label: "Paid in HealthRay (mode not recorded)" },
  { key: PREPAID_MODE, label: "Paid earlier / online" },
];

export const TOP_GROUPS = 8;
export const TOP_CONSULTANTS = 10;
const CACHE_TTL_MS = 3 * 60_000;
const PAST_CACHE_TTL_MS = 30 * 60_000;
const CACHE_LIMIT = 50;

const PAID_DAY = dayOfInstant("m.received_at");

const MONEY_COLUMN = `CASE
    WHEN m.mode = '${PREPAID_MODE}' THEN '${PREPAID_MODE}'
    WHEN (CASE WHEN m.mode = '${HEALTHRAY_MODE}' THEN m.paid_via ELSE m.mode END) = 'upi'
      THEN 'upi_' || COALESCE(m.upi_app, 'unknown')
    WHEN m.mode = '${HEALTHRAY_MODE}' THEN COALESCE(m.paid_via, '${HEALTHRAY_MODE}')
    ELSE m.mode END`;

const ranged = (filters, range, period) => ({ ...filters, ...range, period });

async function billFacts(filters, db) {
  const scope = reportScope(filters, BILL_COLUMNS);
  const { rows } = await db.query(
    `WITH picked AS (
       SELECT ${bucketOf(filters.period, "b.bill_date")} AS bucket, b.bill_type, b.patient_id,
              ${SIGN} AS sign, b.patient_payable, b.round_off
         FROM bills b ${SCHEME_JOIN} ${VISIT_JOIN}
        WHERE ${FINAL} AND ${scope.sql}
     )
     SELECT bucket::text AS bucket, GROUPING(bucket) AS rolled,
            COUNT(*) FILTER (WHERE bill_type = 'invoice') AS bills,
            COUNT(*) FILTER (WHERE bill_type = 'credit_note') AS credit_notes,
            COUNT(DISTINCT patient_id) FILTER (WHERE bill_type = 'invoice') AS patients,
            COALESCE(SUM(sign * patient_payable), 0) AS net_revenue,
            COALESCE(SUM(sign * round_off), 0) AS round_off
       FROM picked
      GROUP BY GROUPING SETS ((bucket), ())`,
    scope.params,
  );
  return rows;
}

async function lineFacts(filters, db) {
  const scope = reportScope(filters, BILL_COLUMNS);
  const { rows } = await db.query(
    `WITH lined AS (
       SELECT ${bucketOf(filters.period, "b.bill_date")} AS bucket,
              COALESCE(mc.key, 'misc') AS col, ${lineKind()} AS kind,
              ${SIGN} * l.actual_amount AS actual, ${SIGN} * l.discount AS discount,
              ${SIGN} * (l.cgst + l.sgst) AS tax, ${SIGN} * l.claim_amount AS claim,
              ${SIGN} * l.adjustment_amount AS adjustment
         FROM bills b JOIN bill_lines l ON l.bill_id = b.id ${SCHEME_JOIN} ${VISIT_JOIN}
         LEFT JOIN service_items si ON si.id = l.service_item_id
         ${misColumnJoin()}
        WHERE ${FINAL} AND ${scope.sql}
     )
     SELECT bucket::text AS bucket, col, GROUPING(col) AS col_rolled,
            COALESCE(SUM(actual), 0) AS charges, COALESCE(SUM(discount), 0) AS discount,
            COALESCE(SUM(discount) FILTER (WHERE kind = 'consultation'), 0)
              AS discount_consultation,
            COALESCE(SUM(discount) FILTER (WHERE kind = 'test'), 0) AS discount_tests,
            COALESCE(SUM(tax), 0) AS tax, COALESCE(SUM(claim), 0) AS claim,
            COALESCE(SUM(adjustment), 0) AS adjustment
       FROM lined
      GROUP BY GROUPING SETS ((bucket, col), (bucket))`,
    scope.params,
  );
  return rows;
}

async function moneyFacts(filters, db) {
  const scope = reportScope(filters, PAYMENT_COLUMNS);
  const start =
    filters.period === "none"
      ? scope.bind(filters.from) + "::date"
      : bucketOf(filters.period, PAID_DAY);
  const { rows } = await db.query(
    `WITH moved AS (
       SELECT ${bucketOf(filters.period, PAID_DAY)} AS bucket,
              CASE WHEN m.mode = '${DEPOSIT_MODE}' THEN '${DEPOSIT_MODE}' ELSE ${MONEY_COLUMN} END
                AS col,
              CASE WHEN m.mode = '${DEPOSIT_MODE}' THEN 0
                   WHEN m.direction = 'in' THEN m.amount ELSE -m.amount END AS amount,
              CASE WHEN m.mode = '${DEPOSIT_MODE}' AND m.direction = 'in' THEN m.amount ELSE 0 END
                AS from_deposit,
              m.direction,
              m.bill_id IS NULL AS deposit,
              m.direction = 'in' AND b.bill_type = 'invoice' AND b.status = 'final'
                AND b.bill_date < ${start} AS earlier,
              m.direction = 'in' AND b.id IS NOT NULL AND b.status <> 'final' AS unbilled
         FROM payments m LEFT JOIN bills b ON b.id = m.bill_id ${SCHEME_JOIN} ${VISIT_JOIN}
        WHERE m.voided_at IS NULL AND ${scope.sql}
     )
     SELECT bucket::text AS bucket, col, GROUPING(col) AS col_rolled,
            COALESCE(SUM(amount), 0) AS amount,
            COALESCE(-SUM(amount) FILTER (WHERE direction = 'out'), 0) AS paid_back,
            COALESCE(SUM(amount) FILTER (WHERE earlier), 0) AS earlier_dues,
            COALESCE(SUM(amount) FILTER (WHERE deposit), 0) AS to_deposit,
            COALESCE(SUM(amount) FILTER (WHERE unbilled), 0) AS unbilled,
            COALESCE(SUM(from_deposit), 0) AS from_deposit
       FROM moved
      GROUP BY GROUPING SETS ((bucket, col), (bucket))`,
    scope.params,
  );
  return rows;
}

async function cashTakenOut(filters, db) {
  if (narrowed(filters)) return null;
  const scope = reportScope(
    { from: filters.from, to: filters.to },
    { day: { instant: "s.closed_at" } },
  );
  const { rows } = await db.query(
    `SELECT ${bucketOf(filters.period, dayOfInstant("s.closed_at"))}::text AS bucket,
            COALESCE(SUM(s.counted_cash), 0) AS cash_taken_out
       FROM cash_shifts s
      WHERE s.closed_at IS NOT NULL AND ${scope.sql}
      GROUP BY 1`,
    scope.params,
  );
  return rows;
}

async function mixFacts(filters, db) {
  const scope = reportScope(filters, BILL_COLUMNS);
  const { rows } = await db.query(
    `WITH lined AS (
       SELECT lower(l.group_code) AS gkey, l.group_code, ${CATEGORY} AS category,
              ${LINE_CONSULTANT} AS consultant,
              ${SIGN} * (l.actual_amount - l.discount) AS net
         FROM bills b JOIN bill_lines l ON l.bill_id = b.id ${SCHEME_JOIN} ${VISIT_JOIN}
        WHERE ${FINAL} AND ${scope.sql}
     ), rolled AS (
       SELECT gkey, MAX(group_code) AS group_code, category, consultant,
              GROUPING(gkey) AS g_rolled, GROUPING(category) AS c_rolled,
              GROUPING(consultant) AS d_rolled, COALESCE(SUM(net), 0) AS net
         FROM lined
        GROUP BY GROUPING SETS ((gkey), (category), (consultant))
     )
     SELECT r.*, sg.name AS group_name, ps.label AS category_label, d.name AS consultant_name
       FROM rolled r
       LEFT JOIN service_groups sg ON lower(sg.code) = r.gkey AND r.g_rolled = 0
       LEFT JOIN patient_schemes ps ON ps.code = r.category AND r.c_rolled = 0
       LEFT JOIN doctors d ON d.id = r.consultant AND r.d_rolled = 0
      ORDER BY r.net DESC`,
    scope.params,
  );
  return rows;
}

async function duesFacts(filters, db) {
  const scope = reportScope({ ...filters, from: null }, BILL_COLUMNS);
  const { rows } = await db.query(
    `SELECT COUNT(*) AS bills, COALESCE(SUM(outstanding), 0) AS outstanding
       FROM (SELECT ${DUE_OUTSTANDING} AS outstanding
               FROM bills b ${SCHEME_JOIN} ${VISIT_JOIN} ${DUE_MONEY}
              WHERE ${DUE_BILLS} AND ${scope.sql}) due
      WHERE outstanding > 0`,
    scope.params,
  );
  return { bills: Number(rows[0].bills), outstanding: paise(rows[0].outstanding) };
}

const emptyMoney = () => Object.fromEntries(MONEY_COLUMNS.map((column) => [column.key, 0]));

function blankRow(bucket, charges) {
  return {
    ...bucket,
    bills: 0,
    credit_notes: 0,
    patients: 0,
    net_revenue: 0,
    rev_per_patient: null,
    money: emptyMoney(),
    collected: 0,
    paid_back: 0,
    pending: 0,
    pending_parts: { earlier_dues: 0, to_deposit: 0, unbilled: 0, from_deposit: 0 },
    charges: Object.fromEntries(charges.map((column) => [column.key, 0])),
    charges_total: 0,
    discount: 0,
    discount_consultation: 0,
    discount_tests: 0,
    tax: 0,
    round_off: 0,
    claim: 0,
    adjustment: 0,
    cash_taken_out: null,
    check: { difference: 0, ok: true },
  };
}

function fill(row, { bills, lines, money, cashOut }) {
  if (bills) {
    row.bills = Number(bills.bills);
    row.credit_notes = Number(bills.credit_notes);
    row.patients = Number(bills.patients);
    row.net_revenue = paise(bills.net_revenue);
    row.round_off = paise(bills.round_off);
  }
  for (const line of lines) {
    if (line.col_rolled) {
      row.charges_total = paise(line.charges);
      row.discount = paise(line.discount);
      row.discount_consultation = paise(line.discount_consultation);
      row.discount_tests = paise(line.discount_tests);
      row.tax = paise(line.tax);
      row.claim = paise(line.claim);
      row.adjustment = paise(line.adjustment);
    } else {
      row.charges[line.col] = (row.charges[line.col] ?? 0) + paise(line.charges);
    }
  }
  for (const part of money) {
    if (part.col_rolled) {
      row.collected = paise(part.amount);
      row.paid_back = paise(part.paid_back);
      row.pending_parts = {
        earlier_dues: paise(part.earlier_dues),
        to_deposit: paise(part.to_deposit),
        unbilled: paise(part.unbilled),
        from_deposit: paise(part.from_deposit),
      };
    } else if (part.col !== DEPOSIT_MODE) {
      row.money[part.col] = (row.money[part.col] ?? 0) + paise(part.amount);
    }
  }
  if (cashOut !== undefined) row.cash_taken_out = cashOut === null ? null : paise(cashOut);
  row.pending = row.net_revenue - row.collected;
  row.rev_per_patient = row.patients ? Math.round(row.net_revenue / row.patients) : null;
  const fromLines =
    row.charges_total - row.discount + row.tax + row.round_off - row.claim - row.adjustment;
  row.check = { difference: fromLines - row.net_revenue, ok: fromLines === row.net_revenue };
  return row;
}

const byBucket = (rows) => {
  const map = new Map();
  for (const row of rows) {
    const key = row.bucket ?? null;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(row);
  }
  return map;
};

function addInto(total, row) {
  for (const key of [
    "bills",
    "credit_notes",
    "net_revenue",
    "collected",
    "paid_back",
    "pending",
    "charges_total",
    "discount",
    "discount_consultation",
    "discount_tests",
    "tax",
    "round_off",
    "claim",
    "adjustment",
  ]) {
    total[key] += row[key];
  }
  for (const part of Object.keys(total.pending_parts)) {
    total.pending_parts[part] += row.pending_parts[part];
  }
  for (const key of Object.keys(row.money)) {
    total.money[key] = (total.money[key] ?? 0) + row.money[key];
  }
  for (const key of Object.keys(row.charges)) {
    total.charges[key] = (total.charges[key] ?? 0) + row.charges[key];
  }
  if (row.cash_taken_out !== null) {
    total.cash_taken_out = (total.cash_taken_out ?? 0) + row.cash_taken_out;
  }
  total.check.difference += row.check.difference;
  total.check.ok = total.check.ok && row.check.ok;
  return total;
}

function topWithOther(rows, size, label) {
  const sorted = [...rows].sort((a, b) => b.net - a.net);
  const top = sorted.slice(0, size);
  const rest = sorted.slice(size);
  if (!rest.length) return top;
  return [
    ...top,
    { key: "other", label, net: rest.reduce((sum, row) => sum + row.net, 0), count: rest.length },
  ];
}

function shapeMix(rows) {
  const net = (row) => paise(row.net);
  return {
    groups: topWithOther(
      rows
        .filter((row) => row.g_rolled === 0)
        .map((row) => ({
          key: row.gkey,
          label: row.group_name ?? row.group_code ?? "No group",
          net: net(row),
        })),
      TOP_GROUPS,
      "Other groups",
    ),
    categories: rows
      .filter((row) => row.c_rolled === 0)
      .map((row) => ({
        key: row.category,
        label: row.category_label ?? row.category ?? "No category",
        net: net(row),
      })),
    consultants: topWithOther(
      rows
        .filter((row) => row.d_rolled === 0)
        .map((row) => ({
          key: row.consultant,
          label: row.consultant_name ?? "No consultant",
          net: net(row),
        })),
      TOP_CONSULTANTS,
      "Other consultants",
    ),
  };
}

function kpisOf(row) {
  return {
    net_revenue: row.net_revenue,
    gross: row.charges_total,
    discount: row.discount,
    discount_pct: row.charges_total
      ? Math.round((10000 * row.discount) / row.charges_total) / 100
      : null,
    collected: row.collected,
    paid_back: row.paid_back,
    pending: row.pending,
    bills: row.bills,
    credit_notes: row.credit_notes,
    patients: row.patients,
    avg_bill: row.bills ? Math.round(row.net_revenue / row.bills) : null,
    rev_per_patient: row.rev_per_patient,
  };
}

async function totalsFor(filters, charges, db) {
  const whole = { ...filters, period: "none" };
  const [bills, lines, money] = await Promise.all([
    billFacts(whole, db),
    lineFacts(whole, db),
    moneyFacts(whole, db),
  ]);
  return fill(blankRow({ bucket: null }, charges), {
    bills: bills.find((row) => row.rolled),
    lines,
    money,
  });
}

async function buildDashboard(filters, db) {
  const charges = await chargeColumns(db);
  const range = { from: filters.from, to: filters.to };
  const previous = previousRange(range);
  const [bills, lines, money] = await Promise.all([
    billFacts(filters, db),
    lineFacts(filters, db),
    moneyFacts(filters, db),
  ]);
  const [cashOut, mix, dues] = await Promise.all([
    cashTakenOut(filters, db),
    mixFacts(filters, db),
    duesFacts(filters, db),
  ]);
  const buckets = bucketsOf(filters);
  const discounts = await discountsFor(filters, buckets, db);
  const before = await totalsFor(ranged(filters, previous, "none"), charges, db);
  const billsBy = byBucket(bills.filter((row) => !row.rolled));
  const linesBy = byBucket(lines);
  const moneyBy = byBucket(money);
  const cashBy = cashOut ? new Map(cashOut.map((row) => [row.bucket, row.cash_taken_out])) : null;
  const rows = buckets.map((bucket) =>
    fill(blankRow(bucket, charges), {
      bills: billsBy.get(bucket.bucket)?.[0],
      lines: linesBy.get(bucket.bucket) ?? [],
      money: moneyBy.get(bucket.bucket) ?? [],
      cashOut: cashBy ? (cashBy.get(bucket.bucket) ?? 0) : null,
    }),
  );
  const total = rows.reduce(
    (sum, row) => addInto(sum, row),
    blankRow({ bucket: null, start: filters.from, end: filters.to, partial: false }, charges),
  );
  const rangeBills = bills.find((row) => row.rolled);
  total.patients = Number(rangeBills?.patients ?? 0);
  total.rev_per_patient = total.patients ? Math.round(total.net_revenue / total.patients) : null;
  return {
    filters,
    previous_range: previous,
    generated_at: new Date().toISOString(),
    columns: { charges, money: MONEY_COLUMNS, pharmacy: PHARMACY_COLUMN },
    rows,
    total,
    kpis: { current: kpisOf(total), previous: kpisOf(before) },
    mix: shapeMix(mix),
    discounts,
    dues,
  };
}

const cache = new Map();

function remember(key, ttl, build, fresh) {
  const hit = cache.get(key);
  if (!fresh && hit && Date.now() - hit.at < ttl) return hit.promise;
  const promise = build().catch((error) => {
    if (cache.get(key)?.promise === promise) cache.delete(key);
    throw error;
  });
  cache.set(key, { at: Date.now(), promise });
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
  return promise;
}

export const clearDashboardCache = () => cache.clear();

export async function billingDashboard(input = {}, db = pool, { today = indiaToday() } = {}) {
  const filters = cleanDashboardFilters(input, today);
  const ttl = filters.to < today ? PAST_CACHE_TTL_MS : CACHE_TTL_MS;
  const fresh = input?.refresh === "1" || input?.refresh === true;
  if (db !== pool) return buildDashboard(filters, db);
  return remember(JSON.stringify(filters), ttl, () => buildDashboard(filters, db), fresh);
}
