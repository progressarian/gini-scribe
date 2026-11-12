import { test, expect } from "@playwright/test";
import { apiAs, loginAs } from "../helpers/auth.mjs";
import { getPool, one, query } from "../helpers/db.mjs";
import { gotoReady } from "../helpers/browser.mjs";
import { PATIENTS } from "../fixtures/data.mjs";
import { LAB_REPORTS, removeLabCatalog, seedLabCatalog } from "../fixtures/labCatalog.mjs";
import { saveResults, suggestedRows } from "../../server/services/giniflow/labResults.js";

const [LIPID] = LAB_REPORTS;
const ids = {};

const addField = async (data) => {
  const api = await apiAs("admin");
  const response = await api.post(`/api/lab-catalog/reports/${LIPID.id}/fields`, { data });
  return { status: response.status(), body: await response.json() };
};

const lipidFields = async () => {
  const api = await apiAs("admin");
  return (await (await api.get(`/api/lab-catalog/tests/${ids.lipid}`)).json()).report.fields;
};

const cleanUp = async () => {
  if (ids.order) await query(`DELETE FROM lab_results WHERE lab_order_id = $1`, [ids.order]);
  if (ids.visit) await query(`DELETE FROM giniflow_visits WHERE id = $1`, [ids.visit]);
  await query(`DELETE FROM lab_test_catalog WHERE name LIKE 'LC08%'`);
  await removeLabCatalog(query);
};

test.describe.serial("LC08 pick-list fields", () => {
  test.beforeAll(async () => {
    await removeLabCatalog(query);
    await query(`DELETE FROM lab_test_catalog WHERE name LIKE 'LC08%'`);
    await seedLabCatalog(query);
    ids.lipid = (
      await one(`SELECT id FROM giniflow_test_catalog WHERE test_name = 'Lipid Profile'`)
    ).id;
    ids.visit = (
      await one(
        `INSERT INTO giniflow_visits (patient_id, visit_date, current_status)
         VALUES ($1, (NOW() AT TIME ZONE 'Asia/Kolkata')::date, 'arrived') RETURNING id`,
        [PATIENTS.general.id],
      )
    ).id;
    ids.order = (
      await one(
        `INSERT INTO giniflow_lab_orders (visit_id, urgency, payment_status, sample_status, kind)
         VALUES ($1, 'today', 'paid', 'sample_received', 'lab') RETURNING id`,
        [ids.visit],
      )
    ).id;
    await query(
      `INSERT INTO giniflow_lab_order_tests (lab_order_id, test_name, price) VALUES ($1, 'Lipid Profile', 0)`,
      [ids.order],
    );
  });
  test.afterAll(cleanUp);

  test("1. a pick list needs at least two different choices", async () => {
    const single = await addField({ name: "LC08 Serum look", type: "select", options: ["Clear"] });
    expect(single.status).toBe(400);
    expect(single.body.error).toBe("A pick list needs at least 2 choices");
    const dupes = await addField({
      name: "LC08 Serum look",
      type: "select",
      options: ["Clear", "clear"],
    });
    expect(dupes.body.error).toBe("Each choice must be different");
    const ok = await addField({
      name: "LC08 Serum look",
      type: "select",
      options: ["Clear", "Turbid", "Lipaemic"],
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const field = (await lipidFields()).find((f) => f.name === "LC08 Serum look");
    expect(field).toMatchObject({ type: "select", options: ["Clear", "Turbid", "Lipaemic"] });
    ids.field = field.id;
  });

  test("2. the lab form receives the choices for the field", async () => {
    const groups = await suggestedRows(ids.order, getPool());
    const row = groups[0].params.find((p) => p.testName === "LC08 Serum look");
    expect(row).toMatchObject({ inputType: "select", options: ["Clear", "Turbid", "Lipaemic"] });
  });

  test("3. saving keeps only a listed choice, in its listed spelling", async () => {
    const bad = saveResults(
      ids.order,
      {
        rows: [{ testId: ids.field, testName: "LC08 Serum look", value: "Milky" }],
      },
      getPool(),
    );
    await expect(bad).rejects.toMatchObject({
      status: 400,
      message: "LC08 Serum look: choose one of Clear, Turbid, Lipaemic",
    });

    await saveResults(
      ids.order,
      {
        rows: [{ testId: ids.field, testName: "LC08 Serum look", value: "turbid" }],
      },
      getPool(),
    );
    const saved = await one(
      `SELECT result, result_text, flag FROM lab_results WHERE lab_order_id = $1 AND test_name = 'LC08 Serum look'`,
      [ids.order],
    );
    expect(saved).toEqual({ result: null, result_text: "Turbid", flag: null });
  });

  test("4. on screen: add a pick-list field and set its choices", async ({ page }) => {
    await loginAs(page, "lab_admin");
    await gotoReady(page, `/settings/tests/${ids.lipid}`, () =>
      page.getByRole("heading", { level: 2, name: "Lipid Profile", exact: true }),
    );
    const add = page.getByRole("form", { name: "Add a field to LIPID PROFILE" });
    await add.getByLabel("Name (required)").fill("LC08 Fasting");
    await add.getByLabel("Type").selectOption("select");
    await add.getByLabel("LC08 Fasting choice 1").fill("Yes");
    await add.getByRole("button", { name: "Add field" }).click();
    await expect(add.getByText("Add at least 2 choices.")).toBeVisible();
    await add.getByLabel("LC08 Fasting choice 2").fill("yes");
    await add.getByRole("button", { name: "Add field" }).click();
    await expect(add.getByText("Each choice must be different.")).toBeVisible();
    await add.getByLabel("LC08 Fasting choice 2").fill("No");
    await add.getByRole("button", { name: "+ Add choice" }).click();
    await add.getByLabel("LC08 Fasting choice 3").fill("Not known");
    await add.getByRole("button", { name: "Add field" }).click();
    const row = page.getByRole("row", { name: /LC08 Fasting/ });
    await expect(row).toContainText("Pick list");
    await expect(row).toContainText("Yes / No / Not known");
  });
});
