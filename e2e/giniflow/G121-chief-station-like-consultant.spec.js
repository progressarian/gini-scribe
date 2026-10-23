import { test, expect } from "@playwright/test";
import { one, query } from "../helpers/db.mjs";
import { apiAs, loginAs } from "../helpers/auth.mjs";
import { gotoReady } from "../helpers/browser.mjs";
import { assertTestDatabase } from "../setup/guard.mjs";
import { CONSULTANTS } from "../fixtures/data.mjs";
import { extraVisit, newTag, setUp, tearDown } from "../billing/phase4/p4-bills-fixture.mjs";
import { db } from "../billing/phase4b/p4b-refunds.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const suggestions = await import("../../server/services/giniflow/planSuggestions.js");
const { closeWithoutDoctor } = await import("../../server/services/giniflow/moStation.js");

const tag = newTag();
const CHIEF = CONSULTANTS.rahul;
let ids;
const made = [];

const addDays = (ymd, days) => {
  const t = new Date(`${ymd}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + days);
  return t.toISOString().slice(0, 10);
};

async function atChiefDesk(label) {
  const visit = await extraVisit(ids, label, { healthray: false });
  made.push(visit);
  await query(
    `UPDATE giniflow_visits SET current_status = 'with_sd', assigned_sd_id = $2 WHERE id = $1`,
    [visit.visit, CHIEF.id],
  );
  await query(
    `INSERT INTO giniflow_visit_events (visit_id, status, actor_role, actor_id, occurred_at)
     VALUES ($1, 'with_sd', 'mo_sd', $2, NOW() - interval '10 minutes')`,
    [visit.visit, CHIEF.id],
  );
  await query(
    `INSERT INTO giniflow_sd_notes (visit_id, plan) VALUES ($1, 'Stable, continue')
     ON CONFLICT (visit_id) DO UPDATE SET plan = EXCLUDED.plan`,
    [visit.visit],
  );
  return visit;
}

test.describe.serial("G121 the Chief station works like the consultant's", () => {
  test.beforeAll(async () => {
    ids = await setUp(tag);
    ids.echo = (
      await one(
        `INSERT INTO service_items (code, name, subgroup_id, base_price, kind, price_per_patient)
         VALUES ($1, $2, $3, 0, 'procedure', TRUE) RETURNING id`,
        [`G121-ECHO-${tag}`, `G121 echo ${tag}`, ids.subgroup],
      )
    ).id;
  });

  test.afterAll(async () => {
    for (const visit of made) {
      await query(`DELETE FROM giniflow_care_plans WHERE visit_id = $1`, [visit.visit]);
      await query(`DELETE FROM giniflow_plan_suggestions WHERE visit_id = $1`, [visit.visit]);
      await query(`DELETE FROM documents WHERE patient_id = $1`, [visit.patient]).catch(() => {});
      await query(`DELETE FROM medications WHERE patient_id = $1`, [visit.patient]);
      await query(`DELETE FROM consultations WHERE patient_id = $1`, [visit.patient]);
    }
    await tearDown(ids);
  });

  test("1. the Chief cannot close without a next visit; once set it goes on the prescription", async () => {
    const visit = await atChiefDesk("ChiefClose");
    await expect(closeWithoutDoctor(visit.visit, CHIEF.id, db)).rejects.toMatchObject({
      status: 409,
      message: "Set the next visit before closing this patient",
    });

    const toSunday = (7 - new Date(`${ids.day}T00:00:00Z`).getUTCDay()) % 7 || 7;
    const sunday = addDays(ids.day, toSunday);
    await suggestions.saveSuggestion(
      visit.visit,
      "next_visit",
      { date: sunday, interval: `${toSunday} days` },
      CHIEF.id,
      db,
    );
    const closed = await closeWithoutDoctor(visit.visit, CHIEF.id, db);
    expect(closed).toMatchObject({ status: "doctor_done", skippedDoctor: true });
    expect(
      await one(
        `SELECT next_visit_date::text AS date FROM giniflow_care_plans WHERE visit_id = $1`,
        [visit.visit],
      ),
    ).toEqual({ date: addDays(sunday, 1) });
    expect(
      await one(
        `SELECT status, decided_by FROM giniflow_plan_suggestions
          WHERE visit_id = $1 AND field = 'next_visit'`,
        [visit.visit],
      ),
    ).toEqual({ status: "accepted", decided_by: CHIEF.id });
  });

  test("2. a procedure ordered at the Chief station waits unpriced for reception", async () => {
    const visit = await atChiefDesk("ChiefProc");
    const chief = await apiAs("rahul");
    const res = await chief.post(`/api/giniflow/stations/mo/${visit.visit}/services`, {
      data: { item_id: ids.echo },
    });
    expect(res.status(), await res.text()).toBe(200);
    const { services } = await res.json();
    expect(services[0]).toMatchObject({ name: `G121 echo ${tag}`, agreed_rate: null });
  });

  test("3. on screen: no prices on tests, and Close waits for the next visit", async ({ page }) => {
    const visit = await atChiefDesk("ChiefScreen");
    await loginAs(page, "rahul");
    const name = page.getByText(`P4 ChiefScreen ${tag}`).first();
    await gotoReady(page, "/giniflow/station/mo", () => name);
    await name.click();

    const tests = page.locator(".dp-sec").filter({ hasText: "🔬 Tests to order" });
    await expect(tests.locator(".tst-chip").first()).toBeVisible();
    await expect(tests.locator(".tst-list")).not.toContainText("₹");

    const close = page.getByRole("button", { name: "✓ Close — no doctor needed" });
    await expect(close).toBeDisabled();
    await expect(page.getByText("Set the next visit before closing this patient")).toBeVisible();
    await expect(page.locator(".cp-next-box.is-missing")).toBeVisible();

    const picker = page.getByRole("group", { name: "Next visit after" });
    await picker.getByRole("combobox", { name: "Number" }).selectOption("1");
    await picker.getByRole("combobox", { name: "Days, weeks or months" }).selectOption("months");
    await expect(close).toBeEnabled({ timeout: 10000 });
    expect(
      (
        await one(
          `SELECT value->>'interval' AS interval FROM giniflow_plan_suggestions
            WHERE visit_id = $1 AND field = 'next_visit' AND status = 'proposed'`,
          [visit.visit],
        )
      ).interval,
    ).toBe("1 month");
  });

  test("4. a visit closed without a Scribe prescription offers no Edit", async () => {
    const visit = await atChiefDesk("ChiefNoRx");
    await query(`UPDATE giniflow_visits SET current_status = 'doctor_done' WHERE id = $1`, [
      visit.visit,
    ]);
    const chief = await apiAs("rahul");
    const { edit } = await (await chief.get(`/api/giniflow/stations/mo/${visit.visit}`)).json();
    expect(edit).toMatchObject({ finalized: true, scribeRx: false, canEdit: false });
  });

  test("5. opening a patient at the Chief station fills the draft with their current medicines", async () => {
    const visit = await extraVisit(ids, "ChiefSeed", { healthray: false });
    made.push(visit);
    await query(`UPDATE giniflow_visits SET current_status = 'vitals_done' WHERE id = $1`, [
      visit.visit,
    ]);
    await query(
      `INSERT INTO medications (patient_id, name, dose, frequency, is_active)
       VALUES ($1, 'G121 Metformin', '500 mg', 'BD', true), ($1, 'G121 Telma', '40 mg', 'OD', true)`,
      [visit.patient],
    );
    const chief = await apiAs("rahul");
    const res = await chief.post(`/api/giniflow/stations/mo/${visit.visit}/start`);
    expect(res.status(), await res.text()).toBe(200);
    expect((await res.json()).seeded).toBe(2);
    const draft = await query(
      `SELECT medicine_name, change_type, approval_status FROM giniflow_rx_items
        WHERE visit_id = $1 ORDER BY medicine_name`,
      [visit.visit],
    );
    expect(draft.rows).toEqual([
      { medicine_name: "G121 Metformin", change_type: "continued", approval_status: null },
      { medicine_name: "G121 Telma", change_type: "continued", approval_status: null },
    ]);
    const again = await chief.post(`/api/giniflow/stations/mo/${visit.visit}/start`);
    expect((await again.json()).seeded).toBe(0);
    await query(`DELETE FROM giniflow_rx_items WHERE visit_id = $1`, [visit.visit]);
  });
});
