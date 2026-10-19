import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { test, expect } from "@playwright/test";
import { PAGE_CAPABILITIES } from "../../../src/config/routes.js";
import { hasAnyCapability } from "../../../shared/permissions.js";
import { apiAs, loginAs } from "../../helpers/auth.mjs";
import { gotoReady } from "../../helpers/browser.mjs";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const tag = crypto.randomBytes(3).toString("hex");
const GROUP = { code: `P128_${tag}`, name: `P1-28 Group ${tag}` };
const CATEGORY = { code: `p128_${tag}`, label: `P1-28 Category ${tag}` };
const OTHER_CATEGORY = { code: `p128b_${tag}`, label: `P1-28 Other ${tag}` };

const ADMIN_TABS = [
  "Patient Flow",
  "Prescription",
  "Test catalogue",
  "Categories",
  "Services",
  "Category rates",
  "Consultant fees",
  "Discounts",
  "Bulk import",
  "Billing settings",
];
const RECEPTION_ADMIN_TABS = [
  "Categories",
  "Services",
  "Category rates",
  "Consultant fees",
  "Discounts",
  "Bulk import",
];
const BILLING_PAGES = [
  "/settings/services",
  "/settings/category-rates",
  "/settings/consultant-fees",
  "/settings/discounts",
  "/settings/bulk-import",
  "/settings/billing",
];
const OUTSIDERS = ["reception", "coordinator", "lab", "banshali"];

const tabsOf = (page) =>
  page.getByRole("navigation", { name: "Settings sections" }).getByRole("link");
const expectTurnedAway = async (page) => {
  await expect(page).not.toHaveURL(/\/settings|\/login/);
  await expect(page.locator(".tabs")).toBeVisible();
};
const gridOf = (page, category) =>
  page.getByRole("heading", { level: 2, name: category.label, exact: true });
const settingsNav = (page) => page.locator(".tabs").getByRole("link", { name: /Settings/ });

const endpointsOf = (source, base) =>
  [...source.matchAll(/router\.(get|post|patch|put|delete)\(\s*`\$\{BASE\}([^`]*)`/g)].map(
    ([, method, route]) => `${method} ${base}${route.replace(/:\w+/g, "*")}`,
  );

const hookCallsOf = (source) => {
  const bases = { MASTER: "/api/billing/master", SETTINGS: "/api/billing/settings" };
  const expand = (url) =>
    url.replace(/^\$\{(MASTER|SETTINGS)\}/, (_, b) => bases[b]).replace(/\$\{[^}]+\}/g, "*");
  const calls = [];
  for (const [, method, url] of source.matchAll(/api\.(post|patch|put|delete)\(\s*`([^`]*)`/g)) {
    calls.push(`${method} ${expand(url)}`);
  }
  for (const [, url] of source.matchAll(/read\(\s*`([^`]*)`/g)) calls.push(`get ${expand(url)}`);
  for (const [, method, base] of source.matchAll(/api\.(patch)\((SETTINGS|MASTER),/g)) {
    calls.push(`${method} ${bases[base]}`);
  }
  for (const [, base] of source.matchAll(/read\((SETTINGS|MASTER)\)/g)) {
    calls.push(`get ${bases[base]}`);
  }
  return calls;
};

test.describe("P1-28 billing section in settings — who may open what", () => {
  test("1. the settings section opens for admin and reception_admin only", () => {
    expect(hasAnyCapability("admin", PAGE_CAPABILITIES["/settings"])).toBe(true);
    expect(hasAnyCapability("reception_admin", PAGE_CAPABILITIES["/settings"])).toBe(true);
    for (const role of ["reception", "coordinator", "lab", "consultant", "nurse", "mo"]) {
      expect(hasAnyCapability(role, PAGE_CAPABILITIES["/settings"]), role).toBe(false);
    }
  });

  test("2. every billing page has its own gate", () => {
    for (const page of BILLING_PAGES) {
      expect(PAGE_CAPABILITIES[page], page).toBeTruthy();
      expect(hasAnyCapability("admin", PAGE_CAPABILITIES[page]), page).toBe(true);
    }
    expect(hasAnyCapability("reception_admin", PAGE_CAPABILITIES["/settings/services"])).toBe(true);
    expect(hasAnyCapability("reception_admin", PAGE_CAPABILITIES["/settings/category-rates"])).toBe(
      true,
    );
    expect(hasAnyCapability("reception_admin", PAGE_CAPABILITIES["/settings/schemes"])).toBe(true);
    expect(hasAnyCapability("reception_admin", PAGE_CAPABILITIES["/settings/bulk-import"])).toBe(
      true,
    );
    expect(hasAnyCapability("reception_admin", PAGE_CAPABILITIES["/settings/billing"])).toBe(false);
    for (const page of ["/settings/flow", "/settings/prescription", "/settings/tests"]) {
      expect(hasAnyCapability("reception_admin", PAGE_CAPABILITIES[page]), page).toBe(false);
    }
  });

  test("3. there is a hook for every Phase 1 billing endpoint", () => {
    const read = (file) => fs.readFileSync(path.join(ROOT, file), "utf8");
    const endpoints = [
      ...endpointsOf(read("server/routes/billingMaster.js"), "/api/billing/master"),
      ...endpointsOf(read("server/routes/billingSettings.js"), "/api/billing/settings"),
    ];
    expect(endpoints.length).toBeGreaterThan(30);
    const calls = new Set(hookCallsOf(read("src/queries/hooks/useBillingMaster.js")));
    const missing = endpoints.filter((e) => !calls.has(e));
    expect(missing).toEqual([]);
  });

  test("3b. saving an item or a category rate also refreshes the floor's price lists", () => {
    const source = fs.readFileSync(
      path.join(ROOT, "src/queries/hooks/useBillingMaster.js"),
      "utf8",
    );
    expect(source).toMatch(/const PRICE_KEYS = \[billingKeys\.all, \["giniflow"\]\];/);
    for (const hook of [
      "useCreateBillingItem",
      "useUpdateBillingItem",
      "useSetBillingItemActive",
      "useDeleteBillingItem",
      "useSaveBillingCategoryRate",
      "useDeleteBillingCategoryRate",
    ]) {
      const body = source.slice(source.indexOf(`export function ${hook}()`)).split("\n}\n")[0];
      expect(body, hook).toContain("PRICE_KEYS");
    }
  });
});

test.describe("P1-28 billing section in settings — screens", () => {
  test.describe.configure({ retries: 1 });

  test.beforeAll(async () => {
    const api = await apiAs("admin");
    expect((await api.post("/api/billing/master/groups", { data: GROUP })).status()).toBe(201);
    for (const category of [CATEGORY, OTHER_CATEGORY]) {
      expect((await api.post("/api/billing/master/categories", { data: category })).status()).toBe(
        201,
      );
    }
    await api.dispose();
  });

  test.afterAll(async () => {
    const api = await apiAs("admin");
    const groups = await (await api.get("/api/billing/master/groups")).json();
    const group = groups.find((g) => g.code === GROUP.code);
    if (group) await api.delete(`/api/billing/master/groups/${group.id}`);
    for (const category of [CATEGORY, OTHER_CATEGORY]) {
      await api.delete(`/api/billing/master/categories/${category.code}`);
    }
    await api.dispose();
  });

  test("4. admin sees every settings tab, billing ones included", async ({ page }) => {
    await loginAs(page, "admin");
    await gotoReady(page, "/settings", () =>
      page.getByRole("navigation", { name: "Settings sections" }),
    );
    await expect(page).toHaveURL(/\/settings\/flow$/);
    await expect(tabsOf(page)).toHaveText(ADMIN_TABS);
    await expect(settingsNav(page)).toHaveCount(1);
  });

  test("5. reception_admin lands on its first tab and sees only the tabs it may use", async ({
    page,
  }) => {
    await loginAs(page, "reception_admin");
    await gotoReady(page, "/settings", () =>
      page.getByRole("navigation", { name: "Settings sections" }),
    );
    await expect(page).toHaveURL(/\/settings\/schemes$/);
    await expect(tabsOf(page)).toHaveText(RECEPTION_ADMIN_TABS);
    await expect(settingsNav(page)).toHaveCount(1);
    await tabsOf(page).getByText("Services", { exact: true }).click();
    await expect(page.getByRole("button", { name: new RegExp(`^${GROUP.name}`) })).toBeVisible();
  });

  test("6. reception_admin is turned away from admin-only settings", async ({ page }) => {
    await loginAs(page, "reception_admin");
    for (const target of ["/settings/billing", "/settings/flow", "/settings/tests"]) {
      await gotoReady(page, target, () => page.locator(".tabs"));
      await expectTurnedAway(page);
    }
  });

  for (const role of OUTSIDERS) {
    test(`7. ${role} gets no settings tab and no billing page`, async ({ page }) => {
      await loginAs(page, role);
      for (const target of ["/settings", ...BILLING_PAGES]) {
        await gotoReady(page, target, () => page.locator(".tabs"));
        await expectTurnedAway(page);
      }
      await expect(settingsNav(page)).toHaveCount(0);
    });
  }

  test("8. the category rates tab loads a category's grid", async ({ page }) => {
    await loginAs(page, "reception_admin");
    await gotoReady(page, "/settings/category-rates", () => page.getByLabel("Category"));
    const picker = page.getByLabel("Category");
    await expect(picker.locator("option", { hasText: CATEGORY.label })).toHaveCount(1);
    await picker.selectOption(CATEGORY.code);
    await expect(gridOf(page, CATEGORY)).toBeVisible();
  });

  test("9. the billing settings tab shows the saved settings to admin", async ({ page }) => {
    await loginAs(page, "admin");
    await gotoReady(page, "/settings/billing", () =>
      page.getByRole("form", { name: "Bills", exact: true }),
    );
    await expect(page.getByLabel("When several discounts apply", { exact: true })).toBeVisible();
    await expect(page.getByRole("region", { name: "Number series", exact: true })).toBeVisible();
  });

  test("10. switching category never shows the previous category's rates", async ({ page }) => {
    await loginAs(page, "reception_admin");
    await gotoReady(page, "/settings/category-rates", () => page.getByLabel("Category"));
    const picker = page.getByLabel("Category");
    await picker.selectOption(CATEGORY.code);
    await expect(gridOf(page, CATEGORY)).toBeVisible();
    let release;
    const held = new Promise((resolve) => (release = resolve));
    await page.route(
      `**/api/billing/master/category-rates/${OTHER_CATEGORY.code}**`,
      async (route) => {
        await held;
        await route.continue();
      },
    );
    await picker.selectOption(OTHER_CATEGORY.code);
    await expect(page.getByText("Loading…")).toBeVisible();
    await expect(gridOf(page, CATEGORY)).toHaveCount(0);
    release();
    await expect(gridOf(page, OTHER_CATEGORY)).toBeVisible();
  });

  test("11. a failed load says so instead of loading forever", async ({ page }) => {
    await loginAs(page, "admin");
    await page.route("**/api/billing/settings", (route) =>
      route.fulfill({ status: 500, json: { error: "boom" } }),
    );
    await page.route(`**/api/billing/master/category-rates/${CATEGORY.code}**`, (route) =>
      route.fulfill({ status: 500, json: { error: "boom" } }),
    );
    await page.goto("/settings/billing");
    await expect(page.getByText("Could not load the billing settings.")).toBeVisible({
      timeout: 20000,
    });
    await page.goto("/settings/category-rates");
    await page.getByLabel("Category").selectOption(CATEGORY.code);
    await expect(page.getByText("Could not load the rates.")).toBeVisible({ timeout: 20000 });
  });

  test("12. the Categories tab's page is titled Categories", async ({ page }) => {
    await loginAs(page, "admin");
    const title = () =>
      page.getByRole("region", { name: "Categories" }).getByRole("heading", { level: 2 });
    await gotoReady(page, "/settings/schemes", title);
    await expect(title()).toHaveText("Categories");
  });

  test("13. on a phone every settings page fits the screen and its tab is in view", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    await loginAs(page, "admin");
    for (const target of [
      "/settings/flow",
      "/settings/tests",
      "/settings/schemes",
      "/settings/services",
      "/settings/category-rates",
      "/settings/bulk-import",
      "/settings/billing",
    ]) {
      await gotoReady(page, target, () =>
        page.getByRole("navigation", { name: "Settings sections" }),
      );
      await expect(page.locator(".set__panel")).toBeVisible();
      await expect
        .poll(
          () =>
            page.evaluate(
              () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
            ),
          { message: `${target} is wider than the screen` },
        )
        .toBe(0);
      const selected = await page.locator(".set__tab--on").evaluate((el) => {
        const r = el.getBoundingClientRect();
        return r.left >= 0 && r.right <= window.innerWidth;
      });
      expect(selected, `${target}: the selected tab is on screen`).toBe(true);
    }
  });
});
