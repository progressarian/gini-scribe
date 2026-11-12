import { test, expect } from "@playwright/test";
import { apiAs, loginAs } from "../helpers/auth.mjs";
import { query } from "../helpers/db.mjs";
import { gotoReady } from "../helpers/browser.mjs";
import { LAB_REPORTS, removeLabCatalog, seedLabCatalog } from "../fixtures/labCatalog.mjs";

const table = (page) => page.locator(".tcat__table");
const search = (page) => page.getByLabel("Search tests by name or code", { exact: true });
const row = (page, name) => table(page).getByRole("row", { name: new RegExp(`^${name}\\b`) });

async function openCatalogue(page, role) {
  await loginAs(page, role);
  await gotoReady(page, "/settings/tests", () => search(page));
}

const catalogue = async (role) => {
  const api = await apiAs(role);
  const response = await api.get("/api/giniflow/test-catalog");
  return { status: response.status(), body: response.ok() ? await response.json() : null };
};

test.describe.serial("LC03 test catalogue shows which tests have result fields", () => {
  test.beforeAll(async () => {
    await seedLabCatalog(query);
    await query(`UPDATE giniflow_test_catalog SET results_as_file = TRUE WHERE test_name = 'VPT'`);
  });
  test.afterAll(async () => {
    await query(`UPDATE giniflow_test_catalog SET results_as_file = FALSE WHERE test_name = 'VPT'`);
    await removeLabCatalog(query);
  });

  test("1. the API reports fields, file-only and not set up per test", async () => {
    const { status, body } = await catalogue("admin");
    expect(status).toBe(200);
    const byName = new Map(body.tests.map((t) => [t.name, t.results]));
    expect(byName.get("Lipid Profile")).toEqual({
      status: "fields",
      reportId: String(LAB_REPORTS[0].id),
      reportName: "LIPID PROFILE",
      fieldCount: 8,
    });
    expect(byName.get("HbA1c")).toMatchObject({ status: "fields", fieldCount: 1 });
    expect(byName.get("VPT")).toMatchObject({ status: "file" });
    expect(byName.get("ABI")).toMatchObject({ status: "not_set_up", reportId: null });
  });

  test("2. a switched-off report or field no longer counts", async () => {
    await query(`UPDATE lab_test_catalog SET is_active = FALSE WHERE id = 990105`);
    await query(`UPDATE lab_report_catalog SET is_active = FALSE WHERE id = $1`, [
      LAB_REPORTS[1].id,
    ]);
    try {
      const byName = new Map((await catalogue("admin")).body.tests.map((t) => [t.name, t.results]));
      expect(byName.get("Lipid Profile").fieldCount).toBe(7);
      expect(byName.get("HbA1c").status).toBe("not_set_up");
    } finally {
      await query(`UPDATE lab_test_catalog SET is_active = TRUE WHERE id = 990105`);
      await query(`UPDATE lab_report_catalog SET is_active = TRUE WHERE id = $1`, [
        LAB_REPORTS[1].id,
      ]);
    }
  });

  test("3. admin sees the Results column, the warning and the Not set up filter", async ({
    page,
  }) => {
    const { body } = await catalogue("admin");
    const missing = body.tests.filter(
      (t) => t.isActive && t.results.status === "not_set_up",
    ).length;
    await openCatalogue(page, "admin");
    await expect(page.locator(".tcat__warn", { hasText: "no result fields" })).toContainText(
      `${missing} active test${missing === 1 ? " has" : "s have"} no result fields.`,
    );
    await search(page).fill("Lipid Profile");
    await expect(row(page, "Lipid Profile")).toContainText("8 fields");
    await search(page).fill("VPT");
    await expect(row(page, "VPT")).toContainText("File only");
    await search(page).fill("");
    await page.getByLabel("Not set up only").check();
    await search(page).fill("ABI");
    await expect(row(page, "ABI")).toContainText("Not set up");
    await search(page).fill("Lipid Profile");
    await expect(page.getByText("Nothing matches.")).toBeVisible();
  });

  test("4. Show them in the warning turns the filter on", async ({ page }) => {
    await openCatalogue(page, "admin");
    await page.getByRole("button", { name: "Show them" }).click();
    await expect(page.getByLabel("Not set up only")).toBeChecked();
    await expect(table(page).getByText("8 fields")).toHaveCount(0);
  });

  test("5. lab admin can read the catalogue but not change price, station or retire", async ({
    page,
  }) => {
    expect((await catalogue("lab_admin")).status).toBe(200);
    const api = await apiAs("lab_admin");
    const lipid = (await catalogue("admin")).body.tests.find((t) => t.name === "Lipid Profile");
    const patch = await api.patch(`/api/giniflow/test-catalog/${lipid.id}`, {
      data: { gloss: "changed by lab admin" },
    });
    expect(patch.status()).toBe(403);

    await openCatalogue(page, "lab_admin");
    await expect(page.getByRole("link", { name: "Test catalogue" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Services" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "+ Add test" })).toHaveCount(0);
    await search(page).fill("Lipid Profile");
    await expect(row(page, "Lipid Profile")).toContainText("8 fields");
    await expect(page.getByLabel("Station for Lipid Profile")).toBeDisabled();
    await expect(table(page).getByRole("button", { name: /Retire/ })).toHaveCount(0);
  });

  test("6. the lab bench and reception cannot read the catalogue", async () => {
    expect((await catalogue("lab")).status).toBe(403);
    expect((await catalogue("reception")).status).toBe(403);
  });
});
