import { test, expect } from "@playwright/test";
import { query } from "../helpers/db.mjs";
import { USERS } from "../fixtures/data.mjs";
import { assertTestDatabase } from "../setup/guard.mjs";
import { extraVisit, newTag, setUp, tearDown } from "../billing/phase4/p4-bills-fixture.mjs";
import { db } from "../billing/phase4b/p4b-refunds.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
await import("../../server/services/giniflow/board.js");
const vitals = await import("../../server/services/giniflow/vitalsStation.js");

const tag = newTag();
let ids;
let visit;

const waitingRow = async () => {
  const queue = await vitals.getVitalsQueue(ids.day, new Date(), db, {});
  return queue.waiting.find((r) => r.visitId === visit);
};

test.describe.serial("G72 sending a patient back from vitals keeps their wait", () => {
  test.beforeAll(async () => {
    ids = await setUp(tag);
    ({ visit } = await extraVisit(ids, "Released", { healthray: false }));
    await query(`UPDATE giniflow_visits SET current_status = 'checked_in' WHERE id = $1`, [visit]);
    await query(
      `INSERT INTO giniflow_visit_events (visit_id, status, actor_role, occurred_at)
       VALUES ($1, 'checked_in', 'reception', NOW() - interval '40 minutes')`,
      [visit],
    );
  });

  test.afterAll(async () => {
    await tearDown(ids);
  });

  test("1. called by mistake and sent back, the wait still counts from arrival", async () => {
    const before = await waitingRow();
    expect(before.waitMinutes).toBeGreaterThanOrEqual(40);

    await vitals.startVitals(visit, USERS.admin.id, db);
    await vitals.releaseVitals(visit, USERS.admin.id, db);

    const after = await waitingRow();
    expect(after).toBeTruthy();
    expect(after.waitMinutes).toBeGreaterThanOrEqual(40);
    expect(after.statusSince).toBe(before.statusSince);
  });
});
