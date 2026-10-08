import { test, expect } from "@playwright/test";
import { one, query } from "../helpers/db.mjs";
import { USERS } from "../fixtures/data.mjs";
import { loginAs } from "../helpers/auth.mjs";
import { gotoReady } from "../helpers/browser.mjs";
import { assertTestDatabase } from "../setup/guard.mjs";
import { extraVisit, newTag, setUp, tearDown } from "../billing/phase4/p4-bills-fixture.mjs";
import { db } from "../billing/phase4b/p4b-refunds.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const vitals = await import("../../server/services/giniflow/vitalsStation.js");
const board = await import("../../server/services/giniflow/board.js");
const { VITALS_REST_MINUTES } = await import("../../shared/giniflowStatus.js");

const tag = newTag();
let ids;
let resting;
let rested;

const failure = (promise) => promise.then(() => null).catch((error) => error);

async function arrived(label, minutesAgo) {
  const { visit } = await extraVisit(ids, label, { healthray: false });
  await query(`UPDATE giniflow_visits SET current_status = 'checked_in' WHERE id = $1`, [visit]);
  await query(
    `INSERT INTO giniflow_visit_events (visit_id, status, actor_role, occurred_at)
     VALUES ($1, 'checked_in', 'reception', NOW() - make_interval(mins => $2))`,
    [visit, minutesAgo],
  );
  return visit;
}

const queueRow = async (visit) => {
  const queue = await vitals.getVitalsQueue(ids.day, new Date(), db, {});
  return { queue, row: queue.waiting.find((r) => r.visitId === visit) };
};

test.describe.serial("G67 vitals waits 15 minutes of rest after arrival", () => {
  test.skip(VITALS_REST_MINUTES === 0, "The rest before vitals is switched off");
  test.beforeAll(async () => {
    ids = await setUp(tag);
    resting = await arrived("Resting", 2);
    rested = await arrived("Rested", 20);
  });

  test.afterAll(async () => {
    await vitals.releaseVitals(rested, USERS.admin.id, db).catch(() => null);
    await tearDown(ids);
  });

  test("1. a patient who arrived 2 minutes ago cannot be called or saved", async () => {
    const started = await failure(vitals.startVitals(resting, USERS.admin.id, db));
    expect(started?.status).toBe(409);
    expect(started?.message).toMatch(/resting for 15 minutes/);
    expect(new Date(started.restUntil).getTime()).toBeGreaterThan(Date.now());
    const saved = await failure(vitals.saveVitals(resting, { weight: 70 }, db));
    expect(saved?.status).toBe(409);
    const status = await one(`SELECT current_status FROM giniflow_visits WHERE id = $1`, [resting]);
    expect(status.current_status).toBe("checked_in");
  });

  test("2. the queue shows the rest end, keeps the usual wait timer, and lists them after ready patients", async () => {
    const { queue, row } = await queueRow(resting);
    expect(row.restUntil).toBeTruthy();
    expect(row.waitMinutes).toBe(2);
    expect(row.slot).not.toBe("Next");
    const order = queue.waiting.map((r) => r.visitId);
    expect(order.indexOf(rested)).toBeLessThan(order.indexOf(resting));
    const patient = await vitals.getVitalsPatient(resting, db);
    expect(patient.restUntil).toBe(row.restUntil);
  });

  test("3. after the rest they can be called and every timer reads as before", async () => {
    const { row } = await queueRow(rested);
    expect(row.restUntil).toBeNull();
    expect(row.waitMinutes).toBe(20);
    const day = await board.getDayBoard(ids.day, await board.getSlaConfig(db), new Date(), db);
    expect(day.cards.find((c) => c.id === rested).statusMinutes).toBe(20);
    expect(day.cards.find((c) => c.id === resting).statusMinutes).toBe(2);
    await vitals.startVitals(rested, USERS.admin.id, db);
    const status = await one(`SELECT current_status FROM giniflow_visits WHERE id = $1`, [rested]);
    expect(status.current_status).toBe("with_vitals");
  });

  test("4. the station shows a countdown and the resting row cannot be opened", async ({
    page,
  }) => {
    await vitals.releaseVitals(rested, USERS.admin.id, db);
    await loginAs(page, "admin");
    await gotoReady(page, "/giniflow/station/vitals", () =>
      page.getByRole("heading", { name: /Waiting/ }),
    );
    await page.getByLabel("Search today's patients").fill(tag);
    const row = page.getByRole("button", { name: new RegExp(`Resting ${tag}.*resting before BP`) });
    await expect(row).toBeDisabled();
    await expect(row).toContainText(/Rest 1[0-3]:\d\d left/);
    await expect(page.getByRole("button", { name: new RegExp(`Rested ${tag}`) })).toBeEnabled();
  });
});
