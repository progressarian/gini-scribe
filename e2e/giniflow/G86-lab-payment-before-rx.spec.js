import { test, expect } from "@playwright/test";
import { one, query } from "../helpers/db.mjs";
import { assertTestDatabase } from "../setup/guard.mjs";
import { extraVisit, newTag, setUp, tearDown } from "../billing/phase4/p4-bills-fixture.mjs";
import { db } from "../billing/phase4b/p4b-refunds.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
await import("../../server/services/giniflow/board.js");
const { setStepStatus } = await import("../../server/services/giniflow/journey.js");

const tag = newTag();
let ids;

async function step(visit, order, catalogId, name) {
  const { id } = await one(
    `INSERT INTO giniflow_visit_steps (visit_id, step_order, step_catalog_id, step_name, status, source)
     VALUES ($1, $2, $3, $4, 'pending', 'template') RETURNING id`,
    [visit, order, catalogId, name],
  );
  return id;
}

const statusOf = async (id) =>
  (await one(`SELECT status FROM giniflow_visit_steps WHERE id = $1`, [id])).status;

test.describe.serial("G86 lab payment is cleared whatever the journey has reached", () => {
  test.beforeAll(async () => {
    ids = await setUp(tag);
  });

  test.afterAll(async () => {
    await tearDown(ids);
  });

  test("1. Lab Billing behind a pending Chief Rx step can still be cleared", async () => {
    const { visit } = await extraVisit(ids, "G86Lab", { healthray: false });
    await step(visit, 1, "rx_ready", "Prescription — Chief Endocrinologist to prepare");
    const labBilling = await step(visit, 2, "lab_billing", "Lab Billing");
    await setStepStatus(labBilling, "done", db);
    expect(await statusOf(labBilling)).toBe("done");
  });

  test("2. other stops still wait for the ones before them", async () => {
    const { visit } = await extraVisit(ids, "G86Bill", { healthray: false });
    await step(visit, 1, "rx_ready", "Prescription — Chief Endocrinologist to prepare");
    const billing = await step(visit, 2, "billing", "Billing");
    await expect(setStepStatus(billing, "done", db)).rejects.toThrow("comes first");
    expect(await statusOf(billing)).toBe("pending");
    await query(`UPDATE giniflow_visit_steps SET status = 'done' WHERE visit_id = $1`, [visit]);
  });
});
