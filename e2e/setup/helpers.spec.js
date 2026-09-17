import { test, expect } from "@playwright/test";
import { USERS } from "../fixtures/data.mjs";
import { anonymousApi, apiAs, loginAs } from "../helpers/auth.mjs";
import { buildCatalogTest, buildPatient, buildScheme, countRows } from "../helpers/builders.mjs";
import { expectRupees, sumRupees } from "../helpers/money.mjs";

test.describe("PT-07 helpers", () => {
  for (const role of Object.keys(USERS)) {
    test(`apiAs("${role}") is authenticated as that role`, async () => {
      const api = await apiAs(role);
      const response = await api.get("/api/auth/me");
      expect(response.status()).toBe(200);
      const body = await response.json();
      expect(body.authenticated).toBe(true);
      expect(body.doctor.id).toBe(USERS[role].id);
      expect(body.doctor.role).toBe(USERS[role].role);
      await api.dispose();
    });
  }

  test("anonymousApi is not signed in and is refused on a protected route", async () => {
    const api = await anonymousApi();
    const me = await api.get("/api/auth/me");
    expect(me.status()).toBe(200);
    expect(await me.json()).toEqual({ authenticated: false });
    const today = new Date().toISOString().slice(0, 10);
    const protectedRoute = await api.get(`/api/giniflow/stations/reception/arrivals?date=${today}`);
    expect(protectedRoute.status()).toBe(401);
    await api.dispose();
  });

  test("loginAs opens the app already signed in", async ({ page }) => {
    await loginAs(page, "admin");
    await page.goto("/");
    await expect
      .poll(() => page.evaluate(() => window.localStorage.getItem("gini_auth_token")))
      .toBeTruthy();
    await expect(page.getByPlaceholder(/pin/i)).toHaveCount(0);
  });

  test("builders create rows in one line", async () => {
    const before = await countRows("patients");
    const patient = await buildPatient({ age: 71 });
    expect(patient.age).toBe(71);
    expect(await countRows("patients")).toBe(before + 1);

    const catalogTest = await buildCatalogTest({ category: "machine", price: 900 });
    expect(catalogTest.category).toBe("machine");

    const scheme = await buildScheme({ label: "E2E Scheme" });
    expect(scheme.label).toBe("E2E Scheme");
  });

  test("money helpers work in paise", () => {
    expectRupees(sumRupees([0.1, 0.2]), 0.3);
    expectRupees(sumRupees([1500, -800]), 700);
    expect(() => expectRupees(700, 700.01)).toThrow();
  });
});
