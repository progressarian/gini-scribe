import { test, expect } from "@playwright/test";
import { apiAs, loginAs } from "../helpers/auth.mjs";
import { one, query } from "../helpers/db.mjs";
import { gotoReady } from "../helpers/browser.mjs";
import { assertTestDatabase } from "../setup/guard.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);

const STAMP = Date.now().toString(36).toUpperCase().slice(-5);
const TAG = `PH12${STAMP}`;
const code = (n) => `${n}${STAMP}`.slice(0, 20);

test.describe.configure({ mode: "serial" });

test.describe("PH12 pharmacy departments and stock levels", () => {
  let admin;
  let nurse;
  let pharmacist;
  let main;
  let ipd;
  let medicine;

  test.beforeAll(async () => {
    admin = await apiAs("pharmacy_admin");
    nurse = await apiAs("nurse");
    pharmacist = await apiAs("pharmacy");
    main = await one(`SELECT * FROM pharmacy_locations WHERE kind = 'main'`);
    medicine = await one(
      `INSERT INTO pharmacy_medicines (name, form, pack_size, unit_label, pack_label, medicine_key)
       VALUES ($1, 'TAB', 10, 'tab', 'strip', $1) RETURNING *`,
      [`${TAG} Pan 40`],
    );
  });

  test.afterAll(async () => {
    await Promise.all([admin?.dispose(), nurse?.dispose(), pharmacist?.dispose()]);
    await query(
      `DELETE FROM pharmacy_location_levels WHERE location_id IN
         (SELECT id FROM pharmacy_locations WHERE name LIKE $1)`,
      [`${TAG}%`],
    );
    await query(`DELETE FROM pharmacy_locations WHERE name LIKE $1`, [`${TAG}%`]);
    await query(`DELETE FROM pharmacy_medicines WHERE name LIKE $1`, [`${TAG}%`]);
  });

  test("the main pharmacy exists, is listed first and cannot be deactivated", async () => {
    expect(main).toMatchObject({ code: "MAIN", kind: "main", is_active: true });
    const list = await (await admin.get("/api/pharmacy/locations")).json();
    expect(list.rows[0].code).toBe("MAIN");

    const off = await admin.patch(`/api/pharmacy/locations/${main.id}/active`, {
      data: { is_active: false },
    });
    expect(off.status()).toBe(409);
    expect((await off.json()).error).toBe("The main pharmacy cannot be deactivated");

    const recode = await admin.put(`/api/pharmacy/locations/${main.id}`, {
      data: { code: "STORE", name: main.name, version: main.version },
    });
    expect(recode.status()).toBe(409);
  });

  test("a department is created with a clean code and duplicates are refused", async () => {
    const created = await admin.post("/api/pharmacy/locations", {
      data: { code: code("ipd-"), name: `${TAG} IPD store` },
    });
    ipd = await created.json();
    expect(created.status(), JSON.stringify(ipd)).toBe(201);
    expect(ipd).toMatchObject({ code: code("IPD-"), kind: "department" });

    const same = await admin.post("/api/pharmacy/locations", {
      data: { code: code("IPD-"), name: `${TAG} Another` },
    });
    expect(same.status()).toBe(409);
    expect((await same.json()).error).toBe("Another department already uses this code");
  });

  test("the main pharmacy does not take department levels", async () => {
    const response = await admin.put(`/api/pharmacy/locations/${main.id}/levels/${medicine.id}`, {
      data: { min_units: 10 },
    });
    expect(response.status()).toBe(409);
  });

  test("stock levels are added, changed and removed with an audit trail", async () => {
    const bad = await admin.put(`/api/pharmacy/locations/${ipd.id}/levels/${medicine.id}`, {
      data: { min_units: 50, max_units: 20 },
    });
    expect(bad.status()).toBe(400);
    expect((await bad.json()).error).toContain(
      "Maximum stock cannot be less than the minimum stock",
    );

    const added = await admin.put(`/api/pharmacy/locations/${ipd.id}/levels/${medicine.id}`, {
      data: { min_units: 20, max_units: 100 },
    });
    expect(added.status(), await added.text()).toBe(200);

    const changed = await admin.put(`/api/pharmacy/locations/${ipd.id}/levels/${medicine.id}`, {
      data: { min_units: 30, max_units: "" },
    });
    expect(await changed.json()).toMatchObject({ min_units: 30, max_units: null });

    const list = await (await admin.get(`/api/pharmacy/locations/${ipd.id}/levels`)).json();
    expect(list.rows.map((r) => [r.name, r.min_units])).toEqual([[`${TAG} Pan 40`, 30]]);

    const removed = await admin.delete(`/api/pharmacy/locations/${ipd.id}/levels/${medicine.id}`);
    expect(removed.status()).toBe(200);

    const audit = await query(
      `SELECT action FROM billing_audit
        WHERE entity = 'pharmacy_location_levels' AND entity_id = $1 ORDER BY id`,
      [`${ipd.id}:${medicine.id}`],
    );
    expect(audit.rows.map((r) => r.action)).toEqual(["create", "update", "delete"]);
  });

  test("a deactivated department cannot take new levels", async () => {
    await admin.patch(`/api/pharmacy/locations/${ipd.id}/active`, { data: { is_active: false } });
    const response = await admin.put(`/api/pharmacy/locations/${ipd.id}/levels/${medicine.id}`, {
      data: { min_units: 5 },
    });
    expect(response.status()).toBe(409);
    await admin.patch(`/api/pharmacy/locations/${ipd.id}/active`, { data: { is_active: true } });
  });

  test("the nurse can read departments but not change them; the pharmacist cannot open them", async () => {
    expect((await nurse.get(`/api/pharmacy/locations/${ipd.id}/levels`)).status()).toBe(200);
    const write = await nurse.put(`/api/pharmacy/locations/${ipd.id}/levels/${medicine.id}`, {
      data: { min_units: 5 },
    });
    expect(write.status()).toBe(403);
    expect((await pharmacist.get("/api/pharmacy/locations")).status()).toBe(403);
  });

  test("pharmacy admin adds a department and sets its stock level from the page", async ({
    page,
  }) => {
    await loginAs(page, "pharmacy_admin");
    await gotoReady(page, "/pharmacy/departments", () =>
      page.getByRole("heading", { name: "Departments", exact: true }),
    );

    const mainRow = page.getByRole("row", { name: /Main pharmacy/ }).first();
    await expect(mainRow.getByRole("button", { name: /Deactivate/ })).toHaveCount(0);

    await page.getByRole("button", { name: "Add department" }).first().click();
    const dialog = page.getByRole("dialog", { name: "Add department" });
    await dialog.getByRole("textbox", { name: "Code", exact: true }).fill(code("ot"));
    await dialog
      .getByRole("textbox", { name: "Department name", exact: true })
      .fill(`${TAG} Operation theatre`);
    await dialog.getByRole("button", { name: "Add department" }).click();
    await expect(dialog).toBeHidden();

    await page.getByLabel("Search departments").fill(TAG);
    const row = page.getByRole("row", { name: new RegExp(`${TAG} Operation theatre`) });
    await expect(row).toContainText("0 medicines");
    await row.getByRole("button", { name: `Stock levels for ${TAG} Operation theatre` }).click();

    const levels = page.getByRole("dialog", { name: `Stock levels · ${TAG} Operation theatre` });
    const picker = levels.getByRole("combobox", { name: "Medicine" });
    await picker.fill(`${TAG} Pan`);
    await expect(levels.getByRole("option", { name: new RegExp(`${TAG} Pan 40`) })).toBeVisible();
    await picker.press("ArrowDown");
    await picker.press("Enter");
    await levels.getByLabel(/^Minimum \(tab\)/).fill("40");
    await levels.getByLabel(/^Maximum \(tab\)/).fill("200");
    await levels.getByRole("button", { name: "Add level" }).click();

    const levelRow = levels.getByRole("row", { name: new RegExp(`${TAG} Pan 40`) });
    await expect(levelRow).toBeVisible();
    await expect(levelRow).toContainText("4 strip");

    await levelRow.getByLabel(new RegExp(`Minimum stock of ${TAG} Pan 40`)).fill("60");
    await levelRow.getByRole("button", { name: `Save stock level for ${TAG} Pan 40` }).click();
    await expect(
      levelRow.getByRole("button", { name: `Save stock level for ${TAG} Pan 40` }),
    ).toBeDisabled();

    const stored = await one(
      `SELECT l.min_units, l.max_units FROM pharmacy_location_levels l
         JOIN pharmacy_locations d ON d.id = l.location_id
        WHERE d.name = $1`,
      [`${TAG} Operation theatre`],
    );
    expect(stored).toEqual({ min_units: 60, max_units: 200 });

    await levels.getByRole("button", { name: "Close" }).click();
    await expect(row).toContainText("1 medicine");
  });
});
