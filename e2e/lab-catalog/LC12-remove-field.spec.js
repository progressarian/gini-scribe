import { test, expect } from "@playwright/test";
import { apiAs, loginAs } from "../helpers/auth.mjs";
import { one, query } from "../helpers/db.mjs";
import { gotoReady } from "../helpers/browser.mjs";
import {
  LAB_FIELDS,
  LAB_REPORTS,
  removeLabCatalog,
  seedLabCatalog,
} from "../fixtures/labCatalog.mjs";

const [LIPID, , RFT] = LAB_REPORTS;
const F = LAB_FIELDS;
const ids = {};

const fieldsOf = async (catalogName) => {
  const api = await apiAs("admin");
  const { id } = await one(`SELECT id FROM giniflow_test_catalog WHERE test_name = $1`, [
    catalogName,
  ]);
  return (await (await api.get(`/api/lab-catalog/tests/${id}`)).json()).report.fields;
};

const remove = async (reportId, field) => {
  const api = await apiAs("lab_admin");
  const response = await api.delete(`/api/lab-catalog/reports/${reportId}/fields/${field.id}`, {
    data: { expectedUpdatedAt: field.updatedAt },
  });
  return { status: response.status(), body: await response.json() };
};

const cleanUp = async () => {
  await query(`DELETE FROM lab_test_catalog WHERE name LIKE 'LC12%'`);
  await removeLabCatalog(query);
};

test.describe.serial("LC12 removing a field", () => {
  test.beforeAll(async () => {
    await cleanUp();
    await seedLabCatalog(query);
    ids.lipid = (
      await one(`SELECT id FROM giniflow_test_catalog WHERE test_name = 'Lipid Profile'`)
    ).id;
  });
  test.afterAll(cleanUp);

  test("1. a field another formula uses cannot be removed", async () => {
    const hdl = (await fieldsOf("Lipid Profile")).find((f) => f.name === "HDL Cholesterol");
    const result = await remove(LIPID.id, hdl);
    expect(result.status).toBe(409);
    expect(result.body.error).toMatch(/^Used in the formula of .+ — change that formula first$/);
  });

  test("2. a field in one report is switched off and leaves the report", async () => {
    const ldlRatio = (await fieldsOf("Lipid Profile")).find(
      (f) => f.name === "LDL / HDL Cholesterol Ratio",
    );
    const result = await remove(LIPID.id, ldlRatio);
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(result.body.keptElsewhere).toBe(false);
    expect((await fieldsOf("Lipid Profile")).map((f) => f.name)).not.toContain(
      "LDL / HDL Cholesterol Ratio",
    );
    const row = await one(`SELECT is_active FROM lab_test_catalog WHERE id = $1`, [
      F.ldlHdlRatio.id,
    ]);
    expect(row.is_active).toBe(false);
    const audit = await one(
      `SELECT action FROM lab_catalog_audit WHERE entity = 'field' AND entity_id = $1
        ORDER BY at DESC LIMIT 1`,
      [String(F.ldlHdlRatio.id)],
    );
    expect(audit.action).toBe("remove");
  });

  test("3. a field shared with another report stays on there", async () => {
    await query(`INSERT INTO lab_report_tests (report_id, test_id, sequence) VALUES ($1, $2, 99)`, [
      RFT.id,
      F.triglycerides.id,
    ]);
    await query(`UPDATE lab_test_catalog SET formula = NULL WHERE id = $1`, [F.vldl.id]);
    const tg = (await fieldsOf("Lipid Profile")).find((f) => f.name === "Triglycerides");
    const result = await remove(LIPID.id, tg);
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(result.body.keptElsewhere).toBe(true);
    expect((await fieldsOf("RFT")).map((f) => f.name)).toContain("Triglycerides");
  });

  test("4. dividing by female is refused", async () => {
    const api = await apiAs("admin");
    const response = await api.post(`/api/lab-catalog/reports/${LIPID.id}/fields`, {
      data: { name: "LC12 Bad", noUnit: true, formula: `#${F.hdl.id} / @female` },
    });
    expect(response.status()).toBe(400);
    expect((await response.json()).error).toBe(
      "Formula: dividing by female divides by zero for every man",
    );
  });

  test("5. on screen: Remove asks first, then the row goes", async ({ page }) => {
    const api = await apiAs("admin");
    await api.post(`/api/lab-catalog/reports/${LIPID.id}/fields`, {
      data: { name: "LC12 Typo field", noUnit: true },
    });
    await loginAs(page, "lab_admin");
    await gotoReady(page, `/settings/tests/${ids.lipid}`, () =>
      page.getByRole("heading", { level: 2, name: "Lipid Profile", exact: true }),
    );
    await page.getByRole("button", { name: "Remove LC12 Typo field" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText("Remove LC12 Typo field from LIPID PROFILE?");
    await dialog.getByRole("button", { name: "Remove field" }).click();
    await expect(page.getByRole("row", { name: /LC12 Typo field/ })).toHaveCount(0);
  });
});

test("LC12 extra: an empty result box never shows a High, Low or Critical flag", async () => {
  const { flagFor } = await import("../../shared/labFormula.js");
  const range = { minValue: 40, maxValue: 60, minCritical: 20 };
  for (const blank of ["", "  ", null, undefined]) {
    expect(flagFor(blank, range)).toEqual({ flag: null, critical: false });
  }
  expect(flagFor("0", range)).toEqual({ flag: "L", critical: true });
  expect(flagFor(35, range)).toEqual({ flag: "L", critical: false });
});
