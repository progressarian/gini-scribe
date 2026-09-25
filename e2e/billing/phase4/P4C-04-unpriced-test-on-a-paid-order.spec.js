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
  refused,
  setUp,
  tearDown,
} from "./p4-bills-fixture.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const bills = await import("../../../server/services/billing/bills.js");
const payments = await import("../../../server/services/billing/payments.js");
const shifts = await import("../../../server/services/billing/cashShifts.js");
const visitLines = await import("../../../server/services/billing/visitLines.js");
const labStation = await import("../../../server/services/giniflow/labStation.js");
const reception = await import("../../../server/services/giniflow/receptionStation.js");
const requests = await import("../../../server/services/billing/billingRequests.js");
const refunds = await import("../phase4b/p4b-refunds.mjs");
const labPayment = await import("../../../shared/labPayment.js");
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
    `SELECT payment_status, sample_status, amount_total, amount_paid, amount_claimed, claim_state
       FROM giniflow_lab_orders WHERE id = $1`,
    [id],
  );

const money = async (id) => {
  const row = await orderRow(id);
  return {
    status: row.payment_status,
    sample: row.sample_status,
    paid: Number(row.amount_paid),
    claimed: Number(row.amount_claimed),
    claim: row.claim_state,
  };
};

const orderOf = async (visit, tests) => {
  const total = tests.reduce((sum, entry) => sum + entry.price, 0);
  const order = await one(
    `INSERT INTO giniflow_lab_orders (visit_id, urgency, payment_status, amount_total,
                                      sample_status, kind)
     VALUES ($1, 'today', 'pending', $2, 'payment_pending', 'lab') RETURNING id`,
    [visit, total],
  );
  for (const entry of tests) {
    await query(
      `INSERT INTO giniflow_lab_order_tests (lab_order_id, test_name, price) VALUES ($1, $2, $3)`,
      [order.id, entry.name, entry.price],
    );
  }
  return order.id;
};

const mixedOrder = async (label, second) => {
  const { visit } = await extraVisit(ids, label);
  const tests = [{ name: ids.hba1cName, price: 250 }, second];
  const order = await orderOf(visit, tests);
  const raised = await visitLines.linesForOrder(
    visit,
    { labOrderId: order, testNames: tests.map((entry) => entry.name) },
    desk,
    db,
  );
  return { visit, order, billId: raised.bill_id, raised };
};

const unpriced = () => ({ name: ids.looseName, price: 300 });
const abi = () => ({ name: ids.abiName, price: 400 });

const payOnBill = async (billId, amount) => {
  const bill = await bills.readBill(billId, db);
  return payments.takePayments(billId, { version: bill.version, mode: "cash", amount }, desk, db);
};

const clear = (orderId) =>
  reception.clearPayment(
    orderId,
    { method: "paid", actorId: USERS.reception.id, confirmNotOnBill: true },
    db,
  );

const drawIt = (orderId) =>
  labStation.advanceSample(orderId, { to: "drawing", actorId: USERS.lab.id }, db);

const lineFor = (bill, itemId) => bill.lines.find((line) => line.service_item_id === itemId);

test.describe.serial("P4C-04 unpriced test on a paid order", () => {
  test.beforeAll(async () => {
    setValve(undefined);
    ids = await setUp(tag);
    await payRule(ids, ids.pensioner, { name: "pensioner claims", patient_pays: "nothing" });
    await closeOpenShifts();
    ids.shift = (await shifts.openShift({ opening_cash: 0 }, desk, db)).id;
  });

  test.afterAll(async () => {
    setValve(valveAtStart);
    await tearDown(ids);
    await closeOpenShifts();
    await query(`DELETE FROM cash_shifts WHERE user_id = $1`, [USERS.reception.id]).catch(() => {});
  });

  test("1. paying the priced test does not release the unpriced one", async () => {
    const mixed = await mixedOrder("Mixed", unpriced());
    expect(mixed.raised.added).toEqual([ids.hba1cName]);
    expect(mixed.raised.not_priced).toEqual([ids.looseName]);
    const draft = await bills.readBill(mixed.billId, db);
    expect(draft.totals.payable).toBe(25000);

    const paid = await payOnBill(mixed.billId, 250);
    expect(paid.totals.outstanding).toBe(0);
    expect(paid.orders.every((order) => !order.opens_lab_gate)).toBe(true);
    const after = await money(mixed.order);
    expect(after.status).toBe(labPayment.PAYMENT_STATUS.PART_PAID);
    expect(after.paid).toBe(250);
    expect(after.sample).toBe("payment_pending");
    expect(labPayment.outstandingOf(await orderRow(mixed.order))).toBe(300);
    await refused(drawIt(mixed.order), 409, /Payment is not cleared/, "drawing the unpaid test");

    ids.mixed = mixed;
  });

  test("2. reception collects the unpriced part and the gate opens; the bill still finalises", async () => {
    const { order, billId } = ids.mixed;
    const cleared = await clear(order);
    expect(cleared).toMatchObject({ paymentStatus: "paid" });
    const after = await money(order);
    expect(after).toMatchObject({ status: "paid", paid: 550, sample: "paid" });
    expect((await drawIt(order)).sampleStatus).toBe("drawing");

    const bill = await bills.readBill(billId, db);
    expect(lineFor(bill, ids.hba1c).order_state ?? null).toBeNull();
    const final = await bills.finaliseBill(billId, { version: bill.version }, desk, db);
    expect(final.status).toBe("final");
    expect(await money(order)).toMatchObject({ status: "paid", paid: 550 });
  });

  test("3. a fully priced order on the same bill still opens on payment", async () => {
    const { visit } = await extraVisit(ids, "Whole");
    const order = await orderOf(visit, [{ name: ids.hba1cName, price: 250 }, abi()]);
    const raised = await visitLines.linesForOrder(
      visit,
      { labOrderId: order, testNames: [ids.hba1cName, ids.abiName] },
      desk,
      db,
    );
    expect(raised.not_priced).toEqual([]);
    const paid = await payOnBill(raised.bill_id, 650);
    expect(paid.orders).toEqual([
      expect.objectContaining({ lab_order_id: order, opens_lab_gate: true }),
    ]);
    expect(await money(order)).toMatchObject({ status: "paid", paid: 650, sample: "paid" });
  });

  test("4. a removed test line is not paid for; billing it again opens the order", async () => {
    const mixed = await mixedOrder("Removed", abi());
    const draft = await bills.readBill(mixed.billId, db);
    const gone = await bills.removeLine(
      mixed.billId,
      lineFor(draft, ids.abi).id,
      { reason: "the patient pays for ABI later" },
      desk,
      db,
    );
    expect(gone.totals.payable).toBe(25000);
    await payOnBill(mixed.billId, 250);
    expect(await money(mixed.order)).toMatchObject({ status: "part_paid", paid: 250 });

    await bills.addLine(
      mixed.billId,
      { item_id: ids.abi, source: "lab_order", lab_order_id: mixed.order },
      desk,
      db,
    );
    const rest = await payOnBill(mixed.billId, 400);
    expect(rest.orders).toEqual([
      expect.objectContaining({ lab_order_id: mixed.order, opens_lab_gate: true }),
    ]);
    expect(await money(mixed.order)).toMatchObject({ status: "paid", paid: 650, sample: "paid" });
    const settle = await one(
      `SELECT meta FROM giniflow_lab_order_events
        WHERE lab_order_id = $1 AND track = 'payment' AND meta ->> 'bill_id' = $2
        ORDER BY occurred_at DESC, seq DESC LIMIT 1`,
      [mixed.order, mixed.billId],
    );
    expect(Number(settle.meta.before.amount_paid)).toBe(0);
    expect(settle.meta.before.claim_state).toBe("none");
  });

  test("5. money reception took for a test the bill later adds is never taken twice", async () => {
    const mixed = await mixedOrder("Twice", abi());
    const draft = await bills.readBill(mixed.billId, db);
    await bills.removeLine(
      mixed.billId,
      lineFor(draft, ids.abi).id,
      { reason: "ABI paid at the desk" },
      desk,
      db,
    );
    await payOnBill(mixed.billId, 250);
    expect(await clear(mixed.order)).toMatchObject({ paymentStatus: "paid" });
    expect(await money(mixed.order)).toMatchObject({ status: "paid", paid: 650 });

    const readded = await bills.addLine(
      mixed.billId,
      { item_id: ids.abi, source: "lab_order", lab_order_id: mixed.order },
      desk,
      db,
    );
    expect(lineFor(readded, ids.abi).order_state).toBe(ORDER_STATE.PAID_AT_RECEPTION);
    const attempt = await failure(payOnBill(mixed.billId, 400));
    expect(attempt?.status).toBe(409);
    expect(attempt.message).toMatch(
      new RegExp(`^ABI ${tag} was already paid ₹400\\.00 at reception`),
    );
  });

  test("6. a Pensioner's claim covers only the priced test, and a cancel gives back exactly that", async () => {
    const plain = await mixedOrder("PensPlain", unpriced());
    let bill = await bills.setCategory(plain.billId, { category: ids.pensioner }, desk, db);
    expect(bill.totals).toMatchObject({ payable: 0, claim: 25000 });
    await bills.finaliseBill(plain.billId, { version: bill.version }, desk, db);
    const claimed = await money(plain.order);
    expect(claimed).toMatchObject({ claimed: 250, paid: 0, claim: "approved" });
    expect(labPayment.opensLabGate(claimed.status)).toBe(false);
    expect(labPayment.outstandingOf(await orderRow(plain.order))).toBe(300);
    await bills.cancelBill(plain.billId, { reason: "billed under the wrong category" }, desk, db);
    expect(await money(plain.order)).toMatchObject({
      status: "pending",
      paid: 0,
      claimed: 0,
      claim: "none",
      sample: "payment_pending",
    });

    const topped = await mixedOrder("PensTopped", unpriced());
    bill = await bills.setCategory(topped.billId, { category: ids.pensioner }, desk, db);
    await bills.finaliseBill(topped.billId, { version: bill.version }, desk, db);
    expect(await clear(topped.order)).toMatchObject({ paymentStatus: "claim_approved" });
    expect(await money(topped.order)).toMatchObject({
      status: "claim_approved",
      paid: 300,
      claimed: 250,
      sample: "paid",
    });
    await bills.cancelBill(topped.billId, { reason: "billed under the wrong category" }, desk, db);
    expect(await money(topped.order)).toMatchObject({
      status: "part_paid",
      paid: 300,
      claimed: 0,
      claim: "none",
      sample: "ordered",
    });
  });
  test("7. a part collected at reception survives the bill's next settle and its credit", async () => {
    const mixed = await mixedOrder("PartTop", unpriced());
    await payOnBill(mixed.billId, 250);
    await reception.clearPayment(
      mixed.order,
      { method: "paid", amountPaid: 100, actorId: USERS.reception.id, confirmNotOnBill: true },
      db,
    );
    expect(await money(mixed.order)).toMatchObject({ status: "part_paid", paid: 350 });
    const bill = await bills.readBill(mixed.billId, db);
    expect(lineFor(bill, ids.hba1c).order_state ?? null).toBeNull();
    const final = await bills.finaliseBill(mixed.billId, { version: bill.version }, desk, db);
    expect(await money(mixed.order)).toMatchObject({ status: "part_paid", paid: 350 });
    expect(labPayment.outstandingOf(await orderRow(mixed.order))).toBe(200);

    const request = await refunds.askRefund(final.id, [{ line_id: lineFor(final, ids.hba1c).id }]);
    const approved = await requests.approveRequest(request.id, {}, refunds.admin, db);
    expect(approved.released_orders.map((order) => order.lab_order_id)).toEqual([mixed.order]);
    expect(await money(mixed.order)).toMatchObject({
      status: "part_paid",
      paid: 100,
      claimed: 0,
      claim: "none",
      sample: "payment_pending",
    });
  });

  test("8. one line covers one of a test ordered twice", async () => {
    const { visit } = await extraVisit(ids, "Double");
    const order = await orderOf(visit, [
      { name: ids.hba1cName, price: 250 },
      { name: ids.hba1cName, price: 250 },
    ]);
    const raised = await visitLines.linesForOrder(
      visit,
      { labOrderId: order, testNames: [ids.hba1cName, ids.hba1cName] },
      desk,
      db,
    );
    const draft = await bills.readBill(raised.bill_id, db);
    expect(draft.lines).toHaveLength(1);
    await payOnBill(raised.bill_id, 250);
    expect(await money(order)).toMatchObject({ status: "part_paid", paid: 250 });
    expect(labPayment.outstandingOf(await orderRow(order))).toBe(250);
    await refused(drawIt(order), 409, /Payment is not cleared/, "drawing the unbilled repeat");
  });

  test("9. an order priced above its bill line still opens once every test is billed", async () => {
    const { visit } = await extraVisit(ids, "Dearer");
    const order = await orderOf(visit, [{ name: ids.hba1cName, price: 900 }]);
    const raised = await visitLines.linesForOrder(
      visit,
      { labOrderId: order, testNames: [ids.hba1cName] },
      desk,
      db,
    );
    const paid = await payOnBill(raised.bill_id, 250);
    expect(paid.orders).toEqual([
      expect.objectContaining({ lab_order_id: order, opens_lab_gate: true }),
    ]);
    expect(await money(order)).toMatchObject({ status: "paid", paid: 900, sample: "paid" });
  });

  test("10. with the valve on, reception collects the unpriced part once the bill is paid", async () => {
    const mixed = await mixedOrder("Valve", unpriced());
    setValve("1");
    try {
      const early = await failure(clear(mixed.order));
      expect(early?.status).toBe(409);
      expect(early.code).toBe("on_bill");
      expect(early.message).toMatch(/first; reception then collects ₹300\.00/);
      await payOnBill(mixed.billId, 250);
      expect(await clear(mixed.order)).toMatchObject({ paymentStatus: "paid" });
    } finally {
      setValve(undefined);
    }
    expect(await money(mixed.order)).toMatchObject({ status: "paid", paid: 550, sample: "paid" });
  });

  test("11. a reception claim on the unpriced part does not hold the bill", async () => {
    const mixed = await mixedOrder("Claimed", unpriced());
    await payOnBill(mixed.billId, 250);
    await reception.clearPayment(
      mixed.order,
      {
        method: "insurance_claim",
        amountClaimed: 300,
        insurer: "Star Health",
        actorId: USERS.reception.id,
        confirmNotOnBill: true,
      },
      db,
    );
    let bill = await bills.readBill(mixed.billId, db);
    expect(lineFor(bill, ids.hba1c).order_state ?? null).toBeNull();

    await reception.clearPayment(
      mixed.order,
      { method: "claim_rejected", actorId: USERS.coordinator.id, note: "not covered" },
      db,
    );
    expect(await clear(mixed.order)).toMatchObject({ paymentStatus: "paid" });
    bill = await bills.readBill(mixed.billId, db);
    expect(lineFor(bill, ids.hba1c).order_state ?? null).toBeNull();
    const final = await bills.finaliseBill(mixed.billId, { version: bill.version }, desk, db);
    expect(final.status).toBe("final");
    expect(await money(mixed.order)).toMatchObject({
      status: "paid",
      paid: 550,
      claimed: 300,
      claim: "rejected",
    });
  });

  test("12. a paid draft that loses a test line settles the order to what it still bills", async () => {
    const mixed = await mixedOrder("Loses", abi());
    await bills.addLine(mixed.billId, { item_id: ids.dressing }, desk, db);
    await payOnBill(mixed.billId, 650);
    expect(await money(mixed.order)).toMatchObject({ status: "paid", paid: 650 });
    const bill = await bills.readBill(mixed.billId, db);
    await bills.removeLine(
      mixed.billId,
      lineFor(bill, ids.abi).id,
      { reason: "ABI another day" },
      desk,
      db,
    );
    const rest = await payOnBill(mixed.billId, 100);
    expect(rest.totals.outstanding).toBe(0);
    expect(await money(mixed.order)).toMatchObject({
      status: "part_paid",
      paid: 250,
      sample: "ordered",
    });
    expect(labPayment.outstandingOf(await orderRow(mixed.order))).toBe(400);
  });
});
