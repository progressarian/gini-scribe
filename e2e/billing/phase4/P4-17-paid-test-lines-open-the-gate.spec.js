import { test, expect } from "@playwright/test";
import { getPool, one, query } from "../../helpers/db.mjs";
import { USERS } from "../../fixtures/data.mjs";
import { assertTestDatabase } from "../../setup/guard.mjs";
import {
  desk,
  extraVisit,
  newTag,
  payRule,
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
const labStation = await import("../../../server/services/giniflow/labStation.js");
const reception = await import("../../../server/services/giniflow/receptionStation.js");
const labPayment = await import("../../../shared/labPayment.js");

const db = getPool();
const tag = newTag();
let ids;

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

const pricedOrder = async (visit, tests, kind = "lab") => {
  const total = tests.reduce((sum, test) => sum + test.price, 0);
  const order = await one(
    `INSERT INTO giniflow_lab_orders (visit_id, urgency, payment_status, amount_total,
                                      sample_status, kind)
     VALUES ($1, 'today', 'pending', $2, 'payment_pending', $3) RETURNING id`,
    [visit, total, kind],
  );
  for (const test of tests) {
    await query(
      `INSERT INTO giniflow_lab_order_tests (lab_order_id, test_name, price) VALUES ($1, $2, $3)`,
      [order.id, test.name, test.price],
    );
  }
  return order.id;
};

const raise = (visit, orderId, names) =>
  visitLines.linesForOrder(visit, { labOrderId: orderId, testNames: names }, desk, db);

const drawIt = (orderId) =>
  labStation.advanceSample(orderId, { to: "drawing", actorId: USERS.lab.id }, db);

test.describe.serial("P4-17 paid test lines open the gate", () => {
  test.beforeAll(async () => {
    ids = await setUp(tag);
    await payRule(ids, ids.pensioner, { name: "pensioner claims", patient_pays: "nothing" });
    await payRule(ids, ids.paid, {
      name: "paid part",
      service_item_id: ids.hba1c,
      patient_pays: "amount",
      patient_value: 100,
    });
    await payRule(ids, ids.paid, { name: "paid rest", patient_pays: "full" });
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

  test.afterAll(async () => {
    await tearDown(ids);
    await closeOpenShifts();
    await query(`DELETE FROM cash_shifts WHERE user_id = $1`, [USERS.reception.id]).catch(() => {});
  });

  test("1. paying HbA1c on the bill lets the lab start it", async () => {
    const { visit } = await extraVisit(ids, "Gate");
    const order = await pricedOrder(visit, [{ name: ids.hba1cName, price: 250 }]);
    const raised = await raise(visit, order, [ids.hba1cName]);
    expect(raised.added).toEqual([ids.hba1cName]);
    const draft = await bills.readBill(raised.bill_id, db);
    expect(draft.totals.payable).toBe(25000);
    await refused(drawIt(order), 409, /Payment is not cleared/, "drawing before the bill is paid");

    const paid = await payments.takePayments(
      draft.id,
      { version: draft.version, mode: "cash", amount: 250 },
      desk,
      db,
    );
    expect(paid.orders).toHaveLength(1);
    expect(paid.orders[0]).toMatchObject({ lab_order_id: order, opens_lab_gate: true });
    const after = await orderRow(order);
    expect(after).toMatchObject({ payment_status: "paid", sample_status: "paid" });
    expect(Number(after.amount_paid)).toBe(250);
    expect(labPayment.opensLabGate(after.payment_status)).toBe(true);
    const drawn = await drawIt(order);
    expect(drawn.sampleStatus).toBe("drawing");
  });

  test("2. a Pensioner's HbA1c is cleared at finalise, with no payment", async () => {
    const { visit } = await extraVisit(ids, "Pens");
    const order = await pricedOrder(visit, [{ name: ids.hba1cName, price: 250 }]);
    await raise(visit, order, [ids.hba1cName]);
    const draft = await bills.openDraft(visit, desk, db);
    const ready = await bills.setCategory(draft.id, { category: ids.pensioner }, desk, db);
    expect(ready.totals).toMatchObject({ payable: 0, claim: 25000 });
    expect((await orderRow(order)).payment_status).toBe("pending");

    const bill = await bills.finaliseBill(draft.id, { version: ready.version }, desk, db);
    expect(bill.status).toBe("final");
    const after = await orderRow(order);
    expect(after).toMatchObject({
      payment_status: "claim_approved",
      sample_status: "paid",
      claim_state: "approved",
    });
    expect(Number(after.amount_claimed)).toBe(250);
    expect(Number(after.amount_paid)).toBe(0);
    expect(labPayment.opensLabGate(after.payment_status)).toBe(true);
    const { count } = await one(`SELECT COUNT(*)::int AS count FROM payments WHERE bill_id = $1`, [
      draft.id,
    ]);
    expect(count).toBe(0);
    ids.pensBill = draft.id;
    ids.pensOrder = order;
  });

  test("3. several test lines are settled in line order, one order at a time", async () => {
    const { visit } = await extraVisit(ids, "Two");
    const first = await pricedOrder(visit, [{ name: ids.hba1cName, price: 250 }]);
    const second = await pricedOrder(visit, [{ name: ids.abiName, price: 400 }], "machine");
    await raise(visit, first, [ids.hba1cName]);
    await raise(visit, second, [ids.abiName]);
    const draft = await bills.openDraft(visit, desk, db);
    expect(draft.totals.payable).toBe(65000);

    const part = await payments.takePayments(
      draft.id,
      { version: draft.version, mode: "cash", amount: 250 },
      desk,
      db,
    );
    expect(part.orders.map((row) => row.lab_order_id)).toEqual([first]);
    expect((await orderRow(first)).payment_status).toBe("paid");
    expect((await orderRow(second)).payment_status).toBe("pending");

    const rest = await payments.takePayments(
      draft.id,
      { version: part.version, mode: "cash", amount: 400 },
      desk,
      db,
    );
    expect(rest.orders.map((row) => row.lab_order_id)).toEqual([second]);
    const machine = await orderRow(second);
    expect(machine.payment_status).toBe("paid");
    expect(Number(machine.amount_paid)).toBe(400);
  });

  test("4. the claim part of a part-claimed test goes to the order's claim", async () => {
    const { visit } = await extraVisit(ids, "Split");
    const order = await pricedOrder(visit, [{ name: ids.hba1cName, price: 250 }]);
    await raise(visit, order, [ids.hba1cName]);
    const draft = await bills.openDraft(visit, desk, db);
    const ready = await bills.setCategory(draft.id, { category: ids.paid }, desk, db);
    expect(ready.totals).toMatchObject({ payable: 10000, claim: 15000 });
    const paid = await payments.takePayments(
      draft.id,
      { version: ready.version, mode: "card", amount: 100, reference: `CARD-${tag}` },
      desk,
      db,
    );
    expect(paid.orders).toHaveLength(1);
    const after = await orderRow(order);
    expect(Number(after.amount_paid)).toBe(100);
    expect(Number(after.amount_claimed)).toBe(150);
    expect(after).toMatchObject({ claim_state: "approved", payment_status: "claim_approved" });
    expect(labPayment.opensLabGate(after.payment_status)).toBe(true);
  });

  test("5. an order with a claim of its own is left to reception", async () => {
    const { visit } = await extraVisit(ids, "Claimed");
    const order = await pricedOrder(visit, [{ name: ids.hba1cName, price: 250 }]);
    await raise(visit, order, [ids.hba1cName]);
    await query(
      `UPDATE giniflow_lab_orders
          SET claim_state = 'submitted', amount_claimed = 250, payment_status = 'insurance_claim'
        WHERE id = $1`,
      [order],
    );
    const before = await orderRow(order);
    const draft = await bills.openDraft(visit, desk, db);
    await refused(
      payments.takePayments(
        draft.id,
        { version: draft.version, mode: "cash", amount: 250 },
        desk,
        db,
      ),
      409,
      /has its own insurance claim of ₹250\.00 at reception/,
      "paying on the bill for a test that carries its own claim",
    );
    expect(await orderRow(order)).toEqual(before);
  });

  test("6. cancelling the bill leaves no order looking paid", async () => {
    await bills.cancelBill(ids.pensBill, { reason: "billed under the wrong category" }, desk, db);
    const after = await orderRow(ids.pensOrder);
    expect(after).toMatchObject({ payment_status: "pending", claim_state: "none" });
    expect(Number(after.amount_claimed)).toBe(0);
    expect(labPayment.opensLabGate(after.payment_status)).toBe(false);
    expect(after.sample_status).toBe("ordered");
  });

  test("7. a fully claimed test is cleared at finalise under an unpaid consultation", async () => {
    const { visit } = await extraVisit(ids, "Under");
    const checkIn = await visitLines.draftAtCheckIn(visit, desk, db);
    expect(checkIn.added).toHaveLength(1);
    const order = await pricedOrder(visit, [{ name: ids.hba1cName, price: 250 }]);
    await raise(visit, order, [ids.hba1cName]);
    const ready = await bills.setCategory(checkIn.bill_id, { category: ids.mixed }, desk, db);
    expect(ready.lines.map((line) => line.patient_payable)).toEqual([200000, 0]);
    expect(ready.totals).toMatchObject({ payable: 200000, claim: 25000 });

    const final = await bills.finaliseBill(
      checkIn.bill_id,
      { version: ready.version, pay_later: true },
      desk,
      db,
    );
    expect(final.totals.paid).toBe(0);
    const after = await orderRow(order);
    expect(after).toMatchObject({ payment_status: "claim_approved", claim_state: "approved" });
    expect(Number(after.amount_claimed)).toBe(250);
    expect(labPayment.opensLabGate(after.payment_status)).toBe(true);
    expect((await drawIt(order)).sampleStatus).toBe("drawing");
  });

  test("8. a cancel puts back its own settle, and never money another desk took", async () => {
    const { visit } = await extraVisit(ids, "Later");
    const order = await pricedOrder(visit, [{ name: ids.hba1cName, price: 250 }]);
    await raise(visit, order, [ids.hba1cName]);
    const draft = await bills.openDraft(visit, desk, db);
    const ready = await bills.setCategory(draft.id, { category: ids.pensioner }, desk, db);
    await bills.finaliseBill(draft.id, { version: ready.version }, desk, db);
    expect((await orderRow(order)).payment_status).toBe("claim_approved");
    await query(
      `INSERT INTO giniflow_lab_order_events (lab_order_id, track, status, actor_role, meta)
       VALUES ($1, 'payment', 'repriced', 'system', $2)`,
      [order, { from: 250, to: 250, reason: "Repriced to the HealthRay bill" }],
    );
    await bills.cancelBill(draft.id, { reason: "wrong category" }, desk, db);
    const back = await orderRow(order);
    expect(back).toMatchObject({ payment_status: "pending", claim_state: "none" });
    expect(labPayment.opensLabGate(back.payment_status)).toBe(false);

    const second = await extraVisit(ids, "Moved");
    const moved = await pricedOrder(second.visit, [{ name: ids.hba1cName, price: 250 }]);
    await raise(second.visit, moved, [ids.hba1cName]);
    const bill = await bills.openDraft(second.visit, desk, db);
    const chosen = await bills.setCategory(bill.id, { category: ids.pensioner }, desk, db);
    await bills.finaliseBill(bill.id, { version: chosen.version }, desk, db);
    await reception.clearPayment(
      moved,
      { method: "claim_rejected", actorId: USERS.reception.id, note: "the insurer said no" },
      db,
    );
    const collected = await reception.clearPayment(
      moved,
      { method: "paid", actorId: USERS.reception.id, confirmNotOnBill: true },
      db,
    );
    expect(collected.paymentStatus).toBe("paid");
    await bills.cancelBill(bill.id, { reason: "the patient paid at the desk" }, desk, db);
    const kept = await orderRow(moved);
    expect(Number(kept.amount_paid)).toBe(250);
    expect(kept.payment_status).toBe("paid");
    expect(labPayment.opensLabGate(kept.payment_status)).toBe(true);
  });
});
