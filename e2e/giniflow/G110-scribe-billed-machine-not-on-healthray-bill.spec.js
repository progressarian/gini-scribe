import { test, expect } from "@playwright/test";
import { one, query } from "../helpers/db.mjs";
import { assertTestDatabase } from "../setup/guard.mjs";
import { desk, extraVisit, newTag, setUp, tearDown } from "../billing/phase4/p4-bills-fixture.mjs";
import {
  admin,
  db,
  dropShifts,
  openDeskShift,
  prepareCategory,
} from "../billing/phase4b/p4b-refunds.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const patientBill = await import("../../server/services/giniflow/patientBill.js");
const visitLines = await import("../../server/services/billing/visitLines.js");
const bills = await import("../../server/services/billing/bills.js");
const payments = await import("../../server/services/billing/payments.js");
const { getMachines } = await import("../../server/services/giniflow/machineCatalog.js");
const { restoreBilledAgainIn } = await import("../../server/services/giniflow/testRestore.js");
const requestsApi = await import("../../server/services/billing/billingRequests.js");

const tag = newTag();
const CONSULT = {
  desc: "New Appointment",
  amount: 1500,
  category: "consultation",
  invoice: "OPD/T-1",
};
let ids;
let machines;

const minutesAfter = (iso, minutes) =>
  new Date(new Date(iso).getTime() + minutes * 60000).toISOString();

async function linkItem(testName, price) {
  const catalog = await one(`SELECT id FROM giniflow_test_catalog WHERE test_name = $1`, [
    testName,
  ]);
  const item = await one(
    `INSERT INTO service_items (code, name, subgroup_id, base_price, kind, test_catalog_id)
     VALUES ($1, $2, $3, $4, 'test', $5) RETURNING id`,
    [`P4-G110${testName}-${tag}`, `G110 ${testName} ${tag}`, ids.subgroup, price, catalog.id],
  );
  return item.id;
}

async function checkInMachine(visit, testName, price, { late = false } = {}) {
  const machine = machines.find((m) => m.tests.includes(testName));
  const at = (
    await one(
      `SELECT COALESCE(min(created_at), clock_timestamp()) AS t FROM giniflow_visit_steps
        WHERE visit_id = $1`,
      [visit],
    )
  ).t;
  await query(
    `INSERT INTO giniflow_visit_steps
       (visit_id, step_order, step_catalog_id, step_name, status, source, created_at)
     VALUES ($1, (SELECT COALESCE(MAX(step_order), 0) + 1 FROM giniflow_visit_steps
                   WHERE visit_id = $1), $2, $3, 'pending', 'template', $4)`,
    [visit, machine.id, machine.name, at],
  );
  const order = await one(
    `INSERT INTO giniflow_lab_orders (visit_id, urgency, payment_status, amount_total,
                                      amount_paid, sample_status, kind, created_at)
     VALUES ($1, 'today', 'pending', $2, 0, 'payment_pending', 'machine',
             $3::timestamptz + CASE WHEN $4 THEN interval '5 minutes' ELSE interval '0' END)
     RETURNING id`,
    [visit, price, at, late],
  );
  await query(
    `INSERT INTO giniflow_lab_order_tests (lab_order_id, test_name, price) VALUES ($1, $2, $3)`,
    [order.id, testName, price],
  );
  return { order: order.id, machine: machine.id };
}

async function billAndPay(visit, orders) {
  let billId;
  for (const o of orders) {
    const raised = await visitLines.linesForOrder(
      visit,
      { labOrderId: o.order, testNames: [o.testName] },
      desk,
      db,
    );
    billId = raised.bill_id;
  }
  const ready = await bills.setCategory(billId, { category: ids.pensioner }, desk, db);
  const taken = await payments.takePayments(
    ready.id,
    { version: ready.version, payments: [{ mode: "cash", amount: ready.totals.payable / 100 }] },
    desk,
    db,
  );
  const bill = await bills.finaliseBill(ready.id, { version: taken.version }, desk, db);
  const paid = await one(
    `SELECT max(occurred_at) AS at FROM giniflow_lab_order_events
      WHERE lab_order_id = ANY($1) AND track = 'payment' AND status = 'paid'`,
    [orders.map((o) => o.order)],
  );
  return { bill, paidAt: new Date(paid.at).toISOString() };
}

async function reconcile(visit, items, readAt) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const result = await patientBill.reconcileTestSteps(
      client,
      visit,
      { status: "billed", items, readAt },
      machines,
    );
    await client.query("COMMIT");
    return result;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

async function scenario(label, tests, options = {}) {
  const { visit } = await extraVisit(ids, label, { healthray: false });
  const orders = [];
  for (const [testName, price] of tests) {
    orders.push({ ...(await checkInMachine(visit, testName, price, options)), testName });
  }
  const { bill, paidAt } = await billAndPay(visit, orders);
  return { visit, orders, bill, paidAt };
}

const orderExists = async (id) =>
  !!(await one(`SELECT 1 AS x FROM giniflow_lab_orders WHERE id = $1`, [id]));

const refundRequests = (billId) =>
  query(
    `SELECT id, status, requested_by, reason_code, refund_lines FROM billing_requests
      WHERE bill_id = $1 AND kind = 'refund'`,
    [billId],
  ).then((r) => r.rows);

const ABI_LINE = { desc: "ABI", amount: 500, category: "machine", invoice: "OPD/T-2", itemId: 21 };
const VPT_LINE = { desc: "VPT", amount: 300, category: "machine", invoice: "OPD/T-2", itemId: 22 };

async function billedAgain(visit, machineIds) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const restored = await restoreBilledAgainIn(client, visit, machineIds);
    await client.query("COMMIT");
    return restored;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

const orderLines = (orderId) =>
  query(`SELECT source, is_live FROM bill_lines WHERE lab_order_id = $1`, [orderId]).then(
    (r) => r.rows,
  );

test.describe
  .serial("G110 check-in machine tests paid on the Scribe bill but not on HealthRay's", () => {
  test.beforeAll(async () => {
    ids = await setUp(tag);
    await prepareCategory(ids);
    await openDeskShift();
    machines = (await getMachines(db)).filter((m) => m.station === "machine_room");
    for (const [name, price] of [
      ["ABI", 500],
      ["VPT", 300],
    ]) {
      await linkItem(name, price);
    }
  });

  test.afterAll(async () => {
    delete process.env.SCRIBE_BILL_AUTO_CANCEL;
    await tearDown(ids);
    await dropShifts();
  });

  test("1. on the first read, the tests are cancelled and one system refund request covers them", async () => {
    const s = await scenario("Both", [
      ["ABI", 500],
      ["VPT", 300],
    ]);
    const before = await one(`SELECT patient_payable, paid_amount FROM bills WHERE id = $1`, [
      s.bill.id,
    ]);
    const result = await reconcile(s.visit, [CONSULT], minutesAfter(s.paidAt, 1));
    expect(result.failed).toEqual([]);
    expect(result.removedOrders).toBe(2);
    for (const o of s.orders) expect(await orderExists(o.order)).toBe(false);

    const requests = await refundRequests(s.bill.id);
    expect(requests).toHaveLength(1);
    expect(requests[0].status).toBe("pending");
    expect(requests[0].requested_by).toBeNull();
    expect(requests[0].reason_code).toBe("billed_by_mistake");
    expect(requests[0].refund_lines).toHaveLength(2);
    expect(result.refunds.map((r) => r.status)).toEqual(["raised"]);

    const after = await one(
      `SELECT status, patient_payable, paid_amount FROM bills WHERE id = $1`,
      [s.bill.id],
    );
    expect(after).toEqual({ status: "final", ...before });

    const cancelled = await query(
      `SELECT reason, source FROM giniflow_test_cancellations WHERE visit_id = $1`,
      [s.visit],
    );
    expect(cancelled.rows.map((r) => `${r.reason}/${r.source}`).sort()).toEqual([
      "not_on_bill/healthray",
      "not_on_bill/healthray",
    ]);
    const steps = await query(
      `SELECT step_catalog_id, status FROM giniflow_visit_steps WHERE visit_id = $1`,
      [s.visit],
    );
    for (const o of s.orders) {
      expect(steps.rows.find((r) => r.step_catalog_id === o.machine)?.status ?? "gone").not.toBe(
        "pending",
      );
    }
  });

  test("2. a bill read before the payment leaves the tests alone", async () => {
    const s = await scenario("Grace", [["ABI", 500]]);
    const result = await reconcile(s.visit, [CONSULT], minutesAfter(s.paidAt, -1));
    expect(result.removedOrders).toBe(0);
    expect(await orderExists(s.orders[0].order)).toBe(true);
    expect(await refundRequests(s.bill.id)).toEqual([]);
  });

  test("3. a test the machine has started is left alone", async () => {
    const s = await scenario("Started", [["ABI", 500]]);
    await query(
      `INSERT INTO giniflow_lab_order_events (lab_order_id, track, status, actor_role)
       VALUES ($1, 'sample', 'in_progress', 'machine')`,
      [s.orders[0].order],
    );
    const result = await reconcile(s.visit, [CONSULT], minutesAfter(s.paidAt, 45));
    expect(result.removedOrders).toBe(0);
    expect(await orderExists(s.orders[0].order)).toBe(true);
  });

  test("4. a test HealthRay did bill is left alone", async () => {
    const s = await scenario("Billed", [["ABI", 500]]);
    const result = await reconcile(
      s.visit,
      [CONSULT, { desc: "ABI", amount: 500, category: "machine", invoice: "OPD/T-1" }],
      minutesAfter(s.paidAt, 45),
    );
    expect(result.removedOrders).toBe(0);
    expect(await orderExists(s.orders[0].order)).toBe(true);
  });

  test("5. a test ordered after check-in (doctor, MO, bill sync) is left alone", async () => {
    const s = await scenario("Late", [["ABI", 500]], { late: true });
    const result = await reconcile(s.visit, [CONSULT], minutesAfter(s.paidAt, 45));
    expect(result.removedOrders).toBe(0);
    expect(await orderExists(s.orders[0].order)).toBe(true);
  });

  test("6. in dry mode it only reports what it would cancel", async () => {
    const s = await scenario("Dry", [["ABI", 500]]);
    process.env.SCRIBE_BILL_AUTO_CANCEL = "dry";
    try {
      const result = await reconcile(s.visit, [CONSULT], minutesAfter(s.paidAt, 45));
      expect(result.wouldCancel.map((w) => w.test)).toContain("ABI");
      expect(result.removedOrders).toBe(0);
    } finally {
      delete process.env.SCRIBE_BILL_AUTO_CANCEL;
    }
    expect(await orderExists(s.orders[0].order)).toBe(true);
    expect(await refundRequests(s.bill.id)).toEqual([]);
  });

  test("7. HealthRay bills the tests after the auto-cancel: back on the floor, refund withdrawn", async () => {
    const s = await scenario("Back", [
      ["ABI", 500],
      ["VPT", 300],
    ]);
    await query(
      `INSERT INTO giniflow_visit_steps (visit_id, step_order, step_catalog_id, step_name, status, source)
       VALUES ($1, 99, 'pharmacy', 'Pharmacy / Exit', 'pending', 'template')`,
      [s.visit],
    );
    await reconcile(s.visit, [CONSULT], minutesAfter(s.paidAt, 1));
    const restored = await billedAgain(
      s.visit,
      s.orders.map((o) => o.machine),
    );
    expect(restored.map((r) => r.tests[0]).sort()).toEqual(["ABI", "VPT"]);
    for (const o of s.orders) {
      expect(await orderExists(o.order)).toBe(true);
      expect(await orderLines(o.order)).toEqual([{ source: "lab_order", is_live: true }]);
      const order = await one(`SELECT payment_status FROM giniflow_lab_orders WHERE id = $1`, [
        o.order,
      ]);
      expect(order.payment_status).toBe("paid");
    }
    const requests = await refundRequests(s.bill.id);
    expect(requests.map((r) => r.status)).toEqual(["withdrawn"]);
    const step = await one(
      `SELECT status FROM giniflow_visit_steps WHERE visit_id = $1 AND step_catalog_id = $2
        ORDER BY step_order DESC LIMIT 1`,
      [s.visit, s.orders[0].machine],
    );
    expect(step.status).toBe("pending");
    expect(
      await billedAgain(
        s.visit,
        s.orders.map((o) => o.machine),
      ),
    ).toEqual([]);
  });

  test("8. HealthRay bills only one of them: that one comes back, the rest stays refunded", async () => {
    const s = await scenario("Half", [
      ["ABI", 500],
      ["VPT", 300],
    ]);
    await reconcile(s.visit, [CONSULT], minutesAfter(s.paidAt, 1));
    const abi = s.orders.find((o) => o.testName === "ABI");
    const vpt = s.orders.find((o) => o.testName === "VPT");
    const restored = await billedAgain(s.visit, [abi.machine]);
    expect(restored.map((r) => r.tests[0])).toEqual(["ABI"]);
    expect(await orderExists(abi.order)).toBe(true);
    expect(await orderExists(vpt.order)).toBe(false);
    const requests = await refundRequests(s.bill.id);
    expect(requests.map((r) => r.status).sort()).toEqual(["pending", "withdrawn"]);
    const open = requests.find((r) => r.status === "pending");
    expect(open.refund_lines).toHaveLength(1);
    expect(open.requested_by).toBeNull();
  });

  test("9. once the refund is approved, a later HealthRay bill does not undo it", async () => {
    const s = await scenario("Approved", [["ABI", 500]]);
    await reconcile(s.visit, [CONSULT], minutesAfter(s.paidAt, 1));
    const [request] = await refundRequests(s.bill.id);
    await requestsApi.approveRequest(request.id, {}, admin, db);
    expect(await billedAgain(s.visit, [s.orders[0].machine])).toEqual([]);
    expect(await orderExists(s.orders[0].order)).toBe(false);
  });
});
