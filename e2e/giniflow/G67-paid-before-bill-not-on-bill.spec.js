import { test, expect } from "@playwright/test";
import { one, query } from "../helpers/db.mjs";
import { USERS } from "../fixtures/data.mjs";
import { assertTestDatabase } from "../setup/guard.mjs";
import { extraVisit, newTag, setUp, tearDown } from "../billing/phase4/p4-bills-fixture.mjs";
import { db } from "../billing/phase4b/p4b-refunds.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const reception = await import("../../server/services/giniflow/receptionStation.js");
const patientBill = await import("../../server/services/giniflow/patientBill.js");
const { getMachines } = await import("../../server/services/giniflow/machineCatalog.js");

const tag = newTag();
let ids;
let machines;
let billed;
let unbilled;

const checkInTime = async (visit) =>
  (
    await one(
      `SELECT COALESCE(min(created_at), clock_timestamp()) AS t
         FROM giniflow_visit_steps WHERE visit_id = $1`,
      [visit],
    )
  ).t;

async function checkInTest(visit, machine, price) {
  const at = await checkInTime(visit);
  await query(
    `INSERT INTO giniflow_visit_steps
       (visit_id, step_order, step_catalog_id, step_name, status, source, created_at)
     VALUES ($1, (SELECT COALESCE(MAX(step_order), 0) + 1 FROM giniflow_visit_steps
                   WHERE visit_id = $1), $2, $3, 'pending', 'template', $4)`,
    [visit, machine.id, machine.name, at],
  );
  const order = (
    await one(
      `INSERT INTO giniflow_lab_orders (visit_id, urgency, payment_status, amount_total,
                                        amount_paid, sample_status, kind, created_at)
       VALUES ($1, 'today', 'pending', $2, 0, 'payment_pending', 'machine', $3) RETURNING id`,
      [visit, price, at],
    )
  ).id;
  await query(
    `INSERT INTO giniflow_lab_order_tests (lab_order_id, test_name, price) VALUES ($1, $2, $3)`,
    [order, machine.tests[0], price],
  );
  return order;
}

const reconcile = async (visit, items) => {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const result = await patientBill.reconcileTestSteps(
      client,
      visit,
      { status: "billed", items },
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
};

test.describe.serial("G67 a check-in test paid before the bill, then missing from it", () => {
  test.beforeAll(async () => {
    ids = await setUp(tag);
    machines = (await getMachines(db)).filter((m) => m.station === "machine_room");
    [billed, unbilled] = machines;
  });

  test.afterAll(async () => {
    await tearDown(ids);
  });

  test("is cancelled with the money it took recorded as a refund", async () => {
    expect(billed && unbilled).toBeTruthy();
    const made = await extraVisit(ids, "G67", { healthray: false });
    const keep = await checkInTest(made.visit, billed, 400);
    const drop = await checkInTest(made.visit, unbilled, 600);

    for (const order of [keep, drop]) {
      await reception.clearPayment(
        order,
        { method: "paid", actorId: USERS.reception.id, confirmNotOnBill: true },
        db,
      );
    }

    const result = await reconcile(made.visit, [
      { desc: billed.tests[0], amount: 400, category: "machine" },
    ]);
    expect(result.failed).toEqual([]);
    expect(result.removedOrders).toBe(1);

    expect(await one(`SELECT 1 AS x FROM giniflow_lab_orders WHERE id = $1`, [drop])).toBeFalsy();
    expect(await one(`SELECT 1 AS x FROM giniflow_lab_orders WHERE id = $1`, [keep])).toBeTruthy();

    const cancelled = await one(
      `SELECT reason, source, refund_amount, test_name FROM giniflow_test_cancellations
        WHERE visit_id = $1`,
      [made.visit],
    );
    expect(cancelled.reason).toBe("not_on_bill");
    expect(cancelled.source).toBe("healthray");
    expect(Number(cancelled.refund_amount)).toBe(600);
  });

  test("is left alone once the machine has started on it", async () => {
    const made = await extraVisit(ids, "G67b", { healthray: false });
    const order = await checkInTest(made.visit, unbilled, 600);
    await reception.clearPayment(
      order,
      { method: "paid", actorId: USERS.reception.id, confirmNotOnBill: true },
      db,
    );
    await query(
      `INSERT INTO giniflow_lab_order_events (lab_order_id, track, status, actor_role)
       VALUES ($1, 'sample', 'in_progress', 'machine')`,
      [order],
    );

    const result = await reconcile(made.visit, [
      { desc: billed.tests[0], amount: 400, category: "machine" },
    ]);
    expect(result.removedOrders).toBe(0);
    expect(await one(`SELECT 1 AS x FROM giniflow_lab_orders WHERE id = $1`, [order])).toBeTruthy();
  });
});
