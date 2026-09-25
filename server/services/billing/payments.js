import pool from "../../config/db.js";
import {
  CLAIM_STATE,
  collectiblePaise,
  derivePaymentStatus,
  opensLabGate,
  paise,
  rupeesFromPaise,
} from "../../../shared/labPayment.js";
import { AS_PAID, ORDER_STATE } from "../../../shared/billingVocab.js";
import { writeAudit } from "./audit.js";
import { nextNumber, seriesFor } from "./billNumber.js";
import { cashOutShift, DRAWER_MODE, openShiftIdFor, PAYMENT_MODES } from "./cashShifts.js";
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

const BILL_COLUMNS = `id, bill_no, bill_type, original_bill_id, bill_date::text AS bill_date,
  patient_id, visit_id, status, patient_payable, paid_amount, pay_later, version`;

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

const TAKING = {
  amount: "The amount taken",
  positive: "The amount taken must be more than zero",
  mode: "A payment must be taken as one of",
  reference: (mode) => `A ${MODE_LABEL[mode]} payment needs its reference number`,
  none: "Enter the payment being taken",
  many: `At most ${PAYMENTS_AT_ONCE} payments can be taken at once`,
};

const PAYING_BACK = {
  amount: "The amount paid back",
  positive: "The amount paid back must be more than zero",
  mode: "Money can only go back as one of",
  reference: (mode) => `A ${MODE_LABEL[mode]} refund needs the reversal's reference number`,
  none: "Enter the money being paid back",
  many: `At most ${PAYMENTS_AT_ONCE} refunds can be paid out at once`,
};

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

function cleanPayment(entry, words) {
  const mode = typeof entry?.mode === "string" ? entry.mode.trim().toLowerCase() : "";
  if (!PAYMENT_MODES.includes(mode)) {
    throw httpError(400, `${words.mode}: ${PAYMENT_MODES.join(", ")}`);
  }
  const amount = paise(cleanMoney(entry?.amount, words.amount));
  if (amount <= 0) throw httpError(400, words.positive);
  const reference = typeof entry?.reference === "string" ? entry.reference.trim() : "";
  if (mode !== DRAWER_MODE && !reference) {
    throw httpError(400, words.reference(mode));
  }
  if (reference.length > REFERENCE_MAX) {
    throw httpError(400, `The reference is too long — keep it under ${REFERENCE_MAX} letters`);
  }
  return { mode, amount, reference: reference || null };
}

function cleanPayments(input, words = TAKING) {
  const given = Array.isArray(input?.payments) ? input.payments : [input];
  const wanted = given
    .filter((entry) => entry && typeof entry === "object")
    .map((entry) => cleanPayment(entry, words));
  if (!wanted.length) throw httpError(400, words.none);
  if (wanted.length > PAYMENTS_AT_ONCE) throw httpError(400, words.many);
  return wanted;
}

function shapePayment(row) {
  return {
    id: row.id,
    bill_id: row.bill_id,
    direction: row.direction,
    mode: row.mode,
    amount: paise(row.amount),
    reference: row.reference,
    receipt_no: row.receipt_no,
    shift_id: row.shift_id,
    received_by: row.received_by,
    received_at: row.received_at,
  };
}

const PAYMENT_COLUMNS = `id, bill_id, direction, mode, amount, reference, receipt_no, shift_id,
  received_by, received_at`;

const MONEY_SQL = `
  SELECT b.patient_payable,
         GREATEST(b.paid_amount,
                  COALESCE((SELECT SUM(p.amount) FROM payments p WHERE p.bill_id = b.id), 0))
           AS paid_in,
         COALESCE((SELECT SUM(c.patient_payable) FROM bills c WHERE c.original_bill_id = b.id), 0)
           AS credited,
         COALESCE((SELECT SUM(p.amount) FROM payments p JOIN bills c ON c.id = p.bill_id
                    WHERE c.original_bill_id = b.id), 0) AS paid_out
    FROM bills b WHERE b.id = $1`;

export async function moneyOn(client, billId) {
  const { rows } = await client.query(MONEY_SQL, [billId]);
  if (!rows.length) throw httpError(404, "That bill no longer exists");
  const payable = paise(rows[0].patient_payable);
  const paidIn = paise(rows[0].paid_in);
  const credited = paise(rows[0].credited);
  const paidOut = paise(rows[0].paid_out);
  const held = paidIn - paidOut;
  const owed = Math.max(0, payable - credited);
  return {
    payable,
    paid_in: paidIn,
    credited,
    paid_out: paidOut,
    held,
    owed,
    balance: Math.max(0, owed - held),
    refundable: Math.max(0, held - owed),
  };
}

async function keepPaidInStep(client, bill, ctx) {
  const { rows } = await client.query(
    `UPDATE bills
        SET paid_amount = (SELECT COALESCE(SUM(amount), 0) FROM payments
                            WHERE bill_id = bills.id),
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

const STANDING_CLAIMS = [CLAIM_STATE.SUBMITTED, CLAIM_STATE.APPROVED];

const claimOf = (money) =>
  STANDING_CLAIMS.includes(money.claim_state)
    ? `${money.claim_state}:${paise(money.amount_claimed)}`
    : CLAIM_STATE.NONE;

const standingClaim = (money) =>
  STANDING_CLAIMS.includes(money.claim_state) ? paise(money.amount_claimed) : 0;

const sameMoney = (order, money) =>
  claimOf(order) === claimOf(money) && paise(order.amount_paid) === paise(money.amount_paid);

const billClaimOf = (settle) =>
  settle.bill_claim === undefined ? standingClaim(settle.after) : paise(settle.bill_claim);

function receptionPart(order, settle) {
  const cash = paise(order.amount_paid) - paise(settle.after.amount_paid);
  if (cash < 0) return null;
  if (billClaimOf(settle)) {
    return claimOf(order) === claimOf(settle.after) ? { cash, claim: 0 } : null;
  }
  return { cash, claim: standingClaim(order) };
}

function withoutBill(order, settle, part) {
  const claimMoved =
    !billClaimOf(settle) &&
    (claimOf(order) !== claimOf(settle.after) ||
      paise(order.amount_claimed) !== paise(settle.after.amount_claimed));
  const claimFrom = claimMoved ? order : settle.before;
  return {
    amount_paid: rupeesFromPaise(paise(settle.before.amount_paid) + part.cash),
    amount_claimed: claimFrom.amount_claimed,
    claim_state: claimFrom.claim_state,
  };
}

async function lockOrder(client, orderId) {
  const { rows } = await client.query(
    `SELECT ${ORDER_COLUMNS} FROM giniflow_lab_orders WHERE id = $1 FOR UPDATE`,
    [orderId],
  );
  return rows[0] ?? null;
}

export const UNCOVERED_SQL = (billParam, orderExpr) => `
  COALESCE((SELECT SUM(t.price) FROM (
             SELECT t.test_name, t.price,
                    ROW_NUMBER() OVER (PARTITION BY t.test_name ORDER BY t.price, t.id) AS nth
               FROM giniflow_lab_order_tests t WHERE t.lab_order_id = ${orderExpr}) t
             WHERE t.nth > COALESCE((
               SELECT SUM(bl.quantity) FROM bill_lines bl
                 JOIN service_items si ON si.id = bl.service_item_id
                 JOIN giniflow_test_catalog tc ON tc.id = si.test_catalog_id
                WHERE bl.bill_id = ${billParam} AND bl.lab_order_id = ${orderExpr}
                  AND bl.is_live AND tc.test_name = t.test_name), 0)), 0)`;

async function uncoveredPaise(client, billId, orderId) {
  const { rows } = await client.query(`SELECT ${UNCOVERED_SQL("$1", "$2")} AS uncovered`, [
    billId,
    orderId,
  ]);
  return paise(rows[0].uncovered);
}

async function lastSettle(client, billId, orderId) {
  const { rows } = await client.query(
    `SELECT meta FROM giniflow_lab_order_events
      WHERE lab_order_id = $1 AND track = 'payment' AND meta ->> 'bill_id' = $2
      ORDER BY occurred_at DESC, seq DESC LIMIT 1`,
    [orderId, billId],
  );
  const meta = rows[0]?.meta;
  return meta?.before && meta.after ? meta : null;
}

const moneyOf = (order) => ({
  amount_paid: order.amount_paid,
  amount_claimed: order.amount_claimed,
  claim_state: order.claim_state,
});

async function settleOrder(client, bill, orderId, claimShare, ctx) {
  const order = await lockOrder(client, orderId);
  if (!order) return null;
  const last = await lastSettle(client, bill.id, orderId);
  const part = last ? receptionPart(order, last) : null;
  if (!part && opensLabGate(order.payment_status)) return null;
  if (!part && STANDING_CLAIMS.includes(order.claim_state)) return null;
  const before = part ? withoutBill(order, last, part) : moneyOf(order);
  const uncovered = Math.min(
    paise(order.amount_total),
    await uncoveredPaise(client, bill.id, orderId),
  );
  const covered = paise(order.amount_total) - uncovered;
  const claim = Math.min(claimShare, covered);
  const reception = standingClaim(before);
  if (claim && reception) return null;
  const kept = Math.min(paise(before.amount_paid), Math.max(0, uncovered - reception));
  const after = {
    amountTotal: order.amount_total,
    amountPaid: rupeesFromPaise(covered - claim + kept),
    amountClaimed: rupeesFromPaise(claim || reception),
    claimState: claim > 0 ? CLAIM_STATE.APPROVED : before.claim_state,
  };
  const written = {
    amount_paid: after.amountPaid,
    amount_claimed: after.amountClaimed,
    claim_state: after.claimState,
  };
  if (sameMoney(order, written)) return null;
  const meta = {
    bill_id: bill.id,
    bill_no: bill.bill_no,
    before,
    after: written,
    bill_claim: rupeesFromPaise(claim),
  };
  return writeOrderMoney(client, order, after, derivePaymentStatus(after), ctx, meta);
}

async function settledLines(client, bill) {
  const { rows } = await client.query(
    `SELECT l.id, l.line_no, l.lab_order_id,
            l.patient_payable - COALESCE(c.patient_payable, 0) AS patient_payable,
            l.claim_amount - COALESCE(c.claim_amount, 0) AS claim_amount
       FROM bill_lines l
       LEFT JOIN LATERAL (
         SELECT SUM(x.patient_payable) AS patient_payable, SUM(x.claim_amount) AS claim_amount
           FROM bill_lines x WHERE x.credited_line_id = l.id
       ) c ON TRUE
      WHERE l.bill_id = $1 AND l.is_live ORDER BY l.line_no, l.created_at, l.id`,
    [bill.id],
  );
  const taken = (await moneyOn(client, bill.id)).held;
  let running = 0;
  return rows.map((row) => {
    const payable = paise(row.patient_payable);
    const room = Math.max(0, taken - running);
    running += payable;
    return { ...row, settled: room >= payable };
  });
}

export async function orderShares(client, bill) {
  const shares = new Map();
  for (const line of await settledLines(client, bill)) {
    if (!line.lab_order_id) continue;
    const share = shares.get(line.lab_order_id) ?? { settled: true, claim: 0 };
    share.settled = share.settled && line.settled;
    share.claim += paise(line.claim_amount);
    shares.set(line.lab_order_id, share);
  }
  return shares;
}

export async function settleTestOrders(client, bill, ctx) {
  const shares = await orderShares(client, bill);
  const opened = [];
  for (const [orderId, share] of shares) {
    if (!share.settled) continue;
    const done = await settleOrder(client, bill, orderId, share.claim, ctx);
    if (done) opened.push(done);
  }
  return opened;
}

const settleOf = (row) => (row.settle?.before && row.settle.after ? row.settle : null);

function receptionState(order) {
  const settle = settleOf(order);
  const part = settle ? receptionPart(order, settle) : null;
  if (part && part.cash + part.claim <= paise(order.uncovered)) return null;
  if (STANDING_CLAIMS.includes(order.claim_state)) return ORDER_STATE.CLAIM_AT_RECEPTION;
  if (paise(order.amount_paid) > 0) return ORDER_STATE.PAID_AT_RECEPTION;
  return null;
}

function receptionPaid(order) {
  const settle = settleOf(order);
  const part = settle ? receptionPart(order, settle) : null;
  return part ? paise(withoutBill(order, settle, part).amount_paid) : paise(order.amount_paid);
}

function addedSinceSettle(rows) {
  const settledAt = rows[0].settled_at;
  if (!settleOf(rows[0]) || !settledAt) return rows;
  const added = rows.filter((row) => new Date(row.created_at) > new Date(settledAt));
  return added.length ? added : rows;
}

async function receptionMoneyLines(client, billId) {
  const { rows } = await client.query(
    `SELECT l.id AS line_id, l.bill_name, l.created_at, o.id, o.amount_total, o.amount_paid,
            o.amount_claimed, o.claim_state, ${UNCOVERED_SQL("$1", "o.id")} AS uncovered,
            s.meta AS settle, s.occurred_at AS settled_at
       FROM bill_lines l JOIN giniflow_lab_orders o ON o.id = l.lab_order_id
       LEFT JOIN LATERAL (
         SELECT e.meta, e.occurred_at FROM giniflow_lab_order_events e
          WHERE e.lab_order_id = o.id AND e.track = 'payment' AND e.meta ->> 'bill_id' = $2
          ORDER BY e.occurred_at DESC, e.seq DESC LIMIT 1
       ) s ON TRUE
      WHERE l.bill_id = $1 AND l.is_live
        AND (o.claim_state = ANY($3::text[]) OR o.amount_paid > 0)
      ORDER BY l.line_no, l.id`,
    [billId, billId, STANDING_CLAIMS],
  );
  const byOrder = new Map();
  for (const row of rows) byOrder.set(row.id, [...(byOrder.get(row.id) ?? []), row]);
  const flagged = new Set();
  for (const lines of byOrder.values()) {
    const state = receptionState(lines[0]);
    if (!state) continue;
    for (const line of addedSinceSettle(lines)) flagged.add(line.line_id);
  }
  return rows
    .filter((row) => flagged.has(row.line_id))
    .map((row) => ({
      ...row,
      order_state: receptionState(row),
      reception_paid: receptionPaid(row),
    }));
}

export async function orderStatesOn(client, billId) {
  const lines = await receptionMoneyLines(client, billId);
  return new Map(lines.map((line) => [line.line_id, line.order_state]));
}

function receptionMoneyRefusal(line, bill) {
  const draft = bill.status === "draft";
  if (line.order_state === ORDER_STATE.CLAIM_AT_RECEPTION) {
    const way = draft
      ? "remove it from this bill and collect the rest at reception"
      : "cancel this bill and collect the rest at reception";
    return {
      code: "order_claim",
      message: `${line.bill_name} has its own insurance claim of ₹${rupees(paise(line.amount_claimed))} at reception, so it can't also be paid on ${billLabel(bill)} — ${way}`,
    };
  }
  const rest = collectiblePaise(line) > 0;
  const way = draft
    ? `remove it from this bill${rest ? " and collect the rest at reception" : ""}`
    : `cancel this bill and bill it again without this test${rest ? ", and collect the rest at reception" : ""}`;
  return {
    code: "order_paid",
    message: `${line.bill_name} was already paid ₹${rupees(line.reception_paid)} at reception, so it can't also be paid on ${billLabel(bill)} — ${way}`,
  };
}

export async function refuseReceptionMoney(client, bill) {
  const [line] = await receptionMoneyLines(client, bill.id);
  if (!line) return;
  const { code, message } = receptionMoneyRefusal(line, bill);
  throw httpError(409, message, {
    code,
    order_state: line.order_state,
    lab_order_id: line.id,
    claim_state: line.claim_state,
  });
}

async function releaseOrder(client, bill, orderId, ctx) {
  const meta = await lastSettle(client, bill.id, orderId);
  if (!meta || meta.released) return null;
  const order = await lockOrder(client, orderId);
  if (!order) return null;
  const part = receptionPart(order, meta);
  if (!part) return null;
  const money = withoutBill(order, meta, part);
  const after = {
    amountTotal: order.amount_total,
    amountPaid: money.amount_paid,
    amountClaimed: money.amount_claimed,
    claimState: money.claim_state,
  };
  return writeOrderMoney(client, order, after, derivePaymentStatus(after), ctx, {
    bill_id: bill.id,
    bill_no: bill.bill_no,
    released: true,
    before: money,
    after: money,
    bill_claim: 0,
  });
}

export async function releaseTestOrders(client, bill, ctx, orderIds = null) {
  const { rows } = await client.query(
    `SELECT DISTINCT lab_order_id FROM bill_lines
      WHERE bill_id = $1 AND lab_order_id IS NOT NULL
        AND ($2::uuid[] IS NULL OR lab_order_id = ANY($2::uuid[]))`,
    [bill.id, orderIds],
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
    if (bill.bill_type !== "invoice") {
      throw httpError(409, "Money is taken on a bill, never on a credit note");
    }
    if (bill.status === "cancelled") {
      throw httpError(409, "That bill was cancelled, so no payment can be taken on it");
    }
    if (bill.version !== version) {
      throw httpError(409, "This bill changed while you were working on it — open it again", {
        version: bill.version,
      });
    }
    await refuseReceptionMoney(client, bill);
    const outstanding = (await moneyOn(client, bill.id)).balance;
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
         RETURNING ${PAYMENT_COLUMNS}`,
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
    const money = await moneyOn(client, after.id);
    return {
      bill_id: after.id,
      bill_no: after.bill_no,
      status: after.status,
      version: after.version,
      totals: {
        payable: paise(after.patient_payable),
        paid: paise(after.paid_amount),
        credited: money.credited,
        refunded: money.paid_out,
        outstanding: money.balance,
      },
      payments: taken,
      orders: opened,
    };
  }, db);
}

export async function listPayments(billId, db = pool) {
  const { rows } = await db.query(
    `SELECT ${PAYMENT_COLUMNS} FROM payments WHERE bill_id = $1
      ORDER BY received_at, receipt_no, id`,
    [cleanUuid(billId, "bill")],
  );
  return rows.map(shapePayment);
}

export async function listDues(filters = {}, db = pool) {
  const where = [
    `b.status = 'final'`,
    `b.paid_amount < b.patient_payable`,
    `b.bill_type = 'invoice'`,
    `GREATEST(b.patient_payable - m.credited, 0) > b.paid_amount - m.refunded`,
  ];
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
            p.id AS patient_id, p.name AS patient_name, p.file_no, m.credited, m.refunded,
            ((NOW() AT TIME ZONE 'Asia/Kolkata')::date - b.bill_date) AS days
       FROM bills b JOIN patients p ON p.id = b.patient_id
       CROSS JOIN LATERAL (
         SELECT COALESCE((SELECT SUM(c.patient_payable) FROM bills c
                           WHERE c.original_bill_id = b.id), 0) AS credited,
                COALESCE((SELECT SUM(x.amount) FROM payments x JOIN bills c ON c.id = x.bill_id
                           WHERE c.original_bill_id = b.id), 0) AS refunded
       ) m
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
    credited: paise(row.credited),
    refunded: paise(row.refunded),
    outstanding:
      Math.max(0, paise(row.patient_payable) - paise(row.credited)) -
      (paise(row.paid_amount) - paise(row.refunded)),
    days: Number(row.days),
  }));
}

function creditNoteRow(row) {
  if (!row) throw httpError(404, "That credit note no longer exists");
  if (row.bill_type !== "credit_note") {
    throw httpError(
      409,
      "Money goes back only against a credit note — ask for a refund on this bill first",
    );
  }
  return row;
}

async function refundOf(db, creditNoteId) {
  const { rows } = await db.query(
    `SELECT id, reason, requested_mode, approved_mode, mode_reason, decision_note
       FROM billing_requests WHERE credit_note_id = $1`,
    [creditNoteId],
  );
  return rows[0] ?? null;
}

async function dueOn(db, note) {
  const money = await moneyOn(db, note.original_bill_id);
  const left = paise(note.patient_payable) - paise(note.paid_amount);
  return { money, due: Math.max(0, Math.min(left, money.refundable)) };
}

export async function refundShares(db, billId, due) {
  const money = await moneyOn(db, billId);
  const { rows } = await db.query(
    `SELECT mode, amount FROM payments WHERE bill_id = $1
      ORDER BY received_at DESC, receipt_no DESC NULLS LAST, id DESC`,
    [billId],
  );
  let earlier = money.paid_out;
  let left = due;
  const shares = new Map();
  for (const row of rows) {
    if (!left) break;
    const amount = paise(row.amount);
    const spent = Math.min(earlier, amount);
    earlier -= spent;
    const take = Math.min(amount - spent, left);
    if (take <= 0) continue;
    shares.set(row.mode, (shares.get(row.mode) ?? 0) + take);
    left -= take;
  }
  return [...shares].map(([mode, amount]) => ({ mode, amount }));
}

export async function refundLegs(db, billId, mode, due) {
  if (!due) return [];
  if (mode === AS_PAID) return refundShares(db, billId, due);
  return [{ mode, amount: due }];
}

function refuseOtherModes(wanted, mode, legs) {
  const asked = new Map();
  for (const payment of wanted) {
    asked.set(payment.mode, (asked.get(payment.mode) ?? 0) + payment.amount);
  }
  if (mode !== AS_PAID) {
    const other = [...asked.keys()].find((given) => given !== mode);
    if (other) {
      throw httpError(
        409,
        `The admin approved paying this back by ${MODE_LABEL[mode]}, so it can't go back by ${MODE_LABEL[other]}`,
        { mode },
      );
    }
    return;
  }
  for (const [given, amount] of asked) {
    const share = legs.find((leg) => leg.mode === given)?.amount ?? 0;
    if (amount <= share) continue;
    throw httpError(
      409,
      share
        ? `Back the way it was paid, at most ₹${rupees(share)} of this refund goes back by ${MODE_LABEL[given]}`
        : `Nothing still to go back was paid by ${MODE_LABEL[given]}, so this refund can't go back that way`,
      { mode, legs },
    );
  }
}

function nothingDue(note, money) {
  if (paise(note.paid_amount) >= paise(note.patient_payable)) {
    return httpError(409, `Credit note ${note.bill_no} has already been paid back in full`);
  }
  if (!money.refundable) {
    return httpError(
      409,
      `Nothing is due back on credit note ${note.bill_no} — the credit went against what was still owed on the bill`,
    );
  }
  return httpError(409, `Nothing is due back on credit note ${note.bill_no}`);
}

async function planFor(db, note) {
  const refund = await refundOf(db, note.id);
  const mode = refund?.approved_mode ?? null;
  const { due } = await dueOn(db, note);
  return {
    credit_note_id: note.id,
    credit_note_no: note.bill_no,
    original_bill_id: note.original_bill_id,
    version: note.version,
    request_id: refund?.id ?? null,
    mode,
    mode_reason: refund?.mode_reason ?? null,
    credited: paise(note.patient_payable),
    refunded: paise(note.paid_amount),
    due,
    legs: mode ? await refundLegs(db, note.original_bill_id, mode, due) : [],
  };
}

export async function refundPlan(creditNoteId, db = pool) {
  const id = cleanUuid(creditNoteId, "credit note");
  const { rows } = await db.query(`SELECT ${BILL_COLUMNS} FROM bills WHERE id = $1`, [id]);
  return planFor(db, creditNoteRow(rows[0]));
}

export async function payOut(creditNoteId, input, ctx, db = pool) {
  const version = wholeNumber(input?.version, "Version", { min: 0 });
  if (version === undefined) {
    throw httpError(400, "Send the credit note's version so nothing is lost");
  }
  const wanted = cleanPayments(input, PAYING_BACK);
  const id = cleanUuid(creditNoteId, "credit note");
  return inTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT id, bill_type, original_bill_id FROM bills WHERE id = $1`,
      [id],
    );
    creditNoteRow(rows[0]);
    const original = await lockRow(client, SPEC, rows[0].original_bill_id);
    const note = creditNoteRow(await lockRow(client, SPEC, id));
    if (note.version !== version) {
      throw httpError(
        409,
        "This credit note changed while you were working on it — open it again",
        {
          version: note.version,
        },
      );
    }
    const refund = await refundOf(client, note.id);
    if (!refund?.approved_mode) {
      throw httpError(409, "This credit note has no approved refund, so nothing can be paid out");
    }
    const { due, money } = await dueOn(client, note);
    if (!due) throw nothingDue(note, money);
    const asked = wanted.reduce((sum, payment) => sum + payment.amount, 0);
    if (asked > due) {
      throw httpError(
        409,
        `₹${rupees(due)} is due back on credit note ${note.bill_no}, so ₹${rupees(asked)} can't be paid out`,
      );
    }
    const legs = await refundLegs(client, note.original_bill_id, refund.approved_mode, due);
    refuseOtherModes(wanted, refund.approved_mode, legs);
    const cash = wanted
      .filter((payment) => payment.mode === DRAWER_MODE)
      .reduce((sum, payment) => sum + payment.amount, 0);
    if (cash && !ctx?.actorId) throw httpError(401, "Sign in again to pay money back");
    let shiftId = null;
    if (cash) {
      const shift = await cashOutShift(client, ctx.actorId);
      if (!shift) {
        throw httpError(
          409,
          "Open your shift first, so this cash comes out of a drawer that is counted at the end of it",
        );
      }
      if (shift.cash < cash) {
        throw httpError(
          409,
          `Your drawer holds ₹${rupees(shift.cash)}, so ₹${rupees(cash)} can't be paid back in cash`,
        );
      }
      shiftId = shift.id;
    } else if (ctx?.actorId) {
      shiftId = await openShiftIdFor(client, ctx.actorId);
    }
    const paid = [];
    for (const payment of wanted) {
      const { rows: saved } = await client.query(
        `INSERT INTO payments (bill_id, direction, mode, amount, reference, shift_id,
                               received_by, created_by, updated_by)
         VALUES ($1, 'out', $2, $3, $4, $5, $6, $6, $6)
         RETURNING ${PAYMENT_COLUMNS}`,
        [
          note.id,
          payment.mode,
          rupees(payment.amount),
          payment.reference,
          shiftId,
          ctx?.actorId ?? null,
        ],
      );
      paid.push(shapePayment(saved[0]));
    }
    const after = await keepPaidInStep(client, note, ctx);
    for (const payment of paid) {
      await writeAudit(client, {
        entity: "payments",
        entityId: payment.id,
        action: "create",
        after: {
          ...payment,
          credit_note_no: note.bill_no,
          bill_no: original.bill_no,
          request_id: refund.id,
          approved_mode: refund.approved_mode,
        },
        ...auditFields(ctx),
      });
    }
    const left = await dueOn(client, after);
    return {
      credit_note_id: after.id,
      credit_note_no: after.bill_no,
      original_bill_id: original.id,
      original_bill_no: original.bill_no,
      version: after.version,
      mode: refund.approved_mode,
      totals: {
        credited: paise(after.patient_payable),
        refunded: paise(after.paid_amount),
        due: left.due,
      },
      payments: paid,
    };
  }, db);
}
