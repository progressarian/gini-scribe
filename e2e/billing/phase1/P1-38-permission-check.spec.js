import fs from "node:fs";
import path from "node:path";
import { test, expect } from "@playwright/test";
import { apiAs, loginAs } from "../../helpers/auth.mjs";
import { gotoReady } from "../../helpers/browser.mjs";
import { repoRoot } from "../../setup/testEnv.mjs";
import { CAPABILITIES, ROLES, hasCapability } from "../../../shared/permissions.js";

const DUMMY = {
  id: "999999",
  itemId: "999999",
  key: "999999",
  code: "zz_nobody",
  kind: "item",
  validFrom: "2030-01-01",
};

const ROUTES_DIR = path.join(repoRoot, "server", "routes");
const routeFiles = fs
  .readdirSync(ROUTES_DIR)
  .filter((f) => /^billing.*\.js$/.test(f))
  .map((file) => {
    const source = fs.readFileSync(path.join(ROUTES_DIR, file), "utf8");
    const base = source.match(/^const BASE = "([^"]+)";$/m)?.[1];
    const declared = [...source.matchAll(/router\.(get|post|patch|put|delete)\(/g)].length;
    const parsed = [
      ...source.matchAll(/router\.(get|post|patch|put|delete)\(\s*`\$\{BASE\}([^`]*)`/g),
    ].map(([, method, route]) => ({ method, route: `/api${base}${route}` }));
    return { file, base, declared, parsed };
  });

const endpoints = routeFiles.flatMap(({ parsed }) =>
  parsed.map(({ method, route }) => ({
    method,
    route,
    url: route.replace(/:(\w+)/g, (_, name) => DUMMY[name] ?? "1"),
    settings: route.startsWith("/api/billing/settings"),
    desk: !/^\/api\/billing\/(master|import|claims|reports|settings)(\/|$)/.test(route),
  })),
);

const UNBUILT = [
  { url: "/api/billing/claims/p138", cap: "claims" },
  { url: "/api/billing/reports/p138", cap: "reports" },
  { url: "/api/billing/import/p138", cap: "import" },
  { url: "/api/billing/p138-desk", cap: "desk" },
];

const PAGES = [
  "/settings/schemes",
  "/settings/services",
  "/settings/category-rates",
  "/settings/billing",
];

async function statusOf(api, { method, url }) {
  const response = await api[method](
    url,
    method === "get" || method === "delete" ? {} : { data: {} },
  );
  return response.status();
}

async function statuses(role, list) {
  const api = await apiAs(role);
  const out = [];
  for (const endpoint of list) out.push({ ...endpoint, status: await statusOf(api, endpoint) });
  await api.dispose();
  return out;
}

const describe = (rows) =>
  rows.map((r) => `${r.method ?? "get"} ${r.route ?? r.url} → ${r.status}`);

async function expectTurnedAway(page, target) {
  await page.goto(target);
  await expect(page).not.toHaveURL(/\/settings|\/login/);
  await expect(page.locator(".tabs")).toBeVisible();
}

test.describe("P1-38 billing permissions — APIs", () => {
  test("0. every route in every billing route file is read", () => {
    const withRoutes = routeFiles.filter((f) => f.declared > 0);
    expect(withRoutes.map((f) => f.file).sort()).toEqual(
      expect.arrayContaining(["billingMaster.js", "billingSettings.js"]),
    );
    for (const f of withRoutes) {
      expect(f.base, `${f.file} has no BASE line`).toMatch(/^\/billing\//);
      expect(f.parsed.length, `${f.file}: every router.<verb>( call is a \${BASE} route`).toBe(
        f.declared,
      );
    }
    expect(endpoints.filter((e) => e.settings).length).toBeGreaterThan(5);
  });

  test("0b. across every role, only the billing roles hold billing capabilities", () => {
    const holders = (capability) =>
      Object.values(ROLES)
        .filter((role) => hasCapability(role, capability))
        .sort();
    expect(holders(CAPABILITIES.BILLING_MASTER)).toEqual(["admin", "reception_admin"]);
    expect(holders(CAPABILITIES.BILLING_CLAIMS)).toEqual(["admin", "reception_admin"]);
    expect(holders(CAPABILITIES.BILLING_REPORTS)).toEqual(["admin", "reception_admin"]);
    expect(holders(CAPABILITIES.BILLING_SETTINGS)).toEqual(["admin"]);
    expect(holders(CAPABILITIES.BILLING_DESK)).toEqual(["admin", "reception", "reception_admin"]);
  });

  for (const role of ["lab", "banshali"]) {
    test(`0c. ${role}: every billing API is refused`, async () => {
      const rows = await statuses(role, [
        ...endpoints,
        ...UNBUILT.map((u) => ({ ...u, method: "get" })),
      ]);
      expect(describe(rows.filter((r) => r.status !== 403))).toEqual([]);
    });
  }

  test("1. reception: every billing admin API returns 403; desk APIs are allowed", async () => {
    const rows = await statuses("reception", endpoints);
    expect(describe(rows.filter((r) => !r.desk && r.status !== 403))).toEqual([]);
    expect(describe(rows.filter((r) => r.desk && (r.status === 403 || r.status >= 500)))).toEqual(
      [],
    );
  });

  test("2. coordinator: every billing API is refused, the desk included", async () => {
    const rows = await statuses("coordinator", [
      ...endpoints,
      ...UNBUILT.map((u) => ({ ...u, method: "get" })),
    ]);
    expect(describe(rows.filter((r) => r.status !== 403))).toEqual([]);
  });

  test("3. reception_admin: settings are refused, everything else is allowed", async () => {
    const rows = await statuses("reception_admin", endpoints);
    expect(describe(rows.filter((r) => r.settings && r.status !== 403))).toEqual([]);
    expect(describe(rows.filter((r) => !r.settings && r.status === 403))).toEqual([]);
    expect(describe(rows.filter((r) => r.status >= 500))).toEqual([]);
  });

  test("4. admin: every billing API is allowed", async () => {
    const rows = await statuses("admin", endpoints);
    expect(describe(rows.filter((r) => r.status === 403 || r.status >= 500))).toEqual([]);
  });

  test("5. the gates for routes not built yet already hold", async () => {
    const byRole = async (role) =>
      Object.fromEntries(
        (
          await statuses(
            role,
            UNBUILT.map((u) => ({ ...u, method: "get" })),
          )
        ).map((r) => [r.cap, r.status === 403 ? "refused" : "allowed"]),
      );
    expect(await byRole("reception")).toEqual({
      claims: "refused",
      reports: "refused",
      import: "refused",
      desk: "allowed",
    });
    expect(await byRole("reception_admin")).toEqual({
      claims: "allowed",
      reports: "allowed",
      import: "allowed",
      desk: "allowed",
    });
    expect(await byRole("admin")).toEqual({
      claims: "allowed",
      reports: "allowed",
      import: "allowed",
      desk: "allowed",
    });
  });

  test("6. the old admin-only category writes stay admin-only", async () => {
    for (const role of ["reception", "reception_admin", "coordinator"]) {
      const api = await apiAs(role);
      expect((await api.post("/api/patient-schemes", { data: {} })).status(), role).toBe(403);
      expect((await api.patch("/api/patient-schemes/zz_nobody", { data: {} })).status(), role).toBe(
        403,
      );
      await api.dispose();
    }
  });
});

test.describe("P1-38 billing permissions — screens", () => {
  test.describe.configure({ retries: 1 });

  for (const role of ["reception", "coordinator"]) {
    test(`7. ${role}: no Settings tab and every billing page is turned away`, async ({ page }) => {
      await loginAs(page, role);
      await gotoReady(page, "/", () => page.locator(".tabs"));
      await expect(page.locator(".tabs").getByRole("link", { name: /Settings/ })).toHaveCount(0);
      for (const target of PAGES) await expectTurnedAway(page, target);
    });
  }

  test("8. reception_admin: billing settings is turned away, the other billing pages open", async ({
    page,
  }) => {
    await loginAs(page, "reception_admin");
    await gotoReady(page, "/settings", () =>
      page.getByRole("navigation", { name: "Settings sections" }),
    );
    await expect(
      page.getByRole("navigation", { name: "Settings sections" }).getByRole("link"),
    ).toHaveText(["Categories", "Services", "Category rates"]);
    await expect(page).toHaveURL(/\/settings\/schemes$/);
    for (const target of PAGES.filter((p) => p !== "/settings/billing")) {
      await page.goto(target);
      await expect(page).toHaveURL(new RegExp(`${target}$`));
      await expect(page.getByRole("navigation", { name: "Settings sections" })).toBeVisible();
    }
    await expectTurnedAway(page, "/settings/billing");
  });

  test("9. admin: every billing page opens", async ({ page }) => {
    await loginAs(page, "admin");
    await gotoReady(page, "/settings", () =>
      page.getByRole("navigation", { name: "Settings sections" }),
    );
    for (const target of PAGES) {
      await page.goto(target);
      await expect(page).toHaveURL(new RegExp(`${target}$`));
      await expect(page.getByRole("navigation", { name: "Settings sections" })).toBeVisible();
    }
  });
});
