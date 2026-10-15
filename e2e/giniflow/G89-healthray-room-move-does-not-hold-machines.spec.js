import { test, expect } from "@playwright/test";
import { one, query } from "../helpers/db.mjs";
import { assertTestDatabase } from "../setup/guard.mjs";
import { extraVisit, newTag, setUp, tearDown } from "../billing/phase4/p4-bills-fixture.mjs";
import { db } from "../billing/phase4b/p4b-refunds.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
await import("../../server/services/giniflow/board.js");
const { getMachineQueue } = await import("../../server/services/giniflow/machineStation.js");
const { getLabQueue } = await import("../../server/services/giniflow/labStation.js");

const tag = newTag();
let ids;
const now = new Date();
const ago = (mins) => new Date(now.getTime() - mins * 60000);
const tail = () => String(Math.floor(Math.random() * 1e12)).padStart(12, "0");

async function event(visit, { id = null, status, actor, at, meta = {} }) {
  await query(
    `INSERT INTO giniflow_visit_events (id, visit_id, status, actor_role, occurred_at, meta)
     VALUES (COALESCE($1::uuid, gen_random_uuid()), $2, $3, $4, $5, $6)`,
    [id, visit, status, actor, at, meta],
  );
}

async function paidVisit(label, kind = "machine", testName = "Fundus") {
  const { visit } = await extraVisit(ids, label, { healthray: false });
  const order = await one(
    `INSERT INTO giniflow_lab_orders (visit_id, urgency, payment_status, amount_total,
                                      amount_paid, sample_status, kind)
     VALUES ($1, 'today', 'paid', 500, 500, 'paid', $2) RETURNING id`,
    [visit, kind],
  );
  await query(
    `INSERT INTO giniflow_lab_order_tests (lab_order_id, test_name, price) VALUES ($1, $2, 500)`,
    [order.id, testName],
  );
  await query(`DELETE FROM giniflow_visit_events WHERE visit_id = $1`, [visit]);
  await event(visit, { status: "checked_in", actor: "reception", at: ago(60) });
  await event(visit, { status: "vitals_done", actor: "vitals", at: ago(55) });
  await query(`UPDATE giniflow_visits SET current_status = 'with_sd' WHERE id = $1`, [visit]);
  return { visit, order: order.id };
}

const dayOf = async (order) =>
  (
    await one(
      `SELECT v.visit_date::text AS visit_date FROM giniflow_lab_orders o
         JOIN giniflow_visits v ON v.id = o.visit_id WHERE o.id = $1`,
      [order],
    )
  ).visit_date;

const healthrayMoveWithVitals = async (visit) => {
  const at = ago(52);
  await event(visit, {
    id: `00000000-0000-4000-8000-${tail()}`,
    status: "with_sd",
    actor: "system",
    at,
    meta: { source: "healthray", observed_from: "with_vitals", healthray_status: "in_visit" },
  });
  await event(visit, {
    id: `ffffffff-ffff-4fff-bfff-${tail()}`,
    status: "with_vitals",
    actor: "vitals",
    at,
  });
};

const labRowOf = async (order) =>
  Object.values(await getLabQueue(await dayOf(order), null, db))
    .filter(Array.isArray)
    .flat()
    .find((r) => r?.orderId === order);

const rowOf = async (order) => {
  const queue = await getMachineQueue(await dayOf(order), null, db);
  return Object.values(queue)
    .filter(Array.isArray)
    .flat()
    .find((r) => r?.orderId === order);
};

test.describe.serial("G89 a HealthRay room move does not hold machine tests", () => {
  test.beforeAll(async () => {
    ids = await setUp(tag);
  });

  test.afterAll(async () => {
    await tearDown(ids);
  });

  test("1. HealthRay moving the patient to the chief at the same instant a nurse logs vitals does not hold the machine", async () => {
    const { visit, order } = await paidVisit("G89Same");
    await healthrayMoveWithVitals(visit);

    const row = await rowOf(order);
    expect(row, "the Fundus order is on the machine queue").toBeTruthy();
    expect(row.blockedReason ?? "").not.toMatch(/room — call once free/);
  });

  test("2. a patient taken into the chief's room in Scribe is still held", async () => {
    const { visit, order } = await paidVisit("G89Scribe");
    await event(visit, { status: "with_sd", actor: "sd", at: ago(10) });

    const row = await rowOf(order);
    expect(row.blockedReason).toMatch(/room — call once free/);
  });

  test("3. Lab Collection can collect blood from the same patient", async () => {
    const { visit, order } = await paidVisit("G89Lab", "lab", "HbA1c");
    await healthrayMoveWithVitals(visit);

    const row = await labRowOf(order);
    expect(row, "the blood order is on the lab queue").toBeTruthy();
    expect(row.collectable).toBe(true);
  });

  test("4. Lab Collection still waits for a patient taken into the chief's room in Scribe", async () => {
    const { visit, order } = await paidVisit("G89LabScribe", "lab", "HbA1c");
    await event(visit, { status: "with_sd", actor: "sd", at: ago(10) });

    const row = await labRowOf(order);
    expect(row.collectable).toBe(false);
  });
});
