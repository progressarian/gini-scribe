import pool from "../../config/db.js";
import { paise } from "../../../shared/labPayment.js";
import { DEPOSIT_MODE } from "../../../shared/billingVocab.js";
import { writeAudit } from "./audit.js";
import { nextNumber, seriesFor } from "./billNumber.js";
import { DRAWER_MODE, openShiftIdFor, PAYMENT_MODES } from "./cashShifts.js";
import { auditFields, cleanMoney, INT_MAX, readNumber } from "./common.js";
import { httpError, inTransaction } from "./transaction.js";

export const ENTRIES_SHOWN = 50;
const REFERENCE_MAX = 60;
const NOTE_MAX = 300;
const MODE_LABEL = { cash: "cash", card: "card", upi: "UPI" };
const rupees = (amount) => (amount / 100).toFixed(2);

function cleanPatientId(value) {
  const id = readNumber(value, "Choose a valid patient");
  if (id === undefined || !Number.isInteger(id) || id <= 0 || id > INT_MAX) {
    throw httpError(400, "Choose a valid patient");
  }
  return id;
}

function cleanReceipt(input) {
  const mode = typeof input?.mode === "string" ? input.mode.trim().toLowerCase() : "";
  if (!PAYMENT_MODES.includes(mode)) {
    throw httpError(400, `A deposit is taken as one of: ${PAYMENT_MODES.join(", ")}`);
  }
  const amount = paise(cleanMoney(input?.amount, "The deposit amount"));
  if (amount <= 0) throw httpError(400, "The deposit must be more than zero");
  const reference = typeof input?.reference === "string" ? input.reference.trim() : "";
  if (mode !== DRAWER_MODE && !reference) {
    throw httpError(400, `A ${MODE_LABEL[mode]} deposit needs its reference number`);
  }
  if (reference.length > REFERENCE_MAX) {
    throw httpError(400, `The reference is too long — keep it under ${REFERENCE_MAX} letters`);
  }
  const note = typeof input?.note === "string" ? input.note.trim() : "";
  if (note.length > NOTE_MAX) {
    throw httpError(400, `The note is too long — keep it under ${NOTE_MAX} letters`);
  }
  return { mode, amount, reference: reference || null, note: note || null };
}

async function patientExists(client, patientId) {
  const { rows } = await client.query(`SELECT id FROM patients WHERE id = $1`, [patientId]);
  if (!rows.length) throw httpError(404, "That patient no longer exists");
}

export async function lockAccount(client, patientId) {
  await client.query(
    `INSERT INTO deposit_accounts (patient_id) VALUES ($1) ON CONFLICT (patient_id) DO NOTHING`,
    [patientId],
  );
  const { rows } = await client.query(
    `SELECT patient_id, balance FROM deposit_accounts WHERE patient_id = $1 FOR UPDATE`,
    [patientId],
  );
  return { patientId, balance: paise(rows[0].balance) };
}

async function moveBalance(client, patientId, delta) {
  const { rows } = await client.query(
    `UPDATE deposit_accounts SET balance = balance + $2::numeric, updated_at = NOW()
      WHERE patient_id = $1 RETURNING balance`,
    [patientId, rupees(delta)],
  );
  return paise(rows[0].balance);
}

async function addEntry(client, entry, ctx) {
  const balanceAfter = await moveBalance(client, entry.patientId, entry.amount);
  const { rows } = await client.query(
    `INSERT INTO deposit_entries (patient_id, kind, amount, balance_after, payment_id, bill_id,
                                  note, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id, created_at`,
    [
      entry.patientId,
      entry.kind,
      rupees(entry.amount),
      rupees(balanceAfter),
      entry.paymentId ?? null,
      entry.billId ?? null,
      entry.note ?? null,
      ctx?.actorId ?? null,
    ],
  );
  await writeAudit(client, {
    entity: "deposit_entries",
    entityId: rows[0].id,
    action: "create",
    after: {
      patient_id: entry.patientId,
      kind: entry.kind,
      amount: entry.amount,
      balance_after: balanceAfter,
      payment_id: entry.paymentId ?? null,
      bill_id: entry.billId ?? null,
      bill_no: entry.billNo ?? null,
    },
    ...auditFields(ctx),
  });
  return { id: rows[0].id, balanceAfter };
}

export async function receiveDeposit(patientIdValue, input, ctx, db = pool) {
  const patientId = cleanPatientId(patientIdValue);
  const wanted = cleanReceipt(input);
  if (!ctx?.actorId) throw httpError(401, "Sign in again to take a deposit");
  return inTransaction(async (client) => {
    await patientExists(client, patientId);
    const shiftId = await openShiftIdFor(client, ctx.actorId);
    if (wanted.mode === DRAWER_MODE && !shiftId) {
      throw httpError(
        409,
        "Open your shift first, so this cash is in a drawer that can be counted at the end of it",
      );
    }
    await lockAccount(client, patientId);
    const receipt = await nextNumber(client, seriesFor("receipt"), null, ctx);
    const { rows } = await client.query(
      `INSERT INTO payments (deposit_patient_id, mode, amount, reference, receipt_no, shift_id,
                             received_by, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $7, $7)
       RETURNING id, receipt_no, received_at`,
      [
        patientId,
        wanted.mode,
        rupees(wanted.amount),
        wanted.reference,
        receipt.number,
        shiftId,
        ctx.actorId,
      ],
    );
    await writeAudit(client, {
      entity: "payments",
      entityId: rows[0].id,
      action: "create",
      after: {
        deposit_patient_id: patientId,
        mode: wanted.mode,
        amount: wanted.amount,
        receipt_no: rows[0].receipt_no,
      },
      ...auditFields(ctx),
    });
    const entry = await addEntry(
      client,
      {
        patientId,
        kind: "received",
        amount: wanted.amount,
        paymentId: rows[0].id,
        note: wanted.note,
      },
      ctx,
    );
    return {
      payment_id: rows[0].id,
      receipt_no: rows[0].receipt_no,
      entry_id: entry.id,
      amount: wanted.amount,
      balance: entry.balanceAfter,
    };
  }, db);
}

export async function holdFor(client, patientId, wanted) {
  if (!wanted) return null;
  const account = await lockAccount(client, patientId);
  if (wanted > account.balance) {
    throw httpError(
      409,
      account.balance
        ? `Only ₹${rupees(account.balance)} is left in this patient's deposit, so ₹${rupees(wanted)} can't be taken from it`
        : "This patient has no deposit to pay from",
      { deposit_balance: account.balance },
    );
  }
  return account;
}

export async function recordApplied(client, { bill, payment }, ctx) {
  return addEntry(
    client,
    {
      patientId: bill.patient_id,
      kind: "applied",
      amount: -payment.amount,
      paymentId: payment.id,
      billId: bill.id,
      billNo: bill.bill_no,
    },
    ctx,
  );
}

export async function restoreToDeposit(client, { note, patientId, amount }, ctx) {
  if (!amount) return null;
  await lockAccount(client, patientId);
  const { rows } = await client.query(
    `INSERT INTO payments (bill_id, direction, mode, amount, received_by, created_by, updated_by)
     VALUES ($1, 'out', '${DEPOSIT_MODE}', $2, $3, $3, $3)
     RETURNING id`,
    [note.id, rupees(amount), ctx?.actorId ?? null],
  );
  await client.query(
    `UPDATE bills
        SET paid_amount = (SELECT COALESCE(SUM(amount), 0) FROM payments WHERE bill_id = bills.id),
            version = version + 1, updated_at = NOW(), updated_by = $2
      WHERE id = $1`,
    [note.id, ctx?.actorId ?? null],
  );
  await writeAudit(client, {
    entity: "payments",
    entityId: rows[0].id,
    action: "create",
    after: {
      bill_id: note.id,
      credit_note_no: note.bill_no,
      direction: "out",
      mode: DEPOSIT_MODE,
      amount,
    },
    ...auditFields(ctx),
  });
  return addEntry(
    client,
    {
      patientId,
      kind: "restored",
      amount,
      paymentId: rows[0].id,
      billId: note.id,
      billNo: note.bill_no,
    },
    ctx,
  );
}

const ENTRY_SQL = `
  SELECT e.id, e.kind, e.amount, e.balance_after, e.note, e.created_at, e.payment_id,
         e.bill_id, b.bill_no, b.bill_type, o.bill_no AS original_bill_no,
         p.mode, p.reference, p.receipt_no,
         COALESCE(d.short_name, d.name) AS created_by_name
    FROM deposit_entries e
    LEFT JOIN bills b ON b.id = e.bill_id
    LEFT JOIN bills o ON o.id = b.original_bill_id
    LEFT JOIN payments p ON p.id = e.payment_id
    LEFT JOIN doctors d ON d.id = e.created_by
   WHERE e.patient_id = $1
   ORDER BY e.created_at DESC, e.id DESC
   LIMIT $2`;

export async function getDeposit(patientIdValue, db = pool) {
  const patientId = cleanPatientId(patientIdValue);
  const [{ rows: account }, { rows: entries }] = await Promise.all([
    db.query(`SELECT balance FROM deposit_accounts WHERE patient_id = $1`, [patientId]),
    db.query(ENTRY_SQL, [patientId, ENTRIES_SHOWN]),
  ]);
  const balance = account.length ? paise(account[0].balance) : 0;
  return {
    patient_id: patientId,
    balance,
    available: balance,
    entries: entries.map((row) => ({
      id: row.id,
      kind: row.kind,
      amount: paise(row.amount),
      balance_after: paise(row.balance_after),
      note: row.note,
      created_at: row.created_at,
      created_by_name: row.created_by_name,
      bill_id: row.bill_id,
      bill_no: row.bill_no,
      bill_type: row.bill_type,
      original_bill_no: row.original_bill_no,
      payment_id: row.payment_id,
      mode: row.mode,
      reference: row.reference,
      receipt_no: row.receipt_no,
    })),
  };
}
