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

const withValveOn = async (work) => {
  setValve("1");
  try {
    return await work();
  } finally {
    setValve(undefined);
  }
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

const paymentEvents = async (id) =>
  Number(
    (
      await one(
        `SELECT COUNT(*) AS n FROM giniflow_lab_order_events
          WHERE lab_order_id = $1 AND track = 'payment'`,
        [id],
      )
    ).n,
  );

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

const hba1c = () => ({ name: ids.hba1cName, price: 250 });
const abi = () => ({ name: ids.abiName, price: 400 });
const unpriced = () => ({ name: ids.looseName, price: 300 });

const billedOrder = async (label, tests, { dressingFirst = 0, dressingAfter = 0 } = {}) => {
  const { visit } = await extraVisit(ids, label);
  const draft = await bills.openDraft(visit, desk, db);
  if (dressingFirst) {
    await bills.addLine(draft.id, { item_id: ids.dressing, quantity: dressingFirst }, desk, db);
  }
  const order = await orderOf(visit, tests);
  await visitLines.linesForOrder(
    visit,
    { labOrderId: order, testNames: tests.map((entry) => entry.name) },
    desk,
    db,
  );
  if (dressingAfter) {
    await bills.addLine(draft.id, { item_id: ids.dressing, quantity: dressingAfter }, desk, db);
  }
  return { visit, order, billId: draft.id };
};

const payOnBill = async (billId, amount) => {
  const bill = await bills.readBill(billId, db);
  return payments.takePayments(billId, { version: bill.version, mode: "cash", amount }, desk, db);
};

const clear = (orderId, extra = {}) =>
  reception.clearPayment(
    orderId,
    { method: "paid", actorId: USERS.reception.id, confirmNotOnBill: true, ...extra },
    db,
  );

const drawIt = (orderId) =>
  labStation.advanceSample(orderId, { to: "drawing", actorId: USERS.lab.id }, db);

const lineFor = async (billId, itemId) =>
  (await bills.readBill(billId, db)).lines.find((line) => line.service_item_id === itemId);

const removeItem = async (billId, itemId, reason = "not today") =>
  bills.removeLine(billId, (await lineFor(billId, itemId)).id, { reason }, desk, db);

const setQuantity = async (billId, itemId, quantity) =>
  bills.changeQuantity(billId, (await lineFor(billId, itemId)).id, { quantity }, desk, db);

const finalise = async (billId) => {
  const bill = await bills.readBill(billId, db);
  return bills.finaliseBill(billId, { version: bill.version }, desk, db);
};

test.describe.serial("P4C-05 reception money after a line change", () => {
  test.beforeAll(async () => {
    setValve(undefined);
    ids = await setUp(tag);
    await payRule(ids, ids.pensioner, { name: "pensioner claims", patient_pays: "nothing" });
    await query(`UPDATE service_items SET allow_quantity = TRUE, max_quantity = 3 WHERE id = $1`, [
      ids.hba1c,
    ]);
    await closeOpenShifts();
    ids.shift = (await shifts.openShift({ opening_cash: 0 }, desk, db)).id;
  });

  test.afterAll(async () => {
    setValve(valveAtStart);
    await tearDown(ids);
    await closeOpenShifts();
    await query(`DELETE FROM cash_shifts WHERE user_id = $1`, [USERS.reception.id]).catch(() => {});
  });

  test("1. removing a test line from a paid draft shuts the gate at once", async () => {
    const billed = await billedOrder("Removed", [hba1c(), abi()], { dressingAfter: 1 });
    await payOnBill(billed.billId, 650);
    expect(await money(billed.order)).toMatchObject({ status: "paid", paid: 650, sample: "paid" });

    await removeItem(billed.billId, ids.abi, "ABI another day");
    expect(await money(billed.order)).toMatchObject({
      status: "part_paid",
      paid: 250,
      sample: "ordered",
    });
    expect(labPayment.outstandingOf(await orderRow(billed.order))).toBe(400);
    await refused(drawIt(billed.order), 409, /Payment is not cleared/, "drawing the removed test");

    expect(await clear(billed.order)).toMatchObject({ paymentStatus: "paid" });
    expect(await money(billed.order)).toMatchObject({ status: "paid", paid: 650 });
    const rest = await payOnBill(billed.billId, 100);
    expect(rest.totals.outstanding).toBe(0);
    await finalise(billed.billId);
    expect(await money(billed.order)).toMatchObject({ status: "paid", paid: 650, sample: "paid" });
  });

  test("2. removing an order's only line from a paid draft gives the order back", async () => {
    const billed = await billedOrder("OnlyLine", [abi()], { dressingAfter: 1 });
    await payOnBill(billed.billId, 400);
    expect(await money(billed.order)).toMatchObject({ status: "paid", paid: 400, sample: "paid" });

    await removeItem(billed.billId, ids.abi, "ABI another day");
    expect(await money(billed.order)).toMatchObject({
      status: "pending",
      paid: 0,
      claimed: 0,
      claim: "none",
      sample: "ordered",
    });
    await refused(drawIt(billed.order), 409, /Payment is not cleared/, "drawing the removed test");
  });

  test("3. reducing a repeated test's quantity settles the order to what the bill still covers", async () => {
    const billed = await billedOrder("Fewer", [hba1c(), hba1c()], { dressingAfter: 1 });
    await setQuantity(billed.billId, ids.hba1c, 2);
    await payOnBill(billed.billId, 500);
    expect(await money(billed.order)).toMatchObject({ status: "paid", paid: 500, sample: "paid" });

    await setQuantity(billed.billId, ids.hba1c, 1);
    expect(await money(billed.order)).toMatchObject({
      status: "part_paid",
      paid: 250,
      sample: "ordered",
    });
    await refused(
      drawIt(billed.order),
      409,
      /Payment is not cleared/,
      "drawing the unbilled repeat",
    );

    await setQuantity(billed.billId, ids.hba1c, 2);
    expect(await money(billed.order)).toMatchObject({ status: "paid", paid: 500, sample: "paid" });
  });

  test("4. a draft with no payment yet is left alone", async () => {
    const plain = await billedOrder("Unpaid", [hba1c(), abi()], { dressingAfter: 1 });
    await removeItem(plain.billId, ids.abi);
    await setQuantity(plain.billId, ids.dressing, 2);
    expect(await money(plain.order)).toMatchObject({
      status: "pending",
      paid: 0,
      claimed: 0,
      sample: "payment_pending",
    });
    expect(await paymentEvents(plain.order)).toBe(0);

    const pensioner = await billedOrder("PensDraft", [hba1c(), abi()]);
    const bill = await bills.setCategory(pensioner.billId, { category: ids.pensioner }, desk, db);
    expect(bill.totals.payable).toBe(0);
    await removeItem(pensioner.billId, ids.abi);
    expect(await money(pensioner.order)).toMatchObject({
      status: "pending",
      paid: 0,
      claimed: 0,
      claim: "none",
      sample: "payment_pending",
    });
    expect(await paymentEvents(pensioner.order)).toBe(0);
  });

  test("5. money reception took for the unbilled part survives a line change", async () => {
    const billed = await billedOrder("Kept", [hba1c(), unpriced()], { dressingAfter: 1 });
    await payOnBill(billed.billId, 250);
    expect(await clear(billed.order, { amountPaid: 100 })).toMatchObject({
      paymentStatus: "part_paid",
    });
    expect(await money(billed.order)).toMatchObject({ status: "part_paid", paid: 350 });

    await setQuantity(billed.billId, ids.dressing, 2);
    expect(await money(billed.order)).toMatchObject({ status: "part_paid", paid: 350 });
    await removeItem(billed.billId, ids.dressing);
    expect(await money(billed.order)).toMatchObject({ status: "part_paid", paid: 350 });
    expect(labPayment.outstandingOf(await orderRow(billed.order))).toBe(200);

    expect(await clear(billed.order)).toMatchObject({ paymentStatus: "paid" });
    await setQuantity(billed.billId, ids.hba1c, 1);
    expect(await money(billed.order)).toMatchObject({ status: "paid", paid: 550, sample: "paid" });
    await finalise(billed.billId);
    expect(await money(billed.order)).toMatchObject({ status: "paid", paid: 550 });
  });

  test("6. a line change never takes over money reception holds on a line the bill must refuse", async () => {
    const billed = await billedOrder("Flagged", [hba1c()], { dressingFirst: 2 });
    await payOnBill(billed.billId, 750);
    expect(await money(billed.order)).toMatchObject({ status: "pending", paid: 0 });
    expect(await clear(billed.order, { amountPaid: 100 })).toMatchObject({
      paymentStatus: "part_paid",
    });

    await setQuantity(billed.billId, ids.dressing, 1);
    expect(await money(billed.order)).toMatchObject({ status: "part_paid", paid: 100 });
    expect((await lineFor(billed.billId, ids.hba1c)).order_state).toBe(
      ORDER_STATE.PAID_AT_RECEPTION,
    );
    const attempt = await failure(finalise(billed.billId));
    expect(attempt?.status).toBe(409);
    expect(attempt.code).toBe("order_paid");
  });

  test("7. with the valve on, reception collects only the part the bill doesn't charge for, once the bill is paid", async () => {
    const billed = await billedOrder("Valve", [hba1c(), unpriced()]);
    const early = await withValveOn(() => failure(clear(billed.order)));
    expect(early?.status).toBe(409);
    expect(early.code).toBe("on_bill");
    expect(early.message).toBe(
      `Pay HbA1c ${tag} on this visit's draft bill first; reception then collects ₹300.00 for the tests the bill doesn't charge for`,
    );
    expect(await money(billed.order)).toMatchObject({ status: "pending", paid: 0 });

    await payOnBill(billed.billId, 250);
    expect(await money(billed.order)).toMatchObject({ status: "part_paid", paid: 250 });
    const cleared = await withValveOn(() => clear(billed.order));
    expect(cleared).toMatchObject({ paymentStatus: "paid" });
    expect(await money(billed.order)).toMatchObject({ status: "paid", paid: 550, sample: "paid" });
    expect((await drawIt(billed.order)).sampleStatus).toBe("drawing");

    const again = await withValveOn(() => clear(billed.order));
    expect(again).toMatchObject({ alreadySettled: true });
    const final = await finalise(billed.billId);
    expect(final.status).toBe("final");
    expect(final.totals.payable).toBe(25000);
    expect(await money(billed.order)).toMatchObject({ status: "paid", paid: 550 });
  });

  test("8. with the valve on, a part at reception then the rest, never more than the bill leaves", async () => {
    const billed = await billedOrder("ValvePart", [hba1c(), unpriced()]);
    await payOnBill(billed.billId, 250);
    await withValveOn(() => clear(billed.order, { amountPaid: 100 }));
    expect(await money(billed.order)).toMatchObject({ status: "part_paid", paid: 350 });
    const over = await withValveOn(() => failure(clear(billed.order, { amountPaid: 300 })));
    expect(over?.message).toMatch(/more than the ₹200 still to be collected/);
    expect(await withValveOn(() => clear(billed.order))).toMatchObject({ paymentStatus: "paid" });
    expect(await money(billed.order)).toMatchObject({ status: "paid", paid: 550 });
  });

  test("9. with the valve on, a fully billed order is still refused at reception", async () => {
    const billed = await billedOrder("ValveWhole", [hba1c(), abi()]);
    const early = await withValveOn(() => failure(clear(billed.order)));
    expect(early?.code).toBe("on_bill");
    expect(early.message).toMatch(/is on this visit's draft bill, take the payment there$/);
    await payOnBill(billed.billId, 250);
    const partPaid = await withValveOn(() => failure(clear(billed.order)));
    expect(partPaid?.code).toBe("on_bill");
    expect(await money(billed.order)).toMatchObject({ status: "pending", paid: 0 });
  });

  test("10. with the valve on, a test removed from a paid draft is collected at reception at once", async () => {
    const billed = await billedOrder("ValveRemoved", [hba1c(), abi()], { dressingAfter: 1 });
    await payOnBill(billed.billId, 650);
    await removeItem(billed.billId, ids.abi, "ABI another day");
    expect(await money(billed.order)).toMatchObject({ status: "part_paid", paid: 250 });
    expect(await withValveOn(() => clear(billed.order))).toMatchObject({ paymentStatus: "paid" });
    expect(await money(billed.order)).toMatchObject({ status: "paid", paid: 650 });
  });

  test("11. with the valve on, a ₹0 Pensioner draft is finalised first, then reception collects the rest", async () => {
    const billed = await billedOrder("ValvePension", [hba1c(), unpriced()]);
    const bill = await bills.setCategory(billed.billId, { category: ids.pensioner }, desk, db);
    expect(bill.totals.payable).toBe(0);
    const early = await withValveOn(() => failure(clear(billed.order)));
    expect(early?.code).toBe("on_bill");
    expect(early.message).toBe(
      `Finalise this visit's draft bill for HbA1c ${tag} first; reception then collects ₹300.00 for the tests the bill doesn't charge for`,
    );
    expect(await money(billed.order)).toMatchObject({ status: "pending", paid: 0, claimed: 0 });

    await finalise(billed.billId);
    expect(await money(billed.order)).toMatchObject({ paid: 0, claimed: 250, claim: "approved" });
    const over = await withValveOn(() => failure(clear(billed.order, { amountPaid: 301 })));
    expect(over?.message).toMatch(/more than the ₹300 still to be collected/);
    expect(await withValveOn(() => clear(billed.order))).toMatchObject({
      paymentStatus: "claim_approved",
    });
    expect(await money(billed.order)).toMatchObject({ paid: 300, claimed: 250, sample: "paid" });
  });
});
