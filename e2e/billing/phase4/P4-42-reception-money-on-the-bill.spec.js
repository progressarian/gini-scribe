import { test, expect } from "@playwright/test";
import { getPool, one, query } from "../../helpers/db.mjs";
import { USERS } from "../../fixtures/data.mjs";
import { assertTestDatabase } from "../../setup/guard.mjs";
import {
  desk,
  extraVisit,
  failure,
  newTag,
  payRule,
  setUp,
  subCategory,
  tearDown,
} from "./p4-bills-fixture.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const bills = await import("../../../server/services/billing/bills.js");
const payments = await import("../../../server/services/billing/payments.js");
const shifts = await import("../../../server/services/billing/cashShifts.js");
const visitLines = await import("../../../server/services/billing/visitLines.js");
const reception = await import("../../../server/services/giniflow/receptionStation.js");
const { ORDER_STATE } = await import("../../../shared/billingVocab.js");

const db = getPool();
const tag = newTag();
const VALVE = "SCRIBE_BILL_TAKES_TEST_PAYMENTS";
const valveAtStart = process.env[VALVE];
let ids;

const setValve = (value) => {
  if (value === undefined) delete process.env[VALVE];
  else process.env[VALVE] = value;
};

const closeOpenShifts = () =>
  query(
    `UPDATE cash_shifts
        SET closed_at = NOW(), expected_cash = opening_cash, counted_cash = opening_cash,
            difference = 0
      WHERE closed_at IS NULL AND user_id = $1`,
    [USERS.reception.id],
  );

const orderRow = (id) =>
  one(
    `SELECT payment_status, sample_status, amount_total, amount_paid, amount_claimed, claim_state,
            version FROM giniflow_lab_orders WHERE id = $1`,
    [id],
  );

const pricedOrder = async (visit, name, price) => {
  const order = await one(
    `INSERT INTO giniflow_lab_orders (visit_id, urgency, payment_status, amount_total,
                                      sample_status, kind)
     VALUES ($1, 'today', 'pending', $2, 'payment_pending', 'lab') RETURNING id`,
    [visit, price],
  );
  await query(
    `INSERT INTO giniflow_lab_order_tests (lab_order_id, test_name, price) VALUES ($1, $2, $3)`,
    [order.id, name, price],
  );
  return order.id;
};

const onTheBill = async (label) => {
  const { visit } = await extraVisit(ids, label);
  const order = await pricedOrder(visit, ids.hba1cName, 250);
  const raised = await visitLines.linesForOrder(
    visit,
    { labOrderId: order, testNames: [ids.hba1cName] },
    desk,
    db,
  );
  expect(raised.added).toEqual([ids.hba1cName]);
  return { visit, order, billId: raised.bill_id };
};

const clear = (orderId, extra = {}) =>
  reception.clearPayment(
    orderId,
    { method: "paid", actorId: USERS.reception.id, confirmNotOnBill: true, ...extra },
    db,
  );

const decide = (orderId, method) =>
  clear(orderId, { method, actorId: USERS.coordinator.id, note: "the insurer answered" });

const payOnBill = async (billId, amount) => {
  const bill = await bills.readBill(billId, db);
  return payments.takePayments(billId, { version: bill.version, mode: "cash", amount }, desk, db);
};

const takenOnBill = async (billId) =>
  Number(
    (
      await one(
        `SELECT COALESCE(SUM(amount), 0)::numeric AS taken FROM payments WHERE bill_id = $1`,
        [billId],
      )
    ).taken,
  );

const receptionMoneyOf = async (order, billIds) => {
  const row = await orderRow(order);
  const settle = await one(
    `SELECT meta FROM giniflow_lab_order_events
      WHERE lab_order_id = $1 AND track = 'payment' AND meta ->> 'bill_id' = ANY($2::text[])
      ORDER BY occurred_at DESC, seq DESC LIMIT 1`,
    [order, billIds],
  );
  const after = settle?.meta?.after;
  const mirrored =
    after &&
    Number(row.amount_paid) === Number(after.amount_paid) &&
    Number(row.amount_claimed) === Number(after.amount_claimed) &&
    row.claim_state === after.claim_state;
  return mirrored ? { ...row, ...settle.meta.before } : row;
};

const hospitalHolds = async (order, billIds) => {
  const row = await receptionMoneyOf(order, billIds);
  const insurer = row.claim_state === "approved" ? Number(row.amount_claimed) : 0;
  let onBills = 0;
  for (const billId of billIds) onBills += await takenOnBill(billId);
  return onBills + Number(row.amount_paid) + insurer;
};

const stateOf = async (billId, orderId) => {
  const bill = await bills.readBill(billId, db);
  return bill.lines.find((line) => line.lab_order_id === orderId)?.order_state ?? null;
};

const paidOn = (label, amount, way) =>
  `HbA1c ${tag} was already paid ₹${amount} at reception, so it can't also be paid on ${label} — ${way}`;

test.describe.serial("P4-42 reception money on the bill", () => {
  test.beforeAll(async () => {
    ids = await setUp(tag);
    ids.later = await subCategory(ids, "Later", { allow_pay_later: true });
    ids.mixed = await subCategory(ids, "Mixed", { allow_pay_later: true });
    await payRule(ids, ids.mixed, {
      name: "mixed test claimed",
      service_item_id: ids.hba1c,
      patient_pays: "nothing",
    });
    await payRule(ids, ids.mixed, { name: "mixed rest", patient_pays: "full" });
    await closeOpenShifts();
    ids.shift = (await shifts.openShift({ opening_cash: 0 }, desk, db)).id;
  });

  test.afterEach(() => setValve(valveAtStart));

  test.afterAll(async () => {
    setValve(valveAtStart);
    await tearDown(ids);
    await closeOpenShifts();
    await query(`DELETE FROM cash_shifts WHERE user_id = $1`, [USERS.reception.id]).catch(() => {});
  });

  test("1. cancel, cash at reception, the test re-added: it is never paid twice", async () => {
    setValve("1");
    const placed = await onTheBill("Cash");
    const ready = await bills.setCategory(placed.billId, { category: ids.later }, desk, db);
    await bills.finaliseBill(placed.billId, { version: ready.version, pay_later: true }, desk, db);
    await bills.cancelBill(placed.billId, { reason: "the patient pays at the desk" }, desk, db);
    expect(await clear(placed.order)).toMatchObject({ paymentStatus: "paid", amountPaid: 250 });

    const draft = await bills.openDraft(placed.visit, desk, db);
    expect(draft.id).not.toBe(placed.billId);
    const readded = await bills.addLine(
      draft.id,
      { item_id: ids.hba1c, source: "lab_order", lab_order_id: placed.order },
      desk,
      db,
    );
    expect(readded.totals.payable).toBe(25000);
    expect(readded.lines[0].order_state).toBe(ORDER_STATE.PAID_AT_RECEPTION);

    const attempt = await failure(payOnBill(draft.id, 250));
    const both = [placed.billId, draft.id];
    expect(await hospitalHolds(placed.order, both), "what the hospital holds for ₹250").toBe(250);
    expect(attempt?.status).toBe(409);
    expect(attempt.message).toBe(
      paidOn("this visit's draft bill", "250.00", "remove it from this bill"),
    );
    expect(attempt).toMatchObject({
      code: "order_paid",
      order_state: ORDER_STATE.PAID_AT_RECEPTION,
      lab_order_id: placed.order,
    });

    const chosen = await bills.setCategory(draft.id, { category: ids.later }, desk, db);
    const final = await failure(
      bills.finaliseBill(draft.id, { version: chosen.version, pay_later: true }, desk, db),
    );
    expect(final?.message).toBe(attempt.message);
    expect((await bills.readBill(draft.id, db)).status).toBe("draft");

    const line = (await bills.readBill(draft.id, db)).lines[0];
    const emptied = await bills.removeLine(
      draft.id,
      line.id,
      { reason: "paid at reception" },
      desk,
      db,
    );
    expect(emptied.totals.payable).toBe(0);
    expect(await hospitalHolds(placed.order, both)).toBe(250);
  });

  test("2. with the valve off, a test reception collected is flagged and refused on the bill", async () => {
    setValve(undefined);
    const placed = await onTheBill("Off");
    expect(await stateOf(placed.billId, placed.order)).toBeNull();
    await clear(placed.order);
    expect(await stateOf(placed.billId, placed.order)).toBe(ORDER_STATE.PAID_AT_RECEPTION);
    const attempt = await failure(payOnBill(placed.billId, 250));
    expect(attempt?.code).toBe("order_paid");
    expect(await hospitalHolds(placed.order, [placed.billId])).toBe(250);
  });

  test("3. part paid at reception: the refusal says to collect the rest there", async () => {
    setValve(undefined);
    const placed = await onTheBill("Part");
    expect(await clear(placed.order, { amountPaid: 100 })).toMatchObject({
      paymentStatus: "part_paid",
    });
    expect(await stateOf(placed.billId, placed.order)).toBe(ORDER_STATE.PAID_AT_RECEPTION);
    const attempt = await failure(payOnBill(placed.billId, 150));
    expect(attempt?.message).toBe(
      paidOn(
        "this visit's draft bill",
        "100.00",
        "remove it from this bill and collect the rest at reception",
      ),
    );
    expect(await takenOnBill(placed.billId)).toBe(0);
  });

  test("4. a final bill whose test was then paid at reception says to cancel it", async () => {
    setValve(undefined);
    const placed = await onTheBill("Final");
    const ready = await bills.setCategory(placed.billId, { category: ids.later }, desk, db);
    const final = await bills.finaliseBill(
      placed.billId,
      { version: ready.version, pay_later: true },
      desk,
      db,
    );
    await clear(placed.order);
    expect(await stateOf(placed.billId, placed.order)).toBe(ORDER_STATE.PAID_AT_RECEPTION);
    const attempt = await failure(payOnBill(placed.billId, 250));
    expect(attempt?.message).toBe(
      paidOn(
        `bill ${final.bill_no}`,
        "250.00",
        "cancel this bill and bill it again without this test",
      ),
    );
    expect(await hospitalHolds(placed.order, [placed.billId])).toBe(250);
  });

  test("5. a claim at reception is flagged up front, and the flag follows the claim", async () => {
    setValve(undefined);
    const placed = await onTheBill("Claim");
    await clear(placed.order, {
      method: "insurance_claim",
      amountClaimed: 150,
      insurer: "Star Health",
    });
    expect(await stateOf(placed.billId, placed.order)).toBe(ORDER_STATE.CLAIM_AT_RECEPTION);
    const attempt = await failure(payOnBill(placed.billId, 250));
    expect(attempt).toMatchObject({
      code: "order_claim",
      order_state: ORDER_STATE.CLAIM_AT_RECEPTION,
    });

    await decide(placed.order, "claim_rejected");
    expect(await stateOf(placed.billId, placed.order)).toBeNull();
    const paid = await payOnBill(placed.billId, 250);
    expect(paid.orders).toHaveLength(1);
    expect(await stateOf(placed.billId, placed.order)).toBeNull();
    expect(await hospitalHolds(placed.order, [placed.billId])).toBe(250);
  });

  test("6. the bill's own settle never flags or blocks it", async () => {
    setValve("1");
    const { visit } = await extraVisit(ids, "Own");
    const first = await pricedOrder(visit, ids.hba1cName, 250);
    const second = await pricedOrder(visit, ids.abiName, 400);
    for (const [order, name] of [
      [first, ids.hba1cName],
      [second, ids.abiName],
    ]) {
      await visitLines.linesForOrder(visit, { labOrderId: order, testNames: [name] }, desk, db);
    }
    const draft = await bills.openDraft(visit, desk, db);
    const part = await payOnBill(draft.id, 250);
    expect(part.orders.map((row) => row.lab_order_id)).toEqual([first]);
    expect(Number((await orderRow(first)).amount_paid)).toBe(250);
    const midway = await bills.readBill(draft.id, db);
    expect(midway.lines.map((line) => line.order_state)).toEqual([null, null]);
    const rest = await payOnBill(draft.id, 400);
    expect(rest.orders.map((row) => row.lab_order_id)).toEqual([second]);
    expect(await takenOnBill(draft.id)).toBe(650);

    const claimed = await extraVisit(ids, "Ownclaim");
    const checkIn = await visitLines.draftAtCheckIn(claimed.visit, desk, db);
    const order = await pricedOrder(claimed.visit, ids.hba1cName, 250);
    await visitLines.linesForOrder(
      claimed.visit,
      { labOrderId: order, testNames: [ids.hba1cName] },
      desk,
      db,
    );
    const ready = await bills.setCategory(checkIn.bill_id, { category: ids.mixed }, desk, db);
    const final = await bills.finaliseBill(
      checkIn.bill_id,
      { version: ready.version, pay_later: true },
      desk,
      db,
    );
    expect(final.lines.map((line) => line.order_state)).toEqual([null, null]);
    expect((await orderRow(order)).claim_state).toBe("approved");
    const dues = await payments.takePayments(
      final.id,
      { version: final.version, mode: "cash", amount: final.totals.payable / 100 },
      desk,
      db,
    );
    expect(dues.totals.outstanding).toBe(0);
  });

  test("7. the flag and the guard never disagree", async () => {
    setValve(undefined);
    const cases = [
      ["Agreeclean", async () => {}],
      ["Agreepaid", (order) => clear(order)],
      ["Agreepart", (order) => clear(order, { amountPaid: 50 })],
      [
        "Agreeclaim",
        (order) =>
          clear(order, { method: "insurance_claim", amountClaimed: 100, insurer: "Star Health" }),
      ],
    ];
    for (const [label, atReception] of cases) {
      const placed = await onTheBill(label);
      await atReception(placed.order);
      const state = await stateOf(placed.billId, placed.order);
      const attempt = await failure(payOnBill(placed.billId, 1));
      if (state) {
        expect(attempt?.order_state, label).toBe(state);
      } else {
        expect(attempt, label).toBeNull();
      }
    }
  });
});
