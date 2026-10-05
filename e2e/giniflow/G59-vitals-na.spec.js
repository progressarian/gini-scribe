import { test, expect } from "@playwright/test";
import { one, query } from "../helpers/db.mjs";
import { USERS } from "../fixtures/data.mjs";
import { assertTestDatabase } from "../setup/guard.mjs";
import { extraVisit, newTag, setUp, tearDown } from "../billing/phase4/p4-bills-fixture.mjs";
import { db } from "../billing/phase4b/p4b-refunds.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const vitals = await import("../../server/services/giniflow/vitalsStation.js");

const tag = newTag();
let ids;

const failure = (promise) => promise.then(() => null).catch((error) => error);

async function checkedIn(label) {
  const { visit } = await extraVisit(ids, label, { healthray: false });
  await query(`UPDATE giniflow_visits SET current_status = 'checked_in' WHERE id = $1`, [visit]);
  return visit;
}

test.describe.serial("G59 close a patient at vitals with NA and a remark", () => {
  test.beforeAll(async () => {
    ids = await setUp(tag);
  });

  test.afterAll(async () => {
    await tearDown(ids);
  });

  test("1. NA moves the patient on, records no reading, keeps the remark", async () => {
    const visit = await checkedIn("VitalsNA");
    const result = await vitals.skipVitals(
      visit,
      { reason: "3-day follow-up, NA in HealthRay", actorId: USERS.nurse?.id ?? null },
      db,
    );
    expect(["vitals_done", "ready_for_doctor"]).toContain(result.movedTo);

    const row = await one(`SELECT current_status FROM giniflow_visits WHERE id = $1`, [visit]);
    expect(row.current_status).toBe(result.movedTo);

    const readings = await one(
      `SELECT COUNT(*)::int AS n FROM giniflow_vitals WHERE visit_id = $1`,
      [visit],
    );
    expect(readings.n).toBe(0);

    const event = await one(
      `SELECT meta FROM giniflow_visit_events WHERE visit_id = $1 AND status = 'vitals_done'`,
      [visit],
    );
    expect(event.meta.vitalsNotTaken).toBe(true);
    expect(event.meta.vitalsNotTakenReason).toBe("3-day follow-up, NA in HealthRay");

    const queue = await vitals.getVitalsQueue(ids.day, new Date(), db, {});
    const done = queue.moved.find((d) => d.visitId === visit);
    expect(done?.notTakenReason).toBe("3-day follow-up, NA in HealthRay");
  });

  test("2. a patient already past vitals cannot be closed again", async () => {
    const visit = await checkedIn("VitalsNA2");
    await vitals.skipVitals(visit, { reason: "follow-up" }, db);
    const error = await failure(vitals.skipVitals(visit, { reason: "again" }, db));
    expect(error?.status).toBe(409);
  });
});
