import { test, expect } from "@playwright/test";
import { apiAs, loginAs } from "../helpers/auth.mjs";
import { getPool, query } from "../helpers/db.mjs";
import { gotoReady } from "../helpers/browser.mjs";
import {
  LAB_FIELDS,
  LAB_REPORTS,
  removeLabCatalog,
  seedLabCatalog,
} from "../fixtures/labCatalog.mjs";
import { catalogRowsFor } from "../../server/services/giniflow/labCatalog.js";
import { computeFormulas } from "../../shared/labFormula.js";

const [LIPID] = LAB_REPORTS;
const F = LAB_FIELDS;
const ids = {};

const cleanUp = async () => {
  await query(`DELETE FROM lab_test_catalog WHERE name LIKE 'LC07%'`);
  await removeLabCatalog(query);
};

const lipid = async () => {
  const api = await apiAs("admin");
  return (await (await api.get(`/api/lab-catalog/tests/${ids.lipid}`)).json()).report.fields;
};
const field = async (name) => (await lipid()).find((f) => f.name === name);

const addField = async (data) => {
  const api = await apiAs("admin");
  const response = await api.post(`/api/lab-catalog/reports/${LIPID.id}/fields`, { data });
  return { status: response.status(), body: await response.json() };
};

const patch = async (name, data) => {
  const f = await field(name);
  const api = await apiAs("admin");
  const response = await api.patch(`/api/lab-catalog/fields/${f.id}`, {
    data: { expectedUpdatedAt: f.updatedAt, reportId: LIPID.id, ...data },
  });
  return { status: response.status(), body: await response.json() };
};

const benchRows = async () =>
  (await catalogRowsFor(["Lipid Profile"], { sex: "Male", ageYears: 40 }, getPool())).get(
    "Lipid Profile",
  );

test.describe.serial("LC07 formulas", () => {
  test.beforeAll(async () => {
    await cleanUp();
    await seedLabCatalog(query);
    ids.lipid = (
      await query(`SELECT id FROM giniflow_test_catalog WHERE test_name = 'Lipid Profile'`)
    ).rows[0].id;
  });
  test.afterAll(cleanUp);

  test("1. a new calculated field is not required and computes on the bench", async () => {
    const added = await addField({
      name: "LC07 TG / HDL",
      noUnit: true,
      formula: `#${F.triglycerides.id} / #${F.hdl.id}`,
    });
    expect(added.status, JSON.stringify(added.body)).toBe(200);
    const row = (await benchRows()).find((r) => r.testName === "LC07 TG / HDL");
    expect(row).toMatchObject({ calculated: true, required: false });
    const rows = await benchRows();
    const values = computeFormulas(
      rows.map((r) => ({ id: r.testId, formula: r.formula, decimals: r.decimals })),
      { [F.triglycerides.id]: 150, [F.hdl.id]: 40 },
    );
    expect(values[row.testId]).toBe(3.75);
    expect((await field("LC07 TG / HDL")).formula.text).toBe("Triglycerides ÷ HDL Cholesterol");
  });

  test("2. broken, foreign, self-referring and text-based formulas are refused with a reason", async () => {
    const cases = [
      [`(#${F.triglycerides.id} / 5`, "Formula: A bracket is not closed"],
      [`#${F.triglycerides.id} #${F.hdl.id}`, "Formula: Two values need a sign between them"],
      ["5 * 2", "Formula: Use at least one field"],
      [`#${F.bun.id} * 2`, "Formula: Blood Urea Nitrogen is not in this report"],
      [`#999999999 * 2`, "Formula: it uses a field that no longer exists"],
    ];
    for (const [formula, message] of cases) {
      const result = await patch("LC07 TG / HDL", { formula });
      expect(result.status, formula).toBe(400);
      expect(result.body.error).toBe(message);
    }
    const self = await field("LC07 TG / HDL");
    const selfRef = await patch("LC07 TG / HDL", { formula: `#${self.id} * 2` });
    expect(selfRef.body.error).toBe("Formula: a field cannot use itself");

    await addField({ name: "LC07 Comment", type: "text" });
    const comment = await field("LC07 Comment");
    const textInput = await patch("LC07 TG / HDL", { formula: `#${comment.id} * 2` });
    expect(textInput.body.error).toBe("Formula: LC07 Comment is not a number field");
  });

  test("3. a loop across two calculated fields is refused and named", async () => {
    const ok = await patch("LC07 TG / HDL", { formula: `#${F.vldl.id} / #${F.hdl.id}` });
    expect(ok.status).toBe(200);
    const mine = await field("LC07 TG / HDL");
    const loop = await patch("VLDL Cholesterol", { formula: `#${mine.id} * 5` });
    expect(loop.status).toBe(400);
    expect(loop.body.error).toBe(
      "Formula: it would go round in a loop (VLDL Cholesterol → LC07 TG / HDL → VLDL Cholesterol)",
    );
  });

  test("4. a typed field becomes calculated, stops being required, and can go back", async () => {
    const made = await patch("LDL Cholesterol", {
      formula: `#${F.totalCholesterol.id} - #${F.hdl.id} - #${F.vldl.id}`,
    });
    expect(made.status, JSON.stringify(made.body)).toBe(200);
    let ldl = (await benchRows()).find((r) => r.testName === "LDL Cholesterol");
    expect(ldl).toMatchObject({ calculated: true, required: false });
    expect((await field("LDL Cholesterol")).formula.text).toBe(
      "Total Cholesterol − HDL Cholesterol − VLDL Cholesterol",
    );

    const back = await patch("LDL Cholesterol", { formula: null, type: "numeric" });
    expect(back.status, JSON.stringify(back.body)).toBe(200);
    ldl = (await benchRows()).find((r) => r.testName === "LDL Cholesterol");
    expect(ldl.calculated).toBe(false);
    expect((await field("LDL Cholesterol")).type).toBe("numeric");
  });

  test("5. a number field used in a formula cannot become text", async () => {
    const result = await patch("HDL Cholesterol", { type: "text" });
    expect(result.status).toBe(409);
    expect(result.body.error).toMatch(/^Used in the formula of .+ — change that formula first$/);
  });

  test("6. an imported formula may keep an input from another report, but not gain a new one", async () => {
    await query(`UPDATE lab_test_catalog SET formula = $2 WHERE id = $1`, [
      F.ldlHdlRatio.id,
      `#${F.ldl.id} / #${F.creatinine.id}`,
    ]);
    const kept = await patch("LDL / HDL Cholesterol Ratio", {
      formula: `(#${F.ldl.id} + 1) / #${F.creatinine.id}`,
    });
    expect(kept.status, JSON.stringify(kept.body)).toBe(200);
    const gained = await patch("LDL / HDL Cholesterol Ratio", {
      formula: `#${F.ldl.id} / #${F.bun.id}`,
    });
    expect(gained.body.error).toBe("Formula: Blood Urea Nitrogen is not in this report");
  });

  test("7. on screen: build a formula from chips, preview it and save", async ({ page }) => {
    await loginAs(page, "lab_admin");
    await gotoReady(page, `/settings/tests/${ids.lipid}`, () =>
      page.getByRole("heading", { level: 2, name: "Lipid Profile", exact: true }),
    );
    const add = page.getByRole("form", { name: "Add a field to LIPID PROFILE" });
    await add.getByLabel("Name (required)").fill("LC07 Half TG");
    await add.getByLabel("Type").selectOption("calculated");
    await add.getByLabel("Unit", { exact: true }).fill("mg/dl");
    await add.getByLabel("Field", { exact: true }).selectOption({ label: "Triglycerides" });
    await add.getByRole("button", { name: "Insert field" }).click();
    await add.getByRole("button", { name: "Insert divided by" }).click();
    await add.getByRole("button", { name: "Add field" }).click();
    await expect(add.getByText("The formula ends too early.")).toBeVisible();
    await add.getByLabel("Number", { exact: true }).fill("2");
    await add.getByRole("button", { name: "Insert number" }).click();
    await expect(add.getByText("Reads as:")).toContainText("Triglycerides ÷ 2");
    await add.getByLabel("Triglycerides (mg/dl)").fill("151");
    await expect(add.getByText("Result:")).toContainText("75.5 mg/dl");
    await add.getByRole("button", { name: "Add field" }).click();
    const row = page.getByRole("row", { name: /LC07 Half TG/ });
    await expect(row).toContainText("Triglycerides ÷ 2");
    await expect(row).toContainText("Calculated");
  });

  test("8. the picker hides fields that would loop back, and Add field keeps its decimals", async ({
    page,
  }) => {
    await loginAs(page, "lab_admin");
    await gotoReady(page, `/settings/tests/${ids.lipid}`, () =>
      page.getByRole("heading", { level: 2, name: "Lipid Profile", exact: true }),
    );
    await page.getByRole("button", { name: "Edit VLDL Cholesterol" }).click();
    const editor = page.getByRole("form", { name: "Edit VLDL Cholesterol" });
    const picker = editor.getByLabel("Field", { exact: true });
    await expect(picker.locator("option", { hasText: "Triglycerides" })).toHaveCount(1);
    await expect(picker.locator("option", { hasText: "LC07 TG / HDL" })).toHaveCount(0);
    await expect(picker.locator("option", { hasText: "VLDL Cholesterol" })).toHaveCount(0);
    await editor.getByRole("button", { name: "Cancel" }).click();

    const add = page.getByRole("form", { name: "Add a field to LIPID PROFILE" });
    await add.getByLabel("Name (required)").fill("LC07 One decimal");
    await add.getByLabel("Unit", { exact: true }).fill("mg/dl");
    await add.getByLabel("Decimals").selectOption("1");
    await add.getByRole("button", { name: "Add field" }).click();
    await expect(page.getByRole("row", { name: /LC07 One decimal/ })).toBeVisible();
    expect((await field("LC07 One decimal")).decimals).toBe(1);
  });
});
