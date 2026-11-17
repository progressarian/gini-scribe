import { test, expect } from "@playwright/test";
import { apiAs, loginAs } from "../helpers/auth.mjs";
import { one, query } from "../helpers/db.mjs";
import { gotoReady } from "../helpers/browser.mjs";
import { assertTestDatabase } from "../setup/guard.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);

const TAG = `PH11${Date.now().toString(36).toUpperCase()}`;
const medName = (n) => `${TAG} ${n}`;

const medicine = (overrides = {}) => ({
  name: medName("Glycomet 500 SR"),
  generic_name: "Metformin 500 mg",
  manufacturer: "USV",
  form: "TAB",
  strength: "500 mg",
  pack_size: 10,
  unit_label: "tab",
  pack_label: "strip",
  hsn_code: "3004",
  gst_rate_pct: 12,
  schedule: "H",
  default_mrp: "35.50",
  default_sale_rate: "32.00",
  min_stock_units: 100,
  max_stock_units: 1000,
  reorder_qty_units: 500,
  default_rack: "A-3",
  ...overrides,
});

test.describe.configure({ mode: "serial" });

test.describe("PH11 pharmacy medicines", () => {
  let admin;
  let pharmacist;
  let nurse;

  test.beforeAll(async () => {
    admin = await apiAs("pharmacy_admin");
    pharmacist = await apiAs("pharmacy");
    nurse = await apiAs("nurse");
  });

  test.afterAll(async () => {
    await Promise.all([admin?.dispose(), pharmacist?.dispose(), nurse?.dispose()]);
    await query(`DELETE FROM pharmacy_medicines WHERE name LIKE $1`, [`${TAG}%`]);
  });

  test("a new medicine gets a code and a prescription key, and is audited", async () => {
    const response = await admin.post("/api/pharmacy/medicines", {
      data: medicine({ name: `Tab ${medName("Glycomet 500 SR")}` }),
    });
    const body = await response.json();
    expect(response.status(), JSON.stringify(body)).toBe(201);
    expect(body.code).toMatch(/^MED\d{6}$/);
    expect(body.medicine_key).toBe(medName("Glycomet 500 SR").toUpperCase());
    expect(body).toMatchObject({
      gst_rate_pct: "12.00",
      default_mrp: "35.50",
      default_sale_rate: "32.00",
      allow_loose_sale: true,
      version: 1,
    });
    const audit = await one(
      `SELECT action FROM billing_audit WHERE entity = 'pharmacy_medicines' AND entity_id = $1`,
      [String(body.id)],
    );
    expect(audit.action).toBe("create");
  });

  test("a custom code and a custom GST rate are kept", async () => {
    const response = await admin.post("/api/pharmacy/medicines", {
      data: medicine({
        name: medName("Insulin Pen"),
        code: `${TAG.slice(0, 8)}-ins`,
        form: "INSULIN PEN",
        pack_size: 1,
        unit_label: "pen",
        pack_label: "unit",
        gst_rate_pct: 7.5,
        allow_loose_sale: false,
      }),
    });
    const body = await response.json();
    expect(response.status(), JSON.stringify(body)).toBe(201);
    expect(body.code).toBe(`${TAG.slice(0, 8)}-INS`);
    expect(body.gst_rate_pct).toBe("7.50");
    expect(body.allow_loose_sale).toBe(false);
  });

  test("selling above MRP and a maximum below the minimum are refused", async () => {
    const overMrp = await admin.post("/api/pharmacy/medicines", {
      data: medicine({ name: medName("Over MRP"), default_mrp: "10", default_sale_rate: "12" }),
    });
    expect(overMrp.status()).toBe(400);
    expect((await overMrp.json()).error).toContain(
      "Sale rate per pack cannot be more than the MRP",
    );

    const levels = await admin.post("/api/pharmacy/medicines", {
      data: medicine({ name: medName("Bad Levels"), min_stock_units: 50, max_stock_units: 10 }),
    });
    expect(levels.status()).toBe(400);
    expect((await levels.json()).error).toContain(
      "Maximum stock cannot be less than the minimum stock",
    );
  });

  test("invalid fields come back with readable messages", async () => {
    const response = await admin.post("/api/pharmacy/medicines", {
      data: medicine({
        name: "X",
        form: "PILL",
        pack_size: 0,
        gst_rate_pct: 40,
        hsn_code: "30",
      }),
    });
    expect(response.status()).toBe(400);
    const { error } = await response.json();
    expect(error).toContain("Medicine name must be at least 2 characters");
    expect(error).toContain("Units per pack must be at least 1");
    expect(error).toContain("GST rate can be at most 28");
    expect(error).toContain("HSN code must be 4 to 8 digits");
  });

  test("duplicate names and codes are refused", async () => {
    const sameName = await admin.post("/api/pharmacy/medicines", {
      data: medicine({ name: `  tab ${medName("glycomet 500 sr").toLowerCase()}  ` }),
    });
    expect(sameName.status()).toBe(409);
    expect((await sameName.json()).error).toBe("A medicine with this name already exists");

    const sameCode = await admin.post("/api/pharmacy/medicines", {
      data: medicine({ name: medName("Other"), code: `${TAG.slice(0, 8)}-INS` }),
    });
    expect(sameCode.status()).toBe(409);
    expect((await sameCode.json()).error).toBe("Another medicine already uses this code");
  });

  test("an edit keeps the code required and bumps the version", async () => {
    const row = await one(`SELECT id, code, version FROM pharmacy_medicines WHERE name = $1`, [
      `Tab ${medName("Glycomet 500 SR")}`,
    ]);
    const noCode = await admin.put(`/api/pharmacy/medicines/${row.id}`, {
      data: { ...medicine({ name: `Tab ${medName("Glycomet 500 SR")}` }), version: row.version },
    });
    expect(noCode.status()).toBe(400);

    const edit = await admin.put(`/api/pharmacy/medicines/${row.id}`, {
      data: {
        ...medicine({ name: `Tab ${medName("Glycomet 500 SR")}`, default_rack: "B-1" }),
        code: row.code,
        version: row.version,
      },
    });
    const body = await edit.json();
    expect(edit.status(), JSON.stringify(body)).toBe(200);
    expect(body.default_rack).toBe("B-1");
    expect(body.version).toBe(row.version + 1);
  });

  test("the list filters by form and schedule", async () => {
    const pens = await (
      await admin.get("/api/pharmacy/medicines", { params: { q: TAG, form: "INSULIN PEN" } })
    ).json();
    expect(pens.rows.map((m) => m.name)).toEqual([medName("Insulin Pen")]);
    const scheduleH = await (
      await admin.get("/api/pharmacy/medicines", { params: { q: TAG, schedule: "H" } })
    ).json();
    expect(scheduleH.total).toBe(2);
    const x = await (
      await admin.get("/api/pharmacy/medicines", { params: { q: TAG, schedule: "X" } })
    ).json();
    expect(x.total).toBe(0);
  });

  test("the pharmacist and nurse can look medicines up but not change them", async () => {
    for (const api of [pharmacist, nurse]) {
      const list = await api.get("/api/pharmacy/medicines", { params: { q: TAG } });
      expect(list.status()).toBe(200);
      const create = await api.post("/api/pharmacy/medicines", {
        data: medicine({ name: medName("Not allowed") }),
      });
      expect(create.status()).toBe(403);
    }
  });

  test("pharmacy admin adds a medicine with a custom GST rate from the page", async ({ page }) => {
    await loginAs(page, "pharmacy_admin");
    await gotoReady(page, "/pharmacy/medicines", () =>
      page.getByRole("heading", { name: "Medicines", exact: true }),
    );
    await page.getByRole("button", { name: "Add medicine" }).first().click();
    const dialog = page.getByRole("dialog", { name: "Add medicine" });

    await dialog
      .getByRole("textbox", { name: "Medicine name", exact: true })
      .fill(medName("Screen Syrup"));
    await dialog.getByRole("combobox", { name: "Form" }).selectOption("SYP");
    await dialog.getByRole("combobox", { name: "Pack" }).selectOption("bottle");
    await dialog.getByRole("textbox", { name: "Units per pack" }).fill("1");
    await dialog.getByRole("combobox", { name: "Unit", exact: true }).selectOption("unit");
    await dialog.getByRole("combobox", { name: "GST rate" }).selectOption("custom");
    await dialog.getByRole("textbox", { name: "Custom GST rate (%)" }).fill("6");
    await dialog.getByRole("textbox", { name: /MRP per bottle/ }).fill("90");
    await dialog.getByRole("textbox", { name: /Sale rate per bottle/ }).fill("95");
    await dialog.getByRole("button", { name: "Add medicine" }).click();
    await expect(dialog.getByText("The sale rate cannot be more than the MRP.")).toBeVisible();

    await dialog.getByRole("textbox", { name: /Sale rate per bottle/ }).fill("85");
    await dialog.getByRole("textbox", { name: "Rack" }).fill("C-2");
    await dialog.getByRole("button", { name: "Add medicine" }).click();
    await expect(dialog).toBeHidden();

    await page.getByLabel("Search medicines").fill(medName("Screen"));
    const row = page.getByRole("row", { name: new RegExp(medName("Screen Syrup")) });
    await expect(row).toContainText("6%");
    await expect(row).toContainText("C-2");

    const stored = await one(
      `SELECT gst_rate_pct, default_sale_rate, pack_label FROM pharmacy_medicines WHERE name = $1`,
      [medName("Screen Syrup")],
    );
    expect(stored).toEqual({
      gst_rate_pct: "6.00",
      default_sale_rate: "85.00",
      pack_label: "bottle",
    });
  });
});
