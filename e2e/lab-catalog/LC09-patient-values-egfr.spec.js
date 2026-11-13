import { test, expect } from "@playwright/test";
import { apiAs, loginAs } from "../helpers/auth.mjs";
import { getPool, one, query } from "../helpers/db.mjs";
import { gotoReady } from "../helpers/browser.mjs";
import { PATIENTS } from "../fixtures/data.mjs";
import {
  LAB_FIELDS,
  LAB_REPORTS,
  removeLabCatalog,
  seedLabCatalog,
} from "../fixtures/labCatalog.mjs";
import { orderPatientValues, saveResults } from "../../server/services/giniflow/labResults.js";

const RFT = LAB_REPORTS[2];
const CREAT = String(LAB_FIELDS.creatinine.id);
const CKD_EPI =
  `142 * min(#${CREAT} / (0.9 - 0.2 * @female), 1) ^ (-0.302 + 0.061 * @female)` +
  ` * max(#${CREAT} / (0.9 - 0.2 * @female), 1) ^ -1.2 * 0.9938 ^ @age * (1 + 0.012 * @female)`;
const COCKCROFT = `((140 - @age) * @weight * (1 - 0.15 * @female)) / (72 * #${CREAT})`;

const reference = (scr, age, female) => {
  const k = female ? 0.7 : 0.9;
  const a = female ? -0.241 : -0.302;
  const v = 142 * Math.min(scr / k, 1) ** a * Math.max(scr / k, 1) ** -1.2 * 0.9938 ** age;
  return Math.round(v * (female ? 1.012 : 1) * 10) / 10;
};

const ids = {};
const today = `(NOW() AT TIME ZONE 'Asia/Kolkata')::date`;

const addField = async (data) => {
  const api = await apiAs("admin");
  const response = await api.post(`/api/lab-catalog/reports/${RFT.id}/fields`, { data });
  return { status: response.status(), body: await response.json() };
};

const rftFields = async () => {
  const api = await apiAs("admin");
  return (await (await api.get(`/api/lab-catalog/tests/${ids.rft}`)).json()).report.fields;
};

async function visitFor(patient) {
  if (ids.visitOf[patient.id]) return { id: ids.visitOf[patient.id] };
  await query(`DELETE FROM giniflow_visits WHERE patient_id = $1 AND visit_date = ${today}`, [
    patient.id,
  ]);
  const visit = await one(
    `INSERT INTO giniflow_visits (patient_id, visit_date, current_status)
     VALUES ($1, ${today}, 'arrived') RETURNING id`,
    [patient.id],
  );
  ids.visitOf[patient.id] = visit.id;
  ids.visits.push(visit.id);
  return visit;
}

async function newOrder(patient) {
  const visit = await visitFor(patient);
  const order = await one(
    `INSERT INTO giniflow_lab_orders (visit_id, urgency, payment_status, sample_status, kind)
     VALUES ($1, 'today', 'paid', 'sample_received', 'lab') RETURNING id`,
    [visit.id],
  );
  await query(
    `INSERT INTO giniflow_lab_order_tests (lab_order_id, test_name, price) VALUES ($1, 'RFT', 0)`,
    [order.id],
  );
  ids.orders.push(order.id);
  return { visit: visit.id, order: order.id };
}

const saved = async (orderId, name) => {
  const { rows } = await query(
    `SELECT result FROM lab_results WHERE lab_order_id = $1 AND test_name = $2`,
    [orderId, name],
  );
  return rows[0]?.result == null ? null : Number(rows[0].result);
};

const enter = (orderId, creatinine) =>
  saveResults(
    orderId,
    {
      rows: [
        { testId: CREAT, testName: "Creatinine, Serum", value: creatinine },
        { testId: ids.egfr, testName: "LC09 eGFR", value: 1 },
        { testId: ids.crcl, testName: "LC09 CrCl", value: 1 },
      ],
    },
    getPool(),
  );

const cleanUp = async () => {
  if (ids.orders?.length) {
    await query(`DELETE FROM lab_results WHERE lab_order_id = ANY($1::uuid[])`, [ids.orders]);
  }
  if (ids.visits?.length) {
    await query(`DELETE FROM giniflow_visits WHERE id = ANY($1::uuid[])`, [ids.visits]);
  }
  await query(`UPDATE patients SET sex = 'Male' WHERE id = $1`, [PATIENTS.general.id]);
  await query(`DELETE FROM lab_test_catalog WHERE name LIKE 'LC09%'`);
  await removeLabCatalog(query);
};

test.describe.serial("LC09 patient values in formulas (eGFR)", () => {
  test.beforeAll(async () => {
    ids.visits = [];
    ids.orders = [];
    ids.visitOf = {};
    await query(`DELETE FROM lab_test_catalog WHERE name LIKE 'LC09%'`);
    await removeLabCatalog(query);
    await seedLabCatalog(query);
    ids.rft = (await one(`SELECT id FROM giniflow_test_catalog WHERE test_name = 'RFT'`)).id;
  });
  test.afterAll(cleanUp);

  test("1. eGFR and creatinine clearance are ordinary calculated fields", async () => {
    const egfr = await addField({
      name: "LC09 eGFR",
      unit: "mL/min/1.73m²",
      decimals: 1,
      formula: CKD_EPI,
    });
    expect(egfr.status, JSON.stringify(egfr.body)).toBe(200);
    const crcl = await addField({ name: "LC09 CrCl", unit: "mL/min", formula: COCKCROFT });
    expect(crcl.status, JSON.stringify(crcl.body)).toBe(200);
    const fields = await rftFields();
    ids.egfr = fields.find((f) => f.name === "LC09 eGFR").id;
    ids.crcl = fields.find((f) => f.name === "LC09 CrCl").id;
    expect(fields.find((f) => f.name === "LC09 CrCl").formula.text).toBe(
      "((140 − age) × weight × (1 − 0.15 × female)) ÷ (72 × Creatinine, Serum)",
    );
  });

  test("2. a man's eGFR matches CKD-EPI 2021; no weight today means no clearance", async () => {
    const { order } = await newOrder(PATIENTS.general);
    await enter(order, 1.0);
    expect(await saved(order, "LC09 eGFR")).toBeCloseTo(
      reference(1.0, PATIENTS.general.age, false),
      5,
    );
    expect(await saved(order, "LC09 CrCl")).toBeNull();
    expect(await orderPatientValues(order, getPool())).toEqual({
      age: 40,
      female: 0,
      weight: null,
    });
  });

  test("3. a woman's eGFR uses the female constants", async () => {
    const { order } = await newOrder(PATIENTS.senior);
    await enter(order, 0.8);
    expect(await saved(order, "LC09 eGFR")).toBeCloseTo(
      reference(0.8, PATIENTS.senior.age, true),
      5,
    );
  });

  test("4. weight counts only from the same day's vitals", async () => {
    const { visit, order } = await newOrder(PATIENTS.general);
    await query(
      `INSERT INTO giniflow_vitals (visit_id, patient_id, weight, recorded_at)
       VALUES ($1, $2, 80, NOW() - INTERVAL '1 day')`,
      [visit, PATIENTS.general.id],
    );
    await enter(order, 1.0);
    expect(await saved(order, "LC09 CrCl")).toBeNull();

    await query(
      `INSERT INTO giniflow_vitals (visit_id, patient_id, weight, recorded_at) VALUES ($1, $2, 70, NOW())`,
      [visit, PATIENTS.general.id],
    );
    await enter(order, 1.0);
    expect(await saved(order, "LC09 CrCl")).toBeCloseTo(97.22, 5);
    expect(await orderPatientValues(order, getPool())).toEqual({ age: 40, female: 0, weight: 70 });
  });

  test("5. a patient whose sex is not Male or Female gets no eGFR rather than a guess", async () => {
    await query(`UPDATE patients SET sex = 'Other' WHERE id = $1`, [PATIENTS.general.id]);
    const { order } = await newOrder(PATIENTS.general);
    await enter(order, 1.0);
    expect(await saved(order, "Creatinine, Serum")).toBe(1);
    expect(await saved(order, "LC09 eGFR")).toBeNull();
  });

  test("6. on screen: the builder offers patient values and previews with them", async ({
    page,
  }) => {
    await loginAs(page, "lab_admin");
    await gotoReady(page, `/settings/tests/${ids.rft}`, () =>
      page.getByRole("heading", { level: 2, name: "RFT", exact: true }),
    );
    const add = page.getByRole("form", { name: "Add a field to RFT" });
    await add.getByLabel("Name (required)").fill("LC09 Age-adjusted");
    await add.getByLabel("Type").selectOption("calculated");
    await add.getByLabel("No unit").check();
    await add.getByLabel("Field", { exact: true }).selectOption({ label: "Creatinine, Serum" });
    await add.getByRole("button", { name: "Insert times" }).click();
    await expect(add.getByRole("button", { name: "Insert the patient's age (years)" })).toHaveCount(
      0,
    );
    await add.getByLabel(/Uses the patient's age, sex or weight/).check();
    await add.getByRole("button", { name: "Insert the patient's age (years)" }).click();
    await expect(add.getByText("Reads as:")).toContainText("Creatinine, Serum × age");
    await add.getByLabel("Patient age (years)").fill("50");
    await add.getByLabel("Creatinine, Serum (mg/dl)").fill("1.2");
    await expect(add.getByText("Result:")).toContainText("60");
    await add.getByRole("button", { name: "Add field" }).click();
    await expect(page.getByRole("row", { name: /LC09 Age-adjusted/ })).toContainText(
      "Creatinine, Serum × age",
    );
  });
});
