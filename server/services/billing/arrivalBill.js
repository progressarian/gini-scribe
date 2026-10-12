import pool from "../../config/db.js";
import { HEALTHRAY_MODE, PREPAID_MODE } from "../../../shared/billingVocab.js";
import { paise } from "../../../shared/labPayment.js";
import { CARRY_STATE, carryOverChoices, carryOverIn } from "../giniflow/carryOver.js";
import { addLine, finaliseBill, openDraftIn, removeLine } from "./bills.js";
import { DRAWER_MODE, PAYMENT_MODES } from "./cashShifts.js";
import { receiveDeposit } from "./deposits.js";
import { collectPlannedIn, moneyOn } from "./payments.js";
import { httpError, inTransaction } from "./transaction.js";
import { arrivalConsultationIn, testsForDesk } from "./visitLines.js";

export const ALREADY_PAID_SOURCES = [HEALTHRAY_MODE, PREPAID_MODE];
const NOT_ARRIVED = ["booked", "no_show", "cancelled"];

const asList = (value) => (Array.isArray(value) ? value.filter(Boolean) : []);

const ARRIVAL_REMOVED = "Removed at check-in";

const itemIds = (value) => [...new Set(asList(value).map(Number))].filter(Number.isInteger);

async function draftOfVisit(client, visitId) {
  const { rows } = await client.query(
    `SELECT id, bill_no, status, version FROM bills
      WHERE visit_id = $1 AND status = 'draft' AND bill_type = 'invoice'
      ORDER BY created_at DESC LIMIT 1`,
    [visitId],
  );
  return rows[0] ?? null;
}

async function applyDeskChanges(client, visitId, { add, remove }, ctx) {
  if (!add.length && !remove.length) return;
  const bill = (await draftOfVisit(client, visitId)) || (await openDraftIn(client, visitId, ctx));
  for (const itemId of remove) {
    const { rows } = await client.query(
      `SELECT id FROM bill_lines WHERE bill_id = $1 AND service_item_id = $2 AND is_live`,
      [bill.id, itemId],
    );
    for (const line of rows) {
      await removeLine(bill.id, line.id, { reason: ARRIVAL_REMOVED }, ctx, client);
    }
  }
  for (const itemId of add) {
    const { rows } = await client.query(
      `SELECT 1 FROM bill_lines WHERE visit_id = $1 AND service_item_id = $2 AND is_live LIMIT 1`,
      [visitId, itemId],
    );
    if (!rows.length) await addLine(bill.id, { item_id: itemId }, ctx, client);
  }
}

async function buildIn(client, visitId, skip, ctx, changes = { add: [], remove: [] }) {
  const choices = await carryOverChoices(visitId, client);
  const carried = choices
    .filter((order) => order.state !== CARRY_STATE.DUE && !skip.includes(order.orderId))
    .map((order) => order.orderId);
  await carryOverIn(client, visitId, carried, ctx);
  await arrivalConsultationIn(client, visitId, ctx);
  await testsForDesk(visitId, ctx, client);
  await applyDeskChanges(client, visitId, changes, ctx);
  return { choices, carried, bill: await draftOfVisit(client, visitId) };
}

async function viewIn(client, built) {
  const carried = new Set(built.carried);
  const offers = built.choices.map((order) => ({
    ...order,
    carried: carried.has(order.orderId),
  }));
  if (!built.bill) return { billId: null, lines: [], outstanding: 0, carry: offers };
  const { rows } = await client.query(
    `SELECT l.service_item_id, l.bill_name, i.kind, l.lab_order_id, l.patient_payable
       FROM bill_lines l JOIN service_items i ON i.id = l.service_item_id
      WHERE l.bill_id = $1 AND l.is_live
      ORDER BY l.line_no`,
    [built.bill.id],
  );
  const money = await moneyOn(client, built.bill.id);
  return {
    billId: built.bill.id,
    lines: rows.map((row) => ({
      itemId: row.service_item_id,
      name: row.bill_name,
      kind: row.kind,
      orderId: row.lab_order_id,
      carried: Boolean(row.lab_order_id && carried.has(row.lab_order_id)),
      amount: paise(row.patient_payable),
    })),
    outstanding: money.balance,
    carry: offers,
  };
}

export async function arrivalBillPreview(visitId, { skip, add, remove } = {}, ctx = {}, db = pool) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SELECT id FROM giniflow_visits WHERE id = $1 FOR UPDATE`, [visitId]);
    const view = await viewIn(
      client,
      await buildIn(client, visitId, asList(skip), ctx, {
        add: itemIds(add),
        remove: itemIds(remove),
      }),
    );
    return { ...view, billId: null };
  } finally {
    await client.query("ROLLBACK").catch(() => {});
    client.release();
  }
}

const rupeeText = (paise) => `₹${(paise / 100).toLocaleString("en-IN")}`;

function splitPayments(split, left, extraToDeposit = false) {
  const payments = split.map((part) => {
    if (!PAYMENT_MODES.includes(part.mode)) {
      throw httpError(400, `Each part of a split is one of: ${PAYMENT_MODES.join(", ")}`);
    }
    const amount = Math.round(Number(part.amount));
    if (!Number.isInteger(amount) || amount <= 0) {
      throw httpError(400, "Each part of a split needs an amount above zero");
    }
    const reference = part.mode === DRAWER_MODE ? null : String(part.reference || "").trim();
    if (part.mode !== DRAWER_MODE && !reference) {
      throw httpError(400, `The ${part.mode.toUpperCase()} part needs its reference number`);
    }
    return { mode: part.mode, amount, reference };
  });
  const total = payments.reduce((sum, part) => sum + part.amount, 0);
  if (total < left || (total > left && !extraToDeposit)) {
    throw httpError(
      409,
      `The split adds up to ${rupeeText(total)}, but ${rupeeText(left)} is to collect`,
    );
  }
  const onBill = [];
  const toDeposit = [];
  let due = left;
  for (const part of payments) {
    const take = Math.min(part.amount, due);
    if (take > 0) onBill.push({ ...part, amount: take });
    if (part.amount > take) toDeposit.push({ ...part, amount: part.amount - take });
    due -= take;
  }
  return { onBill, toDeposit };
}

function paymentsFor(view, input) {
  const byItem = new Map(view.lines.map((line) => [line.itemId, line]));
  const already = new Map();
  let left = view.outstanding;
  for (const { itemId, source, reference: typed } of asList(input.alreadyPaid)) {
    const line = byItem.get(Number(itemId));
    if (!line) throw httpError(409, "An item marked as already paid is no longer on this bill");
    if (!ALREADY_PAID_SOURCES.includes(source)) {
      throw httpError(400, "Say where it was paid: in HealthRay, or earlier / online");
    }
    const reference = source === PREPAID_MODE ? String(typed || "").trim() : "";
    if (source === PREPAID_MODE && !reference) {
      throw httpError(
        400,
        `Enter the transaction ID or earlier receipt number for ${line.name}, paid earlier / online`,
      );
    }
    const amount = Math.min(line.amount, left);
    const key = `${source}|${reference}`;
    const was = already.get(key);
    already.set(key, {
      mode: source,
      amount: (was?.amount ?? 0) + amount,
      reference: reference || null,
    });
    left -= amount;
  }
  const wanted = [...already.values()].filter((payment) => payment.amount > 0);
  if (!left) return wanted;
  if (asList(input.split).length) {
    const { onBill, toDeposit } = splitPayments(input.split, left, input.extraToDeposit === true);
    return { wanted: [...wanted, ...onBill], toDeposit };
  }
  if (!PAYMENT_MODES.includes(input.mode)) {
    throw httpError(400, `Choose how the rest is paid: ${PAYMENT_MODES.join(", ")}`);
  }
  const reference = input.mode === DRAWER_MODE ? null : String(input.reference || "").trim();
  if (input.mode !== DRAWER_MODE && !reference) {
    throw httpError(400, `A ${input.mode.toUpperCase()} payment needs its reference number`);
  }
  return [...wanted, { mode: input.mode, amount: left, reference }];
}

async function depositExtra(client, visitId, parts, ctx) {
  if (!parts.length) return 0;
  const { rows } = await client.query(`SELECT patient_id FROM giniflow_visits WHERE id = $1`, [
    visitId,
  ]);
  let total = 0;
  for (const part of parts) {
    await receiveDeposit(
      rows[0].patient_id,
      {
        mode: part.mode,
        amount: part.amount / 100,
        reference: part.reference,
        note: "Paid over the bill at check-in",
      },
      ctx,
      client,
    );
    total += part.amount;
  }
  return total;
}

async function finaliseIfPaid(client, billId, ctx) {
  if ((await moneyOn(client, billId)).balance) return null;
  const { rows } = await client.query(`SELECT version FROM bills WHERE id = $1`, [billId]);
  try {
    await finaliseBill(billId, { version: rows[0].version }, ctx, client);
    return null;
  } catch (error) {
    if (!error.status || error.status >= 500) throw error;
    return error.message;
  }
}

export async function commitArrivalBill(visitId, input = {}, ctx = {}, db = pool) {
  return inTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT current_status FROM giniflow_visits WHERE id = $1 FOR UPDATE`,
      [visitId],
    );
    if (!rows.length) throw httpError(404, "Visit not found");
    if (NOT_ARRIVED.includes(rows[0].current_status)) {
      throw httpError(409, "Check the patient in before billing them");
    }
    const built = await buildIn(client, visitId, asList(input.skip), ctx, {
      add: itemIds(input.add),
      remove: itemIds(input.remove),
    });
    const view = await viewIn(client, built);
    if (!view.billId) throw httpError(409, "There is nothing to bill for this patient yet");
    if (view.outstanding !== Math.round(Number(input.expectedTotal))) {
      throw httpError(409, "The amount changed — check the new total before collecting", {
        code: "amount_changed",
      });
    }
    const planned = view.outstanding ? paymentsFor(view, input) : [];
    const { wanted, toDeposit } = Array.isArray(planned)
      ? { wanted: planned, toDeposit: [] }
      : planned;
    if (wanted.length) await collectPlannedIn(client, view.billId, wanted, ctx);
    const deposited = await depositExtra(client, visitId, toDeposit, ctx);
    const notFinal = await finaliseIfPaid(client, view.billId, ctx);
    const { rows: bills } = await client.query(
      `SELECT id, bill_no, status FROM bills WHERE id = $1`,
      [view.billId],
    );
    return {
      billId: bills[0].id,
      billNo: bills[0].bill_no,
      status: bills[0].status,
      payments: wanted.map(({ mode, amount }) => ({ mode, amount })),
      deposited,
      carried: built.carried,
      notFinal,
    };
  }, db);
}
