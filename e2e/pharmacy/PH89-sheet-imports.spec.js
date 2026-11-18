import { test, expect } from "@playwright/test";
import ExcelJS from "exceljs";
import { apiAs, loginAs } from "../helpers/auth.mjs";
import { one, query } from "../helpers/db.mjs";
import { gotoReady } from "../helpers/browser.mjs";
import { assertTestDatabase } from "../setup/guard.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);

const TAG = `PH89${Date.now().toString(36).toUpperCase()}`;
const YEAR = new Date().getFullYear() + 2;
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

test.describe.configure({ mode: "serial" });

async function workbook(headers, rows) {
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet("Sheet");
  sheet.addRow(headers);
  for (const row of rows) sheet.addRow(headers.map((h) => row[h] ?? null));
  return Buffer.from(await wb.xlsx.writeBuffer());
}

const MEDICINE_HEADERS = [
  "Medicine code",
  "Medicine name",
  "Manufacturer",
  "Type",
  "Units per pack",
  "Unit",
  "Pack",
  "GST %",
  "Schedule",
  "MRP per pack",
  "Sale rate per pack",
];

test.describe("PH89 Excel imports with conflicts the user decides", () => {
  let admin;
  let pharmacist;
  let existing;

  const post = (url, data, params) =>
    admin.post(url, { headers: { "Content-Type": XLSX }, data, ...(params ? { params } : {}) });

  test.beforeAll(async () => {
    admin = await apiAs("pharmacy_admin");
    pharmacist = await apiAs("pharmacy");
    existing = await (
      await admin.post("/api/pharmacy/medicines", {
        data: {
          name: `${TAG} Metformin 500`,
          form: "TAB",
          pack_size: 10,
          unit_label: "tab",
          pack_label: "strip",
          gst_rate_pct: 12,
          manufacturer: "Old Pharma",
          default_mrp: "30",
        },
      })
    ).json();
  });

  test.afterAll(async () => {
    await Promise.all([admin?.dispose(), pharmacist?.dispose()]);
  });

  test("the medicine sheet downloads with every active medicine", async () => {
    const response = await admin.get("/api/pharmacy/medicines/sheet.xlsx");
    expect(response.status()).toBe(200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(await response.body());
    const sheet = wb.getWorksheet("Medicines");
    const names = [];
    sheet.eachRow((row, n) => n > 1 && names.push(row.getCell(2).value));
    expect(names).toContain(existing.name);
    expect((await pharmacist.get("/api/pharmacy/medicines/sheet.xlsx")).status()).toBe(403);
  });

  test("a medicine sheet is checked: new, conflict, mistakes and duplicates", async () => {
    const file = await workbook(MEDICINE_HEADERS, [
      {
        "Medicine code": existing.code,
        "Medicine name": existing.name,
        Manufacturer: "New Pharma",
        "MRP per pack": 32,
      },
      {
        "Medicine name": `${TAG} Glimepiride 1`,
        Type: "tab",
        "Units per pack": 15,
        Unit: "Tab",
        Pack: "Strip",
        "GST %": 12,
        Schedule: "Schedule H",
      },
      {
        "Medicine name": `${TAG} Broken`,
        Type: "TAB",
        "Units per pack": 0,
        Unit: "tab",
        Pack: "strip",
        "GST %": 50,
      },
      {
        "Medicine name": `${TAG} Glimepiride 1`,
        Type: "TAB",
        "Units per pack": 10,
        Unit: "tab",
        Pack: "strip",
        "GST %": 12,
      },
    ]);
    const response = await post("/api/pharmacy/medicines/import/preview", file);
    const preview = await response.json();
    expect(response.status(), JSON.stringify(preview)).toBe(200);
    expect(preview.counts).toEqual({ new: 1, same: 0, conflict: 1, error: 2 });
    const conflict = preview.rows.find((r) => r.status === "conflict");
    expect(conflict.changes.map((c) => [c.column, c.from, c.to])).toEqual([
      ["Manufacturer", "Old Pharma", "New Pharma"],
      ["MRP per pack", "30.00", 32],
    ]);
    expect(conflict.choices.map((c) => c.value)).toEqual(["sheet", "keep"]);
    const messages = preview.rows.flatMap((r) => r.errors.map((e) => e.message)).join(" | ");
    expect(messages).toContain("Same medicine as row 3");
    expect(messages).toMatch(/GST/);

    const problems = await post("/api/pharmacy/medicines/import/problems.xlsx", file);
    expect(problems.status()).toBe(200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(await problems.body());
    const sheet = wb.getWorksheet("Medicines to fix");
    expect(sheet.rowCount).toBe(3);
    expect(String(sheet.getRow(1).getCell(sheet.columnCount).value)).toBe("Errors");

    const kept = await post("/api/pharmacy/medicines/import", file, { default: "keep" });
    const keptBody = await kept.json();
    expect(kept.status(), JSON.stringify(keptBody)).toBe(200);
    expect(keptBody).toMatchObject({ created: 1, updated: 0, kept: 1, skipped: 2 });
    const still = await one(
      `SELECT manufacturer, default_mrp FROM pharmacy_medicines WHERE id = $1`,
      [existing.id],
    );
    expect(still).toEqual({ manufacturer: "Old Pharma", default_mrp: "30.00" });
    const created = await one(
      `SELECT pack_size, unit_label, schedule, needs_review FROM pharmacy_medicines WHERE name = $1`,
      [`${TAG} Glimepiride 1`],
    );
    expect(created).toEqual({
      pack_size: 15,
      unit_label: "tab",
      schedule: "H",
      needs_review: false,
    });

    const again = await post("/api/pharmacy/medicines/import", file, {
      sheet: String(conflict.row),
    });
    const againBody = await again.json();
    expect(againBody).toMatchObject({ created: 0, updated: 1 });
    const changed = await one(
      `SELECT manufacturer, default_mrp, pack_size FROM pharmacy_medicines WHERE id = $1`,
      [existing.id],
    );
    expect(changed).toEqual({ manufacturer: "New Pharma", default_mrp: "32.00", pack_size: 10 });
  });

  test("vendors import and update by GSTIN", async () => {
    const headers = ["Vendor name", "Phone", "GSTIN", "City"];
    const first = await workbook(headers, [
      { "Vendor name": `${TAG} Medline`, Phone: 9876543210, City: "Mohali" },
    ]);
    const made = await (await post("/api/pharmacy/vendors/import", first)).json();
    expect(made).toMatchObject({ created: 1 });
    const second = await workbook(headers, [
      { "Vendor name": `${TAG} Medline`, Phone: "98765 43210", City: "Chandigarh" },
      { "Vendor name": `${TAG} Bad`, Phone: "12" },
    ]);
    const preview = await (await post("/api/pharmacy/vendors/import/preview", second)).json();
    expect(preview.counts).toMatchObject({ conflict: 1, error: 1 });
    expect(preview.rows[0].changes).toEqual([
      expect.objectContaining({ column: "City", from: "Mohali", to: "Chandigarh" }),
    ]);
    const done = await (await post("/api/pharmacy/vendors/import", second)).json();
    expect(done).toMatchObject({ updated: 1, skipped: 1 });
    const vendor = await one(`SELECT city FROM pharmacy_vendors WHERE name = $1`, [
      `${TAG} Medline`,
    ]);
    expect(vendor.city).toBe("Chandigarh");
  });

  test("DARPAN items become medicines marked for review, once", async () => {
    await query(
      `INSERT INTO pharmacy_stock_items (item_key, item_name, qty, company, item_type, unit_sale_price, in_latest)
       VALUES ($1, $2, 12, 'Sun', 'TAB', 85.5, TRUE), ($3, $4, 3, NULL, 'INJ', 40, TRUE)`,
      [
        `${TAG} TAB DYTOR 5 1 X 15`,
        `${TAG} TAB DYTOR 5 1 X 15`,
        `${TAG} INJ TROPINE`,
        `${TAG} INJ TROPINE`,
      ],
    );
    await query(
      `INSERT INTO pharmacy_stock_links (item_key, medicine_key, status) VALUES ($1, $2, 'confirmed')`,
      [`${TAG} TAB DYTOR 5 1 X 15`, `${TAG} DYTOR 5`],
    );
    const preview = await (await admin.get("/api/pharmacy/medicines/import/darpan")).json();
    const mine = preview.rows.filter((r) => r.key.startsWith(TAG));
    expect(mine.map((r) => r.status)).toEqual(["new", "new"]);

    const done = await admin.post("/api/pharmacy/medicines/import/darpan", { data: {} });
    expect(done.status(), await done.text()).toBe(200);
    const rows = (
      await query(
        `SELECT name, form, pack_size, needs_review, medicine_key, default_sale_rate, manufacturer
           FROM pharmacy_medicines WHERE name LIKE $1 ORDER BY name`,
        [`${TAG} %`],
      )
    ).rows.filter((r) => /DYTOR|TROPINE/.test(r.name));
    expect(rows).toEqual([
      expect.objectContaining({
        form: "INJ",
        pack_size: 1,
        needs_review: true,
        default_sale_rate: "40.00",
      }),
      expect.objectContaining({
        form: "TAB",
        needs_review: true,
        medicine_key: `${TAG} DYTOR 5`,
        manufacturer: "Sun",
      }),
    ]);

    const again = await (await admin.get("/api/pharmacy/medicines/import/darpan")).json();
    expect(again.rows.filter((r) => r.key.startsWith(TAG)).map((r) => r.status)).toEqual([
      "same",
      "same",
    ]);
  });

  test("a receipt sheet asks what to do with a batch already on the receipt", async () => {
    const receipt = await (
      await admin.post("/api/pharmacy/purchases", { data: { kind: "opening" } })
    ).json();
    const headers = [
      "Medicine code",
      "Medicine name",
      "Batch",
      "Expiry",
      "Qty (packs)",
      "MRP per pack",
      "Sale rate per pack",
    ];
    const line = {
      "Medicine code": existing.code,
      Batch: "M1",
      Expiry: `12/${YEAR}`,
      "Qty (packs)": 4,
      "MRP per pack": 32,
      "Sale rate per pack": 30,
    };
    const first = await (
      await post(`/api/pharmacy/purchases/${receipt.id}/import`, await workbook(headers, [line]), {
        version: receipt.version,
      })
    ).json();
    expect(first).toMatchObject({ created: 1 });

    const byName = {
      ...line,
      "Medicine code": null,
      "Medicine name": existing.name,
      "Qty (packs)": 6,
    };
    const file = await workbook(headers, [byName]);
    const preview = await (
      await post(`/api/pharmacy/purchases/${receipt.id}/import/preview`, file)
    ).json();
    expect(preview.counts).toMatchObject({ conflict: 1 });
    expect(preview.rows[0].choices.map((c) => c.value)).toEqual(["sheet", "keep", "add"]);
    expect(preview.rows[0].changes).toEqual([
      expect.objectContaining({ column: "Qty (packs)", from: 4, to: 6 }),
    ]);

    const added = await (
      await post(`/api/pharmacy/purchases/${receipt.id}/import`, file, {
        version: first.purchase.version,
        default: "add",
      })
    ).json();
    expect(added).toMatchObject({ added: 1 });
    expect(added.purchase.lines.map((l) => l.qty_packs)).toEqual([10]);

    const posted = await admin.post(`/api/pharmacy/purchases/${receipt.id}/post`, {
      data: { version: added.purchase.version },
    });
    expect(posted.status(), await posted.text()).toBe(200);

    const next = await (
      await admin.post("/api/pharmacy/purchases", { data: { kind: "opening" } })
    ).json();
    const pricier = await workbook(headers, [
      { ...line, "MRP per pack": 40, "Sale rate per pack": 38 },
    ]);
    const check = await (
      await post(`/api/pharmacy/purchases/${next.id}/import/preview`, pricier)
    ).json();
    expect(check.rows[0].status).toBe("conflict");
    expect(check.rows[0].note).toContain("already in stock");
    expect(check.rows[0].choices.map((c) => c.value)).toEqual(["keep", "skip"]);
    const kept = await (
      await post(`/api/pharmacy/purchases/${next.id}/import`, pricier, {
        version: next.version,
        default: "keep",
      })
    ).json();
    expect(kept.purchase.lines.map((l) => [l.mrp, l.sale_rate])).toEqual([["32.00", "30.00"]]);
  });

  test("the admin decides a conflict in the import popup", async ({ page }) => {
    const file = await workbook(MEDICINE_HEADERS, [
      {
        "Medicine code": existing.code,
        "Medicine name": existing.name,
        Manufacturer: "Popup Pharma",
      },
      {
        "Medicine name": `${TAG} Popup New`,
        Type: "CAP",
        "Units per pack": 10,
        Unit: "cap",
        Pack: "strip",
        "GST %": 5,
      },
      { "Medicine name": `${TAG} Popup Bad`, Type: "NOPE" },
    ]);
    await loginAs(page, "pharmacy_admin");
    await gotoReady(
      page,
      "/pharmacy/medicines",
      () => page.getByRole("button", { name: "Import from Excel" }),
      { timeout: 30000 },
    );
    await page.getByRole("button", { name: "Import from Excel" }).click();
    const dialog = page.getByRole("dialog", { name: "Import medicines from Excel" });
    await dialog.getByLabel("Import medicines from Excel file").setInputFiles({
      name: "medicines.xlsx",
      mimeType: XLSX,
      buffer: file,
    });
    await expect(dialog.getByText("Matches " + existing.code, { exact: false })).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Decide 1 conflict first" })).toBeDisabled();
    await dialog.getByRole("radio", { name: "Use the sheet" }).check();
    await dialog.getByRole("button", { name: /Need fixing/ }).click();
    await expect(dialog.getByText(/Type/).first()).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Download rows to fix" })).toBeVisible();
    await dialog.getByRole("button", { name: "Import 2 rows" }).click();
    await expect(dialog.getByText("Import finished")).toBeVisible();
    await expect(dialog.getByText("updated from the sheet")).toBeVisible();
    const after = await one(`SELECT manufacturer FROM pharmacy_medicines WHERE id = $1`, [
      existing.id,
    ]);
    expect(after.manufacturer).toBe("Popup Pharma");
    await dialog.getByRole("button", { name: "Close" }).click();
    await expect(dialog).toHaveCount(0);
  });
});
