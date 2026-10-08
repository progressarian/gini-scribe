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
let resting;
let rested;

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

const queueRow = async (visit) => {
  const queue = await vitals.getVitalsQueue(ids.day, new Date(), db, {});
  return { queue, row: queue.waiting.find((r) => r.visitId === visit) };
};

test.describe.serial("G67 vitals waits the rest time after arrival", () => {
  test.skip(VITALS_REST_MINUTES === 0, "The rest before vitals is switched off");
  test.beforeAll(async () => {
    ids = await setUp(tag);
    resting = await arrived("Resting", 2);
    rested = await arrived("Rested", 20);
  });

  test.afterAll(async () => {
    await vitals.releaseVitals(rested, USERS.admin.id, db).catch(() => null);
    await expect
      .poll(async () => {
        await query(
          `DELETE FROM vitals WHERE patient_id IN
             (SELECT patient_id FROM giniflow_visits WHERE id = ANY($1))`,
          [[resting, rested]],
        );
        return (
          await one(
            `SELECT COUNT(*)::int AS n FROM vitals WHERE patient_id IN
               (SELECT patient_id FROM giniflow_visits WHERE id = ANY($1))`,
            [[resting, rested]],
          )
        ).n;
      })
      .toBe(0);
    await query(`UPDATE doctors SET vitals_rest = true WHERE id = $1`, [CONSULTANTS.rahul.id]);
    await tearDown(ids);
  });

  test("1. a patient who arrived 2 minutes ago cannot be called or saved", async () => {
    const started = await failure(vitals.startVitals(resting, USERS.admin.id, db));
    expect(started?.status).toBe(409);
    expect(started?.message).toMatch(new RegExp(`resting for ${VITALS_REST_MINUTES} minutes`));
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
    await expect(row).toContainText(/Rest \d{1,2}:\d\d left/);
    await expect(page.getByRole("button", { name: new RegExp(`Rested ${tag}`) })).toBeEnabled();
  });

  test("5. vitals cannot be saved until the patient is called to the station", async ({ page }) => {
    const held = await query(
      `SELECT v.id FROM giniflow_visits v
        WHERE v.visit_date = $1::date AND v.current_status = 'with_vitals' AND v.id <> $2
          AND (SELECT e.actor_id FROM giniflow_visit_events e
                WHERE e.visit_id = v.id AND e.status = 'with_vitals'
                ORDER BY e.occurred_at DESC LIMIT 1) = $3`,
      [ids.day, rested, USERS.admin.id],
    );
    for (const row of held.rows) await vitals.releaseVitals(row.id, USERS.admin.id, db);
    const refused = await failure(vitals.saveVitals(rested, { weight: 70 }, db));
    expect(refused?.status).toBe(409);
    expect(refused?.message).toMatch(/Call this patient to the station/);

    await loginAs(page, "admin");
    await gotoReady(page, "/giniflow/station/vitals", () =>
      page.getByRole("heading", { name: /Waiting/ }),
    );
    await page.getByLabel("Search today's patients").fill(tag);
    await page.getByRole("button", { name: new RegExp(`Rested ${tag}`) }).click();
    await expect(page.getByRole("button", { name: "Done →" })).toBeVisible();
    await vitals.releaseVitals(rested, USERS.admin.id, db);
    await page.reload();
    await page.getByLabel("Search today's patients").fill(tag);
    await expect(page.getByRole("button", { name: "Call to station →" })).toBeVisible();
    await expect(page.getByText("Call the patient to the station first")).toBeVisible();
    await page.getByRole("button", { name: "Call to station →" }).click();
    await expect(page.getByRole("button", { name: "Done →" })).toBeVisible();

    const saved = await vitals.saveVitals(rested, { weight: 70 }, db);
    expect(saved.movedTo).toBeTruthy();
  });

  test("6. a doctor switched off in Settings has patients who skip the rest", async ({ page }) => {
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

    const exempt = await arrived("NoRest", 1, CONSULTANTS.rahul.id);
    const { row } = await queueRow(exempt);
    expect(row.restUntil).toBeNull();
    expect((await queueRow(resting)).row.restUntil).toBeTruthy();
    expect((await vitals.getVitalsPatient(exempt, db)).restUntil).toBeNull();
    await vitals.startVitals(exempt, USERS.admin.id, db);
    expect(
      (await one(`SELECT current_status FROM giniflow_visits WHERE id = $1`, [exempt]))
        .current_status,
    ).toBe("with_vitals");
    await vitals.releaseVitals(exempt, USERS.admin.id, db);
  });
});
