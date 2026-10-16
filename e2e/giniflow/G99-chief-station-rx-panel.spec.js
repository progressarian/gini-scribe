import { test, expect } from "@playwright/test";
import { query } from "../helpers/db.mjs";
import { apiAs, loginAs } from "../helpers/auth.mjs";
import { gotoReady } from "../helpers/browser.mjs";
import { assertTestDatabase } from "../setup/guard.mjs";
import { extraVisit, newTag, setUp, tearDown } from "../billing/phase4/p4-bills-fixture.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);

const tag = newTag();
let ids;
let made;
const SUMMARY = `Chief summary ${tag}.`;

const setStatus = (status) =>
  query(`UPDATE giniflow_visits SET current_status = $2 WHERE id = $1`, [made.visit, status]);
const mo = (path) => `/api/giniflow/stations/mo/${made.visit}/${path}`;
const doctor = (path) => `/api/giniflow/stations/doctor/${made.visit}/${path}`;

test.describe
  .serial("G99 the Chief Endocrinologist station has the visit summary and table", () => {
  test.beforeAll(async () => {
    ids = await setUp(tag);
    made = await extraVisit(ids, "ChiefRx", { healthray: false });
    await query(`UPDATE appointments SET post_visit_summary = $2 WHERE id = $1`, [
      made.appointment,
      JSON.stringify(SUMMARY),
    ]);
    await query(
      `INSERT INTO vitals (patient_id, recorded_at, weight)
       VALUES ($1, ($2::date + time '10:00') AT TIME ZONE 'Asia/Kolkata', 81)`,
      [made.patient, ids.day],
    );
  });

  test.afterAll(async () => {
    if (made) {
      for (const t of ["rx_parameter_overrides", "vitals"]) {
        await query(`DELETE FROM ${t} WHERE patient_id = $1`, [made.patient]);
      }
    }
    await tearDown(ids);
  });

  test("1. while the patient is with the Chief, the Chief reads and saves; the doctor sees it", async () => {
    await setStatus("with_sd");
    const api = await apiAs("admin");
    try {
      const table = await (await api.get(mo("rx-parameters"))).json();
      expect(table.locked).toBe(false);
      expect(table.rows.find((r) => r.key === "weight").values.at(-1)).toBe("81");
      const saved = await api.put(mo("rx-parameters"), {
        data: { rows: [{ key: "weight", value: "80.5" }] },
      });
      expect(saved.status(), await saved.text()).toBe(200);
      const fromDoctor = await (await api.get(doctor("rx-parameters"))).json();
      expect(fromDoctor.rows.find((r) => r.key === "weight").values.at(-1)).toBe("80.5");
      const summary = await (await api.get(mo("visit-summary"))).json();
      expect(summary).toMatchObject({ text: SUMMARY, canGenerate: true });
    } finally {
      await api.dispose();
    }
  });

  test("2. once the patient moves on, the Chief station is read-only", async () => {
    await setStatus("with_doctor");
    const api = await apiAs("admin");
    try {
      const table = await (await api.get(mo("rx-parameters"))).json();
      expect(table).toMatchObject({ locked: true, lockedReason: "not_with_chief" });
      const refused = await api.put(mo("rx-parameters"), {
        data: { rows: [{ key: "weight", value: "79" }] },
      });
      expect(refused.status()).toBe(409);
      expect((await refused.json()).error).toMatch(/no longer with the Chief/);
      expect((await (await api.get(mo("visit-summary"))).json()).canGenerate).toBe(false);
      expect((await api.post(mo("visit-summary"))).status()).toBe(409);
      const doctorTable = await (await api.get(doctor("rx-parameters"))).json();
      expect(doctorTable.locked).toBe(false);
    } finally {
      await api.dispose();
    }
  });

  test("3. roles without the Chief station are refused", async () => {
    for (const role of ["reception", "lab"]) {
      const api = await apiAs(role);
      try {
        expect((await api.get(mo("rx-parameters"))).status()).toBe(403);
        expect((await api.put(mo("rx-parameters"), { data: { rows: [] } })).status()).toBe(403);
        expect((await api.get(mo("visit-summary"))).status()).toBe(403);
      } finally {
        await api.dispose();
      }
    }
  });

  test("4. the Chief station shows both sections and saves the table", async ({ page }) => {
    await setStatus("vitals_done");
    await query(
      `INSERT INTO giniflow_visit_events (visit_id, status, actor_role, occurred_at)
       VALUES ($1, 'checked_in', 'reception', NOW() - interval '20 minutes'),
              ($1, 'vitals_done', 'vitals', NOW() - interval '5 minutes')`,
      [made.visit],
    );
    await loginAs(page, "admin");
    await gotoReady(page, "/giniflow/station/mo", () =>
      page.getByText(`P4 ChiefRx ${tag}`).first(),
    );
    await page.getByText(`P4 ChiefRx ${tag}`).first().click();
    await expect(page.getByRole("region", { name: "📝 Visit summary" })).toContainText(SUMMARY);
    const panel = page.getByRole("region", { name: "📊 Vitals & biomarkers table" });
    const weight = panel.getByRole("textbox", { name: "Today's Weight" });
    await expect(weight).toBeEnabled();
    await weight.fill("80");
    await panel.getByRole("button", { name: "Save table" }).click();
    await expect(panel.getByRole("button", { name: "Saved" })).toBeVisible();
    const api = await apiAs("admin");
    try {
      const table = await (await api.get(doctor("rx-parameters"))).json();
      expect(table.rows.find((r) => r.key === "weight").values.at(-1)).toBe("80");
    } finally {
      await api.dispose();
    }
  });
});
