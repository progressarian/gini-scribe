import pool from "../../config/db.js";
import { paise } from "../../../shared/labPayment.js";
import { DEPOSIT_MODE, HEALTHRAY_MODE, PREPAID_MODE } from "../../../shared/billingVocab.js";
import { indiaToday } from "./categoryResolver.js";
import { cleanDate, INT_MAX } from "./common.js";
import { daysBetween, previousRange } from "./dashboardPeriods.js";
import { RANGE_DAYS_MAX, IST } from "./reportsFilters.js";
import { DRAWER_MODE, SHIFT_SQL, shape } from "./cashShifts.js";
import { CLEARED_SOURCES, PAYMENTS_TAB_CLEARED } from "./clearedMoney.js";

export { CLEARED_SOURCES };
import { httpError } from "./transaction.js";
import { getPrescriptionFooter, normalizeHospital } from "../prescriptionFooter.js";
import { CAPABILITIES, hasAnyCapability } from "../../../shared/permissions.js";

export const STAFF_MONEY_COLUMNS = [
  { key: "cash", label: "Cash", drawer: true },
  { key: "card", label: "Swipe" },
  { key: "upi_bharatpe", label: "BharatPe (QR Code)" },
  { key: "upi_paytm", label: "Paytm" },
  { key: "upi_other", label: "Other UPI" },
  { key: "upi_unknown", label: "UPI (app not recorded)" },
  { key: "neft", label: "NEFT / CHEQUE" },
  { key: HEALTHRAY_MODE, label: "Paid in HealthRay", outside: true },
  { key: PREPAID_MODE, label: "Paid earlier / online", outside: true },
];

export const MANUAL_DISCOUNT_FLAG = { amount: 50000, share: 0.2 };
export const SHIFT_LIST_MAX = 200;
export const EXCEPTION_LIST_MAX = 100;

const STAFF_COLUMN = `CASE
    WHEN m.mode IN ('${HEALTHRAY_MODE}', '${PREPAID_MODE}') THEN m.mode
    WHEN m.mode = 'upi' THEN 'upi_' || COALESCE(m.upi_app, 'unknown')
    ELSE m.mode END`;

const dayOf = (column) => `(${column} AT TIME ZONE '${IST}')::date`;
const startOf = (bind) => `(${bind}::date::timestamp AT TIME ZONE '${IST}')`;
const endOf = (bind) => `((${bind}::date + 1)::timestamp AT TIME ZONE '${IST}')`;

function cleanStaff(value) {
  if (value === undefined || value === null || value === "") return null;
  const id = Number(String(value).trim());
  if (!Number.isInteger(id) || id <= 0 || id > INT_MAX) throw httpError(400, "Staff must be an id");
  return id;
}

export function cleanStaffFilters(input = {}, today = indiaToday()) {
  const raw = input && typeof input === "object" ? input : {};
  const to = cleanDate(raw.to, "To") ?? today;
  const from = cleanDate(raw.from, "From") ?? to;
  if (from > to) throw httpError(400, "The start date is after the end date");
  if (daysBetween(from, to) > RANGE_DAYS_MAX) {
    throw httpError(400, `Choose at most ${RANGE_DAYS_MAX} days at a time`);
  }
  if (to > today) throw httpError(400, "The range can't end after today");
  const staff = cleanStaff(raw.staff);
  return staff ? { from, to, staff } : { from, to };
}

function scoped(filters, staffColumn) {
  const params = [filters.from, filters.to];
  const staff = filters.staff ? ` AND ${staffColumn} = $3` : "";
  if (filters.staff) params.push(filters.staff);
  return { params, staff };
}

async function moneyFacts(filters, db) {
  const { params, staff } = scoped(filters, "m.received_by");
  const { rows } = await db.query(
    `WITH picked AS (
       SELECT m.received_by AS staff, ${STAFF_COLUMN} AS col, m.direction, m.amount,
              COALESCE(b.patient_id, m.deposit_patient_id) AS patient,
              m.bill_id IS NULL AS deposit
         FROM payments m
         LEFT JOIN bills b ON b.id = m.bill_id
        WHERE m.voided_at IS NULL AND m.mode <> '${DEPOSIT_MODE}'
          AND ${dayOf("m.received_at")} BETWEEN $1::date AND $2::date${staff}
     )
     SELECT staff, col, GROUPING(col) AS rolled,
            COALESCE(SUM(amount) FILTER (WHERE direction = 'in'), 0) AS taken,
            COALESCE(SUM(amount) FILTER (WHERE direction = 'out'), 0) AS paid_back,
            COUNT(*) FILTER (WHERE direction = 'in') AS payments,
            COUNT(*) FILTER (WHERE direction = 'out') AS refunds,
            COALESCE(SUM(amount) FILTER (WHERE direction = 'in' AND deposit), 0) AS deposits,
            COUNT(DISTINCT patient) FILTER (WHERE direction = 'in') AS patients
       FROM picked
      GROUP BY GROUPING SETS ((staff, col), (staff))`,
    params,
  );
  return rows;
}

const CLEARED_SQL = (staff) => `
  SELECT staff, 'payments_tab' AS source, COUNT(*) AS clearances, COALESCE(SUM(amount), 0) AS amount
    FROM (
      ${PAYMENTS_TAB_CLEARED}
         AND ${dayOf("e.occurred_at")} BETWEEN $1::date AND $2::date
       ORDER BY e.lab_order_id, e.occurred_at
    ) tab
   WHERE TRUE${staff.replace("{col}", "tab.staff")}
   GROUP BY staff
  UNION ALL
  SELECT c.paid_by AS staff, 'fee_settle' AS source, COUNT(*), COALESCE(SUM(c.amount), 0)
    FROM giniflow_bill_charges c
   WHERE c.payment_status = 'paid'
     AND ${dayOf("c.paid_at")} BETWEEN $1::date AND $2::date${staff.replace("{col}", "c.paid_by")}
   GROUP BY c.paid_by`;

async function clearedFacts(filters, db) {
  const { params, staff } = scoped(filters, "{col}");
  const { rows } = await db.query(CLEARED_SQL(staff), params);
  return rows;
}

async function workFacts(filters, db) {
  const { params, staff } = scoped(filters, "{col}");
  const by = (col) => staff.replace("{col}", col);
  const { rows } = await db.query(
    `SELECT staff, kind, COUNT(*) AS n, COALESCE(SUM(amount), 0) AS amount FROM (
       SELECT b.finalised_by AS staff, 'finalised' AS kind, 0 AS amount
         FROM bills b
        WHERE b.bill_type = 'invoice' AND b.finalised_at IS NOT NULL
          AND ${dayOf("b.finalised_at")} BETWEEN $1::date AND $2::date${by("b.finalised_by")}
       UNION ALL
       SELECT b.cancelled_by, 'cancelled', 0
         FROM bills b
        WHERE b.status = 'cancelled' AND b.cancelled_at IS NOT NULL
          AND ${dayOf("b.cancelled_at")} BETWEEN $1::date AND $2::date${by("b.cancelled_by")}
       UNION ALL
       SELECT d.applied_by, 'manual_discount', d.amount
         FROM bill_line_discounts d
         JOIN bill_lines l ON l.id = d.bill_line_id
         JOIN bills b ON b.id = l.bill_id AND b.status <> 'cancelled'
        WHERE d.method = 'manual'
          AND ${dayOf("d.created_at")} BETWEEN $1::date AND $2::date${by("d.applied_by")}
       UNION ALL
       SELECT v.checked_in_by, 'check_in', 0
         FROM giniflow_visits v
        WHERE v.checked_in_by IS NOT NULL
          AND v.visit_date BETWEEN $1::date AND $2::date${by("v.checked_in_by")}
     ) w
     WHERE staff IS NOT NULL
     GROUP BY staff, kind`,
    params,
  );
  return rows;
}

async function hourFacts(filters, db) {
  const { params, staff } = scoped(filters, "m.received_by");
  const { rows } = await db.query(
    `SELECT EXTRACT(HOUR FROM m.received_at AT TIME ZONE '${IST}')::int AS hour,
            COUNT(*) AS payments, COALESCE(SUM(m.amount), 0) AS amount
       FROM payments m
      WHERE m.voided_at IS NULL AND m.direction = 'in' AND m.mode <> '${DEPOSIT_MODE}'
        AND ${dayOf("m.received_at")} BETWEEN $1::date AND $2::date${staff}
      GROUP BY 1 ORDER BY 1`,
    params,
  );
  return rows.map((row) => ({
    hour: row.hour,
    payments: Number(row.payments),
    amount: paise(row.amount),
  }));
}

async function shiftRows(filters, db) {
  const { params, staff } = scoped(filters, "s.user_id");
  params.push(SHIFT_LIST_MAX);
  const { rows } = await db.query(
    `${SHIFT_SQL}
      WHERE s.opened_at < ${endOf("$2")}
        AND (s.closed_at IS NULL OR s.closed_at >= ${startOf("$1")})${staff}
      ORDER BY s.closed_at IS NULL DESC, s.opened_at DESC
      LIMIT $${params.length}`,
    params,
  );
  return rows;
}

async function staffNames(ids, db) {
  if (!ids.length) return new Map();
  const { rows } = await db.query(
    `SELECT id, name, short_name, role FROM doctors WHERE id = ANY($1::int[])`,
    [ids],
  );
  return new Map(rows.map((row) => [row.id, row]));
}

async function collectedTotal(range, staffId, db) {
  const params = [range.from, range.to];
  if (staffId) params.push(staffId);
  const { rows } = await db.query(
    `SELECT COALESCE(SUM(CASE WHEN m.direction = 'in' THEN m.amount ELSE -m.amount END), 0) AS net
       FROM payments m
      WHERE m.voided_at IS NULL AND m.mode <> '${DEPOSIT_MODE}'
        AND ${dayOf("m.received_at")} BETWEEN $1::date AND $2::date
        ${staffId ? "AND m.received_by = $3" : ""}`,
    params,
  );
  return paise(rows[0].net);
}

async function voidedPayments(filters, db) {
  const { params, staff } = scoped(filters, "m.received_by");
  params.push(EXCEPTION_LIST_MAX);
  const { rows } = await db.query(
    `SELECT m.id, m.received_by, m.voided_by, m.voided_at, m.received_at, m.mode, m.amount,
            m.direction, m.receipt_no, b.bill_no, p.name AS patient_name, p.file_no,
            u.name AS received_by_name, vu.name AS voided_by_name
       FROM payments m
       LEFT JOIN bills b ON b.id = m.bill_id
       LEFT JOIN patients p ON p.id = COALESCE(b.patient_id, m.deposit_patient_id)
       LEFT JOIN doctors u ON u.id = m.received_by
       LEFT JOIN doctors vu ON vu.id = m.voided_by
      WHERE m.voided_at IS NOT NULL
        AND ${dayOf("m.voided_at")} BETWEEN $1::date AND $2::date${staff}
      ORDER BY m.voided_at DESC
      LIMIT $${params.length}`,
    params,
  );
  return rows.map((row) => ({
    id: row.id,
    received_by: row.received_by_name,
    voided_by: row.voided_by_name,
    voided_at: row.voided_at,
    received_at: row.received_at,
    mode: row.mode,
    direction: row.direction,
    amount: paise(row.amount),
    receipt_no: row.receipt_no,
    bill_no: row.bill_no,
    patient_name: row.patient_name,
    file_no: row.file_no,
  }));
}

async function bigManualDiscounts(filters, db) {
  const { params, staff } = scoped(filters, "d.applied_by");
  params.push(MANUAL_DISCOUNT_FLAG.amount / 100, MANUAL_DISCOUNT_FLAG.share, EXCEPTION_LIST_MAX);
  const n = params.length;
  const { rows } = await db.query(
    `SELECT d.id, d.amount, d.created_at, l.bill_name AS item_name, l.actual_amount, b.id AS bill_id,
            b.bill_no, b.visit_id, b.bill_date::text AS bill_date, b.patient_id,
            p.name AS patient_name, p.file_no, u.name AS given_by,
            COALESCE(l.manual_discount_reason, b.manual_discount_reason) AS reason
       FROM bill_line_discounts d
       JOIN bill_lines l ON l.id = d.bill_line_id
       JOIN bills b ON b.id = l.bill_id AND b.status <> 'cancelled'
       LEFT JOIN patients p ON p.id = b.patient_id
       LEFT JOIN doctors u ON u.id = d.applied_by
      WHERE d.method = 'manual'
        AND ${dayOf("d.created_at")} BETWEEN $1::date AND $2::date${staff}
        AND (d.amount >= $${n - 2} OR d.amount >= $${n - 1} * NULLIF(l.actual_amount + d.amount, 0))
      ORDER BY d.amount DESC
      LIMIT $${n}`,
    params,
  );
  return rows.map((row) => ({
    id: row.id,
    amount: paise(row.amount),
    item_name: row.item_name,
    bill_id: row.bill_id,
    bill_no: row.bill_no,
    bill_date: row.bill_date,
    visit_id: row.visit_id,
    patient_id: row.patient_id,
    patient_name: row.patient_name,
    file_no: row.file_no,
    given_by: row.given_by,
    reason: row.reason,
    at: row.created_at,
  }));
}

const toPaise = (rupees) => (rupees === null || rupees === undefined ? null : paise(rupees));

export function shiftInPaise(shift, today) {
  const flow = (money) =>
    Object.fromEntries(Object.entries(money).map(([key, value]) => [key, paise(value)]));
  const openedDay = new Intl.DateTimeFormat("en-CA", { timeZone: IST }).format(
    new Date(shift.opened_at),
  );
  const closedDay = shift.closed_at
    ? new Intl.DateTimeFormat("en-CA", { timeZone: IST }).format(new Date(shift.closed_at))
    : null;
  return {
    ...shift,
    opening_cash: paise(shift.opening_cash),
    collected: flow(shift.collected),
    refunded: flow(shift.refunded),
    deposits: {
      ...shift.deposits,
      received: paise(shift.deposits.received),
      refunded: paise(shift.deposits.refunded),
    },
    healthray: {
      collected: paise(shift.healthray.collected),
      refunded: paise(shift.healthray.refunded),
    },
    prepaid: { collected: paise(shift.prepaid.collected) },
    expected_cash: paise(shift.expected_cash),
    counted_cash: toPaise(shift.counted_cash),
    difference: toPaise(shift.difference),
    opened_day: openedDay,
    left_open: shift.is_open && openedDay < today,
    crosses_midnight: Boolean(closedDay) && closedDay !== openedDay,
  };
}

const zeroMoney = () => Object.fromEntries(STAFF_MONEY_COLUMNS.map((col) => [col.key, 0]));

function blankStaff(id, person) {
  return {
    id,
    name: person?.name ?? (id ? `Staff #${id}` : "Not recorded"),
    role: person?.role ?? null,
    money: zeroMoney(),
    taken: zeroMoney(),
    paid_back: zeroMoney(),
    cleared: Object.fromEntries(CLEARED_SOURCES.map((src) => [src.key, 0])),
    cleared_count: 0,
    payments: 0,
    refunds: 0,
    refunded: 0,
    deposits: 0,
    patients: 0,
    collected: 0,
    finalised: 0,
    cancelled: 0,
    check_ins: 0,
    manual_discounts: 0,
    manual_discount_amount: 0,
    shifts: 0,
    open_shifts: 0,
    short: 0,
    over: 0,
  };
}

function cashChecks(shifts) {
  const closed = shifts.filter((s) => !s.is_open && s.difference !== null);
  const short = closed.filter((s) => s.difference < 0);
  const over = closed.filter((s) => s.difference > 0);
  return {
    short: { count: short.length, amount: short.reduce((sum, s) => sum + s.difference, 0) },
    over: { count: over.length, amount: over.reduce((sum, s) => sum + s.difference, 0) },
    matched: closed.length - short.length - over.length,
    not_counted: shifts.filter((s) => !s.is_open && s.counted_cash === null).length,
  };
}

export async function staffDashboard(input = {}, db = pool, { today = indiaToday() } = {}) {
  const filters = cleanStaffFilters(input, today);
  const previous = previousRange(filters);
  const [money, cleared, work] = await Promise.all([
    moneyFacts(filters, db),
    clearedFacts(filters, db),
    workFacts(filters, db),
  ]);
  const [hours, shiftsRaw, before] = await Promise.all([
    hourFacts(filters, db),
    shiftRows(filters, db),
    collectedTotal(previous, filters.staff, db),
  ]);
  const [voided, discounts] = await Promise.all([
    voidedPayments(filters, db),
    bigManualDiscounts(filters, db),
  ]);
  const shifts = shiftsRaw.map((row) => shiftInPaise(shape(row), today));

  const ids = new Set();
  for (const row of [...money, ...cleared, ...work]) ids.add(row.staff ?? 0);
  for (const shift of shifts) ids.add(shift.user.id);
  const people = await staffNames([...ids].filter(Boolean), db);
  const byId = new Map();
  const staffOf = (id) => {
    const key = id ?? 0;
    if (!byId.has(key)) byId.set(key, blankStaff(id ?? null, people.get(id)));
    return byId.get(key);
  };

  for (const row of money) {
    const person = staffOf(row.staff);
    if (Number(row.rolled) === 1) {
      person.payments = Number(row.payments);
      person.refunds = Number(row.refunds);
      person.patients = Number(row.patients);
      person.deposits = paise(row.deposits);
      person.refunded = paise(row.paid_back);
      person.collected = paise(row.taken) - paise(row.paid_back);
      continue;
    }
    if (!(row.col in person.money)) continue;
    person.money[row.col] = paise(row.taken) - paise(row.paid_back);
    person.taken[row.col] = paise(row.taken);
    person.paid_back[row.col] = paise(row.paid_back);
  }
  for (const row of cleared) {
    const person = staffOf(row.staff);
    person.cleared[row.source] += paise(row.amount);
    person.cleared_count += Number(row.clearances);
  }
  for (const row of work) {
    const person = staffOf(row.staff);
    if (row.kind === "finalised") person.finalised = Number(row.n);
    if (row.kind === "cancelled") person.cancelled = Number(row.n);
    if (row.kind === "check_in") person.check_ins = Number(row.n);
    if (row.kind === "manual_discount") {
      person.manual_discounts = Number(row.n);
      person.manual_discount_amount = paise(row.amount);
    }
  }
  for (const shift of shifts) {
    const person = staffOf(shift.user.id);
    person.shifts += 1;
    if (shift.is_open) person.open_shifts += 1;
    const counts = !shift.is_open && closedWithin(shift, filters);
    if (counts && shift.difference < 0) person.short += shift.difference;
    if (counts && shift.difference > 0) person.over += shift.difference;
  }

  const staff = [...byId.values()].sort(
    (a, b) => b.collected - a.collected || a.name.localeCompare(b.name),
  );
  const sum = (key) => staff.reduce((total, person) => total + person[key], 0);
  const sumOf = (key, col) => staff.reduce((total, person) => total + person[key][col], 0);
  const total = {
    collected: sum("collected"),
    refunded: sum("refunded"),
    refunds: sum("refunds"),
    payments: sum("payments"),
    deposits: sum("deposits"),
    finalised: sum("finalised"),
    cancelled: sum("cancelled"),
    check_ins: sum("check_ins"),
    manual_discounts: sum("manual_discounts"),
    manual_discount_amount: sum("manual_discount_amount"),
    cleared_count: sum("cleared_count"),
    money: Object.fromEntries(STAFF_MONEY_COLUMNS.map((c) => [c.key, sumOf("money", c.key)])),
    taken: Object.fromEntries(STAFF_MONEY_COLUMNS.map((c) => [c.key, sumOf("taken", c.key)])),
    cleared: Object.fromEntries(CLEARED_SOURCES.map((c) => [c.key, sumOf("cleared", c.key)])),
    patients: await distinctPatients(filters, db),
  };
  const open = shifts.filter((s) => s.is_open);
  const handover = {
    closed_cash: shifts
      .filter((s) => !s.is_open && s.closed_at && closedWithin(s, filters))
      .reduce((sum, s) => sum + (s.counted_cash ?? s.expected_cash), 0),
    open_cash: open.reduce((sum, s) => sum + s.expected_cash, 0),
    open_shifts: open.length,
    includes_today: filters.to === today,
    ...cashChecks(shifts.filter((s) => s.closed_at && closedWithin(s, filters))),
  };
  return {
    filters,
    today,
    previous: { ...previous, collected: before },
    columns: {
      money: STAFF_MONEY_COLUMNS.filter((col) => staff.some((p) => p.money[col.key] !== 0)),
      all_money: STAFF_MONEY_COLUMNS,
      cleared: CLEARED_SOURCES.filter((src) => staff.some((p) => p.cleared[src.key] !== 0)),
    },
    total,
    handover,
    staff,
    shifts,
    hours,
    exceptions: {
      left_open: shifts.filter((s) => s.left_open),
      differences: shifts.filter((s) => !s.is_open && s.difference && closedWithin(s, filters)),
      voided,
      manual_discounts: discounts,
      flag: MANUAL_DISCOUNT_FLAG,
    },
    drawer_mode: DRAWER_MODE,
  };
}

function closedWithin(shift, filters) {
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: IST }).format(new Date(shift.closed_at));
  return day >= filters.from && day <= filters.to;
}

async function distinctPatients(filters, db) {
  const { params, staff } = scoped(filters, "m.received_by");
  const { rows } = await db.query(
    `SELECT COUNT(DISTINCT COALESCE(b.patient_id, m.deposit_patient_id)) AS n
       FROM payments m
       LEFT JOIN bills b ON b.id = m.bill_id
      WHERE m.voided_at IS NULL AND m.direction = 'in' AND m.mode <> '${DEPOSIT_MODE}'
        AND ${dayOf("m.received_at")} BETWEEN $1::date AND $2::date${staff}`,
    params,
  );
  return Number(rows[0].n);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const SHIFT_PAYMENTS_MAX = 1000;

const WINDOW = `s.opened_at AND COALESCE(s.closed_at, NOW())`;

async function shiftPayments(id, db) {
  const { rows } = await db.query(
    `SELECT m.id, m.received_at, m.receipt_no, m.mode, m.upi_app, m.paid_via, m.reference,
            m.direction, m.amount, m.voided_at, vu.name AS voided_by, m.shift_id,
            m.bill_id IS NULL AS deposit, b.id AS bill_id, b.bill_no, b.visit_id,
            b.bill_date::text AS bill_date, p.id AS patient_id, p.name AS patient_name, p.file_no
       FROM cash_shifts s
       JOIN payments m ON m.shift_id = s.id
                       OR (m.shift_id IS NULL AND m.received_by = s.user_id
                           AND m.received_at BETWEEN ${WINDOW})
       LEFT JOIN bills b ON b.id = m.bill_id
       LEFT JOIN patients p ON p.id = COALESCE(b.patient_id, m.deposit_patient_id)
       LEFT JOIN doctors vu ON vu.id = m.voided_by
      WHERE s.id = $1
      ORDER BY m.received_at
      LIMIT ${SHIFT_PAYMENTS_MAX + 1}`,
    [id],
  );
  return rows;
}

async function shiftCleared(id, db) {
  const { rows } = await db.query(
    `SELECT * FROM (
       SELECT DISTINCT ON (e.lab_order_id) 'payments_tab' AS source, e.occurred_at AS at,
              o.amount_paid AS amount, p.name AS patient_name, p.file_no,
              COALESCE((SELECT string_agg(t.test_name, ', ' ORDER BY t.test_name)
                         FROM giniflow_lab_order_tests t WHERE t.lab_order_id = o.id),
                       'Test order') AS item
         FROM cash_shifts s
         JOIN giniflow_lab_order_events e ON e.actor_id = s.user_id
                                          AND e.occurred_at BETWEEN ${WINDOW}
         JOIN giniflow_lab_orders o ON o.id = e.lab_order_id
         LEFT JOIN giniflow_visits v ON v.id = o.visit_id
         LEFT JOIN patients p ON p.id = v.patient_id
        WHERE s.id = $1 AND e.track = 'payment' AND e.status IN ('paid', 'split')
          AND e.meta ->> 'bill_id' IS NULL AND o.amount_paid > 0
        ORDER BY e.lab_order_id, e.occurred_at
     ) tab
     UNION ALL
     SELECT 'fee_settle', c.paid_at, c.amount, p.name, p.file_no, c.item_name
       FROM cash_shifts s
       JOIN giniflow_bill_charges c ON c.paid_by = s.user_id AND c.payment_status = 'paid'
                                    AND c.paid_at BETWEEN ${WINDOW}
       LEFT JOIN giniflow_visits v ON v.id = c.visit_id
       LEFT JOIN patients p ON p.id = v.patient_id
      WHERE s.id = $1
     ORDER BY at`,
    [id],
  );
  return rows.map((row) => ({
    source: row.source,
    at: row.at,
    amount: paise(row.amount),
    patient_name: row.patient_name,
    file_no: row.file_no,
    item: row.item,
  }));
}

async function shiftActivity(id, db) {
  const { rows } = await db.query(
    `SELECT kind, at, bill_id, bill_no, visit_id, bill_date, patient_name, file_no, amount, note
       FROM (
         SELECT 'finalised' AS kind, b.finalised_at AS at, b.id AS bill_id, b.bill_no, b.visit_id,
                b.bill_date::text AS bill_date, p.name AS patient_name, p.file_no,
                b.patient_payable AS amount, NULL AS note
           FROM cash_shifts s
           JOIN bills b ON b.finalised_by = s.user_id AND b.finalised_at BETWEEN ${WINDOW}
           LEFT JOIN patients p ON p.id = b.patient_id
          WHERE s.id = $1 AND b.bill_type = 'invoice'
         UNION ALL
         SELECT 'cancelled', b.cancelled_at, b.id, b.bill_no, b.visit_id, b.bill_date::text,
                p.name, p.file_no, b.patient_payable, b.cancel_reason
           FROM cash_shifts s
           JOIN bills b ON b.cancelled_by = s.user_id AND b.cancelled_at BETWEEN ${WINDOW}
           LEFT JOIN patients p ON p.id = b.patient_id
          WHERE s.id = $1
         UNION ALL
         SELECT 'manual_discount', MIN(d.created_at), b.id, b.bill_no, b.visit_id,
                b.bill_date::text, p.name, p.file_no, SUM(d.amount),
                string_agg(DISTINCT COALESCE(l.manual_discount_reason, b.manual_discount_reason), '; ')
           FROM cash_shifts s
           JOIN bill_line_discounts d ON d.applied_by = s.user_id AND d.method = 'manual'
                                     AND d.created_at BETWEEN ${WINDOW}
           JOIN bill_lines l ON l.id = d.bill_line_id
           JOIN bills b ON b.id = l.bill_id
           LEFT JOIN patients p ON p.id = b.patient_id
          WHERE s.id = $1
          GROUP BY b.id, b.bill_no, b.visit_id, b.bill_date, p.name, p.file_no
       ) a
      ORDER BY at`,
    [id],
  );
  return rows.map((row) => ({ ...row, amount: paise(row.amount) }));
}

async function changedAfterClose(id, db) {
  const { rows } = await db.query(
    `SELECT a.entity_id AS payment_id, a.at, a.before, a.after, u.name AS by
       FROM cash_shifts s
       JOIN payments m ON m.shift_id = s.id
       JOIN billing_audit a ON a.entity = 'payments' AND a.entity_id = m.id::text
                            AND a.action = 'update' AND a.at > s.closed_at
       LEFT JOIN doctors u ON u.id = a.actor_id
      WHERE s.id = $1 AND s.closed_at IS NOT NULL
      ORDER BY a.at`,
    [id],
  );
  return rows;
}

export async function staffShiftDetail(id, db = pool, { today = indiaToday() } = {}) {
  const shiftId = typeof id === "string" ? id.trim() : "";
  if (!UUID.test(shiftId)) throw httpError(400, "Choose a valid shift");
  const { rows } = await db.query(`${SHIFT_SQL} WHERE s.id = $1`, [shiftId]);
  if (!rows.length) throw httpError(404, "That shift no longer exists");
  const shift = shiftInPaise(shape(rows[0]), today);
  const [payments, cleared, activity] = await Promise.all([
    shiftPayments(shiftId, db),
    shiftCleared(shiftId, db),
    shiftActivity(shiftId, db),
  ]);
  const changes = await changedAfterClose(shiftId, db);
  const footer = await getPrescriptionFooter();
  return {
    hospital: normalizeHospital(footer?.hospital).name,
    shift,
    payments: payments.slice(0, SHIFT_PAYMENTS_MAX).map((row) => ({
      ...row,
      amount: paise(row.amount),
      outside_shift: row.shift_id === null,
    })),
    payments_truncated: payments.length > SHIFT_PAYMENTS_MAX,
    cleared,
    activity,
    changes,
    columns: STAFF_MONEY_COLUMNS,
  };
}

export async function shiftHandover(id, ctx, db = pool) {
  const detail = await staffShiftDetail(id, db);
  const own = detail.shift.user.id === ctx?.actorId;
  if (!own && !hasAnyCapability(ctx?.role, CAPABILITIES.BILLING_REPORTS)) {
    throw httpError(403, "You can print only your own shift's handover");
  }
  return detail;
}

export const EXPORT_PAYMENTS_MAX = 20000;

export async function rangePayments(input = {}, db = pool, { today = indiaToday() } = {}) {
  const filters = cleanStaffFilters(input, today);
  const { params, staff } = scoped(filters, "m.received_by");
  params.push(EXPORT_PAYMENTS_MAX);
  const { rows } = await db.query(
    `SELECT m.received_at, m.receipt_no, m.mode, m.upi_app, m.paid_via, m.reference, m.direction,
            m.amount, m.voided_at, u.name AS staff, b.bill_no, p.name AS patient_name, p.file_no,
            m.bill_id IS NULL AS deposit
       FROM payments m
       LEFT JOIN doctors u ON u.id = m.received_by
       LEFT JOIN bills b ON b.id = m.bill_id
       LEFT JOIN patients p ON p.id = COALESCE(b.patient_id, m.deposit_patient_id)
      WHERE m.mode <> '${DEPOSIT_MODE}'
        AND ${dayOf("m.received_at")} BETWEEN $1::date AND $2::date${staff}
      ORDER BY m.received_at
      LIMIT $${params.length}`,
    params,
  );
  return rows.map((row) => ({ ...row, amount: paise(row.amount) }));
}
