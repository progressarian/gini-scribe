import pool from "../../config/db.js";
import { writeAudit } from "../billing/audit.js";
import { httpError, inTransaction } from "../billing/transaction.js";
import { nextNumber } from "../billing/billNumber.js";
import { shiftForPayments } from "./paymentShift.js";
import { DUE_SQL } from "./billDue.js";
import { toPaise, toRupees } from "../../../shared/pharmacyMoney.js";
import { PHARMACY_SERIES } from "../../../shared/pharmacyVocab.js";

const ENTITY = "pharmacy_account_entries";
const today = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
const rupeeText = (paise) => `₹${toRupees(paise)}`;

export const BALANCE_SQL = (patient) => `(SELECT COALESCE(SUM(CASE
      WHEN e.kind IN ('deposit', 'voucher_credit') THEN e.amount
      ELSE -e.amount END) FILTER (WHERE e.kind <> 'write_off'), 0)::numeric(12, 2)
   FROM pharmacy_account_entries e WHERE e.patient_id = ${patient})`;

async function lockPatient(client, patientId) {
  await client.query(`SELECT pg_advisory_xact_lock(hashtext('pharmacy_account:' || $1))`, [
    patientId,
  ]);
  const { rows } = await client.query(
    `SELECT p.id, p.name, ${BALANCE_SQL("p.id")} AS balance FROM patients p WHERE p.id = $1`,
    [patientId],
  );
  if (!rows.length) throw httpError(404, "Patient not found");
  return { ...rows[0], balance: toPaise(rows[0].balance) };
}

async function entry(client, ctx, values) {
  const { rows } = await client.query(
    `INSERT INTO pharmacy_account_entries
       (patient_id, kind, amount, bill_id, payment_id, reason, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, entry_no, kind, amount, created_at`,
    [
      values.patientId,
      values.kind,
      toRupees(values.amount),
      values.billId ?? null,
      values.paymentId ?? null,
      values.reason ?? null,
      ctx.actorId ?? null,
    ],
  );
  await writeAudit(client, {
    entity: ENTITY,
    entityId: String(rows[0].id),
    action: "create",
    after: {
      ...rows[0],
      patient_id: values.patientId,
      bill_id: values.billId ?? null,
      reason: values.reason ?? null,
    },
    actorId: ctx.actorId,
    ip: ctx.ip,
  });
  return rows[0];
}

async function moneyRow(
  client,
  ctx,
  { billId = null, patientId, direction, payment, shiftId, receipt },
) {
  const { rows } = await client.query(
    `INSERT INTO pharmacy_payments
       (bill_id, patient_id, direction, mode, amount, reference, upi_app, receipt_no, received_by,
        shift_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING id, receipt_no`,
    [
      billId,
      patientId,
      direction,
      payment.mode,
      toRupees(toPaise(payment.amount)),
      payment.mode === "cash" || payment.mode === "deposit" ? null : (payment.reference ?? null),
      payment.upi_app ?? null,
      receipt,
      ctx.actorId ?? null,
      payment.mode === "deposit" ? null : shiftId,
    ],
  );
  return rows[0];
}

export async function recordBillPayments(
  client,
  { billId, patientId, payments, day = today() },
  ctx,
  { requireShiftForCash = false } = {},
) {
  const shiftId = await shiftForPayments(
    client,
    ctx,
    payments.map((p) => p.mode),
    { requireForCash: requireShiftForCash },
  );
  const fromDeposit = payments
    .filter((p) => p.mode === "deposit")
    .reduce((sum, p) => sum + toPaise(p.amount), 0);
  if (fromDeposit) {
    const account = await lockPatient(client, patientId);
    if (fromDeposit > account.balance) {
      throw httpError(
        409,
        `Only ${rupeeText(account.balance)} is left in ${account.name}'s pharmacy deposit, so ${rupeeText(fromDeposit)} cannot be paid from it`,
      );
    }
  }
  const receipts = [];
  for (const payment of payments) {
    const receipt =
      payment.mode === "deposit"
        ? null
        : (await nextNumber(client, PHARMACY_SERIES.receipt, day, ctx)).number;
    const row = await moneyRow(client, ctx, {
      billId,
      patientId,
      direction: "in",
      payment,
      shiftId,
      receipt,
    });
    if (payment.mode === "deposit") {
      await entry(client, ctx, {
        patientId,
        kind: "deposit_used",
        amount: toPaise(payment.amount),
        billId,
        paymentId: row.id,
      });
    }
    if (receipt) receipts.push(receipt);
  }
  return receipts;
}

export async function receiveDeposit(patientId, input, ctx = {}, db = pool) {
  return inTransaction(async (client) => {
    await lockPatient(client, patientId);
    const shiftId = await shiftForPayments(client, ctx, [input.mode], {
      requireForCash: Boolean(input.requireShiftForCash),
    });
    const receipt = await nextNumber(client, PHARMACY_SERIES.receipt, today(), ctx);
    const payment = await moneyRow(client, ctx, {
      patientId,
      direction: "in",
      payment: input,
      shiftId,
      receipt: receipt.number,
    });
    await entry(client, ctx, {
      patientId,
      kind: "deposit",
      amount: toPaise(input.amount),
      paymentId: payment.id,
      reason: input.reason ?? null,
    });
    return patientAccount(patientId, client);
  }, db);
}

export async function refundDeposit(patientId, input, ctx = {}, db = pool) {
  return inTransaction(async (client) => {
    const account = await lockPatient(client, patientId);
    const amount = toPaise(input.amount);
    if (amount > account.balance) {
      throw httpError(
        409,
        `Only ${rupeeText(account.balance)} is left in ${account.name}'s pharmacy deposit`,
      );
    }
    const shiftId = await shiftForPayments(client, ctx, [input.mode]);
    const payment = await moneyRow(client, ctx, {
      patientId,
      direction: "out",
      payment: input,
      shiftId,
      receipt: null,
    });
    await entry(client, ctx, {
      patientId,
      kind: "deposit_refund",
      amount,
      paymentId: payment.id,
      reason: input.reason,
    });
    return patientAccount(patientId, client);
  }, db);
}

export async function addVoucher(patientId, input, ctx = {}, db = pool) {
  return inTransaction(async (client) => {
    const account = await lockPatient(client, patientId);
    const amount = toPaise(input.amount);
    if (input.kind === "debit" && amount > account.balance) {
      throw httpError(
        409,
        `A debit voucher cannot take the account below zero; ${rupeeText(account.balance)} is left`,
      );
    }
    await entry(client, ctx, {
      patientId,
      kind: input.kind === "credit" ? "voucher_credit" : "voucher_debit",
      amount,
      reason: input.reason,
    });
    return patientAccount(patientId, client);
  }, db);
}

export async function writeOffDue(billId, input, ctx = {}, db = pool) {
  return inTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT b.id, b.bill_no, b.patient_id, b.bill_type, b.status, ${DUE_SQL} AS due
         FROM pharmacy_bills b WHERE b.id = $1 FOR UPDATE`,
      [billId],
    );
    if (!rows.length) throw httpError(404, "Pharmacy bill not found");
    const bill = rows[0];
    if (bill.bill_type !== "invoice" || bill.status !== "final") {
      throw httpError(409, "Only money due on a finalised bill can be written off");
    }
    const due = toPaise(bill.due);
    const amount =
      input.amount === undefined || input.amount === null ? due : toPaise(input.amount);
    if (!due) throw httpError(409, `Nothing is due on bill ${bill.bill_no}`);
    if (amount <= 0 || amount > due) {
      throw httpError(409, `At most ${rupeeText(due)} is due on bill ${bill.bill_no}`);
    }
    await entry(client, ctx, {
      patientId: bill.patient_id,
      kind: "write_off",
      amount,
      billId,
      reason: input.reason,
    });
    await client.query(
      `UPDATE pharmacy_bills SET version = version + 1, updated_at = NOW(), updated_by = $2
        WHERE id = $1`,
      [billId, ctx.actorId ?? null],
    );
    return patientAccount(bill.patient_id, client);
  }, db);
}

export async function patientAccount(patientId, db = pool) {
  const { rows } = await db.query(
    `SELECT p.id, p.name, p.file_no, p.phone, ${BALANCE_SQL("p.id")} AS balance
       FROM patients p WHERE p.id = $1`,
    [patientId],
  );
  if (!rows.length) throw httpError(404, "Patient not found");
  const { rows: statement } = await db.query(
    `SELECT * FROM (
       SELECT b.finalised_at AS at, CASE WHEN b.bill_type = 'invoice' THEN 'bill' ELSE 'sales_return' END AS kind,
              b.bill_no AS ref, b.id::text AS bill_id, b.net_amount AS amount,
              CASE WHEN b.bill_type = 'credit_note' THEN b.notes END AS note
         FROM pharmacy_bills b
        WHERE b.patient_id = $1 AND b.status = 'final'
       UNION ALL
       SELECT p.received_at, CASE WHEN p.direction = 'out' THEN 'refund_paid' ELSE 'payment' END,
              COALESCE(p.receipt_no, '—'), p.bill_id::text, p.amount,
              CASE p.mode WHEN 'cash' THEN 'Cash' WHEN 'card' THEN 'Card' WHEN 'upi' THEN 'UPI'
                          WHEN 'neft' THEN 'NEFT / Cheque' ELSE 'From deposit' END
                || COALESCE(' · ' || p.reference, '')
         FROM pharmacy_payments p
        WHERE p.patient_id = $1 AND p.bill_id IS NOT NULL
       UNION ALL
       SELECT e.created_at, e.kind, e.entry_no, e.bill_id::text, e.amount, e.reason
         FROM pharmacy_account_entries e
        WHERE e.patient_id = $1 AND e.kind <> 'deposit_used'
     ) s
     ORDER BY at DESC
     LIMIT 300`,
    [patientId],
  );
  const { rows: open } = await db.query(
    `SELECT * FROM (
       SELECT b.id, b.bill_no, b.bill_date, b.net_amount, ${DUE_SQL} AS due_amount
         FROM pharmacy_bills b
        WHERE b.patient_id = $1 AND b.bill_type = 'invoice' AND b.status = 'final'
          AND b.pay_later AND b.paid_amount < b.net_amount) d
      WHERE due_amount > 0 ORDER BY bill_date`,
    [patientId],
  );
  return { ...rows[0], open_bills: open, statement };
}

const LEDGER_SORTS = {
  name: "lower(name)",
  file_no: "file_no",
  payer: "lower(payer)",
  total_amount: "total_amount",
  paid: "paid",
  write_off: "write_off",
  deposit: "deposit",
  deposit_refund: "deposit_refund",
  discounts: "discounts",
  sales_return: "sales_return",
  voucher_manual: "voucher_manual",
  due: "due",
  balance: "balance",
  last_activity: "last_activity",
};

export async function patientLedger(
  { q, sort = "last_activity", dir = "desc", only = "all", limit = 50, offset = 0 } = {},
  db = pool,
) {
  const params = [limit, offset];
  const where = [];
  if (q) {
    params.push(`%${q.toLowerCase()}%`);
    const $ = `$${params.length}`;
    where.push(
      `(lower(name) LIKE ${$} OR lower(COALESCE(file_no, '')) LIKE ${$} OR COALESCE(phone, '') LIKE ${$})`,
    );
  }
  if (only === "due") where.push("due > 0");
  if (only === "balance") where.push("balance > 0");
  const order = `${LEDGER_SORTS[sort] ?? LEDGER_SORTS.last_activity} ${dir === "asc" ? "ASC" : "DESC"} NULLS LAST`;
  const { rows } = await db.query(
    `WITH active AS (
       SELECT patient_id FROM pharmacy_bills WHERE status = 'final'
       UNION SELECT patient_id FROM pharmacy_account_entries
     ),
     bills AS (
       SELECT b.patient_id,
              COALESCE(SUM(b.net_amount) FILTER (WHERE b.bill_type = 'invoice'), 0) AS total_amount,
              COALESCE(SUM(b.discount_amount) FILTER (WHERE b.bill_type = 'invoice'), 0) AS discounts,
              COALESCE(SUM(b.net_amount) FILTER (WHERE b.bill_type = 'credit_note'), 0) AS sales_return,
              COALESCE(SUM(${DUE_SQL}) FILTER (WHERE b.bill_type = 'invoice'), 0) AS due,
              MAX(b.finalised_at) AS last_bill
         FROM pharmacy_bills b
        WHERE b.status = 'final'
        GROUP BY b.patient_id
     ),
     paid AS (
       SELECT p.patient_id, COALESCE(SUM(p.amount), 0) AS paid
         FROM pharmacy_payments p
         JOIN pharmacy_bills b ON b.id = p.bill_id AND b.bill_type = 'invoice'
        WHERE p.direction = 'in' AND p.mode <> 'deposit'
        GROUP BY p.patient_id
     ),
     entries AS (
       SELECT e.patient_id,
              COALESCE(SUM(e.amount) FILTER (WHERE e.kind = 'write_off'), 0) AS write_off,
              COALESCE(SUM(e.amount) FILTER (WHERE e.kind = 'deposit'), 0) AS deposit,
              COALESCE(SUM(e.amount) FILTER (WHERE e.kind = 'deposit_refund'), 0) AS deposit_refund,
              COALESCE(SUM(CASE e.kind WHEN 'voucher_credit' THEN e.amount
                                       WHEN 'voucher_debit' THEN -e.amount END), 0) AS voucher_manual,
              COALESCE(SUM(CASE WHEN e.kind IN ('deposit', 'voucher_credit') THEN e.amount
                                WHEN e.kind = 'write_off' THEN 0 ELSE -e.amount END), 0) AS balance,
              MAX(e.created_at) AS last_entry
         FROM pharmacy_account_entries e
        GROUP BY e.patient_id
     ),
     ledger AS (
       SELECT p.id AS patient_id, p.name, p.file_no, p.phone,
              COALESCE(s.label, s.payer_name, 'Self') AS payer,
              COALESCE(b.total_amount, 0)::numeric(14, 2) AS total_amount,
              COALESCE(pd.paid, 0)::numeric(14, 2) AS paid,
              COALESCE(e.write_off, 0)::numeric(14, 2) AS write_off,
              COALESCE(e.deposit, 0)::numeric(14, 2) AS deposit,
              COALESCE(e.deposit_refund, 0)::numeric(14, 2) AS deposit_refund,
              COALESCE(b.discounts, 0)::numeric(14, 2) AS discounts,
              COALESCE(b.sales_return, 0)::numeric(14, 2) AS sales_return,
              COALESCE(e.voucher_manual, 0)::numeric(14, 2) AS voucher_manual,
              COALESCE(b.due, 0)::numeric(14, 2) AS due,
              COALESCE(e.balance, 0)::numeric(14, 2) AS balance,
              GREATEST(b.last_bill, e.last_entry) AS last_activity
         FROM active a
         JOIN patients p ON p.id = a.patient_id
         LEFT JOIN patient_schemes s ON s.code = p.scheme_code
         LEFT JOIN bills b ON b.patient_id = p.id
         LEFT JOIN paid pd ON pd.patient_id = p.id
         LEFT JOIN entries e ON e.patient_id = p.id
     )
     SELECT *, count(*) OVER()::int AS total,
            SUM(total_amount) OVER() AS sum_total, SUM(due) OVER() AS sum_due,
            SUM(balance) OVER() AS sum_balance
       FROM ledger
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY ${order}, lower(name)
      LIMIT $1 OFFSET $2`,
    params,
  );
  const first = rows[0];
  return {
    total: first?.total ?? 0,
    sums: {
      total_amount: first?.sum_total ?? "0.00",
      due: first?.sum_due ?? "0.00",
      balance: first?.sum_balance ?? "0.00",
    },
    rows: rows.map(({ total, sum_total, sum_due, sum_balance, ...r }) => r),
  };
}
