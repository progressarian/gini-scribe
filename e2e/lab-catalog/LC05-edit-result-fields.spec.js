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
const MAN = { sex: "Male", ageYears: 40 };
const ids = {};

const catalogIdOf = async (name) =>
  (await query(`SELECT id FROM giniflow_test_catalog WHERE test_name = $1`, [name])).rows[0].id;

const read = async (catalogId) =>
  (await (await apiAs("admin")).get(`/api/lab-catalog/tests/${catalogId}`)).json();

const field = async (name) => (await read(ids.lipid)).report.fields.find((f) => f.name === name);

const bench = async (testName = "Lipid Profile") =>
  ((await catalogRowsFor([testName], MAN, getPool())).get(testName) || []).map((r) => r.testName);

const call = async (role, method, path, data) => {
  const api = await apiAs(role);
  const response = await api[method](`/api/lab-catalog${path}`, { data });
  return { status: response.status(), body: await response.json().catch(() => null) };
};

const cleanUp = async () => {
  await query(`DELETE FROM lab_report_catalog WHERE name LIKE 'LC05%'`);
  await query(`DELETE FROM lab_test_catalog WHERE name LIKE 'LC05%'`);
  await query(`UPDATE giniflow_test_catalog SET lab_report_id = NULL, results_as_file = FALSE
                WHERE test_name IN ('ABI', 'Fasting Blood Sugar')`);
  await removeLabCatalog(query);
};

test.describe.serial("LC05 editing a test's result fields", () => {
  test.beforeAll(async () => {
    await cleanUp();
    await seedLabCatalog(query);
    ids.lipid = await catalogIdOf("Lipid Profile");
    ids.abi = await catalogIdOf("ABI");
    ids.fbs = await catalogIdOf("Fasting Blood Sugar");
  });
  test.afterAll(cleanUp);

  test("1. link an existing report, unlink it, and a stale save is refused with who changed it", async () => {
    const before = await read(ids.abi);
    const linked = await call("admin", "put", `/tests/${ids.abi}/report`, {
      reportId: LAB_REPORTS[1].id,
      expectedUpdatedAt: before.updatedAt,
    });
    expect(linked.status).toBe(200);
    expect((await read(ids.abi)).report.name).toBe("HBA1C");

    const stale = await call("admin", "delete", `/tests/${ids.abi}/report`, {
      expectedUpdatedAt: before.updatedAt,
    });
    expect(stale.status).toBe(409);
    expect(stale.body.error).toMatch(/^Changed by E2E Admin at .+ — reload to see it$/);

    const now = await read(ids.abi);
    const unlinked = await call("admin", "delete", `/tests/${ids.abi}/report`, {
      expectedUpdatedAt: now.updatedAt,
    });
    expect(unlinked.status).toBe(200);
    expect((await read(ids.abi)).report).toBeNull();
  });

  test("2. create a report; a name clash points to the existing one", async () => {
    const clash = await call("admin", "post", `/tests/${ids.abi}/report`, {
      name: "Lipid Profile",
      expectedUpdatedAt: (await read(ids.abi)).updatedAt,
    });
    expect(clash.status).toBe(409);
    expect(clash.body.error).toBe(
      'A report called "LIPID PROFILE" already exists — link it instead',
    );

    const created = await call("admin", "post", `/tests/${ids.abi}/report`, {
      name: "LC05 ABI report",
      expectedUpdatedAt: (await read(ids.abi)).updatedAt,
    });
    expect(created.status).toBe(200);
    const abi = await read(ids.abi);
    expect(abi.report).toMatchObject({ name: "LC05 ABI report", fields: [] });
  });

  test("3. file-only is refused while a report is linked, and allowed without one", async () => {
    const linked = await call("admin", "put", `/tests/${ids.abi}/results-as-file`, {
      value: true,
      expectedUpdatedAt: (await read(ids.abi)).updatedAt,
    });
    expect(linked.status).toBe(409);
    const fbs = await call("admin", "put", `/tests/${ids.fbs}/results-as-file`, {
      value: true,
      expectedUpdatedAt: (await read(ids.fbs)).updatedAt,
    });
    expect(fbs.status).toBe(200);
    expect((await read(ids.fbs)).resultsAsFile).toBe(true);
  });

  test("4. add a field: a number needs a unit or 'no unit', names are unique, the bench shows it last", async () => {
    const path = `/reports/${LIPID.id}/fields`;
    const noUnit = await call("admin", "post", path, { name: "LC05 Lp(a)" });
    expect(noUnit.status).toBe(400);
    expect(noUnit.body.error).toMatch(/Enter a unit, or tick “No unit”/);
    const dupe = await call("admin", "post", path, { name: "hdl cholesterol", unit: "mg/dl" });
    expect(dupe.status).toBe(409);
    const added = await call("admin", "post", path, { name: "LC05 Lp(a)", unit: "mg/dl" });
    expect(added.status).toBe(200);
    const ratio = await call("admin", "post", path, { name: "LC05 Ratio", noUnit: true });
    expect(ratio.status).toBe(200);
    expect((await bench()).slice(-2)).toEqual(["LC05 Lp(a)", "LC05 Ratio"]);
  });

  test("5. editing a field: rename, unit and decimals reach the bench; stale saves are refused", async () => {
    const hdl = await field("HDL Cholesterol");
    const saved = await call("admin", "patch", `/fields/${hdl.id}`, {
      expectedUpdatedAt: hdl.updatedAt,
      reportId: LIPID.id,
      name: "HDL Cholesterol (direct)",
      unit: "mmol/L",
    });
    expect(saved.status).toBe(200);
    expect(await bench()).toContain("HDL Cholesterol (direct)");
    const stale = await call("admin", "patch", `/fields/${hdl.id}`, {
      expectedUpdatedAt: hdl.updatedAt,
      name: "Again",
    });
    expect(stale.status).toBe(409);

    const vldl = await field("VLDL Cholesterol");
    await call("admin", "patch", `/fields/${vldl.id}`, {
      expectedUpdatedAt: vldl.updatedAt,
      decimals: 1,
    });
    const rows = (await catalogRowsFor(["Lipid Profile"], MAN, getPool())).get("Lipid Profile");
    const vldlRow = rows.find((r) => r.testName === "VLDL Cholesterol");
    expect(vldlRow.decimals).toBe(1);
    const values = computeFormulas(
      rows.map((r) => ({ id: r.testId, formula: r.formula, decimals: r.decimals })),
      { [LAB_FIELDS.triglycerides.id]: 151 },
    );
    expect(values[vldlRow.testId]).toBe(30.2);
  });

  test("6. a field used in a formula cannot be turned off; a calculated field cannot be required or retyped", async () => {
    const tg = await field("Triglycerides");
    const off = await call("admin", "patch", `/fields/${tg.id}`, {
      expectedUpdatedAt: tg.updatedAt,
      active: false,
    });
    expect(off.status).toBe(409);
    expect(off.body.error).toBe(
      "Used in the formula of VLDL Cholesterol — change that formula first",
    );

    const vldl = await field("VLDL Cholesterol");
    const required = await call("admin", "patch", `/fields/${vldl.id}`, {
      expectedUpdatedAt: vldl.updatedAt,
      reportId: LIPID.id,
      required: true,
    });
    expect(required.status).toBe(400);
    const retype = await call("admin", "patch", `/fields/${vldl.id}`, {
      expectedUpdatedAt: vldl.updatedAt,
      type: "text",
    });
    expect(retype.status).toBe(409);

    const turnedOff = await call("admin", "patch", `/fields/${vldl.id}`, {
      expectedUpdatedAt: vldl.updatedAt,
      active: false,
    });
    expect(turnedOff.status).toBe(200);
    expect(await bench()).not.toContain("VLDL Cholesterol");
  });

  test("7. moving a field changes the bench order", async () => {
    const before = await bench();
    const tg = await field("Triglycerides");
    const moved = await call("admin", "put", `/reports/${LIPID.id}/order`, {
      fieldId: Number(tg.id),
      direction: "up",
    });
    expect(moved.status).toBe(200);
    const after = await bench();
    expect(after.slice(0, 2)).toEqual([before[1], before[0]]);
  });

  test("8. every change is in the history with who made it", async () => {
    const history = await (
      await (await apiAs("admin")).get(`/api/lab-catalog/tests/${ids.lipid}/history`)
    ).json();
    const kinds = history.map((h) => `${h.entity}:${h.action}`);
    for (const kind of ["field:create", "field:update", "order:move"])
      expect(kinds).toContain(kind);
    const edits = history.filter((h) => ["field", "order"].includes(h.entity));
    expect(edits.length).toBeGreaterThan(0);
    expect(edits.every((h) => h.actor === "E2E Admin")).toBe(true);
  });

  test("9. lab admin may edit; the lab bench may not", async () => {
    const hdl = await field("HDL Cholesterol (direct)");
    expect(
      (
        await call("lab", "patch", `/fields/${hdl.id}`, {
          expectedUpdatedAt: hdl.updatedAt,
          unit: "x",
        })
      ).status,
    ).toBe(403);
    const byLabAdmin = await call("lab_admin", "patch", `/fields/${hdl.id}`, {
      expectedUpdatedAt: hdl.updatedAt,
      reportId: LIPID.id,
      name: "HDL Cholesterol",
      unit: "mg/dl",
    });
    expect(byLabAdmin.status).toBe(200);
  });

  test("10. on screen: edit a field's unit, add a field, and set up a test from nothing", async ({
    page,
  }) => {
    await loginAs(page, "lab_admin");
    await gotoReady(page, `/settings/tests/${ids.lipid}`, () =>
      page.getByRole("heading", { level: 2, name: "Lipid Profile", exact: true }),
    );
    await page.getByRole("button", { name: "Edit Total Cholesterol" }).click();
    const editor = page.getByRole("form", { name: "Edit Total Cholesterol" });
    await editor.getByLabel("Unit", { exact: true }).fill("mmol/L");
    await editor.getByRole("button", { name: "Save field" }).click();
    await expect(page.getByRole("row", { name: /Total Cholesterol/ }).first()).toContainText(
      "mmol/L",
    );

    await page.getByRole("button", { name: "Edit Triglycerides" }).click();
    const tgEditor = page.getByRole("form", { name: "Edit Triglycerides" });
    await tgEditor.getByLabel("Unit", { exact: true }).fill("");
    await tgEditor.getByRole("button", { name: "Save field" }).click();
    await expect(tgEditor.getByText("Enter a unit, or tick “No unit”.")).toBeVisible();
    await tgEditor.getByRole("button", { name: "Cancel" }).click();

    const add = page.getByRole("form", { name: "Add a field to LIPID PROFILE" });
    await add.getByLabel("Name (required)").fill("LC05 Apo B");
    await add.getByLabel("Unit", { exact: true }).fill("mg/dl");
    await add.getByRole("button", { name: "Add field" }).click();
    await expect(page.getByRole("row", { name: /LC05 Apo B/ })).toBeVisible();

    await gotoReady(page, `/settings/tests/${ids.abi}`, () =>
      page.getByRole("heading", { level: 2, name: "ABI", exact: true }),
    );
    await page.getByRole("button", { name: "Unlink…" }).click();
    await page.getByRole("button", { name: "Unlink report" }).click();
    await expect(page.getByText("No result fields yet.")).toBeVisible();
    await page.getByLabel("Search reports by name").fill("rft");
    await page.getByRole("button", { name: "Link RFT to ABI" }).click();
    await expect(page.getByText("Result report:")).toContainText("RFT");
    await expect(page.getByRole("row", { name: /^1 Blood Urea Nitrogen/ })).toBeVisible();
  });
});
