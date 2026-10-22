import { test, expect } from "@playwright/test";
import { query } from "../helpers/db.mjs";
import { apiAs, loginAs } from "../helpers/auth.mjs";
import { gotoReady } from "../helpers/browser.mjs";
import { assertTestDatabase } from "../setup/guard.mjs";
import { CONSULTANTS } from "../fixtures/data.mjs";
import { extraVisit, newTag, setUp, tearDown } from "../billing/phase4/p4-bills-fixture.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);

const tag = newTag();
let ids;
let made;
let consultationId;

const base = () => `/api/giniflow/stations/doctor/${made.visit}`;
const draft = async () =>
  (
    await query(
      `SELECT medicine_name, change_type, dose FROM giniflow_rx_items WHERE visit_id = $1
        ORDER BY medicine_name`,
      [made.visit],
    )
  ).rows;
const med = async (name) =>
  (
    await query(
      `SELECT name, dose, is_active, stop_reason, consultation_id FROM medications
        WHERE patient_id = $1 AND name = $2 ORDER BY is_active DESC, id DESC LIMIT 1`,
      [made.patient, name],
    )
  ).rows[0];
const visitRow = async () =>
  (
    await query(
      `SELECT current_status, editing_by, amended_at, amendments FROM giniflow_visits WHERE id = $1`,
      [made.visit],
    )
  ).rows[0];

test.describe.serial("G116 a finalized consultation can be edited the same day", () => {
  test.beforeAll(async () => {
    ids = await setUp(tag);
    made = await extraVisit(ids, "Amend", { healthray: false });
    await query(`UPDATE giniflow_visits SET current_status = 'with_doctor' WHERE id = $1`, [
      made.visit,
    ]);
    await query(
      `INSERT INTO medications (patient_id, name, dose, frequency, is_active, change_type)
       VALUES ($1, 'G116 Metformin', '500 mg', 'BD', true, 'continued')`,
      [made.patient],
    );
    const { db } = await import("../billing/phase4b/p4b-refunds.mjs");
    const rx = await import("../../server/services/giniflow/prescription.js");
    const { finalizeConsult } = await import("../../server/services/giniflow/finalize.js");
    await rx.seedDraftFromRegimen(made.visit, db);
    for (const [name, dose] of [
      ["G116 Telma", "40 mg"],
      ["G116 Rosuvas", "10 mg"],
    ]) {
      await rx.addItem(
        made.visit,
        { medicineName: name, pharmacyMatch: name, dose, frequency: "OD", changeType: "new" },
        db,
      );
    }
    const result = await finalizeConsult(made.visit, CONSULTANTS.banshali.id, db);
    consultationId = result.consultationId;
    const { saveCarePlan } = await import("../../server/services/giniflow/doctorStation.js");
    await saveCarePlan(made.visit, { nextVisitInterval: "1 month" }, null, db);
  });

  test.afterAll(async () => {
    if (made) {
      await query(`DELETE FROM giniflow_rx_items WHERE visit_id = $1`, [made.visit]);
      await query(`DELETE FROM documents WHERE patient_id = $1`, [made.patient]).catch(() => {});
      await query(`DELETE FROM medications WHERE patient_id = $1`, [made.patient]);
      await query(`DELETE FROM consultations WHERE patient_id = $1`, [made.patient]);
      await query(`DELETE FROM rx_parameter_overrides WHERE patient_id = $1`, [made.patient]);
    }
    await tearDown(ids);
  });

  test("1. another consultant cannot open it; the one who finalized gets the same medicines back", async () => {
    const other = await apiAs("rahul");
    expect((await other.post(`${base()}/edit`)).status()).toBe(403);

    const doctor = await apiAs("banshali");
    const res = await doctor.post(`${base()}/edit`);
    expect(res.status(), await res.text()).toBe(200);
    expect(await draft()).toEqual([
      { medicine_name: "G116 Metformin", change_type: "continued", dose: "500 mg" },
      { medicine_name: "G116 Rosuvas", change_type: "new", dose: "10 mg" },
      { medicine_name: "G116 Telma", change_type: "new", dose: "40 mg" },
    ]);
    const consult = await (await doctor.get(base())).json();
    expect(consult.editingMine).toBe(true);
    expect(consult.readOnly).toBe(false);
    expect((await visitRow()).current_status).toBe("rx_pending");
  });

  test("1b. the vitals & biomarkers table unlocks for the editor only", async () => {
    const doctor = await apiAs("banshali");
    const table = await (await doctor.get(`${base()}/rx-parameters`)).json();
    expect(table.locked).toBe(false);
    const saved = await doctor.put(`${base()}/rx-parameters`, {
      data: { rows: [{ key: "weight", value: "80.5" }] },
    });
    expect(saved.status(), await saved.text()).toBe(200);
    const row = (await saved.json()).rows.find((r) => r.key === "weight");
    expect(row.values.at(-1)).toBe("80.5");

    const other = await apiAs("rahul");
    expect((await (await other.get(`${base()}/rx-parameters`)).json()).locked).toBe(true);
    const refused = await other.put(`${base()}/rx-parameters`, {
      data: { rows: [{ key: "weight", value: "70" }] },
    });
    expect(refused.status()).toBe(409);
  });

  test("2. saving writes into the same consultation, switches off what was removed, and leaves the patient where they are", async () => {
    const { db } = await import("../billing/phase4b/p4b-refunds.mjs");
    const rx = await import("../../server/services/giniflow/prescription.js");
    const rows = (
      await query(`SELECT id, medicine_name FROM giniflow_rx_items WHERE visit_id = $1`, [
        made.visit,
      ])
    ).rows;
    const idOf = (name) => rows.find((r) => r.medicine_name === name).id;
    await rx.removeItem(idOf("G116 Rosuvas"), db);
    await query(
      `UPDATE giniflow_rx_items SET dose = '80 mg', change_type = 'changed' WHERE id = $1`,
      [idOf("G116 Telma")],
    );
    await rx.addItem(
      made.visit,
      {
        medicineName: "G116 Shelcal",
        pharmacyMatch: "G116 Shelcal",
        dose: "500 mg",
        frequency: "OD",
        changeType: "new",
      },
      db,
    );

    const doctor = await apiAs("banshali");
    const noDate = await doctor.post(`${base()}/edit/save`, { data: {} });
    expect(noDate.status()).toBe(409);
    expect((await noDate.json()).error).toMatch(/next visit/i);
    await query(
      `UPDATE giniflow_care_plans SET next_visit_date = $2::date + 30 WHERE visit_id = $1`,
      [made.visit, ids.day],
    );
    const res = await doctor.post(`${base()}/edit/save`, { data: {} });
    expect(res.status(), await res.text()).toBe(200);
    const body = await res.json();
    expect(body.consultationId).toBe(consultationId);
    expect(body.added).toEqual(["G116 Shelcal"]);
    expect(body.removed).toEqual(["G116 Rosuvas"]);
    expect(body.changed).toEqual(["G116 Telma"]);

    const count = await query(
      `SELECT count(*)::int AS n FROM consultations WHERE patient_id = $1`,
      [made.patient],
    );
    expect(count.rows[0].n).toBe(1);
    expect(await med("G116 Shelcal")).toMatchObject({
      is_active: true,
      consultation_id: consultationId,
    });
    expect(await med("G116 Telma")).toMatchObject({ is_active: true, dose: "80 mg" });
    expect(await med("G116 Rosuvas")).toMatchObject({
      is_active: false,
      stop_reason: "Removed when the visit was edited",
    });
    expect(await med("G116 Metformin")).toMatchObject({ is_active: true });

    const visit = await visitRow();
    expect(visit.current_status).toBe("rx_pending");
    expect(visit.editing_by).toBeNull();
    expect(visit.amended_at).not.toBeNull();
    expect(visit.amendments).toHaveLength(1);
    expect(visit.amendments[0]).toMatchObject({ reason: null, by: CONSULTANTS.banshali.id });
    expect(await draft()).toEqual([]);
  });

  test("3. a removed medicine does not come back when the visit is edited again, and Cancel changes nothing", async () => {
    const doctor = await apiAs("banshali");
    expect((await doctor.post(`${base()}/edit`)).status()).toBe(200);
    const names = (await draft()).map((r) => r.medicine_name);
    expect(names).toEqual(["G116 Metformin", "G116 Shelcal", "G116 Telma"]);
    await query(
      `DELETE FROM giniflow_rx_items WHERE visit_id = $1 AND medicine_name = 'G116 Telma'`,
      [made.visit],
    );
    expect((await doctor.post(`${base()}/edit/cancel`)).status()).toBe(200);
    expect(await draft()).toEqual([]);
    expect(await med("G116 Telma")).toMatchObject({ is_active: true, dose: "80 mg" });
    expect((await visitRow()).editing_by).toBeNull();
  });

  test("4. the Rx desk sees the prescription was updated, with the reason kept", async () => {
    const doctor = await apiAs("banshali");
    await doctor.post(`${base()}/edit`);
    const res = await doctor.post(`${base()}/edit/save`, { data: { reason: "Missed Vit D" } });
    expect(res.status()).toBe(200);
    expect((await visitRow()).amendments.at(-1).reason).toBe("Missed Vit D");

    const admin = await apiAs("admin");
    const patient = await (await admin.get(`/api/giniflow/stations/rx/${made.visit}`)).json();
    expect(patient.amendedAt).toBeTruthy();
    expect(patient.amendedAfterExplained).toBe(false);
  });

  test("5. an older visit cannot be edited", async () => {
    await query(`UPDATE giniflow_visits SET visit_date = visit_date - 1 WHERE id = $1`, [
      made.visit,
    ]);
    try {
      const doctor = await apiAs("banshali");
      const res = await doctor.post(`${base()}/edit`);
      expect(res.status()).toBe(409);
      expect((await res.json()).error).toMatch(/today/);
    } finally {
      await query(`UPDATE giniflow_visits SET visit_date = visit_date + 1 WHERE id = $1`, [
        made.visit,
      ]);
    }
  });

  test("6. on screen: Edit prescription opens the editing bar, Cancel edit closes it", async ({
    page,
  }) => {
    await loginAs(page, "banshali");
    const edit = page.getByRole("button", { name: "✎ Edit prescription" });
    await gotoReady(page, `/giniflow/station/doctor/${made.visit}`, () => edit);
    await expect(page.getByText("Prescription last updated at")).toBeVisible();
    await edit.click();
    await expect(page.getByText("✎ Editing after finalize")).toBeVisible();
    await expect(page.getByRole("button", { name: "Save changes →" })).toBeEnabled();
    await page.getByRole("button", { name: "Clear the next visit" }).click();
    await expect(page.getByRole("button", { name: "Save changes →" })).toBeDisabled();
    await expect(page.getByText("Set the next visit before saving.")).toBeVisible();
    await page.getByRole("button", { name: "Cancel edit" }).click();
    await expect(edit).toBeVisible();
    expect((await visitRow()).editing_by).toBeNull();
  });
});
