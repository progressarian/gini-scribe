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

const onTheBill = async (label) => {
  const { visit } = await extraVisit(ids, label);
  const order = (
    await one(
      `INSERT INTO giniflow_lab_orders (visit_id, urgency, payment_status, amount_total,
                                        sample_status, kind)
       VALUES ($1, 'today', 'pending', 250, 'payment_pending', 'lab') RETURNING id`,
      [visit],
    )
  ).id;
  await query(
    `INSERT INTO giniflow_lab_order_tests (lab_order_id, test_name, price) VALUES ($1, $2, 250)`,
    [order, ids.hba1cName],
  );
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

const claim = (orderId, amount) =>
  clear(orderId, { method: "insurance_claim", amountClaimed: amount, insurer: "Star Health" });

const decide = (orderId, method) =>
  clear(orderId, { method, actorId: USERS.coordinator.id, note: "the insurer answered" });

const payOnBill = async (billId, amount) => {
  const bill = await bills.readBill(billId, db);
  return payments.takePayments(billId, { version: bill.version, mode: "cash", amount }, desk, db);
};

const removeTest = async (billId) => {
  const bill = await bills.readBill(billId, db);
  const line = bill.lines.find((row) => row.bill_name.startsWith("HbA1c"));
  return bills.removeLine(billId, line.id, { reason: "the insurer covers it" }, desk, db);
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

const hospitalPaid = async ({ order, billId }) => {
  const row = await orderRow(order);
  const insurer = row.claim_state === "approved" ? Number(row.amount_claimed) : 0;
  return (await takenOnBill(billId)) + Number(row.amount_paid) + insurer;
};

const standingOn = (label, bill) =>
  `HbA1c ${tag} has its own insurance claim of ₹150.00 at reception, so it can't also be paid on ${label} — ${
    bill === "draft"
      ? "remove it from this bill and collect the rest at reception"
      : "cancel this bill and collect the rest at reception"
  }`;

test.describe.serial("P4-41 one claim per test", () => {
  test.beforeAll(async () => {
    ids = await setUp(tag);
    await payRule(ids, ids.pensioner, { name: "pensioner claims", patient_pays: "nothing" });
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

  test("1. a ₹250 test with a ₹150 claim standing is never paid ₹400", async () => {
    setValve(undefined);
    const placed = await onTheBill("Standing");
    expect(await claim(placed.order, 150)).toMatchObject({ claimState: "submitted" });
    const before = await orderRow(placed.order);
    const attempt = await failure(payOnBill(placed.billId, 250));
    await decide(placed.order, "claim_approved");
    expect(await hospitalPaid(placed), "what the hospital holds for a ₹250 test").toBe(150);
    expect(attempt?.status).toBe(409);
    expect(attempt.message).toBe(standingOn("this visit's draft bill", "draft"));
    expect(attempt).toMatchObject({ code: "order_claim", lab_order_id: placed.order });
    expect(await takenOnBill(placed.billId)).toBe(0);
    expect(Number(before.amount_claimed)).toBe(150);

    await removeTest(placed.billId);
    setValve("1");
    expect(await clear(placed.order)).toMatchObject({ paymentStatus: "claim_approved" });
    const row = await orderRow(placed.order);
    expect(Number(row.amount_paid)).toBe(100);
    expect(Number(row.amount_claimed)).toBe(150);
    expect(await hospitalPaid(placed)).toBe(250);
  });

  test("2. with the valve on, a claimed test put back on the bill is refused there too", async () => {
    setValve("1");
    const placed = await onTheBill("Readded");
    await removeTest(placed.billId);
    await claim(placed.order, 150);
    const readded = await bills.addLine(
      placed.billId,
      { item_id: ids.hba1c, source: "lab_order", lab_order_id: placed.order },
      desk,
      db,
    );
    expect(readded.totals.payable).toBe(25000);
    const attempt = await failure(payOnBill(placed.billId, 250));
    await decide(placed.order, "claim_approved");
    expect(await hospitalPaid(placed), "what the hospital holds for a ₹250 test").toBe(150);
    expect(attempt?.message).toBe(standingOn("this visit's draft bill", "draft"));
  });

  test("3. a category claim on the bill is not raised beside the order's own claim", async () => {
    setValve(undefined);
    const placed = await onTheBill("Pension");
    await claim(placed.order, 150);
    const ready = await bills.setCategory(placed.billId, { category: ids.pensioner }, desk, db);
    expect(ready.totals).toMatchObject({ payable: 0, claim: 25000 });
    const { next_no: nextBefore } = await one(
      `SELECT next_no FROM bill_series WHERE series = 'MAIN' AND fy = $1`,
      [ids.fy],
    );
    const attempt = await failure(
      bills.finaliseBill(placed.billId, { version: ready.version }, desk, db),
    );
    const bill = await bills.readBill(placed.billId, db);
    const claimed = bill.status === "final" ? bill.totals.claim / 100 : 0;
    const row = await orderRow(placed.order);
    expect(claimed + Number(row.amount_claimed), "claimed from payers for a ₹250 test").toBe(150);
    expect(attempt?.message).toBe(standingOn("this visit's draft bill", "draft"));
    expect(bill).toMatchObject({ status: "draft", bill_no: null, claim_status: "none" });
    const { next_no: nextAfter } = await one(
      `SELECT next_no FROM bill_series WHERE series = 'MAIN' AND fy = $1`,
      [ids.fy],
    );
    expect(nextAfter).toBe(nextBefore);

    await decide(placed.order, "claim_rejected");
    const again = await bills.readBill(placed.billId, db);
    const final = await bills.finaliseBill(placed.billId, { version: again.version }, desk, db);
    expect(final).toMatchObject({ status: "final", claim_status: "pending" });
    expect(final.totals).toMatchObject({ payable: 0, claim: 25000 });
    const settled = await orderRow(placed.order);
    expect(settled).toMatchObject({ payment_status: "claim_approved", claim_state: "approved" });
    expect(Number(settled.amount_claimed)).toBe(250);
  });

  test("4. once the insurer rejects, the bill takes the test and the patient pays once", async () => {
    setValve("1");
    const placed = await onTheBill("Rejected");
    await removeTest(placed.billId);
    await claim(placed.order, 150);
    await bills.addLine(
      placed.billId,
      { item_id: ids.hba1c, source: "lab_order", lab_order_id: placed.order },
      desk,
      db,
    );
    await decide(placed.order, "claim_rejected");
    const paid = await payOnBill(placed.billId, 250);
    expect(paid.orders).toHaveLength(1);
    const row = await orderRow(placed.order);
    expect(row).toMatchObject({ payment_status: "paid", sample_status: "paid" });
    expect(Number(row.amount_paid)).toBe(250);
    expect(Number(row.amount_claimed)).toBe(0);
    expect(await takenOnBill(placed.billId)).toBe(250);
  });

  test("5. a claim the bill wrote itself never blocks the rest of the bill", async () => {
    const { visit } = await extraVisit(ids, "Own");
    const checkIn = await visitLines.draftAtCheckIn(visit, desk, db);
    const order = (
      await one(
        `INSERT INTO giniflow_lab_orders (visit_id, urgency, payment_status, amount_total,
                                          sample_status, kind)
         VALUES ($1, 'today', 'pending', 250, 'payment_pending', 'lab') RETURNING id`,
        [visit],
      )
    ).id;
    await query(
      `INSERT INTO giniflow_lab_order_tests (lab_order_id, test_name, price) VALUES ($1, $2, 250)`,
      [order, ids.hba1cName],
    );
    await visitLines.linesForOrder(
      visit,
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
    expect((await orderRow(order)).claim_state).toBe("approved");
    const dues = await payments.takePayments(
      final.id,
      { version: final.version, mode: "cash", amount: final.totals.payable / 100 },
      desk,
      db,
    );
    expect(dues.totals.outstanding).toBe(0);
  });

  test("6. a final bill whose test later gained a claim is cancelled, and the claim stays", async () => {
    setValve(undefined);
    const placed = await onTheBill("Cancel");
    const ready = await bills.setCategory(placed.billId, { category: ids.later }, desk, db);
    const final = await bills.finaliseBill(
      placed.billId,
      { version: ready.version, pay_later: true },
      desk,
      db,
    );
    await claim(placed.order, 150);
    const attempt = await failure(payOnBill(placed.billId, 250));
    expect(attempt?.message).toBe(standingOn(`bill ${final.bill_no}`, "final"));
    expect(await takenOnBill(placed.billId)).toBe(0);
    const before = await orderRow(placed.order);
    await bills.cancelBill(placed.billId, { reason: "the insurer covers the test" }, desk, db);
    expect(await orderRow(placed.order)).toEqual(before);
    expect(before).toMatchObject({ claim_state: "submitted" });
    expect(Number(before.amount_claimed)).toBe(150);
  });
});
