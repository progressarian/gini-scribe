import { test, expect } from "@playwright/test";
import { one, query } from "../../helpers/db.mjs";
import { USERS } from "../../fixtures/data.mjs";
import { assertTestDatabase } from "../../setup/guard.mjs";
import { desk, extraVisit, newTag, setUp, tearDown } from "../phase4/p4-bills-fixture.mjs";
import { db, dropShifts, lineFor, openDeskShift, prepareCategory } from "./p4b-refunds.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const bills = await import("../../../server/services/billing/bills.js");
const payments = await import("../../../server/services/billing/payments.js");
const visitLines = await import("../../../server/services/billing/visitLines.js");
const testCancel = await import("../../../server/services/giniflow/testCancel.js");

const tag = newTag();
let ids;

async function orderOn(visit, test, kind) {
  const order = await one(
    `INSERT INTO giniflow_lab_orders (visit_id, urgency, payment_status, amount_total,
                                      sample_status, kind)
     VALUES ($1, 'today', 'pending', $2, 'payment_pending', $3) RETURNING id`,
    [visit, test.price, kind],
  );
  await query(
    `INSERT INTO giniflow_lab_order_tests (lab_order_id, test_name, price) VALUES ($1, $2, $3)`,
    [order.id, test.name, test.price],
  );
  const raised = await visitLines.linesForOrder(
    visit,
    { labOrderId: order.id, testNames: [test.name] },
    desk,
    db,
  );
  return { order: order.id, billId: raised.bill_id };
}

async function paidDraft(label, rupees) {
  const { visit } = await extraVisit(ids, label);
  const lab = await orderOn(visit, { name: ids.hba1cName, price: 250 }, "lab");
  const machine = await orderOn(visit, { name: ids.abiName, price: 400 }, "machine");
  expect(machine.billId).toBe(lab.billId);
  const ready = await bills.setCategory(lab.billId, { category: ids.pensioner }, desk, db);
  await payments.takePayments(
    ready.id,
    {
      version: ready.version,
      payments: [{ mode: "cash", amount: rupees ?? ready.totals.payable / 100 }],
    },
    desk,
    db,
  );
  return { visit, billId: ready.id, machineOrder: machine.order, payable: ready.totals.payable };
}

const cancelMachine = (orderId) =>
  testCancel.cancelTest(
    {
      target: { orderId },
      reason: "patient_declined",
      source: "station",
      stationLabel: "Machine Room",
      actorId: USERS.lab.id,
      actorRole: "lab",
    },
    db,
  );

const billRow = (id) => one(`SELECT status, bill_no FROM bills WHERE id = $1`, [id]);
const orderHere = async (id) =>
  Boolean(await one(`SELECT 1 AS here FROM giniflow_lab_orders WHERE id = $1`, [id]));

test.describe.serial("P4B-21 cancelling a test already paid on a draft bill", () => {
  test.beforeAll(async () => {
    ids = await setUp(tag);
    await prepareCategory(ids);
    await openDeskShift(0);
  });

  test.afterAll(async () => {
    await tearDown(ids);
    await dropShifts();
  });

  test("1. fully paid draft: the bill is made final, the test cancelled and its refund raised", async () => {
    const { billId, machineOrder } = await paidDraft("PaidDraft");
    expect((await billRow(billId)).status).toBe("draft");

    const result = await cancelMachine(machineOrder);

    const bill = await billRow(billId);
    expect(bill.status).toBe("final");
    expect(await orderHere(machineOrder)).toBe(false);
    expect(result.refunds).toEqual([
      expect.objectContaining({
        status: "raised",
        bill_id: billId,
        bill_no: bill.bill_no,
        amount: 40000,
      }),
    ]);
    const final = await bills.readBill(billId, db);
    expect(lineFor(final, ids.abi)).toMatchObject({ lab_order_id: null, source: "added" });
  });

  test("2. a draft that still owes money is left alone and the station is told what to do", async () => {
    const { billId, machineOrder } = await paidDraft("PartPaid", 500);

    const refused = await cancelMachine(machineOrder).catch((error) => error);

    expect(refused.status).toBe(409);
    expect(refused.message).toContain(
      "Make that bill final at the Billing Counter, then cancel the test here",
    );
    expect((await billRow(billId)).status).toBe("draft");
    expect(await orderHere(machineOrder)).toBe(true);
  });
});
