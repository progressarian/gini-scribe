import { test, expect } from "@playwright/test";
import { one, query } from "../../helpers/db.mjs";
import { USERS } from "../../fixtures/data.mjs";
import { assertTestDatabase } from "../../setup/guard.mjs";
import { desk, extraVisit, newTag, refused, setUp, tearDown } from "../phase4/p4-bills-fixture.mjs";
import {
  admin,
  askRefund,
  db,
  dropShifts,
  lineFor,
  linesOf,
  openDeskShift,
  prepareCategory,
} from "./p4b-refunds.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const bills = await import("../../../server/services/billing/bills.js");
const payments = await import("../../../server/services/billing/payments.js");
const requests = await import("../../../server/services/billing/billingRequests.js");
const visitLines = await import("../../../server/services/billing/visitLines.js");
const labStation = await import("../../../server/services/giniflow/labStation.js");

const tag = newTag();
let ids;

const orderRow = (id) =>
  one(
    `SELECT payment_status, sample_status, amount_paid, amount_claimed, claim_state
       FROM giniflow_lab_orders WHERE id = $1`,
    [id],
  );

async function paidTest(label) {
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
  const ready = await bills.setCategory(raised.bill_id, { category: ids.pensioner }, desk, db);
  const taken = await payments.takePayments(
    ready.id,
    { version: ready.version, payments: [{ mode: "cash", amount: ready.totals.payable / 100 }] },
    desk,
    db,
  );
  const bill = await bills.finaliseBill(ready.id, { version: taken.version }, desk, db);
  expect((await orderRow(order)).payment_status).toBe("paid");
  return { visit, order, bill };
}

test.describe.serial("P4B-07 test orders on a credit note", () => {
  test.beforeAll(async () => {
    ids = await setUp(tag);
    await prepareCategory(ids);
    await openDeskShift(0);
  });

  test.afterAll(async () => {
    await tearDown(ids);
    await dropShifts();
  });

  test("1. crediting a test not yet sampled puts the order's money back and closes the gate", async () => {
    const { order, bill } = await paidTest("Undone");
    const before = await orderRow(order);
    expect(before.sample_status).toBe("paid");
    const request = await askRefund(bill.id, [{ line_id: lineFor(bill, ids.hba1c).id }]);
    const approved = await requests.approveRequest(request.id, {}, admin, db);
    expect(approved.released_orders.map((o) => o.lab_order_id)).toEqual([order]);
    const after = await orderRow(order);
    expect(after).toMatchObject({ payment_status: "pending", sample_status: "ordered" });
    expect(Number(after.amount_paid)).toBe(0);
    await refused(
      labStation.advanceSample(order, { to: "drawing", actorId: USERS.lab.id }, db),
      409,
      /Payment is not cleared/,
      "drawing a credited test",
    );
    const released = await one(
      `SELECT meta FROM giniflow_lab_order_events
        WHERE lab_order_id = $1 AND track = 'payment' ORDER BY occurred_at DESC, seq DESC LIMIT 1`,
      [order],
    );
    expect(released.meta).toMatchObject({ bill_id: bill.id, released: true });
    expect((await linesOf(bill.id))[0].is_live).toBe(false);
  });

  test("2. a test already done needs the admin's reason, and its order is left alone", async () => {
    const { order, bill } = await paidTest("Done");
    await query(`UPDATE giniflow_lab_orders SET sample_status = 'sample_collected' WHERE id = $1`, [
      order,
    ]);
    const request = await askRefund(bill.id, [{ line_id: lineFor(bill, ids.hba1c).id }]);
    const error = await refused(
      requests.approveRequest(request.id, {}, admin, db),
      409,
      /already been done, so it can be refunded only with the admin's reason/,
      "a done test with no reason",
    );
    expect(error.code).toBe("test_done");
    const waiting = await one(`SELECT status FROM billing_requests WHERE id = $1`, [request.id]);
    expect(waiting.status).toBe("pending");
    expect(
      await one(`SELECT count(*)::int AS n FROM bills WHERE original_bill_id = $1`, [bill.id]),
    ).toEqual({ n: 0 });

    const approved = await requests.approveRequest(
      request.id,
      { note: "Goodwill — the report was late" },
      admin,
      db,
    );
    expect(approved.released_orders).toEqual([]);
    expect(approved.credit_note.refund.admin_note).toBe("Goodwill — the report was late");
    const after = await orderRow(order);
    expect(after).toMatchObject({ payment_status: "paid", sample_status: "sample_collected" });
    expect(Number(after.amount_paid)).toBe(250);
  });
});
