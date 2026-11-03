import { test, expect } from "@playwright/test";
import { query } from "../../helpers/db.mjs";
import { loginAs } from "../../helpers/auth.mjs";
import { gotoReady } from "../../helpers/browser.mjs";
import { assertTestDatabase } from "../../setup/guard.mjs";
import { desk, discountCode, newTag, setUp, tearDown } from "../phase4/p4-bills-fixture.mjs";
import {
  db,
  draftWith,
  dropShifts,
  openDeskShift,
  prepareCategory,
} from "../phase4b/p4b-refunds.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const bills = await import("../../../server/services/billing/bills.js");
const payments = await import("../../../server/services/billing/payments.js");
const dashboard = await import("../../../server/services/billing/dashboard.js");

const tag = newTag();
const CODE = `BDP${tag}`.toUpperCase();
const SHOTS = process.env.BD_SCREENSHOTS;
let ids;
let xrayBefore;

const heading = (page) => page.getByRole("heading", { name: "Billing dashboard" });
const mis = (page) => page.getByRole("table", { name: /wise summary$/ });
const open = (page, search = "") =>
  gotoReady(page, `/billing/dashboard?sub_category=${ids.pensioner}${search}`, () => heading(page));

async function finalBill(label, items, { pay = [], payLater = false, codes = [] }) {
  const { bill: draft } = await draftWith(
    ids,
    label,
    items.map((item) => ({ item })),
    { codes },
  );
  let version = draft.version;
  if (pay.length) {
    const taken = await payments.takePayments(draft.id, { version, payments: pay }, desk, db);
    version = taken.version;
  }
  return bills.finaliseBill(draft.id, { version, pay_later: payLater }, desk, db);
}

test.describe.serial("BD-02 billing dashboard page", () => {
  test.beforeAll(async () => {
    ids = await setUp(tag);
    await prepareCategory(ids);
    await openDeskShift(0);
    await discountCode(ids, CODE, { value: 10, service_item_ids: [ids.dressing] });
    await finalBill("PageA", [ids.brace], {
      pay: [{ mode: "upi", upi_app: "bharatpe", amount: 800, reference: `A-${tag}` }],
    });
    await finalBill("PageB", [ids.dressing, ids.brace], {
      pay: [{ mode: "cash", amount: 800 }],
      payLater: true,
      codes: [CODE],
    });
    xrayBefore = (await query(`SELECT label FROM billing_mis_columns WHERE key = 'x_ray'`)).rows[0]
      ?.label;
    dashboard.clearDashboardCache();
  });

  test.afterAll(async () => {
    if (xrayBefore) {
      await query(`UPDATE billing_mis_columns SET label = $1 WHERE key = 'x_ray'`, [xrayBefore]);
    }
    await tearDown(ids);
    await dropShifts();
  });

  test("1. reception admin sees the tiles, the trend and the MIS table for today", async ({
    page,
  }) => {
    await loginAs(page, "reception_admin");
    await open(page, "&range=today");
    const tiles = page.getByRole("region", { name: "Headline figures" });
    await expect(tiles.getByRole("group", { name: "Net revenue" })).toContainText("₹2,050");
    await expect(tiles.getByRole("group", { name: "Collected" })).toContainText("₹1,600");
    await expect(tiles.getByRole("group", { name: "Pending" })).toContainText("₹450");
    await expect(tiles.getByRole("group", { name: "Bills" })).toContainText("2");
    const table = mis(page);
    await expect(table).toBeVisible();
    const total = table.locator("tfoot tr");
    await expect(total).toContainText("Grand Total");
    await expect(total).toContainText("₹2,050");
    await expect(table.getByRole("columnheader", { name: "BharatPe (QR Code)" })).toBeVisible();
    await expect(table.getByRole("columnheader", { name: /Pharmacy Charges/ })).toContainText(
      "Not in Scribe",
    );
    await expect(
      page.getByRole("heading", { name: /^Revenue and collections by day$/ }),
    ).toBeVisible();
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/dashboard-desktop.png`, fullPage: true });
  });

  test("2. view by week keeps the filter in the link; a week row opens day by day", async ({
    page,
  }) => {
    await loginAs(page, "reception_admin");
    await open(page, "&range=month");
    await page
      .getByRole("group", { name: "View by" })
      .getByRole("button", { name: "Week" })
      .click();
    await expect(page).toHaveURL(/period=week/);
    await expect(page.getByRole("heading", { name: "Week wise summary" })).toBeVisible();
    await mis(page)
      .getByRole("button", { name: /day by day$/ })
      .last()
      .click();
    await expect(page).toHaveURL(/period=day/);
    await expect(page).toHaveURL(/range=custom/);
    await expect(page.getByRole("heading", { name: "Day wise summary" })).toBeVisible();
  });

  test("3. a chart's numbers are available as a table", async ({ page }) => {
    await loginAs(page, "reception_admin");
    await open(page, "&range=today");
    const trend = page.getByRole("region", { name: /Revenue and collections/ });
    await trend.getByText("Show as table").click();
    await expect(trend.getByRole("table", { name: "Revenue and collections" })).toContainText(
      "₹2,050",
    );
  });

  test("4. a range too long for day by day says why instead of failing", async ({ page }) => {
    await loginAs(page, "reception_admin");
    await open(page, "&range=custom&from=2026-01-01&to=2026-06-30&period=day");
    await expect(page.getByRole("alert")).toContainText("Day by day covers at most 92 days");
    await expect(
      page.getByRole("group", { name: "View by" }).getByRole("button", { name: "Day" }),
    ).toBeDisabled();
  });

  test("5. reception without the reports capability can't open the dashboard", async ({ page }) => {
    await loginAs(page, "reception");
    await page.goto("/billing/dashboard");
    await expect(heading(page)).toHaveCount(0);
    await expect(page).not.toHaveURL(/\/billing\/dashboard/);
  });

  test("6. MIS columns: rename a column and see it on the dashboard", async ({ page }) => {
    await loginAs(page, "reception_admin");
    await gotoReady(page, "/billing/dashboard/columns", () =>
      page.getByRole("heading", { name: "MIS columns" }),
    );
    const form = page.getByRole("form", { name: xrayBefore });
    await form.getByLabel("Column name").fill(`X-Ray ${tag}`);
    await form.getByRole("button", { name: "Save column" }).click();
    const renamed = page.getByRole("form", { name: `X-Ray ${tag}` });
    await expect(renamed.getByRole("status")).toContainText("saved");
    await open(page, "&range=today");
    await expect(mis(page).getByRole("columnheader", { name: `X-Ray ${tag}` })).toBeVisible();
  });

  test("6b. the discount section shows the code, its share of charges and the bill it was on", async ({
    page,
  }) => {
    await loginAs(page, "reception_admin");
    await open(page, "&range=today");
    const section = page.getByRole("region", { name: "Discounts" });
    await expect(section).toContainText("₹50");
    await expect(section.getByRole("table", { name: "By rule or code" })).toContainText(CODE);
    const top = section.getByRole("table", { name: /^Biggest discounts/ });
    await expect(top).toContainText("₹50");
    await expect(top.getByRole("link", { name: /^Open bill .* at the counter$/ })).toHaveCount(1);
    if (SHOTS) await section.screenshot({ path: `${SHOTS}/dashboard-discounts.png` });
  });

  test("6c. dashboard Download Excel saves the MIS workbook", async ({ page }) => {
    await loginAs(page, "reception_admin");
    await open(page, "&range=today");
    const saved = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download Excel" }).click();
    const file = await saved;
    expect(file.suggestedFilename()).toMatch(
      /^billing-mis-day-wise-\d{4}-\d{2}-\d{2}-to-\d{4}-\d{2}-\d{2}\.xlsx$/,
    );
  });

  test("6d. billing reports keep their filters in the link, and an empty section offers Clear filters", async ({
    page,
  }) => {
    await loginAs(page, "reception_admin");
    const tabs = () => page.getByRole("tablist", { name: "Billing reports" });
    await gotoReady(
      page,
      `/billing/reports?report=collections&range=yesterday&sub_category=${ids.pensioner}`,
      tabs,
    );
    await expect(page.getByLabel("Dates", { exact: true })).toHaveValue("yesterday");
    await expect(page.getByLabel("Sub-category", { exact: true })).toHaveValue(ids.pensioner);
    const empty = page.getByText("Nothing for these filters.").first();
    await expect(empty).toBeVisible();
    await page.getByLabel("Dates", { exact: true }).selectOption("today");
    await expect(page).toHaveURL(/range=today/);
    await page.reload();
    await expect(page.getByLabel("Dates", { exact: true })).toHaveValue("today");
    await expect(page.getByLabel("Sub-category", { exact: true })).toHaveValue(ids.pensioner);
    await page.getByRole("button", { name: "Clear filters" }).first().click();
    await expect(page).toHaveURL(/\/billing\/reports\?report=collections$/);
    await expect(page.getByLabel("Dates", { exact: true })).toHaveValue("month");
  });

  test("6e. a panel's report link opens that report with the same dates and filters", async ({
    page,
  }) => {
    await loginAs(page, "reception_admin");
    await open(page, "&range=today");
    await page
      .getByRole("region", { name: "Discounts" })
      .getByRole("link", { name: "Open Discounts report →" })
      .click();
    await expect(page).toHaveURL(/\/billing\/reports\?report=discounts&range=custom/);
    await expect(page).toHaveURL(new RegExp(`sub_category=${ids.pensioner}`));
    await expect(page.getByRole("tab", { name: "Discounts" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(page.getByLabel("Dates", { exact: true })).toHaveValue("custom");
    await expect(page.getByLabel("Sub-category", { exact: true })).toHaveValue(ids.pensioner);
    await expect(page.getByRole("table", { name: "By rule and code" })).toContainText(CODE);
  });

  test("7. on a phone the page stacks with no sideways page scroll", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await loginAs(page, "reception_admin");
    await open(page, "&range=today");
    await expect(mis(page)).toBeVisible();
    const overflowing = await page.evaluate(() => {
      const root = document.querySelector(".bdash-page");
      const edge = root.getBoundingClientRect().right;
      return [...root.querySelectorAll("*")]
        .filter((el) => !el.closest(".fset__scroll"))
        .filter((el) => el.getBoundingClientRect().right > edge + 1)
        .map((el) => `${el.tagName.toLowerCase()}.${el.className}`.slice(0, 80))
        .slice(0, 8);
    });
    expect(overflowing).toEqual([]);
    const pageWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(pageWidth).toBeLessThanOrEqual(390);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/dashboard-phone.png`, fullPage: true });
  });
});
