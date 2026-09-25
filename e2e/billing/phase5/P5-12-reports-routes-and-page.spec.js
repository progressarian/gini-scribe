import { test, expect } from "@playwright/test";
import { assertTestDatabase } from "../../setup/guard.mjs";
import { loginAs } from "../../helpers/auth.mjs";
import { gotoReady } from "../../helpers/browser.mjs";
import { CAPABILITIES, ROLES, hasCapability } from "../../../shared/permissions.js";
import { newTag } from "../phase4/p4-bills-fixture.mjs";
import { SEED_WAIT_MS, seedReports, unseed } from "./p5-reports-seed.mjs";
import { REPORTS_PATH, callAs, mountReports, proxyReports } from "./p5-http.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const reports = await import("../../../server/services/billing/reports.js");
const { PAGE_CAPABILITIES } = await import("../../../src/config/routes.js");

const tag = newTag();
let ids;
let api;

const NAV = "Billing Reports";

const endpoints = () => [
  [REPORTS_PATH, {}],
  [`${REPORTS_PATH}/revenue_items`, { from: ids.privateDay, to: ids.privateDay }],
  [`${REPORTS_PATH}/dues/export`, { to: ids.privateDay }],
];

test.describe.serial("P5-12 reports routes and page", () => {
  test.beforeAll(async () => {
    test.setTimeout(SEED_WAIT_MS + 60000);
    ids = await seedReports(tag);
    api = await mountReports();
  });

  test.afterAll(async () => {
    await api?.close();
    await unseed(ids);
  });

  test("1. the reports API answers admin and reception_admin, and nobody else", async () => {
    const holders = Object.values(ROLES)
      .filter((role) => hasCapability(role, CAPABILITIES.BILLING_REPORTS))
      .sort();
    expect(holders).toEqual(["admin", "reception_admin"]);
    expect(PAGE_CAPABILITIES["/billing/reports"]).toBe(CAPABILITIES.BILLING_REPORTS);
    for (const [route, query] of endpoints()) {
      for (const role of ["admin", "reception_admin"]) {
        expect((await callAs(api.url, role, route, query)).status, `${role} ${route}`).toBe(200);
      }
      for (const role of ["reception", "coordinator", "lab", "banshali"]) {
        expect((await callAs(api.url, role, route, query)).status, `${role} ${route}`).toBe(403);
      }
      expect((await callAs(api.url, null, route, query)).status, `nobody ${route}`).toBe(403);
    }
  });

  test("2. the catalog lists every report and its filters; bad input is refused in words", async () => {
    const catalog = await callAs(api.url, "admin", REPORTS_PATH);
    expect(catalog.body.reports.map((r) => r.key)).toEqual(reports.REPORT_KEYS);
    expect(catalog.body.reports.find((r) => r.key === "revenue_items")).toMatchObject({
      title: "Revenue by service",
      filters: expect.arrayContaining(["period", "group", "consultant"]),
    });
    expect(catalog.body.options.users.map((u) => u.role)).not.toContain("consultant");
    expect(catalog.body.options.categories.map((c) => c.code)).toContain(ids.paid);
    const asked = async (route, query) => {
      const res = await callAs(api.url, "admin", route, query);
      return [res.status, res.body.error];
    };
    expect(await asked(`${REPORTS_PATH}/nothing-here`)).toEqual([
      404,
      "There is no such billing report",
    ]);
    expect(await asked(`${REPORTS_PATH}/collections`, { from: "2026-02-31" })).toEqual([
      400,
      "From must be a date like 2026-10-01",
    ]);
    expect(await asked(`${REPORTS_PATH}/collections`, { colour: "red" })).toEqual([
      400,
      "Unknown field: colour",
    ]);
    expect(await asked(`${REPORTS_PATH}/requests`, { consultant: "9101" })).toEqual([
      400,
      "The Desk requests report can't be filtered by consultant",
    ]);
    const report = await callAs(api.url, "admin", `${REPORTS_PATH}/collections`, {
      from: ids.privateDay,
      to: ids.privateDay,
    });
    expect(report.body.sections[0].total.net).toBeGreaterThan(0);
  });

  for (const role of ["admin", "reception_admin"]) {
    test(`3. ${role}: the menu has Billing Reports; the page has a filter bar, a tab per report and an export button`, async ({
      page,
    }) => {
      await loginAs(page, role);
      await proxyReports(page, api.url);
      await gotoReady(page, "/", () => page.locator(".tabs"));
      await page
        .locator(".tabs")
        .getByRole("link", { name: new RegExp(NAV) })
        .click();
      await expect(page).toHaveURL(/\/billing\/reports/);
      const tabs = page.getByRole("tablist", { name: "Billing reports" }).getByRole("tab");
      await expect(tabs).toHaveText(reports.REPORT_KEYS.map((key) => reports.REPORTS[key].title));
      await expect(page.getByRole("button", { name: "Download Excel" })).toBeEnabled();
      await page.getByRole("tab", { name: "Collections" }).click();
      await expect(page).toHaveURL(/report=collections/);
      await expect(page.getByLabel("Group", { exact: true })).toHaveCount(0);
      await page.getByLabel("From", { exact: true }).fill(ids.privateDay);
      await page.getByLabel("To", { exact: true }).fill(ids.privateDay);
      const modes = page.getByRole("table", { name: "By payment mode" });
      await expect(modes.getByRole("row", { name: /^UPI/ })).toContainText("₹300");
      await page.getByRole("tab", { name: "Revenue by service" }).click();
      await expect(page.getByLabel("Group", { exact: true })).toBeVisible();
      await expect(page.getByLabel("By", { exact: true })).toBeVisible();
    });
  }

  test("4. reception: no menu entry, and the page is turned away", async ({ page }) => {
    await loginAs(page, "reception");
    await proxyReports(page, api.url);
    await gotoReady(page, "/", () => page.locator(".tabs"));
    await expect(page.locator(".tabs").getByRole("link", { name: new RegExp(NAV) })).toHaveCount(0);
    await gotoReady(page, "/billing/reports", () => page.locator(".tabs"));
    await expect(page).not.toHaveURL(/\/billing\/reports/);
    await expect(page.getByRole("tablist", { name: "Billing reports" })).toHaveCount(0);
  });
});
