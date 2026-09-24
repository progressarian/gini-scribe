import pool from "../../config/db.js";
import {
  CLAIM_STATE,
  derivePaymentStatus,
  opensLabGate,
  paise,
  rupeesFromPaise,
} from "../../../shared/labPayment.js";
import { writeAudit } from "./audit.js";
import { nextNumber, seriesFor } from "./billNumber.js";
import { DRAWER_MODE, openShiftIdFor, PAYMENT_MODES } from "./cashShifts.js";
import { httpError, inTransaction } from "./transaction.js";
import {
  auditFields,
  cleanDate,
  cleanMoney,
  INT_MAX,
  lockRow,
  readNumber,
  wholeNumber,
} from "./common.js";

export { PAYMENT_MODES };

const BILL_COLUMNS = `id, bill_no, bill_date::text AS bill_date, patient_id, visit_id, status,
  patient_payable, paid_amount, pay_later, version`;

const SPEC = { table: "bills", noun: "bill", columns: BILL_COLUMNS };

const ORDER_COLUMNS = `id, visit_id, payment_status, sample_status, amount_total, amount_paid,
  amount_claimed, claim_state, version`;

const MODE_LABEL = { cash: "cash", card: "card", upi: "UPI" };

export const PAYMENTS_AT_ONCE = 10;
export const REFERENCE_MAX = 60;
const DUES_LIMIT = 500;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const rupees = (amount) => (amount / 100).toFixed(2);

const billLabel = (bill) => (bill?.bill_no ? `bill ${bill.bill_no}` : "this visit's draft bill");

function cleanUuid(value, label) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!UUID.test(text)) throw httpError(400, `Choose a valid ${label}`);
  return text.toLowerCase();
}

function cleanPatientId(value) {
  const id = readNumber(value, "Choose a valid patient");
  if (id === undefined || !Number.isInteger(id) || id <= 0 || id > INT_MAX) {
    throw httpError(400, "Choose a valid patient");
  }
  return id;
}

function cleanLimit(value) {
  const limit = readNumber(value, "Limit must be a whole number");
  if (limit === undefined) return DUES_LIMIT;
  if (!Number.isInteger(limit) || limit <= 0) throw httpError(400, "Limit must be a whole number");
  return Math.min(limit, DUES_LIMIT);
}

function cleanPayment(entry) {
  const mode = typeof entry?.mode === "string" ? entry.mode.trim().toLowerCase() : "";
  if (!PAYMENT_MODES.includes(mode)) {
    throw httpError(400, `A payment must be taken as one of: ${PAYMENT_MODES.join(", ")}`);
  }
  const amount = paise(cleanMoney(entry?.amount, "The amount taken"));
  if (amount <= 0) throw httpError(400, "The amount taken must be more than zero");
  const reference = typeof entry?.reference === "string" ? entry.reference.trim() : "";
  if (mode !== DRAWER_MODE && !reference) {
    throw httpError(400, `A ${MODE_LABEL[mode]} payment needs its reference number`);
  }
  if (reference.length > REFERENCE_MAX) {
    throw httpError(400, `The reference is too long — keep it under ${REFERENCE_MAX} letters`);
  }
  return { mode, amount, reference: reference || null };
}

function cleanPayments(input) {
  const given = Array.isArray(input?.payments) ? input.payments : [input];
  const wanted = given.filter((entry) => entry && typeof entry === "object").map(cleanPayment);
  if (!wanted.length) throw httpError(400, "Enter the payment being taken");
  if (wanted.length > PAYMENTS_AT_ONCE) {
    throw httpError(400, `At most ${PAYMENTS_AT_ONCE} payments can be taken at once`);
  }
  return wanted;
}

function shapePayment(row) {
  return {
    id: row.id,
    bill_id: row.bill_id,
    mode: row.mode,
    amount: paise(row.amount),
    reference: row.reference,
    receipt_no: row.receipt_no,
    shift_id: row.shift_id,
    received_by: row.received_by,
    received_at: row.received_at,
  };
}

async function takenOn(client, billId) {
  const { rows } = await client.query(
    `SELECT GREATEST(b.paid_amount, COALESCE(SUM(p.amount), 0)) AS taken
       FROM bills b LEFT JOIN payments p ON p.bill_id = b.id AND p.direction = 'in'
      WHERE b.id = $1 GROUP BY b.paid_amount`,
    [billId],
  );
  return paise(rows[0].taken);
}

async function keepPaidInStep(client, bill, ctx) {
  const { rows } = await client.query(
    `UPDATE bills
        SET paid_amount = (SELECT COALESCE(SUM(amount), 0) FROM payments
                            WHERE bill_id = bills.id AND direction = 'in'),
            version = version + 1, updated_at = NOW(), updated_by = $2
      WHERE id = $1
      RETURNING ${BILL_COLUMNS}`,
    [bill.id, ctx?.actorId ?? null],
  );
  return rows[0];
}

async function syncLabSteps(client, visitId) {
  if (!visitId) return;
  const { syncLabStepsFromLab } = await import("../giniflow/journey.js");
  await syncLabStepsFromLab(client, visitId);
}

async function orderEvent(client, orderId, status, ctx, meta) {
  await client.query(
    `INSERT INTO giniflow_lab_order_events
       (lab_order_id, track, status, actor_role, actor_id, meta)
     VALUES ($1, 'payment', $2, $3, $4, $5)`,
    [orderId, status, ctx?.role ?? "reception", ctx?.actorId ?? null, meta],
  );
}

async function writeOrderMoney(client, order, after, status, ctx, meta) {
  const { rowCount } = await client.query(
    `UPDATE giniflow_lab_orders
        SET amount_paid = $3, amount_claimed = $4, claim_state = $5, payment_status = $6,
            sample_status = CASE
              WHEN $7 AND sample_status IN ('ordered', 'payment_pending') THEN 'paid'
              WHEN NOT $7 AND sample_status = 'paid' THEN 'ordered'
              ELSE sample_status END,
            version = version + 1, updated_at = NOW()
      WHERE id = $1 AND version = $2`,
    [
      order.id,
      order.version,
      after.amountPaid,
      after.amountClaimed,
      after.claimState,
      status,
      opensLabGate(status),
    ],
  );
  if (!rowCount) {
    throw httpError(409, "That test order changed while the bill was being paid — open it again");
  }
  await orderEvent(client, order.id, status, ctx, meta);
  if (opensLabGate(status) && !opensLabGate(order.payment_status)) {
    await client.query(
      `INSERT INTO giniflow_lab_order_events
         (lab_order_id, track, status, actor_role, actor_id)
       VALUES ($1, 'sample', 'paid', $2, $3)`,
      [order.id, ctx?.role ?? "reception", ctx?.actorId ?? null],
    );
  }
  await syncLabSteps(client, order.visit_id);
  return {
    lab_order_id: order.id,
    payment_status: status,
    amount_paid: paise(after.amountPaid),
    amount_claimed: paise(after.amountClaimed),
    opens_lab_gate: opensLabGate(status),
  };
}

async function lockOrder(client, orderId) {
  const { rows } = await client.query(
    `SELECT ${ORDER_COLUMNS} FROM giniflow_lab_orders WHERE id = $1 FOR UPDATE`,
    [orderId],
  );
  return rows[0] ?? null;
}

async function settleOrder(client, bill, orderId, claimShare, ctx) {
  const order = await lockOrder(client, orderId);
  if (!order) return null;
  if (opensLabGate(order.payment_status)) return null;
  if ([CLAIM_STATE.SUBMITTED, CLAIM_STATE.APPROVED].includes(order.claim_state)) return null;
  const total = paise(order.amount_total);
  const claim = Math.min(claimShare, total);
  const after = {
    amountTotal: order.amount_total,
    amountPaid: rupeesFromPaise(total - claim),
    amountClaimed: rupeesFromPaise(claim),
    claimState: claim > 0 ? CLAIM_STATE.APPROVED : order.claim_state,
  };
  const meta = {
    bill_id: bill.id,
    bill_no: bill.bill_no,
    before: {
      amount_paid: order.amount_paid,
      amount_claimed: order.amount_claimed,
      claim_state: order.claim_state,
    },
    after: {
      amount_paid: after.amountPaid,
      amount_claimed: after.amountClaimed,
      claim_state: after.claimState,
    },
  };
  return writeOrderMoney(client, order, after, derivePaymentStatus(after), ctx, meta);
}

async function settledLines(client, bill) {
  const { rows } = await client.query(
    `SELECT id, line_no, lab_order_id, patient_payable, claim_amount
       FROM bill_lines WHERE bill_id = $1 AND is_live ORDER BY line_no, created_at, id`,
    [bill.id],
  );
  const taken = await takenOn(client, bill.id);
  let running = 0;
  return rows.map((row) => {
    const payable = paise(row.patient_payable);
    const room = Math.max(0, taken - running);
    running += payable;
    return { ...row, settled: room >= payable };
  });
}

export async function settleTestOrders(client, bill, ctx) {
  const shares = new Map();
  for (const line of await settledLines(client, bill)) {
    if (!line.lab_order_id) continue;
    const share = shares.get(line.lab_order_id) ?? { settled: true, claim: 0 };
    share.settled = share.settled && line.settled;
    share.claim += paise(line.claim_amount);
    shares.set(line.lab_order_id, share);
  }
  const opened = [];
  for (const [orderId, share] of shares) {
    if (!share.settled) continue;
    const done = await settleOrder(client, bill, orderId, share.claim, ctx);
    if (done) opened.push(done);
  }
  return opened;
}

const sameMoney = (order, money) =>
  paise(order.amount_paid) === paise(money.amount_paid) &&
  paise(order.amount_claimed) === paise(money.amount_claimed) &&
  order.claim_state === money.claim_state;

export async function refuseStandingClaims(client, bill) {
  const { rows } = await client.query(
    `SELECT l.bill_name, o.id, o.amount_paid, o.amount_claimed, o.claim_state,
            (SELECT e.meta FROM giniflow_lab_order_events e
              WHERE e.lab_order_id = o.id AND e.track = 'payment' AND e.meta ->> 'bill_id' = $2
              ORDER BY e.occurred_at DESC, e.seq DESC LIMIT 1) AS settle
       FROM bill_lines l JOIN giniflow_lab_orders o ON o.id = l.lab_order_id
      WHERE l.bill_id = $1 AND l.is_live AND o.claim_state = ANY($3::text[])
      ORDER BY l.line_no, l.id`,
    [bill.id, bill.id, [CLAIM_STATE.SUBMITTED, CLAIM_STATE.APPROVED]],
  );
  const standing = rows.find((row) => !(row.settle?.after && sameMoney(row, row.settle.after)));
  if (!standing) return;
  const way =
    bill.status === "draft"
      ? "remove it from this bill and collect the rest at reception"
      : "cancel this bill and collect the rest at reception";
  throw httpError(
    409,
    `${standing.bill_name} has its own insurance claim of ₹${rupees(paise(standing.amount_claimed))} at reception, so it can't also be paid on ${billLabel(bill)} — ${way}`,
    { code: "order_claim", lab_order_id: standing.id, claim_state: standing.claim_state },
  );
}

async function releaseOrder(client, bill, orderId, ctx) {
  const { rows } = await client.query(
    `SELECT meta FROM giniflow_lab_order_events
      WHERE lab_order_id = $1 AND track = 'payment' AND meta ->> 'bill_id' = $2
      ORDER BY occurred_at DESC, seq DESC LIMIT 1`,
    [orderId, bill.id],
  );
  const meta = rows[0]?.meta;
  if (!meta?.before || !meta.after) return null;
  const order = await lockOrder(client, orderId);
  if (!order || !sameMoney(order, meta.after)) return null;
  const after = {
    amountTotal: order.amount_total,
    amountPaid: meta.before.amount_paid,
    amountClaimed: meta.before.amount_claimed,
    claimState: meta.before.claim_state,
  };
  return writeOrderMoney(client, order, after, derivePaymentStatus(after), ctx, {
    bill_id: bill.id,
    bill_no: bill.bill_no,
    released: true,
  });
}

export async function releaseTestOrders(client, bill, ctx) {
  const { rows } = await client.query(
    `SELECT DISTINCT lab_order_id FROM bill_lines
      WHERE bill_id = $1 AND lab_order_id IS NOT NULL`,
    [bill.id],
  );
  const released = [];
  for (const row of rows) {
    const done = await releaseOrder(client, bill, row.lab_order_id, ctx);
    if (done) released.push(done);
  }
  return released;
}

export async function takePayments(billId, input, ctx, db = pool) {
  const version = wholeNumber(input?.version, "Version", { min: 0 });
  if (version === undefined) throw httpError(400, "Send the bill's version so nothing is lost");
  const wanted = cleanPayments(input);
  const id = cleanUuid(billId, "bill");
  return inTransaction(async (client) => {
    const bill = await lockRow(client, SPEC, id);
    if (bill.status === "cancelled") {
      throw httpError(409, "That bill was cancelled, so no payment can be taken on it");
    }
    if (bill.version !== version) {
      throw httpError(409, "This bill changed while you were working on it — open it again", {
        version: bill.version,
      });
    }
    await refuseStandingClaims(client, bill);
    const outstanding = Math.max(0, paise(bill.patient_payable) - (await takenOn(client, bill.id)));
    const asked = wanted.reduce((sum, payment) => sum + payment.amount, 0);
    if (!outstanding) throw httpError(409, `Nothing is left to collect on ${billLabel(bill)}`);
    if (asked > outstanding) {
      throw httpError(
        409,
        `₹${rupees(outstanding)} is left to collect on ${billLabel(bill)}, so ₹${rupees(asked)} can't be taken`,
      );
    }
    const takesCash = wanted.some((payment) => payment.mode === DRAWER_MODE);
    if (takesCash && !ctx?.actorId) throw httpError(401, "Sign in again to take a payment");
    const shiftId = ctx?.actorId ? await openShiftIdFor(client, ctx.actorId) : null;
    if (takesCash && !shiftId) {
      throw httpError(
        409,
        "Open your shift first, so this cash is in a drawer that can be counted at the end of it",
      );
    }
    const taken = [];
    for (const payment of wanted) {
      const receipt = await nextNumber(client, seriesFor("receipt"), null, ctx);
      const { rows } = await client.query(
        `INSERT INTO payments (bill_id, mode, amount, reference, receipt_no, shift_id,
                               received_by, created_by, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $7, $7)
         RETURNING id, bill_id, mode, amount, reference, receipt_no, shift_id, received_by,
                   received_at`,
        [
          bill.id,
          payment.mode,
          rupees(payment.amount),
          payment.reference,
          receipt.number,
          shiftId,
          ctx?.actorId ?? null,
        ],
      );
      taken.push(shapePayment(rows[0]));
    }
    const after = await keepPaidInStep(client, bill, ctx);
    for (const payment of taken) {
      await writeAudit(client, {
        entity: "payments",
        entityId: payment.id,
        action: "create",
        after: { ...payment, bill_no: bill.bill_no },
        ...auditFields(ctx),
      });
    }
    const opened = await settleTestOrders(client, after, ctx);
    return {
      bill_id: after.id,
      bill_no: after.bill_no,
      status: after.status,
      version: after.version,
      totals: {
        payable: paise(after.patient_payable),
        paid: paise(after.paid_amount),
        outstanding: Math.max(0, paise(after.patient_payable) - paise(after.paid_amount)),
      },
      payments: taken,
      orders: opened,
    };
  }, db);
}

export async function listPayments(billId, db = pool) {
  const { rows } = await db.query(
    `SELECT id, bill_id, mode, amount, reference, receipt_no, shift_id, received_by, received_at
       FROM payments WHERE bill_id = $1 AND direction = 'in'
      ORDER BY received_at, receipt_no, id`,
    [cleanUuid(billId, "bill")],
  );
  return rows.map(shapePayment);
}

export async function listDues(filters = {}, db = pool) {
  const where = [`b.status = 'final'`, `b.paid_amount < b.patient_payable`];
  const params = [];
  const add = (sql, value) => {
    params.push(value);
    where.push(sql.replace("?", `$${params.length}`));
  };
  if (filters.patientId !== undefined && filters.patientId !== null && filters.patientId !== "") {
    add("b.patient_id = ?", cleanPatientId(filters.patientId));
  }
  const from = cleanDate(filters.from, "The start date");
  const to = cleanDate(filters.to, "The end date");
  if (from && to && from > to) throw httpError(400, "The start date is after the end date");
  if (from) add("b.bill_date >= ?::date", from);
  if (to) add("b.bill_date <= ?::date", to);
  params.push(cleanLimit(filters.limit));
  const { rows } = await db.query(
    `SELECT b.id, b.bill_no, b.bill_date::text AS bill_date, b.visit_id, b.pay_later,
            b.patient_payable, b.paid_amount, b.scheme_label,
            p.id AS patient_id, p.name AS patient_name, p.file_no,
            ((NOW() AT TIME ZONE 'Asia/Kolkata')::date - b.bill_date) AS days
       FROM bills b JOIN patients p ON p.id = b.patient_id
      WHERE ${where.join(" AND ")}
      ORDER BY b.bill_date, b.created_at, b.id
      LIMIT $${params.length}`,
    params,
  );
  return rows.map((row) => ({
    bill_id: row.id,
    bill_no: row.bill_no,
    bill_date: row.bill_date,
    visit_id: row.visit_id,
    pay_later: row.pay_later,
    category_label: row.scheme_label,
    patient: { id: row.patient_id, name: row.patient_name, file_no: row.file_no },
    payable: paise(row.patient_payable),
    paid: paise(row.paid_amount),
    outstanding: paise(row.patient_payable) - paise(row.paid_amount),
    days: Number(row.days),
  }));
}
