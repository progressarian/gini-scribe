import { test, expect } from "@playwright/test";
import { query } from "../helpers/db.mjs";
import { apiAs, loginAs } from "../helpers/auth.mjs";
import { gotoReady } from "../helpers/browser.mjs";
import { assertTestDatabase } from "../setup/guard.mjs";
import { CONSULTANTS } from "../fixtures/data.mjs";
import { extraVisit, newTag, setUp, tearDown } from "../billing/phase4/p4-bills-fixture.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);

const tag = newTag();
const CHIEF = CONSULTANTS.rahul;
let ids;
let made;

const mo = () => `/api/giniflow/stations/mo/${made.visit}`;
const rows = async () =>
  (
    await query(
      `SELECT id, medicine_name, change_type, dose, approval_status FROM giniflow_rx_items
        WHERE visit_id = $1 ORDER BY medicine_name`,
      [made.visit],
    )
  ).rows;
const med = async (name) =>
  (
    await query(
      `SELECT dose, is_active, stop_reason FROM medications
        WHERE patient_id = $1 AND name = $2 ORDER BY is_active DESC, id DESC LIMIT 1`,
      [made.patient, name],
    )
  ).rows[0];

test.describe.serial("G118 the Chief edits a visit they closed, from the Chief station", () => {
  test.beforeAll(async () => {
    ids = await setUp(tag);
    made = await extraVisit(ids, "ChiefAmend", { healthray: false });
    await query(
      `UPDATE giniflow_visits SET current_status = 'with_sd', assigned_sd_id = $2 WHERE id = $1`,
      [made.visit, CHIEF.id],
    );
    await query(
      `INSERT INTO giniflow_visit_events (visit_id, status, actor_role, actor_id, occurred_at)
       VALUES ($1, 'with_sd', 'mo_sd', $2, NOW() - interval '10 minutes')`,
      [made.visit, CHIEF.id],
    );
    const { db } = await import("../billing/phase4b/p4b-refunds.mjs");
    const rx = await import("../../server/services/giniflow/prescription.js");
    const { finalizeConsult } = await import("../../server/services/giniflow/finalize.js");
    for (const [name, dose] of [
      ["G118 Telma", "40 mg"],
      ["G118 Rosuvas", "10 mg"],
    ]) {
      await rx.addItem(
        made.visit,
        { medicineName: name, pharmacyMatch: name, dose, frequency: "OD", changeType: "new" },
        db,
      );
    }
    await finalizeConsult(made.visit, CHIEF.id, db, { closedBySd: true });
  });

  test.afterAll(async () => {
    if (made) {
      await query(`DELETE FROM giniflow_rx_items WHERE visit_id = $1`, [made.visit]);
      await query(`DELETE FROM documents WHERE patient_id = $1`, [made.patient]).catch(() => {});
      await query(`DELETE FROM medications WHERE patient_id = $1`, [made.patient]);
      await query(`DELETE FROM consultations WHERE patient_id = $1`, [made.patient]);
    }
    await tearDown(ids);
  });

  test("1. another Chief cannot open it; the Chief who closed it can, and the station says so", async () => {
    const other = await apiAs("beant");
    expect((await other.post(`${mo()}/edit`)).status()).toBe(403);

    const chief = await apiAs("rahul");
    const before = await (await chief.get(mo())).json();
    expect(before.edit).toMatchObject({ finalized: true, canEdit: true, editingMine: false });

    const res = await chief.post(`${mo()}/edit`);
    expect(res.status(), await res.text()).toBe(200);
    const after = await (await chief.get(mo())).json();
    expect(after.edit).toMatchObject({ canEdit: false, editingMine: true });
    expect((await rows()).map((r) => r.medicine_name)).toEqual(["G118 Rosuvas", "G118 Telma"]);
  });

  test("2. while editing, the Chief's medicines are direct, not proposals, and only the editor may change rows", async () => {
    const chief = await apiAs("rahul");
    const added = await chief.post(`${mo()}/prescription/items`, {
      data: {
        medicineName: "G118 Shelcal",
        pharmacyMatch: "G118 Shelcal",
        dose: "500 mg",
        frequency: "OD",
        changeType: "new",
      },
    });
    expect(added.status(), await added.text()).toBe(200);
    const shelcal = (await rows()).find((r) => r.medicine_name === "G118 Shelcal");
    expect(shelcal.approval_status).toBeNull();

    const telma = (await rows()).find((r) => r.medicine_name === "G118 Telma");
    const rosuvas = (await rows()).find((r) => r.medicine_name === "G118 Rosuvas");
    const other = await apiAs("beant");
    expect(
      (
        await other.patch(`/api/giniflow/stations/mo/prescription/items/${telma.id}`, {
          data: { dose: "80 mg" },
        })
      ).status(),
    ).toBe(403);

    const patched = await chief.patch(`/api/giniflow/stations/mo/prescription/items/${telma.id}`, {
      data: { dose: "80 mg" },
    });
    expect(patched.status(), await patched.text()).toBe(200);
    expect(
      (await chief.delete(`/api/giniflow/stations/mo/prescription/items/${rosuvas.id}`)).status(),
    ).toBe(200);
  });

  test("3. saving from the Chief station updates the prescription and leaves the patient where they are", async () => {
    const chief = await apiAs("rahul");
    const res = await chief.post(`${mo()}/edit/save`, { data: { reason: "Missed calcium" } });
    expect(res.status(), await res.text()).toBe(200);
    const body = await res.json();
    expect(body.added).toEqual(["G118 Shelcal"]);
    expect(body.removed).toEqual(["G118 Rosuvas"]);
    expect(body.changed).toEqual(["G118 Telma"]);
    expect(await med("G118 Telma")).toMatchObject({ is_active: true, dose: "80 mg" });
    expect(await med("G118 Rosuvas")).toMatchObject({
      is_active: false,
      stop_reason: "Removed when the visit was edited",
    });
    const visit = (
      await query(
        `SELECT current_status, editing_by, amendments FROM giniflow_visits WHERE id = $1`,
        [made.visit],
      )
    ).rows[0];
    expect(visit.current_status).toBe("rx_pending");
    expect(visit.editing_by).toBeNull();
    expect(visit.amendments.at(-1)).toMatchObject({ by: CHIEF.id, reason: "Missed calcium" });
  });

  test("4. outside an edit, the Chief station cannot change rows", async () => {
    const chief = await apiAs("rahul");
    await chief.post(`${mo()}/edit`);
    const row = (await rows())[0];
    await chief.post(`${mo()}/edit/cancel`);
    await query(
      `INSERT INTO giniflow_rx_items (id, visit_id, medicine_name, change_type)
       VALUES ($1, $2, 'G118 Stray', 'new')`,
      [row.id, made.visit],
    );
    const res = await chief.delete(`/api/giniflow/stations/mo/prescription/items/${row.id}`);
    expect(res.status()).toBe(403);
    await query(`DELETE FROM giniflow_rx_items WHERE visit_id = $1`, [made.visit]);
  });

  test("5. on screen: the Chief opens the closed patient, presses Edit prescription, and cancels", async ({
    page,
  }) => {
    await loginAs(page, "rahul");
    const name = page.getByText(`P4 ChiefAmend ${tag}`).first();
    await gotoReady(page, "/giniflow/station/mo", () => name);
    await name.click();
    const edit = page.getByRole("button", { name: "✎ Edit prescription" });
    await expect(edit).toBeVisible();
    await expect(page.getByText("Prescription last updated at")).toBeVisible();
    await edit.click();
    await expect(page.getByText("✎ Editing after finalize")).toBeVisible();
    await page.getByRole("button", { name: "Cancel edit" }).click();
    await expect(edit).toBeVisible();
  });
});
