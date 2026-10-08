import { test, expect } from "@playwright/test";
import { query } from "../helpers/db.mjs";
import { CONSULTANTS } from "../fixtures/data.mjs";
import { loginAs } from "../helpers/auth.mjs";
import { gotoReady } from "../helpers/browser.mjs";

const SHOTS = process.env.DM_SHOTS;
const doctor = CONSULTANTS.rahul;

const istDay = (offset) => {
  const d = new Date(Date.now() + 5.5 * 3600_000);
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
};

const clearTimeOff = () =>
  query(`DELETE FROM doctor_unavailability WHERE doctor_id = $1`, [doctor.id]);

test.describe.serial("G71 Staff Management: list, tabs and one time-off form", () => {
  test.beforeAll(clearTimeOff);
  test.afterAll(clearTimeOff);

  test.beforeEach(async ({ page }) => {
    await loginAs(page, "admin");
    await gotoReady(page, "/staff-management", () =>
      page.getByRole("heading", { name: "Staff Management" }),
    );
    await page
      .getByRole("list", { name: "Staff list" })
      .getByRole("button")
      .filter({ hasText: doctor.name })
      .click();
    await expect(page.getByRole("heading", { name: doctor.name })).toBeVisible();
  });

  test("1. search narrows the doctor list", async ({ page }) => {
    const list = page.getByRole("list", { name: "Staff list" });
    await page.getByLabel("Search staff").fill("E2E Rahul");
    await expect(list.getByRole("button")).toHaveCount(1);
    await page.getByLabel("Search staff").fill("no such doctor zz");
    await expect(list.getByText("No one matches this search.")).toBeVisible();
    if (SHOTS) await page.getByLabel("Search staff").fill("");
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/1-schedule.png`, fullPage: true });
  });

  test("2. the day preview steps a day at a time", async ({ page }) => {
    const date = page.getByLabel("Preview date");
    const before = await date.inputValue();
    await page.getByRole("button", { name: "Next day" }).click();
    await expect(date).not.toHaveValue(before);
    await page.getByRole("button", { name: "Previous day" }).click();
    await expect(date).toHaveValue(before);
  });

  test("3. Add time off opens one form; a holiday lands in the list and can be cancelled", async ({
    page,
  }) => {
    await page.locator(".docmgmt-head").getByRole("button", { name: "+ Add time off" }).click();
    await expect(page.getByRole("tab", { name: "Time off" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    const form = page.getByRole("form", { name: "Add time off" });
    await form.getByLabel("Type").selectOption("holiday");
    await form.getByLabel("From", { exact: true }).fill(istDay(40));
    await form.getByLabel("To", { exact: true }).fill(istDay(41));
    await form.getByLabel("Reason").fill("G71 holiday");
    await form.getByRole("button", { name: "Add holiday" }).click();
    await expect(form).toBeHidden();

    const row = page.getByRole("row").filter({ hasText: "G71 holiday" });
    await expect(row).toContainText("Holiday");
    await expect(row).toContainText("Whole day");
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/2-timeoff.png`, fullPage: true });

    await row.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByRole("row").filter({ hasText: "G71 holiday" })).toHaveCount(0);
  });

  test("4. a break asks for one date and the slots, not a range", async ({ page }) => {
    await page.getByRole("tab", { name: "Time off" }).click();
    await page.getByRole("button", { name: "+ Add time off" }).last().click();
    const form = page.getByRole("form", { name: "Add time off" });
    await form.getByLabel("Type").selectOption("break");
    await expect(form.getByLabel("Date", { exact: true })).toBeVisible();
    await expect(form.getByLabel("To", { exact: true })).toHaveCount(0);
    await expect(form.getByRole("button", { name: "Add break" })).toBeVisible();
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/3-break.png`, fullPage: true });
  });

  test("5. settings hold the toggles and the letterhead line", async ({ page }) => {
    await page.getByRole("tab", { name: "Settings" }).click();
    await expect(page.getByLabel("Chief consultant")).toBeVisible();
    await expect(page.getByLabel("Qualification on letterhead")).toBeVisible();
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/4-settings.png`, fullPage: true });
  });
});
