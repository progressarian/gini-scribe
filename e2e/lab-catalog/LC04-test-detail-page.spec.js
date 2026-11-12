import { test, expect } from "@playwright/test";
import { apiAs, loginAs } from "../helpers/auth.mjs";
import { query } from "../helpers/db.mjs";
import { gotoReady } from "../helpers/browser.mjs";
import { LAB_REPORTS, removeLabCatalog, seedLabCatalog } from "../fixtures/labCatalog.mjs";

const ids = {};

const detail = async (role, catalogId) => {
  const api = await apiAs(role);
  const response = await api.get(`/api/lab-catalog/tests/${catalogId}`);
  return { status: response.status(), body: response.ok() ? await response.json() : null };
};

const catalogIdOf = async (name) =>
  (await query(`SELECT id FROM giniflow_test_catalog WHERE test_name = $1`, [name])).rows[0].id;

test.describe.serial("LC04 a test's page shows its result fields read-only", () => {
  test.beforeAll(async () => {
    await seedLabCatalog(query);
    ids.lipid = await catalogIdOf("Lipid Profile");
    ids.hba1c = await catalogIdOf("HbA1c");
    ids.rft = await catalogIdOf("RFT");
    ids.abi = await catalogIdOf("ABI");
  });
  test.afterAll(async () => {
    await removeLabCatalog(query);
  });

  test("1. the API lists the fields in print order with formulas shown as names", async () => {
    const { status, body } = await detail("admin", ids.lipid);
    expect(status).toBe(200);
    expect(body.report.name).toBe("LIPID PROFILE");
    expect(body.report.fields.map((f) => f.name)).toEqual(LAB_REPORTS[0].fields.map((f) => f.name));
    const vldl = body.report.fields.find((f) => f.name === "VLDL Cholesterol");
    expect(vldl.type).toBe("calculated");
    expect(vldl.formula.text).toBe("Triglycerides ÷ 5");
    expect(vldl.required).toBe(false);
    const nonHdl = body.report.fields.find((f) => f.name === "Non HDL Cholesterol");
    expect(nonHdl.formula.text).toBe("Total Cholesterol − HDL Cholesterol");
    expect(body.report.fields.find((f) => f.name === "Triglycerides").required).toBe(true);
  });

  test("2. ranges come back per sex, and a chained formula shows its calculated input", async () => {
    const hba1c = (await detail("admin", ids.hba1c)).body.report.fields[0];
    expect(hba1c.ranges.map((r) => [r.gender, r.min, r.max])).toEqual([
      ["Female", 4.5, 6.5],
      ["Male", 4, 6],
    ]);
    const rft = (await detail("admin", ids.rft)).body.report.fields;
    expect(rft.find((f) => f.name === "Urea / Creatinine Ratio").formula.text).toBe(
      "Blood Urea ÷ Creatinine, Serum",
    );
  });

  test("3. a field shared with another report says where else it prints", async () => {
    await query(
      `INSERT INTO lab_report_tests (report_id, test_id, sequence) VALUES ($1, 990201, 9)`,
      [LAB_REPORTS[0].id],
    );
    try {
      const hba1c = (await detail("admin", ids.hba1c)).body.report.fields[0];
      expect(hba1c.alsoIn).toEqual(["LIPID PROFILE"]);
    } finally {
      await query(`DELETE FROM lab_report_tests WHERE report_id = $1 AND test_id = 990201`, [
        LAB_REPORTS[0].id,
      ]);
    }
  });

  test("4. an unknown or malformed id is a 404; the bench cannot read it; lab admin can", async () => {
    expect((await detail("admin", "00000000-0000-0000-0000-000000000000")).status).toBe(404);
    expect((await detail("admin", "not-a-uuid")).status).toBe(404);
    expect((await detail("lab", ids.lipid)).status).toBe(403);
    expect((await detail("reception", ids.lipid)).status).toBe(403);
    expect((await detail("lab_admin", ids.lipid)).status).toBe(200);
  });

  test("5. the history lists link changes for this test", async () => {
    const api = await apiAs("admin");
    const empty = await api.get(`/api/lab-catalog/tests/${ids.abi}/history`);
    expect(await empty.json()).toEqual([]);
    await query(
      `INSERT INTO lab_catalog_audit (entity, entity_id, action, before, after)
       VALUES ('link', $1, 'backfill', '{"lab_report_id": null}', $2)`,
      [ids.lipid, JSON.stringify({ lab_report_id: LAB_REPORTS[0].id, report: "LIPID PROFILE" })],
    );
    const history = await (await api.get(`/api/lab-catalog/tests/${ids.lipid}/history`)).json();
    expect(history[0]).toMatchObject({ entity: "link", action: "backfill" });
  });

  test("6. admin opens a test from the list and reads its fields, details and history", async ({
    page,
  }) => {
    await loginAs(page, "admin");
    await gotoReady(page, "/settings/tests", () =>
      page.getByLabel("Search tests by name or code", { exact: true }),
    );
    await page.getByLabel("Search tests by name or code", { exact: true }).fill("Lipid Profile");
    await page.getByRole("link", { name: "Lipid Profile", exact: true }).click();
    await expect(
      page.getByRole("heading", { level: 2, name: "Lipid Profile", exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("tab", { name: "Result fields" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    const vldl = page.getByRole("row", { name: /VLDL Cholesterol/ });
    await expect(vldl).toContainText("Triglycerides ÷ 5");
    await expect(vldl).toContainText("Calculated");
    await expect(page.getByRole("row", { name: /^3 HDL Cholesterol/ })).toContainText("40 – 60");

    await page.getByRole("tab", { name: "Details" }).click();
    await expect(page.getByText("8 active fields in LIPID PROFILE")).toBeVisible();

    await page.getByRole("tab", { name: "History" }).click();
    await expect(page.getByText("Linked to LIPID PROFILE").first()).toBeVisible();
    await expect(page.getByText("System (setup)").first()).toBeVisible();

    await page.getByRole("link", { name: "Test catalogue" }).first().click();
    await expect(page).toHaveURL(/\/settings\/tests$/);
  });

  test("7. a test with no report explains why there are no fields", async ({ page }) => {
    await loginAs(page, "admin");
    await gotoReady(page, `/settings/tests/${ids.abi}`, () =>
      page.getByRole("heading", { level: 2, name: "ABI", exact: true }),
    );
    await expect(page.getByText("No result fields yet.")).toBeVisible();
  });

  test("8. a missing test says so instead of loading forever", async ({ page }) => {
    await loginAs(page, "admin");
    await gotoReady(page, "/settings/tests/00000000-0000-0000-0000-000000000000", () =>
      page.getByRole("alert"),
    );
    await expect(page.getByRole("alert")).toContainText("This test is not in the catalogue");
  });

  test("9. needs-attention marks a numeric field with no unit", async ({ page }) => {
    await query(`UPDATE lab_test_catalog SET unit = NULL WHERE id = 990201`);
    try {
      await loginAs(page, "admin");
      await gotoReady(page, `/settings/tests/${ids.hba1c}`, () =>
        page.getByRole("heading", { level: 2, name: "HbA1c", exact: true }),
      );
      await expect(page.getByText("1 field needs attention.")).toBeVisible();
      await expect(page.getByText(/Needs attention: No unit/)).toBeVisible();
    } finally {
      await query(`UPDATE lab_test_catalog SET unit = '%' WHERE id = 990201`);
    }
  });
});
