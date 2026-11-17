import { test, expect } from "@playwright/test";
import { loginAs } from "../helpers/auth.mjs";
import { gotoReady } from "../helpers/browser.mjs";
import { pickOption } from "../helpers/pickers.mjs";

const pressed = (page, name) => page.getByRole("button", { name, exact: true });

test.describe("PH85 pharmacy filters live in the URL and are remembered", () => {
  test("bill filters survive a reload and a trip through the top bar", async ({ page }) => {
    await loginAs(page, "pharmacy_admin");
    await gotoReady(page, "/pharmacy/billing", () => pressed(page, "Drafts"), { timeout: 30000 });

    await pressed(page, "Drafts").click();
    await page.getByLabel("Search pharmacy bills").fill("PH85 Kumar");
    await expect(page).toHaveURL(/status=draft/);
    await expect(page).toHaveURL(/q=PH85\+Kumar/);

    await page.reload();
    await expect(pressed(page, "Drafts")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByLabel("Search pharmacy bills")).toHaveValue("PH85 Kumar");

    await page.getByRole("link", { name: "Pharmacy Today", exact: true }).click();
    await expect(page).toHaveURL(/\/pharmacy\/dashboard$/);
    await page.getByRole("link", { name: "Pharmacy Bills", exact: true }).click();
    await expect(page).toHaveURL(/status=draft/);
    await expect(pressed(page, "Drafts")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByLabel("Search pharmacy bills")).toHaveValue("PH85 Kumar");

    await pressed(page, "All").click();
    await page.getByLabel("Search pharmacy bills").fill("");
    await expect(page).toHaveURL(/\/pharmacy\/billing$/);
  });

  test("top items keeps its period, grouping and sort", async ({ page }) => {
    await loginAs(page, "pharmacy_admin");
    await gotoReady(
      page,
      "/pharmacy/reports/top-items",
      () => page.getByRole("heading", { name: "Top selling items" }),
      { timeout: 30000 },
    );
    await pickOption(page, "Item type", "INJ");
    await pressed(page, "Split by supplier").click();
    await expect(page).toHaveURL(/form=INJ/);
    await expect(page).toHaveURL(/group=vendor/);

    await page.reload();
    await expect(page.getByRole("button", { name: /^Item type/ })).toContainText("INJ");
    await expect(pressed(page, "Split by supplier")).toHaveAttribute("aria-pressed", "true");
  });

  test("each stock tab keeps its own filters when switching tabs", async ({ page }) => {
    await loginAs(page, "pharmacy_admin");
    await gotoReady(page, "/pharmacy/stock", () => pressed(page, "Out of stock"), {
      timeout: 30000,
    });
    await pressed(page, "Out of stock").click();
    await page.getByRole("tab", { name: "Stock list" }).click();
    const listFilters = page.locator(".phs-filters");
    await pickOption(listFilters, "Expiry", "Within 30 days");
    await expect(page).toHaveURL(/tab=list/);
    await expect(page).toHaveURL(/l_expiry=30/);
    await expect(page).toHaveURL(/filter=out/);

    await page.getByRole("tab", { name: "Batch stock" }).click();
    await expect(pressed(page, "Out of stock")).toHaveAttribute("aria-pressed", "true");
    await page.getByRole("tab", { name: "Stock list" }).click();
    await expect(listFilters.getByRole("button", { name: /^Expiry/ })).toContainText(
      "Within 30 days",
    );
  });
});
