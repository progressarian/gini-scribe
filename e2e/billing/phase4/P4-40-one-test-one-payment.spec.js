import { test, expect } from "@playwright/test";
import { getPool, one, query } from "../../helpers/db.mjs";
import { USERS } from "../../fixtures/data.mjs";
import { assertTestDatabase } from "../../setup/guard.mjs";
import {
  desk,
  extraVisit,
  newTag,
  refused,
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
const floor = await import("../../../shared/manualFloor.js");

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

const refusedAsOnBill = async (attempt, billId, label) => {
  const bill = await bills.readBill(billId, db);
  const error = await refused(attempt(), 409, null, label);
  expect(error.message).toBe(
    `${bill.lines[0].bill_name} is on this visit's draft bill, take the payment there`,
  );
  expect(error).toMatchObject({ code: "on_bill", bill_id: billId, bill_no: null });
  return error;
};

test.describe.serial("P4-40 one test, one payment", () => {
  test.beforeAll(async () => {
    ids = await setUp(tag);
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

  test("1. the valve is off unless it says exactly 1", async () => {
    for (const value of [undefined, "", "0", "true", "yes", "on", " 1"]) {
      setValve(value);
      expect(floor.billTakesTestPayments(), `${VALVE}=${JSON.stringify(value)}`).toBe(false);
    }
    setValve("1");
    expect(floor.billTakesTestPayments()).toBe(true);
  });

  test("2. with the valve off, reception still collects a test on the bill, as today", async () => {
    setValve(undefined);
    const { order, billId } = await onTheBill("Off");
    const cleared = await clear(order);
    expect(cleared).toMatchObject({ paymentStatus: "paid", alreadySettled: false });
    const paid = await payOnBill(billId, 250);
    expect(paid.orders).toHaveLength(0);
    expect(Number((await orderRow(order)).amount_paid) + (await takenOnBill(billId))).toBe(500);
  });

  test("3. with the valve on, reception refuses a test on the bill and the patient pays once", async () => {
    setValve("1");
    const { order, billId } = await onTheBill("Once");
    const before = await orderRow(order);
    for (const extra of [
      { method: "paid" },
      { method: "split", amountPaid: 100, amountClaimed: 150, insurer: "Star Health" },
      { method: "insurance_claim", insurer: "Star Health" },
    ]) {
      await refusedAsOnBill(() => clear(order, extra), billId, `reception ${extra.method}`);
      expect(await orderRow(order)).toEqual(before);
    }
    const paid = await payOnBill(billId, 250);
    expect(paid.orders).toHaveLength(1);
    const after = await orderRow(order);
    expect(after).toMatchObject({ payment_status: "paid", sample_status: "paid" });
    expect(Number(after.amount_paid)).toBe(250);
    expect(await takenOnBill(billId)).toBe(250);

    const again = await clear(order);
    expect(again).toMatchObject({ alreadySettled: true, outstanding: 0 });
    expect((await orderRow(order)).version).toBe(after.version);
  });

  test("4. an order with its own insurance claim: off lets reception collect the rest, on refuses it", async () => {
    const claimedBeforeTheBill = async (label) => {
      setValve(undefined);
      const placed = await onTheBill(label);
      const claimed = await clear(placed.order, {
        method: "insurance_claim",
        amountClaimed: 150,
        insurer: "Star Health",
      });
      expect(claimed).toMatchObject({ claimState: "submitted", outstanding: 250 });
      await refused(
        payOnBill(placed.billId, 250),
        409,
        /has its own insurance claim of ₹150\.00 at reception/,
        "the bill taking a test that carries its own claim",
      );
      expect(await takenOnBill(placed.billId)).toBe(0);
      return placed;
    };

    const open = await claimedBeforeTheBill("Claimoff");
    const rest = await clear(open.order);
    expect(rest).toMatchObject({ amountPaid: 100, alreadySettled: false });
    expect(
      (await takenOnBill(open.billId)) + Number((await orderRow(open.order)).amount_paid),
    ).toBe(100);

    const shut = await claimedBeforeTheBill("Claimon");
    setValve("1");
    const before = await orderRow(shut.order);
    await refusedAsOnBill(
      () => clear(shut.order),
      shut.billId,
      "reception collecting the remainder",
    );
    await refusedAsOnBill(
      () =>
        clear(shut.order, { method: "split", amountPaid: 50, amountClaimed: 50, insurer: "Star" }),
      shut.billId,
      "reception splitting the remainder",
    );
    expect(await orderRow(shut.order)).toEqual(before);
    expect(Number(before.amount_paid)).toBe(0);

    const approved = await clear(shut.order, {
      method: "claim_approved",
      actorId: USERS.coordinator.id,
    });
    expect(approved).toMatchObject({ claimState: "approved", alreadySettled: false });
    expect(Number((await orderRow(shut.order)).amount_paid)).toBe(0);
    expect(await takenOnBill(shut.billId)).toBe(0);
  });

  test("5. with the valve on, reception still collects what no live bill line carries", async () => {
    setValve("1");
    const loose = await extraVisit(ids, "Loose");
    const unpriced = await pricedOrder(loose.visit, ids.looseName, 300);
    const raised = await visitLines.linesForOrder(
      loose.visit,
      { labOrderId: unpriced, testNames: [ids.looseName] },
      desk,
      db,
    );
    expect(raised.not_priced).toEqual([ids.looseName]);
    expect(await clear(unpriced)).toMatchObject({ paymentStatus: "paid", amountPaid: 300 });

    const removed = await onTheBill("Removed");
    await refusedAsOnBill(
      () => clear(removed.order),
      removed.billId,
      "reception before the line is removed",
    );
    const draft = await bills.readBill(removed.billId, db);
    await bills.removeLine(
      removed.billId,
      draft.lines[0].id,
      { reason: "the patient pays at the desk" },
      desk,
      db,
    );
    expect(await clear(removed.order)).toMatchObject({ paymentStatus: "paid", amountPaid: 250 });

    const cancelled = await onTheBill("Cancelled");
    const later = await subCategory(ids, "Later", { allow_pay_later: true });
    const ready = await bills.setCategory(cancelled.billId, { category: later }, desk, db);
    const final = await bills.finaliseBill(
      cancelled.billId,
      { version: ready.version, pay_later: true },
      desk,
      db,
    );
    const error = await refused(
      clear(cancelled.order),
      409,
      null,
      "reception while the bill is final",
    );
    expect(error.message).toBe(
      `${final.lines[0].bill_name} is on bill ${final.bill_no}, take the payment there`,
    );
    expect(error.bill_no).toBe(final.bill_no);
    await bills.cancelBill(cancelled.billId, { reason: "the patient pays at the desk" }, desk, db);
    const { live } = await one(
      `SELECT COUNT(*)::int AS live FROM bill_lines WHERE lab_order_id = $1 AND is_live`,
      [cancelled.order],
    );
    expect(live).toBe(0);
    expect(await clear(cancelled.order)).toMatchObject({ paymentStatus: "paid", amountPaid: 250 });
  });
});
