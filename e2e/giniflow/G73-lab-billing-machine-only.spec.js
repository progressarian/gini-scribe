import { test, expect } from "@playwright/test";
import { one, query } from "../helpers/db.mjs";
import { assertTestDatabase } from "../setup/guard.mjs";
import { extraVisit, newTag, setUp, tearDown } from "../billing/phase4/p4-bills-fixture.mjs";
import { db } from "../billing/phase4b/p4b-refunds.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
await import("../../server/services/giniflow/board.js");
const { syncLabStepsFromLab } = await import("../../server/services/giniflow/journey.js");
const { getMachines } = await import("../../server/services/giniflow/machineCatalog.js");

const tag = newTag();
let ids;

async function visitWithLabBilling(label) {
  const made = await extraVisit(ids, label, { healthray: false });
  await query(
    `INSERT INTO giniflow_visit_steps (visit_id, step_order, step_catalog_id, step_name, status)
     VALUES ($1, 1, 'lab_billing', 'Lab Billing', 'pending')`,
    [made.visit],
  );
  return made.visit;
}

async function machineOrder(visit, paymentStatus, sampleStatus = null, testName = null) {
  const { id } = await one(
    `INSERT INTO giniflow_lab_orders (visit_id, urgency, payment_status, amount_total,
                                      amount_paid, sample_status, kind)
     VALUES ($1, 'today', $2, 500, $3, $4, 'machine') RETURNING id`,
    [
      visit,
      paymentStatus,
      paymentStatus === "paid" ? 500 : 0,
      sampleStatus ?? (paymentStatus === "paid" ? "paid" : "payment_pending"),
    ],
  );
  if (testName)
    await query(
      `INSERT INTO giniflow_lab_order_tests (lab_order_id, test_name, price) VALUES ($1, $2, 500)`,
      [id, testName],
    );
}

async function machineStep(visit, machine, order) {
  await query(
    `INSERT INTO giniflow_visit_steps (visit_id, step_order, step_catalog_id, step_name, status)
     VALUES ($1, $2, $3, $4, 'pending')`,
    [visit, order, machine.id, machine.name],
  );
}

const stepStatus = async (visit, catalogId) =>
  (
    await one(
      `SELECT status FROM giniflow_visit_steps WHERE visit_id = $1 AND step_catalog_id = $2`,
      [visit, catalogId],
    )
  ).status;

const labBilling = async (visit) =>
  (
    await one(
      `SELECT status FROM giniflow_visit_steps
        WHERE visit_id = $1 AND step_catalog_id = 'lab_billing'`,
      [visit],
    )
  ).status;

test.describe.serial("G73 Lab Billing counts machine tests, not only blood tests", () => {
  test.beforeAll(async () => {
    ids = await setUp(tag);
  });

  test.afterAll(async () => {
    await tearDown(ids);
  });

  test("1. machine tests all paid tick Lab Billing", async () => {
    const visit = await visitWithLabBilling("G73Paid");
    await machineOrder(visit, "paid");
    await machineOrder(visit, "paid");
    expect((await syncLabStepsFromLab(db, visit)).billed).toBe(true);
    expect(await labBilling(visit)).toBe("done");
  });

  test("2. one unpaid machine test keeps Lab Billing open", async () => {
    const visit = await visitWithLabBilling("G73Part");
    await machineOrder(visit, "paid");
    await machineOrder(visit, "pending");
    expect((await syncLabStepsFromLab(db, visit)).billed).toBe(false);
    expect(await labBilling(visit)).toBe("pending");
  });

  test("3. a machine test finished or in progress at the station moves its journey step", async () => {
    const [first, second, third] = (await getMachines(db)).filter(
      (m) => m.station === "machine_room",
    );
    const visit = await visitWithLabBilling("G73Steps");
    await machineStep(visit, first, 2);
    await machineStep(visit, second, 3);
    await machineStep(visit, third, 4);
    await machineOrder(visit, "paid", "reported", first.tests[0]);
    await machineOrder(visit, "paid", "in_progress", second.tests[0]);
    await machineOrder(visit, "paid", "paid", third.tests[0]);
    await syncLabStepsFromLab(db, visit);
    expect(await stepStatus(visit, first.id)).toBe("done");
    expect(await stepStatus(visit, second.id)).toBe("in_progress");
    expect(await stepStatus(visit, third.id)).toBe("pending");
  });
});
