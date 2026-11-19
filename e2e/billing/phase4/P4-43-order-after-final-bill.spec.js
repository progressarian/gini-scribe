import { test, expect } from "@playwright/test";
import { getPool, one, query } from "../../helpers/db.mjs";
import { USERS } from "../../fixtures/data.mjs";
import { assertTestDatabase } from "../../setup/guard.mjs";
import {
  autoConsultation,
  desk,
  extraVisit,
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
const counter = await import("../../../server/services/billing/counterPatients.js");

const db = getPool();
const tag = newTag();
let ids;
let autoBefore;

const closeOpenShifts = () =>
  query(
    `UPDATE cash_shifts
        SET closed_at = NOW(), expected_cash = opening_cash, counted_cash = opening_cash,
            difference = 0
      WHERE closed_at IS NULL AND user_id = $1`,
    [USERS.reception.id],
  );

const orderRow = (id) =>
  one(`SELECT payment_status, sample_status, amount_paid FROM giniflow_lab_orders WHERE id = $1`, [
    id,
  ]);

const pricedOrder = async (visit, tests) => {
  const total = tests.reduce((sum, t) => sum + t.price, 0);
  const order = await one(
    `INSERT INTO giniflow_lab_orders (visit_id, urgency, payment_status, amount_total,
                                      sample_status, kind)
     VALUES ($1, 'today', 'pending', $2, 'payment_pending', 'lab') RETURNING id`,
    [visit, total],
  );
  for (const t of tests) {
    await query(
      `INSERT INTO giniflow_lab_order_tests (lab_order_id, test_name, price) VALUES ($1, $2, $3)`,
      [order.id, t.name, t.price],
    );
  }
  return order.id;
};

const finalBillWith = async (visit, itemIds, pay) => {
  const draft = await bills.openDraft(visit, desk, db);
  let current = pay ? draft : await bills.setCategory(draft.id, { category: ids.later }, desk, db);
  for (const item_id of itemIds) current = await bills.addLine(draft.id, { item_id }, desk, db);
  if (pay) {
    current = await payments.takePayments(
      draft.id,
      { version: current.version, mode: "cash", amount: current.totals.payable / 100 },
      desk,
      db,
    );
  }
  return bills.finaliseBill(draft.id, { version: current.version, pay_later: !pay }, desk, db);
};

test.describe.serial("P4-43 a test order that arrives after the bill is final", () => {
  test.beforeAll(async () => {
    ids = await setUp(tag);
    autoBefore = await autoConsultation(false);
    ids.later = await subCategory(ids, "Later", { allow_pay_later: true });
    await payRule(ids, ids.later, { name: "later pays full", patient_pays: "full" });
    await closeOpenShifts();
    await shifts.openShift({ opening_cash: 0 }, desk, db);
  });

  test.afterAll(async () => {
    if (autoBefore !== undefined) await autoConsultation(autoBefore);
    await tearDown(ids);
    await closeOpenShifts();
    await query(`DELETE FROM cash_shifts WHERE user_id = $1`, [USERS.reception.id]).catch(() => {});
  });

  test("1. tests already paid on a final bill clear the order and leave Pending bill", async () => {
    const { visit } = await extraVisit(ids, "Late");
    const bill = await finalBillWith(visit, [ids.hba1c], true);
    expect(bill.status).toBe("final");

    const order = await pricedOrder(visit, [{ name: ids.hba1cName, price: 250 }]);
    const raised = await visitLines.linesForOrder(
      visit,
      { labOrderId: order, testNames: [ids.hba1cName] },
      desk,
      db,
    );
    expect(raised.skipped).toEqual([]);
    expect(raised.added).toEqual([]);

    const line = await one(
      `SELECT source, lab_order_id FROM bill_lines WHERE bill_id = $1 AND service_item_id = $2`,
      [bill.id, ids.hba1c],
    );
    expect(line).toEqual({ source: "lab_order", lab_order_id: order });
    expect(await orderRow(order)).toMatchObject({ payment_status: "paid", sample_status: "paid" });
    const { drafts } = await one(
      `SELECT COUNT(*)::int AS drafts FROM bill_lines l JOIN bills b ON b.id = l.bill_id
        WHERE b.visit_id = $1 AND b.status = 'draft'`,
      [visit],
    );
    expect(drafts).toBe(0);

    const day = await counter.counterPatients(null, "", new Date(), db);
    const row = [...day.toBill, ...day.billed, ...day.waiting].find((r) => r.visitId === visit);
    expect(row.hints.tests).toBe(0);
    expect(day.toBill.some((r) => r.visitId === visit)).toBe(false);
  });

  test("2. tests on an unpaid final bill are linked but the lab stays closed", async () => {
    const { visit } = await extraVisit(ids, "Due");
    const bill = await finalBillWith(visit, [ids.hba1c], false);
    const order = await pricedOrder(visit, [{ name: ids.hba1cName, price: 250 }]);
    await visitLines.linesForOrder(
      visit,
      { labOrderId: order, testNames: [ids.hba1cName] },
      desk,
      db,
    );
    const line = await one(
      `SELECT lab_order_id FROM bill_lines WHERE bill_id = $1 AND service_item_id = $2`,
      [bill.id, ids.hba1c],
    );
    expect(line.lab_order_id).toBe(order);
    expect(await orderRow(order)).toMatchObject({
      payment_status: "pending",
      sample_status: "payment_pending",
    });
  });

  test("3. the repair path links an order that was already refused", async () => {
    const { visit } = await extraVisit(ids, "Fix");
    const bill = await finalBillWith(visit, [ids.hba1c], true);
    const order = await pricedOrder(visit, [{ name: ids.hba1cName, price: 250 }]);
    const fixed = await visitLines.linkOrderToFinalBills(
      visit,
      { labOrderId: order, testNames: [ids.hba1cName] },
      desk,
      db,
    );
    expect(fixed).toEqual({ linked: [ids.hba1cName], bills: [bill.id] });
    expect((await orderRow(order)).payment_status).toBe("paid");
  });
});
