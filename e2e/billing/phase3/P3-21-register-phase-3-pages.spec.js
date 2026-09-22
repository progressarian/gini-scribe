import fs from "node:fs";
import path from "node:path";
import { test, expect } from "@playwright/test";
import { loginAs } from "../../helpers/auth.mjs";
import { gotoReady } from "../../helpers/browser.mjs";
import { repoRoot } from "../../setup/testEnv.mjs";
import { PAGE_CAPABILITIES } from "../../../src/config/routes.js";
import { CAPABILITIES } from "../../../shared/permissions.js";

const PAGES = [
  { path: "/settings/consultant-fees", tab: "Consultant fees" },
  { path: "/settings/discounts", tab: "Discounts" },
];
const sections = (page) => page.getByRole("navigation", { name: "Settings sections" });

test.describe("P3-21 register Phase 3 pages", () => {
  test("1. both pages are lazy routes behind BILLING_MASTER", () => {
    const router = fs.readFileSync(path.join(repoRoot, "src", "router.jsx"), "utf8");
    for (const name of ["ConsultantFeesPage", "DiscountsSettingsPage"]) {
      expect(router, name).toMatch(
        new RegExp(
          `const ${name} = lazyWithRetry\\(\\s*\\(\\) => import\\("\\./pages/billing/${name}"\\)`,
        ),
      );
    }
    for (const { path: target } of PAGES) {
      expect(PAGE_CAPABILITIES[target], target).toBe(CAPABILITIES.BILLING_MASTER);
    }
  });

  for (const role of ["admin", "reception_admin"]) {
    test(`2. ${role}: both tabs are listed and open their page`, async ({ page }) => {
      await loginAs(page, role);
      for (const { path: target, tab } of PAGES) {
        await gotoReady(page, target, () => sections(page));
        await expect(page).toHaveURL(new RegExp(`${target}$`));
        await expect(sections(page).getByRole("link", { name: tab, exact: true })).toBeVisible();
        await expect(page.getByRole("heading", { name: tab, exact: true })).toBeVisible();
      }
    });
  }

  for (const role of ["reception", "lab"]) {
    test(`3. ${role}: both pages are turned away`, async ({ page }) => {
      await loginAs(page, role);
      for (const { path: target } of PAGES) {
        await gotoReady(page, target, () => page.locator(".tabs"));
        await expect(page).not.toHaveURL(/\/settings|\/login/);
      }
    });
  }
});
