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
const SUMMARY = `Your sugar control is improving ${tag}.`;

const addDays = (ymd, days) => {
  const t = new Date(`${ymd}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + days);
  return t.toISOString().slice(0, 10);
};

const summaryPanel = (page) => page.getByRole("region", { name: "📝 Visit summary" });
const tablePanel = (page) => page.getByRole("region", { name: "📊 Vitals & biomarkers table" });

test.describe.serial("G96 the doctor station shows the visit summary and edits the table", () => {
  test.beforeAll(async () => {
    ids = await setUp(tag);
    made = await extraVisit(ids, "Rxui", { healthray: false });
    await query(`UPDATE giniflow_visits SET current_status = 'with_doctor' WHERE id = $1`, [
      made.visit,
    ]);
    await query(`UPDATE appointments SET post_visit_summary = $2 WHERE id = $1`, [
      made.appointment,
      JSON.stringify(SUMMARY),
    ]);
    await query(
      `INSERT INTO appointments (patient_id, patient_name, file_no, appointment_date, status, visit_type, doctor_name)
       SELECT id, name, file_no, $2::date, 'completed', 'Follow-Up', 'Dr. G93' FROM patients WHERE id = $1`,
      [made.patient, addDays(ids.day, -30)],
    );
    await query(
      `INSERT INTO vitals (patient_id, recorded_at, weight, height)
       VALUES ($1, ($2::date + time '10:00') AT TIME ZONE 'Asia/Kolkata', 90, 170),
              ($1, ($3::date + time '10:00') AT TIME ZONE 'Asia/Kolkata', 88, NULL)`,
      [made.patient, addDays(ids.day, -30), ids.day],
    );
  });

  test.afterAll(async () => {
    if (made) {
      for (const t of ["rx_parameter_overrides", "vitals"]) {
        await query(`DELETE FROM ${t} WHERE patient_id = $1`, [made.patient]);
      }
      await query(`DELETE FROM appointments WHERE patient_id = $1 AND doctor_name = 'Dr. G93'`, [
        made.patient,
      ]);
    }
    await tearDown(ids);
  });

  test("1. the visit summary shows on the station, not on the print", async ({ page }) => {
    await loginAs(page, "admin");
    await gotoReady(page, `/giniflow/station/doctor/${made.visit}`, () => summaryPanel(page));
    await expect(summaryPanel(page)).toContainText(SUMMARY);
    await expect(summaryPanel(page)).toContainText("not printed");
  });

  test("2. staff edit today, add a parameter and remove one, and it is saved", async ({ page }) => {
    await loginAs(page, "admin");
    await gotoReady(page, `/giniflow/station/doctor/${made.visit}`, () => tablePanel(page));
    const panel = tablePanel(page);
    await expect(panel.getByRole("textbox", { name: "Today's Weight" })).toHaveValue("88");
    await panel.getByRole("textbox", { name: "Today's Weight" }).fill("87.5");
    await expect(panel.getByRole("textbox", { name: "Today's HOMA-B" })).toHaveCount(0);
    await expect(panel.getByRole("button", { name: "Remove Height" })).toHaveCount(0);
    await panel.getByRole("button", { name: /Show all \d+ parameters/ }).click();
    await expect(panel.getByRole("textbox", { name: "Today's HOMA-B" })).toBeVisible();
    await panel.getByRole("button", { name: /Show only filled rows/ }).click();
    await expect(panel.getByRole("textbox", { name: "Today's HOMA-B" })).toHaveCount(0);
    await panel.getByRole("button", { name: "Edit rows" }).click();
    await panel.getByRole("button", { name: "Remove Height" }).click();
    await panel.getByRole("textbox", { name: "New parameter name" }).fill("Grip strength");
    await panel.getByRole("textbox", { name: "New parameter unit" }).fill("kg");
    await panel.getByRole("textbox", { name: "New parameter value" }).fill("24");
    await panel.getByRole("button", { name: "Add new" }).click();
    await panel.getByRole("button", { name: "Save table" }).click();
    await expect(panel.getByRole("button", { name: "Saved" })).toBeVisible();

    const api = await apiAs("admin");
    try {
      const table = await (
        await api.get(`/api/giniflow/stations/doctor/${made.visit}/rx-parameters`)
      ).json();
      const weight = table.rows.find((r) => r.key === "weight");
      expect(weight.values.at(-1)).toBe("87.5");
      expect(table.rows.find((r) => r.label === "Grip strength")?.values.at(-1)).toBe("24");
      expect(table.rows.find((r) => r.key === "height")).toBeUndefined();
    } finally {
      await api.dispose();
    }

    await page.reload();
    await expect(tablePanel(page).getByRole("textbox", { name: "Today's Weight" })).toHaveValue(
      "87.5",
    );
    await expect(tablePanel(page)).toContainText("Grip strength");
  });

  test("3. a finalized consult shows the table locked", async ({ page }) => {
    await query(`UPDATE giniflow_visits SET current_status = 'doctor_done' WHERE id = $1`, [
      made.visit,
    ]);
    try {
      await loginAs(page, "admin");
      await gotoReady(page, `/giniflow/station/doctor/${made.visit}`, () => tablePanel(page));
      await expect(tablePanel(page)).toContainText("finalized");
      await expect(
        tablePanel(page).getByRole("textbox", { name: "Today's Weight" }),
      ).toBeDisabled();
    } finally {
      await query(`UPDATE giniflow_visits SET current_status = 'with_doctor' WHERE id = $1`, [
        made.visit,
      ]);
    }
  });
});
