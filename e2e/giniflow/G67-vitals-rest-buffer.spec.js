import { test, expect } from "@playwright/test";
import { one, query } from "../helpers/db.mjs";
import { CONSULTANTS, USERS } from "../fixtures/data.mjs";
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
let fresh;
let waited;
let rested;
let exempt;

const failure = (promise) => promise.then(() => null).catch((error) => error);

async function arrived(label, minutesAgo, doctorId = CONSULTANTS.banshali.id) {
  const { visit } = await extraVisit(ids, label, { healthray: false, doctorId });
  await query(`UPDATE giniflow_visits SET current_status = 'checked_in' WHERE id = $1`, [visit]);
  await query(
    `INSERT INTO giniflow_visit_events (visit_id, status, actor_role, occurred_at)
     VALUES ($1, 'checked_in', 'reception', NOW() - make_interval(mins => $2))`,
    [visit, minutesAgo],
  );
  return visit;
}

async function calledAgo(visit, minutesAgo) {
  await query(`UPDATE giniflow_visits SET current_status = 'with_vitals' WHERE id = $1`, [visit]);
  await query(
    `INSERT INTO giniflow_visit_events (visit_id, status, actor_role, occurred_at)
     VALUES ($1, 'with_vitals', 'vitals', NOW() - make_interval(mins => $2))`,
    [visit, minutesAgo],
  );
}

const statusOf = async (visit) =>
  (await one(`SELECT current_status FROM giniflow_visits WHERE id = $1`, [visit])).current_status;

const queueOf = () => vitals.getVitalsQueue(ids.day, new Date(), db, {});
const rowOf = (queue, visit) =>
  [...queue.atStation, ...queue.waiting].find((r) => r.visitId === visit);

async function releaseHeldBy(actorId, except = []) {
  const held = await query(
    `SELECT v.id FROM giniflow_visits v
      WHERE v.visit_date = $1::date AND v.current_status = 'with_vitals' AND NOT (v.id = ANY($2))
        AND (SELECT e.actor_id FROM giniflow_visit_events e
              WHERE e.visit_id = v.id AND e.status = 'with_vitals'
              ORDER BY e.occurred_at DESC LIMIT 1) = $3`,
    [ids.day, except, actorId],
  );
  for (const row of held.rows) await vitals.releaseVitals(row.id, actorId, db);
}

test.describe.serial("G67 vitals rest starts when the patient is called", () => {
  test.skip(VITALS_REST_MINUTES === 0, "The rest before vitals is switched off");
  test.beforeAll(async () => {
    ids = await setUp(tag);
    fresh = await arrived("Fresh", 2);
    waited = await arrived("Waited", 25);
    rested = await arrived("Rested", 40);
    await calledAgo(rested, 20);
  });

  test.afterAll(async () => {
    for (const visit of [fresh, waited, rested]) {
      await vitals.releaseVitals(visit, USERS.admin.id, db).catch(() => null);
    }
    await expect
      .poll(async () => {
        await query(
          `DELETE FROM vitals WHERE patient_id IN
             (SELECT patient_id FROM giniflow_visits WHERE id = ANY($1))`,
          [[fresh, waited, rested, exempt].filter(Boolean)],
        );
        return (
          await one(
            `SELECT COUNT(*)::int AS n FROM vitals WHERE patient_id IN
               (SELECT patient_id FROM giniflow_visits WHERE id = ANY($1))`,
            [[fresh, waited, rested, exempt].filter(Boolean)],
          )
        ).n;
      })
      .toBe(0);
    await query(`UPDATE doctors SET vitals_rest = true WHERE id = $1`, [CONSULTANTS.rahul.id]);
    await tearDown(ids);
  });

  test("1. waiting patients never rest, however recently they arrived", async () => {
    const queue = await queueOf();
    for (const visit of [fresh, waited]) {
      const row = queue.waiting.find((r) => r.visitId === visit);
      expect(row.restUntil).toBeNull();
    }
    expect(queue.waiting.find((r) => r.visitId === fresh).waitMinutes).toBe(2);
    expect((await vitals.getVitalsPatient(fresh, db)).restUntil).toBeNull();
  });

  test("2. a patient who arrived 2 minutes ago can be called, and the rest starts then", async () => {
    await releaseHeldBy(USERS.admin.id);
    const before = Date.now();
    await vitals.startVitals(fresh, USERS.admin.id, db);
    expect(await statusOf(fresh)).toBe("with_vitals");
    const row = rowOf(await queueOf(), fresh);
    const restEnds = new Date(row.restUntil).getTime();
    expect(restEnds).toBeGreaterThanOrEqual(before + VITALS_REST_MINUTES * 60000 - 5000);
    expect(restEnds).toBeLessThanOrEqual(Date.now() + VITALS_REST_MINUTES * 60000 + 5000);
    expect((await vitals.getVitalsPatient(fresh, db)).restUntil).toBe(row.restUntil);
  });

  test("3. vitals cannot be saved while the called patient rests", async () => {
    const saved = await failure(vitals.saveVitals(fresh, { weight: 70 }, db));
    expect(saved?.status).toBe(409);
    expect(saved?.message).toMatch(
      new RegExp(`resting for ${VITALS_REST_MINUTES} minutes at the station`),
    );
    expect(new Date(saved.restUntil).getTime()).toBeGreaterThan(Date.now());
    expect(await statusOf(fresh)).toBe("with_vitals");
  });

  test("4. while one patient rests, the same nurse can call the next", async () => {
    await vitals.startVitals(waited, USERS.admin.id, db);
    expect(await statusOf(waited)).toBe("with_vitals");
    await vitals.releaseVitals(waited, USERS.admin.id, db);
    expect(await statusOf(waited)).toBe("vitals_pending");
  });

  test("5. a patient called 20 minutes ago has rested and can be saved; timers read as before", async () => {
    const queue = await queueOf();
    const row = rowOf(queue, rested);
    expect(row.restUntil).toBeNull();
    const day = await board.getDayBoard(ids.day, await board.getSlaConfig(db), new Date(), db);
    expect(day.cards.find((c) => c.id === rested).statusMinutes).toBe(20);
    const saved = await vitals.saveVitals(rested, { weight: 70 }, db);
    expect(saved.movedTo).toBeTruthy();
  });

  test("6. the station shows the resting patient with a countdown and a way back to the queue", async ({
    page,
  }) => {
    await loginAs(page, "admin");
    await gotoReady(page, "/giniflow/station/vitals", () =>
      page.getByRole("heading", { name: /Waiting/ }),
    );
    await page.getByLabel("Search today's patients").fill(tag);
    const row = page.getByRole("button", { name: new RegExp(`Fresh ${tag}.*resting before BP`) });
    await expect(row).toBeEnabled();
    await expect(row).toContainText(/Rest \d{1,2}:\d\d left/);
    await row.click();
    await expect(page.getByText(/minutes of rest at the station/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Done →" })).toHaveCount(0);
    await page.getByRole("button", { name: "← Back to queue" }).click();
    await expect.poll(() => statusOf(fresh)).toBe("vitals_pending");
    expect(rowOf(await queueOf(), fresh).restUntil).toBeNull();
  });

  test("7. a doctor switched off in Settings has patients who skip the rest", async ({ page }) => {
    await loginAs(page, "admin");
    await gotoReady(page, "/staff-management", () =>
      page.getByRole("heading", { name: "Staff Management" }),
    );
    await page
      .getByRole("list", { name: "Staff list" })
      .getByRole("button")
      .filter({ hasText: CONSULTANTS.rahul.name })
      .click();
    await page.getByRole("tab", { name: "Settings" }).click();
    const toggle = page.getByLabel(`${VITALS_REST_MINUTES}-min rest before vitals`);
    await expect(toggle).toBeChecked();
    await toggle.click();
    await expect(toggle).not.toBeChecked();
    await expect
      .poll(
        async () =>
          (await one(`SELECT vitals_rest FROM doctors WHERE id = $1`, [CONSULTANTS.rahul.id]))
            .vitals_rest,
      )
      .toBe(false);

    exempt = await arrived("NoRest", 1, CONSULTANTS.rahul.id);
    await releaseHeldBy(USERS.admin.id);
    await vitals.startVitals(exempt, USERS.admin.id, db);
    expect(rowOf(await queueOf(), exempt).restUntil).toBeNull();
    expect((await vitals.getVitalsPatient(exempt, db)).restUntil).toBeNull();
    const saved = await vitals.saveVitals(exempt, { weight: 70 }, db);
    expect(saved.movedTo).toBeTruthy();
  });
});
