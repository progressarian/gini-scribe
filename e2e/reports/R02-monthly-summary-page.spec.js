import { test, expect } from "@playwright/test";
import { loginAs } from "../helpers/auth.mjs";
import { gotoReady } from "../helpers/browser.mjs";
import { MONTH, clear, newTag, seed } from "./opd-fixture.mjs";

const tag = newTag();
let plan;

const heading = (page) => page.getByRole("heading", { name: "Monthly summary" });
const tile = (page, label) =>
  page.locator(".ms-tile").filter({ has: page.locator(".ms-tile__lbl", { hasText: label }) });
const visitsCard = (page) => page.getByRole("region", { name: "Visits", exact: true });
const pageUrl = (params) => `/reports/monthly?${new URLSearchParams({ month: MONTH, ...params })}`;

async function open(page, params = {}) {
  await loginAs(page, "admin");
  await gotoReady(page, pageUrl(params), () => heading(page));
}

test.describe.serial("R02 Monthly summary page", () => {
  test.beforeAll(async () => {
    plan = await seed(tag);
  });

  test.afterAll(async () => {
    await clear(tag);
  });

  test("1. the tiles show the month's numbers for the chosen doctor", async ({ page }) => {
    await open(page, { doctor: plan.docA });
    await expect(tile(page, "Visits attended").locator(".ms-tile__val")).toHaveText("4");
    await expect(tile(page, "Unique patients").locator(".ms-tile__val")).toHaveText("3");
    await expect(tile(page, "Tele").locator(".ms-tile__val")).toHaveText("1");
    await expect(tile(page, "Lab-only").locator(".ms-tile__val")).toHaveText("1");
    await expect(page.getByText("1 of the visits attended are not yet marked completed")).toBeVisible();
    await expect(page.getByLabel("Doctor", { exact: true })).toHaveValue(plan.docA);
  });

  test("1b. the repeat-patient tile lists those patients and toggles off", async ({ page }) => {
    await open(page, { doctor: plan.docA });
    const repeat = page.getByRole("button", { name: /Came more than once/ });
    await expect(repeat.locator(".ms-tile__val")).toHaveText("1");
    await expect(repeat).toContainText("1 extra visit");
    await expect(tile(page, "Unique patients")).toContainText("Each person counted once");
    await repeat.click();
    await expect(page).toHaveURL(/status=repeat/);
    await expect(repeat).toHaveAttribute("aria-pressed", "true");
    const rows = visitsCard(page).locator("tbody tr");
    await expect(rows).toHaveCount(2);
    await expect(rows.first()).toContainText("E2E General Adult");
    await repeat.click();
    await expect(page).not.toHaveURL(/status=repeat/);
  });

  test("2. the month arrows move the month, and next stops at this month", async ({ page }) => {
    await open(page, { doctor: plan.docA });
    await page.getByRole("button", { name: "Next month" }).click();
    await expect(page).toHaveURL(/month=2021-07/);
    await expect(page.getByLabel("Month", { exact: true })).toHaveValue("2021-07");
    await page.getByRole("button", { name: "Previous month" }).click();
    await expect(page).toHaveURL(/month=2021-06/);
    await gotoReady(page, "/reports/monthly", () => heading(page));
    await expect(page.getByRole("button", { name: "Next month" })).toBeDisabled();
  });

  test("3. search waits for typing to stop, then asks the server once", async ({ page }) => {
    await open(page, { doctor: plan.docA, type: "all", status: "all" });
    await expect(visitsCard(page).locator("tbody tr")).toHaveCount(9);
    const searches = [];
    page.on("request", (r) => {
      if (r.url().includes("/api/reports/opd/visits") && r.url().includes("q=")) searches.push(r.url());
    });
    await page.getByLabel("Search", { exact: true }).pressSequentially("E2E Senior", { delay: 40 });
    await expect(visitsCard(page).locator("tbody tr")).toHaveCount(2);
    await expect(page).toHaveURL(/q=E2E\+Senior/);
    expect(searches).toHaveLength(1);
  });

  test("4. pagination pages through the list on the server", async ({ page }) => {
    await open(page, { doctor: plan.docA, type: "all", limit: "2" });
    const card = visitsCard(page);
    await expect(card.getByText("Showing 1–2 of 6 visits")).toBeVisible();
    await card.getByRole("button", { name: "Next ›" }).click();
    await expect(card.getByText("Showing 3–4 of 6 visits")).toBeVisible();
    await expect(page).toHaveURL(/page=2/);
  });

  test("5. picking a day lists only that day, and Reset clears it", async ({ page }) => {
    await open(page, { doctor: plan.docA, type: "all" });
    const byDay = page.getByRole("region", { name: "By day" });
    await byDay.getByRole("button", { name: /2 Jun/ }).click();
    await expect(page).toHaveURL(/day=2021-06-02/);
    await expect(visitsCard(page).locator("tbody tr")).toHaveCount(2);
    await page.getByRole("button", { name: "Reset filters" }).first().click();
    await expect(page).not.toHaveURL(/day=|doctor=/);
  });

  test("6. reloading keeps the filters", async ({ page }) => {
    await open(page, { doctor: plan.docB });
    await page.getByLabel("Visit type", { exact: true }).selectOption("all");
    await expect(page).toHaveURL(/type=all/);
    await page.reload();
    await expect(heading(page)).toBeVisible();
    await expect(page.getByLabel("Visit type", { exact: true })).toHaveValue("all");
    await expect(page.getByLabel("Doctor", { exact: true })).toHaveValue(plan.docB);
    await expect(tile(page, "Visits attended").locator(".ms-tile__val")).toHaveText("1");
    await expect(tile(page, "Lab-only").locator(".ms-tile__note")).toHaveText("included above");
  });

  test("7. empty and failed loads say what happened", async ({ page }) => {
    await open(page, { doctor: `Dr. Nobody ${tag}` });
    await expect(page.getByText("No OPD visits in June 2021 for these filters.")).toBeVisible();
    await expect(page.getByText("No visits match these filters.")).toBeVisible();

    await page.route("**/api/reports/opd/summary**", (route) =>
      route.fulfill({ status: 500, contentType: "application/json", body: "{}" }),
    );
    await page.goto(pageUrl({ doctor: plan.docA, type: "new" }));
    await expect(page.getByText("Couldn't load the summary.")).toBeVisible({ timeout: 20_000 });
    await page.unroute("**/api/reports/opd/summary**");
    await page.getByRole("button", { name: "Try again" }).click();
    await expect(tile(page, "Visits attended").locator(".ms-tile__val")).toHaveText("1");
  });

  test("8. at phone width the page does not scroll sideways", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await open(page, { doctor: plan.docA, type: "all" });
    await expect(visitsCard(page).locator("tbody tr").first()).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
  });

  test("9. the Download button saves the month's Excel file", async ({ page }) => {
    await open(page, { doctor: plan.docA });
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("button", { name: "Download Excel" }).click(),
    ]);
    expect(download.suggestedFilename()).toBe(`OPD-summary-${MONTH}.xlsx`);
  });

  test("10. a role without access gets no menu item and is sent away", async ({ page }) => {
    await loginAs(page, "reception");
    await page.goto(pageUrl({}));
    await expect(page).not.toHaveURL(/reports\/monthly/);
    await expect(page.getByRole("link", { name: /Monthly summary/ })).toHaveCount(0);
  });
});
