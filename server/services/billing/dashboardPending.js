import pool from "../../config/db.js";
import { paise } from "../../../shared/labPayment.js";
import { DEPOSIT_MODE } from "../../../shared/billingVocab.js";
import { indiaToday } from "./categoryResolver.js";
import { cleanDashboardFilters } from "./dashboardPeriods.js";
import { SCHEME_JOIN, SIGN, VISIT_JOIN } from "./reports.js";
import { dayOfInstant, reportScope } from "./reportsFilters.js";
import { BILL_COLUMNS, BILLED, PAYMENT_COLUMNS } from "./dashboardSql.js";
import { MONEY_COLUMN, MONEY_COLUMNS } from "./dashboard.js";

export const PENDING_ROWS_MAX = 500;

const PAID_DAY = dayOfInstant("m.received_at");

const LINE_NAMES = (
  billExpr,
  liveOnly = true,
) => `(SELECT string_agg(l.bill_name, ', ' ORDER BY l.line_no)
    FROM bill_lines l WHERE l.bill_id = ${billExpr}${liveOnly ? " AND l.is_live" : ""})`;

const SERVICES = (alias) =>
  `COALESCE(${LINE_NAMES(`${alias}.id`)}, ${LINE_NAMES(`${alias}.original_bill_id`)},
            ${LINE_NAMES(`${alias}.original_bill_id`, false)})`;

const MODE_LABEL = Object.fromEntries(MONEY_COLUMNS.map((column) => [column.key, column.label]));

async function outsidePayments(filters, db) {
  const scope = reportScope(filters, PAYMENT_COLUMNS);
  const from = scope.bind(filters.from);
  const to = scope.bind(filters.to);
  const { rows } = await db.query(
    `SELECT m.id, m.received_at, m.direction, ${MONEY_COLUMN} AS col,
            CASE WHEN m.direction = 'in' THEN m.amount ELSE -m.amount END AS amount,
            CASE WHEN m.bill_id IS NULL THEN 'to_deposit'
                 WHEN NOT ${BILLED} THEN 'unbilled'
                 ELSE 'earlier_dues' END AS reason,
            b.id AS bill_id, b.bill_no, b.bill_date::text AS bill_date, b.bill_type,
            b.status AS bill_status, b.patient_payable AS bill_total, b.paid_amount AS bill_paid,
            p.id AS patient_id, p.name AS patient_name, p.file_no,
            ${SERVICES("b")} AS services
       FROM payments m LEFT JOIN bills b ON b.id = m.bill_id ${SCHEME_JOIN} ${VISIT_JOIN}
       LEFT JOIN patients p ON p.id = COALESCE(b.patient_id, m.deposit_patient_id)
      WHERE m.voided_at IS NULL AND m.mode <> '${DEPOSIT_MODE}' AND ${scope.sql}
        AND (m.bill_id IS NULL OR NOT ${BILLED}
             OR b.bill_date < ${from}::date OR b.bill_date > ${to}::date)
      ORDER BY m.received_at, p.name, m.id`,
    scope.params,
  );
  return rows;
}

async function openBills(filters, db) {
  const scope = reportScope(filters, BILL_COLUMNS);
  const from = scope.bind(filters.from);
  const to = scope.bind(filters.to);
  const { rows } = await db.query(
    `WITH picked AS (
       SELECT b.id, b.original_bill_id, b.bill_no, b.bill_date, b.bill_type, b.status, b.patient_id,
              ${SIGN} * b.patient_payable AS billed,
              COALESCE((SELECT SUM(CASE WHEN m.direction = 'in' THEN m.amount ELSE -m.amount END)
                          FROM payments m
                         WHERE m.bill_id = b.id AND m.voided_at IS NULL
                           AND m.mode <> '${DEPOSIT_MODE}'
                           AND ${PAID_DAY} BETWEEN ${from}::date AND ${to}::date), 0) AS collected,
              COALESCE((SELECT SUM(CASE WHEN m.direction = 'in' THEN m.amount ELSE -m.amount END)
                          FROM payments m
                         WHERE m.bill_id = b.id AND m.voided_at IS NULL
                           AND m.mode = '${DEPOSIT_MODE}'), 0) AS from_deposit
         FROM bills b ${SCHEME_JOIN} ${VISIT_JOIN}
        WHERE ${BILLED} AND ${scope.sql}
     )
     SELECT k.*, k.bill_date::text AS bill_day, p.name AS patient_name, p.file_no,
            ${SERVICES("k")} AS services
       FROM picked k JOIN patients p ON p.id = k.patient_id
      WHERE k.billed <> k.collected
      ORDER BY k.bill_date, p.name, k.id`,
    scope.params,
  );
  return rows;
}

const sumOf = (rows, key) => rows.reduce((sum, row) => sum + row[key], 0);

export async function pendingDetail(input = {}, db = pool, { today = indiaToday() } = {}) {
  const filters = cleanDashboardFilters(input, today);
  const [paymentRows, billRows] = await Promise.all([
    outsidePayments(filters, db),
    openBills(filters, db),
  ]);
  const payments = paymentRows.map((row) => ({
    id: row.id,
    received_at: row.received_at,
    reason: row.reason,
    mode: MODE_LABEL[row.col] ?? row.col,
    amount: paise(row.amount),
    bill_id: row.bill_id,
    bill_no: row.bill_no,
    bill_date: row.bill_date,
    bill_status: row.bill_status,
    bill_total: row.bill_id ? paise(row.bill_total) : null,
    bill_paid: row.bill_id ? paise(row.bill_paid) : null,
    credit_note: row.bill_type === "credit_note",
    patient: { id: row.patient_id, name: row.patient_name, file_no: row.file_no },
    services: row.services,
  }));
  const bills = billRows.map((row) => {
    const billed = paise(row.billed);
    const collected = paise(row.collected);
    return {
      bill_id: row.id,
      bill_no: row.bill_no,
      bill_date: row.bill_day,
      status: row.status,
      credit_note: row.bill_type === "credit_note",
      patient: { id: row.patient_id, name: row.patient_name, file_no: row.file_no },
      services: row.services,
      billed,
      collected,
      from_deposit: paise(row.from_deposit),
      gap: billed - collected,
    };
  });
  const paymentsTotal = sumOf(payments, "amount");
  const billsTotal = sumOf(bills, "gap");
  return {
    filters,
    pending: billsTotal - paymentsTotal,
    payments: {
      total: paymentsTotal,
      count: payments.length,
      truncated: payments.length > PENDING_ROWS_MAX,
      rows: payments.slice(0, PENDING_ROWS_MAX),
    },
    bills: {
      total: billsTotal,
      count: bills.length,
      truncated: bills.length > PENDING_ROWS_MAX,
      rows: bills.slice(0, PENDING_ROWS_MAX),
    },
  };
}
