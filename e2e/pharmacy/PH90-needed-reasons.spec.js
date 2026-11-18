import { test, expect } from "@playwright/test";
import ExcelJS from "exceljs";
import { apiAs, loginAs } from "../helpers/auth.mjs";
import { gotoReady } from "../helpers/browser.mjs";
import { query } from "../helpers/db.mjs";
import { buildPatient, insertRow } from "../helpers/builders.mjs";
import { assertTestDatabase } from "../setup/guard.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);

const { medicineKey } = await import("../../server/services/pharmacy/stockMatch.js");

const TAG = `PH90${Date.now().toString(36).toUpperCase()}`;
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const dayOffset = (days) => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
};
const TODAY = dayOffset(0);
const DMY = (iso) => iso.split("-").reverse().join("/");
const OUTSIDE = `Ozempic ${TAG}`;
const EMPTY = `Januvia ${TAG}`;

test.describe.configure({ mode: "serial" });

test.describe("PH90 needed in stock tracks why prescribed medicines were not taken", () => {
  let admin;
  let pharmacist;
  let reception;

  const report = async (api, params = {}) => {
    const res = await api.get("/api/pharmacy/stock/needed", { params });
    expect(res.status()).toBe(200);
    const body = await res.json();
    return { ...body, mine: body.items.filter((i) => i.medicineName.includes(TAG)) };
  };

  const sheet = async (rows) => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Needed");
    const headers = ["Medicine name", "Reason", "Quantity needed (units)", "Date", "Note"];
    ws.addRow(headers);
    for (const row of rows) ws.addRow(headers.map((h) => row[h] ?? null));
    return Buffer.from(await wb.xlsx.writeBuffer());
  };

  const upload = (path, file, params) =>
    admin.post(`/api/pharmacy/stock/needed/${path}`, {
      headers: { "Content-Type": XLSX },
      data: file,
      ...(params ? { params } : {}),
    });

  test.beforeAll(async () => {
    admin = await apiAs("pharmacy_admin");
    pharmacist = await apiAs("pharmacy");
    reception = await apiAs("reception");
    await query(
      `INSERT INTO pharmacy_inventory (medicine_name, stock_qty) VALUES ($1, 40), ($2, 0)`,
      [medicineKey(OUTSIDE), medicineKey(EMPTY)],
    );
    for (const [index, [name, reason, note]] of [
      [OUTSIDE, "buying_outside", null],
      [OUTSIDE, "other", "Patient wants the pen, not vials"],
      [EMPTY, "out_of_stock", null],
    ].entries()) {
      const patient = await buildPatient({ name: `${TAG} patient ${index}` });
      const medication = await insertRow("medications", {
        patient_id: patient.id,
        name,
        is_active: true,
        prescriber: "Dr. Bansal",
      });
      await insertRow("medicine_collections", {
        medication_id: medication.id,
        patient_id: patient.id,
        collected_date: dayOffset(-index),
        status: "not_given",
        reason,
        qty_note: note,
      });
    }
  });

  test.afterAll(async () => {
    await query(`DELETE FROM pharmacy_inventory WHERE medicine_name = ANY($1)`, [
      [medicineKey(OUTSIDE), medicineKey(EMPTY)],
    ]);
    await Promise.all([admin?.dispose(), pharmacist?.dispose(), reception?.dispose()]);
  });

  test("not-given medicines are counted by reason with the notes, even when in stock", async () => {
    const { mine, summary } = await report(pharmacist);
    const outside = mine.find((i) => i.medicineName === OUTSIDE);
    expect(outside).toMatchObject({
      status: "in_stock",
      times: 2,
      patients: 2,
      reasons: { buying_outside: 1, other: 1 },
      doctors: ["Dr. Bansal"],
    });
    expect(outside.notes.map((n) => n.text)).toEqual(["Patient wants the pen, not vials"]);
    expect(mine.find((i) => i.medicineName === EMPTY)).toMatchObject({
      status: "out_of_stock",
      reasons: { out_of_stock: 1 },
    });
    expect(summary.byReason.buying_outside).toBeGreaterThanOrEqual(1);

    const filtered = await report(pharmacist, { reason: "out_of_stock", q: TAG });
    expect(filtered.mine.map((i) => i.medicineName)).toEqual([EMPTY]);
    const lastDay = await report(pharmacist, { days: 1, q: TAG });
    expect(lastDay.mine.map((i) => i.medicineName)).toEqual([OUTSIDE]);
    expect((await reception.get("/api/pharmacy/stock/needed")).status()).toBe(403);
  });

  test("the list downloads as Excel", async () => {
    const res = await pharmacist.get("/api/pharmacy/stock/needed/export.xlsx", {
      params: { q: TAG },
    });
    expect(res.status()).toBe(200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(await res.body());
    const ws = wb.getWorksheet("Needed in stock");
    expect(ws.rowCount).toBe(3);
    expect(ws.getRow(1).values).toContain("Buying outside");
  });

  test("Other needs a written reason on the prescription screen", async () => {
    const res = await pharmacist.post("/api/pharmacy/prescriptions/patients/1/outcomes", {
      data: {
        bill_id: "00000000-0000-4000-8000-000000000000",
        outcomes: [{ medication_id: 1, outcome: "not_given", reason: "other" }],
      },
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).error).toContain("written reason when the reason is Other");
  });

  test("a sheet adds needed medicines; a repeat asks to add the quantities", async () => {
    const sample = await admin.get("/api/pharmacy/stock/needed/sample.xlsx");
    expect(sample.status()).toBe(200);
    expect((await pharmacist.get("/api/pharmacy/stock/needed/sample.xlsx")).status()).toBe(403);

    const file = await sheet([
      {
        "Medicine name": `Trajenta ${TAG}`,
        Reason: "Out of stock",
        "Quantity needed (units)": 30,
        Date: DMY(TODAY),
      },
      { "Medicine name": `Rybelsus ${TAG}`, Reason: "Other", Date: DMY(TODAY) },
      { "Medicine name": `Jardiance ${TAG}`, Reason: "Lost it" },
      { "Medicine name": `Galvus ${TAG}`, Reason: "buying outside", Date: DMY(dayOffset(3)) },
    ]);
    const preview = await (await upload("import/preview", file)).json();
    expect(preview.counts).toEqual({ new: 1, same: 0, conflict: 0, error: 3 });
    const messages = preview.rows.flatMap((r) => r.errors.map((e) => e.message)).join(" | ");
    expect(messages).toContain("needed when the reason is Other");
    expect(messages).toContain("must be one of");
    expect(messages).toContain("cannot be in the future");

    expect(
      (
        await pharmacist.post("/api/pharmacy/stock/needed/import", {
          headers: { "Content-Type": XLSX },
          data: file,
        })
      ).status(),
    ).toBe(403);
    const done = await (await upload("import", file)).json();
    expect(done).toMatchObject({ created: 1, skipped: 3 });

    const again = await sheet([
      {
        "Medicine name": `Trajenta ${TAG}`,
        Reason: "Out of stock",
        "Quantity needed (units)": 10,
        Date: DMY(TODAY),
      },
    ]);
    const check = await (await upload("import/preview", again)).json();
    expect(check.rows[0].status).toBe("conflict");
    expect(check.rows[0].choices.map((c) => c.value)).toEqual(["sheet", "keep", "add"]);
    expect(await (await upload("import", again, { default: "add" })).json()).toMatchObject({
      added: 1,
    });

    const { mine } = await report(pharmacist, { q: "Trajenta" });
    expect(mine[0]).toMatchObject({
      qtyUnits: 40,
      reasons: { out_of_stock: 1 },
      status: "not_stocked",
    });
  });

  test("the page shows the reasons and lets the admin import", async ({ page }) => {
    await loginAs(page, "pharmacy_admin");
    await gotoReady(
      page,
      `/pharmacy/needed?q=${TAG}`,
      () => page.getByRole("heading", { name: "Needed in stock" }),
      { timeout: 30000 },
    );
    const row = page.getByRole("row").filter({ hasText: OUTSIDE });
    await expect(row.getByText("Buying outside")).toBeVisible();
    await expect(row.getByText("Patient wants the pen, not vials")).toBeVisible();
    await expect(row.getByText("In stock")).toBeVisible();
    await page
      .getByRole("group", { name: "Filter by reason" })
      .getByRole("button", { name: /Out of stock/ })
      .click();
    await expect(page.getByRole("row").filter({ hasText: OUTSIDE })).toHaveCount(0);
    await expect(page.getByRole("row").filter({ hasText: EMPTY })).toHaveCount(1);
    await page.getByRole("button", { name: "Import from Excel" }).click();
    const dialog = page.getByRole("dialog", { name: "Import needed medicines from Excel" });
    await expect(dialog.getByRole("button", { name: "Download sample" })).toBeVisible();
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await page.getByRole("link", { name: "Needed in Stock" }).first().isVisible();
  });
});
