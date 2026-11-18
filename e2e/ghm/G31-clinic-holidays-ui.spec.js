import { test, expect } from "@playwright/test";
import { one, query } from "../helpers/db.mjs";
import { loginAs } from "../helpers/auth.mjs";
import { gotoReady } from "../helpers/browser.mjs";
import { addDays, istDate } from "../../server/crm/istPeriods.js";
import { isSunday } from "../../server/crm/daysOff.js";

const sundayAfter = (day) => {
  let d = day;
  while (!isSunday(d)) d = addDays(d, 1);
  return d;
};
const SUNDAY = sundayAfter(addDays(istDate(), 50));
const SATURDAY = addDays(SUNDAY, -1);
const MONDAY = addDays(SUNDAY, 1);

const cleanUp = () =>
  query(`DELETE FROM clinic_holidays WHERE holiday_date BETWEEN $1::date AND $2::date`, [
    SATURDAY,
    MONDAY,
  ]);

test.describe.serial("G31 Slot settings: clinic holidays panel", () => {
  test.beforeAll(cleanUp);
  test.afterAll(cleanUp);

  test.beforeEach(async ({ page }) => {
    await loginAs(page, "admin");
    await gotoReady(page, "/settings/slots", () =>
      page.getByRole("heading", { name: "Slot settings" }),
    );
    await page.getByRole("button", { name: "Clinic holidays" }).click();
    await expect(page.getByRole("heading", { name: "Clinic holidays" })).toBeVisible();
  });

  test("1. checks the fields, confirms, and adds a range without the Sunday", async ({ page }) => {
    await page.getByRole("button", { name: "+ Add holiday" }).click();
    const form = page.getByRole("form", { name: "Add clinic holiday" });
    await form.getByRole("button", { name: "Add holiday" }).click();
    await expect(page.getByText("Enter the holiday name, like Diwali.")).toBeVisible();
    await expect(page.getByText("Choose the first day.")).toBeVisible();

    await page.getByLabel("Holiday name").fill("G31 Festival");
    await page.getByLabel("First day").fill(SATURDAY);
    await page.getByLabel("Last day").fill(MONDAY);
    await expect(form.getByRole("status")).toHaveText("2 holidays · 1 Sunday skipped");
    await form.getByRole("button", { name: "Add holiday" }).click();

    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText("Close the clinic for G31 Festival?")).toBeVisible();
    await expect(dialog.getByText(/Patients already booked are not moved/)).toBeVisible();
    await dialog.getByRole("button", { name: "Add holiday" }).click();

    await expect(page.getByText("G31 Festival added for 2 days.")).toBeVisible();
    await expect(page.getByRole("cell", { name: "G31 Festival" })).toHaveCount(2);
    const saved = await one(
      `SELECT count(*)::int AS n FROM clinic_holidays
        WHERE holiday_date BETWEEN $1::date AND $2::date AND remarks = 'G31 Festival'`,
      [SATURDAY, MONDAY],
    );
    expect(saved.n).toBe(2);
  });

  test("2. removes one day after confirming", async ({ page }) => {
    const row = page.getByRole("row").filter({ hasText: "G31 Festival" }).first();
    await row.getByRole("button", { name: "Remove" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText(/Remove G31 Festival on/)).toBeVisible();
    await dialog.getByRole("button", { name: "Remove holiday" }).click();
    await expect(page.getByRole("cell", { name: "G31 Festival" })).toHaveCount(1);
    const left = await one(
      `SELECT holiday_date::text AS day FROM clinic_holidays WHERE remarks = 'G31 Festival'`,
    );
    expect(left.day).toBe(MONDAY);
  });

  test("3. the panel fits at phone width", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
  });
});
