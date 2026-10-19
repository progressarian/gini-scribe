import { test, expect } from "@playwright/test";
import { one, query } from "../helpers/db.mjs";
import { apiAs, loginAs } from "../helpers/auth.mjs";
import { USERS } from "../fixtures/data.mjs";
import { assertTestDatabase } from "../setup/guard.mjs";
import { desk, extraVisit, newTag, setUp, tearDown } from "../billing/phase4/p4-bills-fixture.mjs";
import { db, dropShifts, openDeskShift, prepareCategory } from "../billing/phase4b/p4b-refunds.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
await import("../../server/services/giniflow/board.js");
const bills = await import("../../server/services/billing/bills.js");
const payments = await import("../../server/services/billing/payments.js");
const visitLines = await import("../../server/services/billing/visitLines.js");
const requests = await import("../../server/services/giniflow/cancelRequests.js");

const tag = newTag();
const labCtx = { actorId: USERS.lab.id, role: "lab", ip: "10.9.103.1" };
const admin = { actorId: USERS.admin.id, role: "admin", ip: "10.9.103.2", canDecide: true };
let ids;

const refusal = (promise) => promise.then(() => null).catch((error) => error);

async function paidOrder(label, { names, status = "paid" } = {}) {
  const { visit } = await extraVisit(ids, label);
  const tests = names ?? [
    { name: ids.hba1cName, price: 250 },
    { name: ids.lipidName, price: 350 },
  ];
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
  const raised = await visitLines.linesForOrder(
    visit,
    { labOrderId: order.id, testNames: tests.map((t) => t.name) },
    desk,
    db,
  );
  const ready = await bills.setCategory(raised.bill_id, { category: ids.pensioner }, desk, db);
  await payments.takePayments(
    ready.id,
    { version: ready.version, payments: [{ mode: "cash", amount: ready.totals.payable / 100 }] },
    desk,
    db,
  );
  const fresh = await bills.readBill(ready.id, db);
  await bills.finaliseBill(ready.id, { version: fresh.version }, desk, db);
  await query(`UPDATE giniflow_lab_orders SET sample_status = $2 WHERE id = $1`, [
    order.id,
    status,
  ]);
  await query(`UPDATE giniflow_visits SET current_status = 'checked_in' WHERE id = $1`, [visit]);
  const paid = await one(`SELECT amount_paid FROM giniflow_lab_orders WHERE id = $1`, [order.id]);
  return {
    visit,
    order: order.id,
    bill: ready.id,
    paid: Number(paid.amount_paid),
    name: `P4 ${label} ${tag}`,
    tests,
  };
}

const orderExists = async (id) =>
  Boolean(await one(`SELECT 1 AS here FROM giniflow_lab_orders WHERE id = $1`, [id]));

async function openOrder(page, patient) {
  await loginAs(page, "lab");
  await page.goto("/giniflow/station/lab");
  await page.getByText(patient).first().click();
}

test.describe.serial("G103 lab station: cancel all tests on a blood order", () => {
  test.beforeAll(async () => {
    ids = await setUp(tag);
    await prepareCategory(ids);
    await openDeskShift(0);
    const catalog = await one(
      `INSERT INTO giniflow_test_catalog (test_name, price, category) VALUES ($1, 350, 'lab')
       RETURNING id`,
      [`P4 Lipid ${tag}`],
    );
    ids.lipidName = `P4 Lipid ${tag}`;
    await query(
      `INSERT INTO service_items (code, name, subgroup_id, base_price, kind, test_catalog_id)
       VALUES ($1, $2, $3, 350, 'test', $4)`,
      [`P4-LP-${tag}`, `Lipid ${tag}`, ids.subgroup, catalog.id],
    );
  });

  test.afterAll(async () => {
    await query(
      `DELETE FROM billing_requests WHERE kind = 'test_cancel'
          AND visit_id IN (SELECT v.id FROM giniflow_visits v JOIN patients p ON p.id = v.patient_id
                            WHERE p.name LIKE $1)`,
      [`%${tag}`],
    );
    await tearDown(ids);
    await query(`DELETE FROM giniflow_test_catalog WHERE test_name = $1`, [`P4 Lipid ${tag}`]);
    await dropShifts();
  });

  test("1. Cancel all tests cancels every test, the refund adds up, and the order is gone", async ({
    page,
  }) => {
    const o = await paidOrder("AllDirect");
    expect(o.paid).toBe(600);
    await openOrder(page, o.name);
    await page.getByRole("button", { name: "✕ Cancel all 2 tests" }).click();
    const form = page.getByRole("form", { name: "Cancel all 2 tests" });
    await expect(form).toContainText(`Cancels ${ids.hba1cName}, ${ids.lipidName}`);
    await expect(form).toContainText("₹600 to refund · ₹600 comes off the bill");
    await form.getByLabel("Reason").selectOption("patient_declined");
    await form.getByRole("button", { name: "Cancel all 2 tests" }).click();
    await expect(page.getByText(`✕ All 2 tests cancelled for ${o.name}`)).toBeVisible();

    expect(await orderExists(o.order)).toBe(false);
    const rows = (
      await query(
        `SELECT test_name, refund_amount FROM giniflow_test_cancellations
          WHERE order_id = $1 ORDER BY test_name`,
        [o.order],
      )
    ).rows;
    expect(rows.map((r) => r.test_name).sort()).toEqual([ids.hba1cName, ids.lipidName].sort());
    expect(rows.reduce((sum, r) => sum + Number(r.refund_amount), 0)).toBe(600);
    const byName = Object.fromEntries(rows.map((r) => [r.test_name, Number(r.refund_amount)]));
    expect(byName[ids.hba1cName]).toBe(250);
    expect(byName[ids.lipidName]).toBe(350);
    const refund = await one(
      `SELECT COUNT(*)::int AS n FROM billing_requests WHERE kind = 'refund' AND bill_id = $1`,
      [o.bill],
    );
    expect(refund.n).toBe(1);
  });

  test("2. an order with one test offers no Cancel all", async ({ page }) => {
    const o = await paidOrder("OneTest", { names: [{ name: ids.hba1cName, price: 250 }] });
    await openOrder(page, o.name);
    await expect(page.getByRole("button", { name: /✕ Cancel / }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: /Cancel all/ })).toHaveCount(0);
  });

  test("3. after collection one request covers the whole sample and holds it", async ({ page }) => {
    const o = await paidOrder("AllRequest", { status: "sample_collected" });
    await openOrder(page, o.name);
    await expect(page.getByRole("button", { name: "Request urgent cancellation" })).toHaveCount(2);
    await page.getByRole("button", { name: "Request to cancel all 2 tests" }).click();
    const form = page.getByRole("form", {
      name: `Urgent cancellation of all tests (${ids.hba1cName}, ${ids.lipidName})`,
    });
    await form.getByLabel("Why must it be cancelled? (required)").selectOption("patient_left");
    await form.getByRole("button", { name: "Send to admin" }).click();
    await expect(
      page.getByText("Sent to admin — the test is on hold until they decide"),
    ).toBeVisible();
    const asked = await one(
      `SELECT cancel_key FROM billing_requests WHERE kind = 'test_cancel' AND status = 'pending'
          AND cancel_key LIKE 'order:' || $1 || ':%'`,
      [o.order],
    );
    expect(asked.cancel_key).toBe(`order:${o.order}:all`);
    await page.reload();
    await page.getByText(o.name).first().click();
    await expect(page.getByRole("button", { name: "Request urgent cancellation" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Request to cancel all/ })).toHaveCount(0);
    await expect(
      page.getByRole("status").filter({ hasText: "Cancellation requested — waiting for admin" }),
    ).not.toHaveCount(0);
  });

  test("4. a one-test request and an all-tests request never wait together", async () => {
    const o = await paidOrder("Overlap", { status: "sample_collected" });
    const tests = (
      await query(`SELECT id, test_name FROM giniflow_lab_order_tests WHERE lab_order_id = $1`, [
        o.order,
      ])
    ).rows;
    const hba1c = tests.find((t) => t.test_name === ids.hba1cName);
    const one1 = await requests.raiseCancelRequest(
      { target: { orderId: o.order, testId: hba1c.id }, reason_code: "duplicate" },
      labCtx,
      db,
    );
    const all = await refusal(
      requests.raiseCancelRequest(
        { target: { orderId: o.order }, reason_code: "duplicate" },
        labCtx,
        db,
      ),
    );
    expect(all).toMatchObject({ status: 409 });
    expect(all.message).toBe(
      `A request for ${ids.hba1cName} is already waiting — withdraw it first or wait for the admin`,
    );
    await requests.withdrawCancelRequest(one1.id, labCtx, db);
    await requests.raiseCancelRequest(
      { target: { orderId: o.order }, reason_code: "duplicate" },
      labCtx,
      db,
    );
    const single = await refusal(
      requests.raiseCancelRequest(
        { target: { orderId: o.order, testId: hba1c.id }, reason_code: "duplicate" },
        labCtx,
        db,
      ),
    );
    expect(single).toMatchObject({ status: 409 });
    expect(single.message).toBe(
      "A request to cancel all tests on this sample is already waiting — withdraw it first or wait for the admin",
    );
  });

  test("5. approving the all-tests request cancels both, keeps the charge once and credits the rest", async () => {
    const o = await paidOrder("AllApprove", { status: "sample_collected" });
    const asked = await requests.raiseCancelRequest(
      { target: { orderId: o.order }, reason_code: "patient_left" },
      labCtx,
      db,
    );
    const approved = await requests.approveCancelRequest(
      asked.id,
      { charge_type: "fixed", charge_value: 100, note: "Left in an emergency" },
      admin,
      db,
    );
    expect(approved).toMatchObject({ status: "approved", paid: 60000, charge: 10000 });
    expect(approved.refund).toBe(50000);
    expect(await orderExists(o.order)).toBe(false);
    const cancelled = await one(
      `SELECT COUNT(*)::int AS n FROM giniflow_test_cancellations WHERE order_id = $1`,
      [o.order],
    );
    expect(cancelled.n).toBe(2);
  });

  test("6. the server refuses a direct cancel while a request holds the order", async () => {
    const o = await paidOrder("HeldDirect", { status: "sample_collected" });
    await requests.raiseCancelRequest(
      { target: { orderId: o.order }, reason_code: "duplicate" },
      labCtx,
      db,
    );
    await query(`UPDATE giniflow_lab_orders SET sample_status = 'paid' WHERE id = $1`, [o.order]);
    const lab = await apiAs("lab");
    const res = await lab.post(`/api/giniflow/stations/lab/${o.order}/cancel-test`, {
      data: { reason: "patient_declined" },
    });
    expect(res.status()).toBe(409);
    expect((await res.json()).error).toBe("Cancellation requested — waiting for admin");
    await lab.dispose();
    expect(await orderExists(o.order)).toBe(true);
  });
});
