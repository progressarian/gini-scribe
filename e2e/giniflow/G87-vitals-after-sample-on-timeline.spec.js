import { test, expect } from "@playwright/test";
import { query } from "../helpers/db.mjs";
import { assertTestDatabase } from "../setup/guard.mjs";
import { extraVisit, newTag, setUp, tearDown } from "../billing/phase4/p4-bills-fixture.mjs";
import { db } from "../billing/phase4b/p4b-refunds.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
await import("../../server/services/giniflow/board.js");
const { getStationTimes } = await import("../../server/services/giniflow/statusEngine.js");

const tag = newTag();
let ids;
const now = new Date();
const ago = (mins, secs = 0) => new Date(now.getTime() - mins * 60000 + secs * 1000);

async function events(visit, rows) {
  await query(`DELETE FROM giniflow_visit_events WHERE visit_id = $1`, [visit]);
  for (const [status, actor, at] of rows) {
    await query(
      `INSERT INTO giniflow_visit_events (visit_id, status, actor_role, occurred_at)
       VALUES ($1, $2, $3, $4)`,
      [visit, status, actor, at],
    );
  }
}

const reportsWaitFrom = (from) => [
  { status: "reports_wait", label: "Waiting for lab reports", from, to: null, isWait: true },
];

test.describe.serial("G87 vitals taken after the sample still show on the timeline", () => {
  test.beforeAll(async () => {
    ids = await setUp(tag);
  });

  test.afterAll(async () => {
    await tearDown(ids);
  });

  test("1. a sample drawn before vitals does not hide the vitals stop", async () => {
    const { visit } = await extraVisit(ids, "G87Vitals", { healthray: false });
    await events(visit, [
      ["checked_in", "reception", ago(40)],
      ["with_vitals", "vitals", ago(27)],
      ["vitals_done", "vitals", ago(27, 3)],
    ]);
    const steps = await getStationTimes(db, visit, {}, now, { segments: reportsWaitFrom(ago(35)) });
    const labels = steps.map((s) => s.status);
    expect(labels).toContain("with_vitals");
    const vitalsAt = labels.indexOf("with_vitals");
    expect(labels.indexOf("reports_wait")).toBeLessThan(vitalsAt);
    expect(labels.lastIndexOf("reports_wait")).toBeGreaterThan(vitalsAt);
    expect(steps.at(-1)).toMatchObject({ status: "reports_wait", isCurrent: true });
  });

  test("2. a nurse saving vitals in one go still shows Vitals recorded", async () => {
    const { visit } = await extraVisit(ids, "G87Direct", { healthray: false });
    await events(visit, [
      ["checked_in", "reception", ago(40)],
      ["vitals_done", "vitals", ago(27)],
    ]);
    const steps = await getStationTimes(db, visit, {}, now, { segments: reportsWaitFrom(ago(35)) });
    expect(steps.map((s) => s.status)).toContain("vitals_recorded");
  });
});
