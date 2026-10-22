import { test, expect } from "@playwright/test";
import { query } from "../helpers/db.mjs";
import { apiAs, loginAs } from "../helpers/auth.mjs";
import { gotoReady } from "../helpers/browser.mjs";
import { assertTestDatabase } from "../setup/guard.mjs";
import { extraVisit, newTag, setUp, tearDown } from "../billing/phase4/p4-bills-fixture.mjs";
import {
  followUpDueDate,
  followUpIntervalLabel,
  parseFollowUpInterval,
} from "../../shared/followUp.js";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);

const tag = newTag();
let ids;
let made;

const addDays = (ymd, days) => {
  const t = new Date(`${ymd}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + days);
  return t.toISOString().slice(0, 10);
};
const weekday = (ymd) => new Date(`${ymd}T00:00:00Z`).getUTCDay();
const savedPlan = async () =>
  (
    await query(
      `SELECT next_visit_date::text AS date, next_visit_interval AS interval
         FROM giniflow_care_plans WHERE visit_id = $1`,
      [made.visit],
    )
  ).rows[0];

test.describe.serial("G115 the next visit is picked as a number and days, weeks or months", () => {
  test.beforeAll(async () => {
    ids = await setUp(tag);
    made = await extraVisit(ids, "Nextvisit", { healthray: false });
    await query(`UPDATE giniflow_visits SET current_status = 'with_doctor' WHERE id = $1`, [
      made.visit,
    ]);
  });

  test.afterAll(async () => {
    if (made) {
      await query(`DELETE FROM giniflow_care_plans WHERE visit_id = $1`, [made.visit]);
      await query(`DELETE FROM documents WHERE patient_id = $1`, [made.patient]).catch(() => {});
      await query(`DELETE FROM medications WHERE patient_id = $1`, [made.patient]);
      await query(`DELETE FROM consultations WHERE patient_id = $1`, [made.patient]);
    }
    await tearDown(ids);
  });

  test("1. the date is counted from the visit day, and a Sunday becomes the Monday", () => {
    expect(followUpDueDate("2026-10-22", "3 days")).toBe("2026-10-26");
    expect(followUpDueDate("2026-10-22", "1 week")).toBe("2026-10-29");
    expect(followUpDueDate("2026-01-31", "1 month")).toBe("2026-02-28");
    expect(followUpIntervalLabel("1", "weeks")).toBe("1 week");
    expect(followUpIntervalLabel("12", "days")).toBe("12 days");
    expect(parseFollowUpInterval("~3 months")).toEqual({ count: "3", unit: "months" });
    expect(parseFollowUpInterval("1 year")).toEqual({ count: "12", unit: "months" });
  });

  test("2. a Sunday saved through the service is stored as the Monday", async () => {
    const { saveCarePlan } = await import("../../server/services/giniflow/doctorStation.js");
    const { db } = await import("../billing/phase4b/p4b-refunds.mjs");
    const sunday = addDays(ids.day, (7 - weekday(ids.day)) % 7 || 7);
    await saveCarePlan(made.visit, { nextVisitDate: sunday, nextVisitInterval: "" }, null, db);
    expect((await savedPlan()).date).toBe(addDays(sunday, 1));
  });

  test("3. the doctor picks a number and Days, sees the date with its day, and it is saved", async ({
    page,
  }) => {
    const toSunday = (7 - weekday(ids.day)) % 7 || 7;
    const monday = addDays(ids.day, toSunday + 1);
    await loginAs(page, "admin");
    const picker = page.getByRole("group", { name: "Next visit after" });
    await gotoReady(page, `/giniflow/station/doctor/${made.visit}`, () => picker);
    await picker.getByRole("combobox", { name: "Number" }).selectOption(String(toSunday));
    await picker.getByRole("combobox", { name: "Days, weeks or months" }).selectOption("days");
    const shown = page.locator(".cp-next-date");
    await expect(shown).toContainText("Monday");
    await expect(shown).toContainText("moved from Sunday");
    await expect
      .poll(savedPlan, { timeout: 10000 })
      .toEqual({ date: monday, interval: `${toSunday} day${toSunday === 1 ? "" : "s"}` });

    await picker.getByRole("combobox", { name: "Number" }).selectOption("4");
    await picker.getByRole("combobox", { name: "Days, weeks or months" }).selectOption("months");
    await expect(page.getByText("More than 3 months away")).toBeVisible();
    await picker.getByRole("combobox", { name: "Number" }).selectOption("3");
    await expect(page.getByText("More than 3 months away")).toHaveCount(0);

    await picker.getByRole("combobox", { name: "Number" }).selectOption("2");
    await picker.getByRole("combobox", { name: "Days, weeks or months" }).selectOption("weeks");
    await expect(shown).not.toContainText("moved from Sunday");
    await expect
      .poll(savedPlan, { timeout: 10000 })
      .toEqual({ date: followUpDueDate(ids.day, "2 weeks"), interval: "2 weeks" });

    await page.getByRole("button", { name: "Clear the next visit" }).click();
    await expect(shown).toHaveText("Not set");
    await expect(picker.getByRole("combobox", { name: "Number" })).toHaveValue("");
    await expect.poll(async () => (await savedPlan()).date, { timeout: 10000 }).toBeNull();
  });

  test("4. Finalize is refused until the next visit is set, on screen and on the server", async ({
    page,
  }) => {
    await query(
      `UPDATE giniflow_care_plans SET next_visit_date = NULL, next_visit_interval = NULL
        WHERE visit_id = $1`,
      [made.visit],
    );
    const doctor = await apiAs("banshali");
    const refused = await doctor.post(`/api/giniflow/stations/doctor/${made.visit}/finalize`, {
      data: { confirm: true },
    });
    expect(refused.status()).toBe(409);
    expect((await refused.json()).error).toMatch(/next visit/i);

    await loginAs(page, "banshali");
    const picker = page.getByRole("group", { name: "Next visit after" });
    await gotoReady(page, `/giniflow/station/doctor/${made.visit}`, () => picker);
    await expect(page.locator(".cp-next-box.is-missing")).toBeVisible();
    await expect(page.getByText("Required — set the next visit before you finalize")).toBeVisible();

    const finalize = page.getByRole("button", { name: "Finalize →" });
    await expect(finalize).toBeDisabled();
    await expect(page.getByText("Set the next visit before finalizing.")).toBeVisible();

    await picker.getByRole("combobox", { name: "Number" }).selectOption("1");
    await picker.getByRole("combobox", { name: "Days, weeks or months" }).selectOption("months");
    await expect(page.locator(".cp-next-box.is-missing")).toHaveCount(0);
    await expect.poll(async () => (await savedPlan()).interval, { timeout: 10000 }).toBe("1 month");

    await expect(finalize).toBeEnabled();
    await finalize.click();
    const dialog = page.getByRole("alertdialog", { name: "Confirm finalize" });
    await expect(
      dialog.getByText("Set the next visit in the Care plan before finalizing"),
    ).toHaveCount(0);
    const accepted = await doctor.post(`/api/giniflow/stations/doctor/${made.visit}/finalize`, {
      data: { confirm: true },
    });
    expect(accepted.status(), await accepted.text()).toBe(200);
  });
});
