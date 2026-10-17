import { test, expect } from "@playwright/test";
import { seedCrmStaff, crmApi, loginCrm, resetCrm } from "../helpers/crm.mjs";
import { loginAs } from "../helpers/auth.mjs";
import { gotoReady } from "../helpers/browser.mjs";

test.describe("CRM tabs in the top navigation", () => {
  let users;

  test.beforeAll(async () => {
    users = (await seedCrmStaff()).users;
  });

  test.afterAll(resetCrm);

  const tabs = (page) => page.locator(".tabs");

  test("1. the head of growth sees CRM and Import doctors", async ({ page }) => {
    await loginCrm(page, await crmApi(users.virender));
    await gotoReady(page, "/crm/import", () => tabs(page));
    await expect(tabs(page).getByRole("link", { name: "🤝 CRM" })).toBeVisible();
    await expect(tabs(page).getByRole("link", { name: "📥 Import doctors" })).toBeVisible();
    await tabs(page).getByRole("link", { name: "🤝 CRM" }).click();
    await expect(page).toHaveURL(/\/crm\/home$/);
  });

  test("1b. the import page's back link returns to the CRM home", async ({ page }) => {
    await loginCrm(page, await crmApi(users.virender));
    await gotoReady(page, "/crm/import", () =>
      page.getByRole("heading", { name: "Import doctors" }),
    );
    await page.getByRole("link", { name: "Back to CRM home" }).click();
    await expect(page).toHaveURL(/\/crm\/home$/);
  });

  test("2. a growth executive sees only CRM", async ({ page }) => {
    await loginCrm(page, await crmApi(users.rajesh));
    await gotoReady(page, "/crm/home", () => tabs(page));
    await expect(tabs(page).getByRole("link", { name: "🤝 CRM" })).toBeVisible();
    await expect(tabs(page).getByRole("link", { name: "📥 Import doctors" })).toHaveCount(0);
  });

  test("2b. a growth manager sees only CRM", async ({ page }) => {
    await loginCrm(page, await crmApi(users.manager));
    await gotoReady(page, "/crm/home", () => tabs(page));
    await expect(tabs(page).getByRole("link", { name: "🤝 CRM" })).toBeVisible();
    await expect(tabs(page).getByRole("link", { name: "📥 Import doctors" })).toHaveCount(0);
  });

  test("3. a role without CRM access sees neither", async ({ page }) => {
    await loginAs(page, "reception");
    await gotoReady(page, "/", () => tabs(page));
    await expect(tabs(page).getByRole("link", { name: "🤝 CRM" })).toHaveCount(0);
    await expect(tabs(page).getByRole("link", { name: "📥 Import doctors" })).toHaveCount(0);
  });
});
