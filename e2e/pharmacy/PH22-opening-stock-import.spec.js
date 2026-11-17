import { test, expect } from "@playwright/test";
import ExcelJS from "exceljs";
import { apiAs, loginAs } from "../helpers/auth.mjs";
import { one } from "../helpers/db.mjs";
import { gotoReady } from "../helpers/browser.mjs";
import { assertTestDatabase } from "../setup/guard.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);

const TAG = `PH22${Date.now().toString(36).toUpperCase()}`;
const YEAR = new Date().getFullYear() + 2;
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

test.describe.configure({ mode: "serial" });

test.describe("PH22 opening stock from the Excel template", () => {
  let admin;
  let tablet;
  let syrup;
  let receipt;

  const medicine = (name, extra) =>
    admin
      .post("/api/pharmacy/medicines", {
        data: {
          name: `${TAG} ${name}`,
          form: "TAB",
          pack_size: 10,
          unit_label: "tab",
          pack_label: "strip",
          gst_rate_pct: 12,
          ...extra,
        },
      })
      .then((r) => r.json());

  async function filledTemplate(fill) {
    const response = await admin.get("/api/pharmacy/purchases/template.xlsx");
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toContain(XLSX);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(await response.body());
    const sheet = workbook.getWorksheet("Stock");
    const header = sheet.getRow(1).values;
    const col = (name) => header.findIndex((h) => String(h).startsWith(name));
    const rowOf = (code) => {
      for (let r = 2; r <= sheet.rowCount; r += 1) {
        if (sheet.getRow(r).getCell(col("Medicine code")).value === code) return sheet.getRow(r);
      }
      return null;
    };
    const set = (row, values) => {
      for (const [name, value] of Object.entries(values)) row.getCell(col(name)).value = value;
      row.commit();
    };
    fill({ sheet, rowOf, set, col });
    return Buffer.from(await workbook.xlsx.writeBuffer());
  }

  test.beforeAll(async () => {
    admin = await apiAs("pharmacy_admin");
    tablet = await medicine("Losartan 50", {
      default_rack: "D-1",
      default_mrp: "20",
      default_sale_rate: "18",
    });
    syrup = await medicine("Antacid Gel", {
      form: "SYP",
      pack_size: 1,
      unit_label: "unit",
      pack_label: "bottle",
      gst_rate_pct: 5,
    });
    receipt = await (
      await admin.post("/api/pharmacy/purchases", { data: { kind: "opening" } })
    ).json();
  });

  test.afterAll(async () => {
    await admin?.dispose();
  });

  test("the template lists every active medicine with its defaults", async () => {
    await filledTemplate(({ rowOf, col }) => {
      const row = rowOf(tablet.code);
      expect(row, "tablet row").not.toBeNull();
      expect(row.getCell(col("Medicine name")).value).toBe(tablet.name);
      expect(row.getCell(col("Pack")).value).toBe("strip of 10 tab");
      expect(row.getCell(col("GST %")).value).toBe(12);
      expect(row.getCell(col("MRP per pack")).value).toBe(20);
      expect(row.getCell(col("Rack")).value).toBe("D-1");
    });
  });

  test("filled rows become draft lines and bad rows come back with reasons", async () => {
    const file = await filledTemplate(({ sheet, rowOf, set }) => {
      set(rowOf(tablet.code), {
        Batch: "imp 1",
        Expiry: `12/${YEAR}`,
        "Qty (packs)": 3,
        "Purchase rate per pack": 10,
      });
      const second = sheet.addRow([]);
      set(second, {
        "Medicine code": tablet.code,
        Batch: "IMP2",
        Expiry: new Date(Date.UTC(YEAR + 1, 0, 15)),
        "Qty (packs)": 1,
        "GST %": 12,
        "MRP per pack": 20,
        "Sale rate per pack": 18,
      });
      const duplicate = sheet.addRow([]);
      set(duplicate, {
        "Medicine code": tablet.code,
        Batch: "IMP1",
        Expiry: `31/12/${YEAR}`,
        "Qty (packs)": 9,
        "MRP per pack": 20,
        "Sale rate per pack": 18,
      });
      set(rowOf(syrup.code), {
        Batch: "GEL1",
        Expiry: `${YEAR}-03-31`,
        "Qty (packs)": 2,
        "MRP per pack": 25,
        "Sale rate per pack": 30,
      });
      const unknown = sheet.addRow([]);
      set(unknown, {
        "Medicine code": "NOPE-404",
        Batch: "X1",
        Expiry: `${YEAR}-01-01`,
        "Qty (packs)": 1,
        "MRP per pack": 5,
        "Sale rate per pack": 5,
      });
    });

    const response = await admin.post(`/api/pharmacy/purchases/${receipt.id}/import`, {
      params: { version: receipt.version },
      headers: { "Content-Type": XLSX },
      data: file,
    });
    const body = await response.json();
    expect(response.status(), JSON.stringify(body)).toBe(200);
    expect(body.added).toBe(2);
    const reasons = body.skipped.map((s) => s.reason).join(" | ");
    expect(body.skipped).toHaveLength(3);
    expect(reasons).toContain("is already on this receipt");
    expect(reasons).toContain("cannot be more than the MRP");
    expect(reasons).toContain("No medicine has the code NOPE-404");

    receipt = body.purchase;
    expect(receipt.lines.map((l) => [l.batch_no, l.expiry_date, l.qty_packs, l.rack_no])).toEqual([
      ["IMP1", `${YEAR}-12-31`, 3, "D-1"],
      ["IMP2", `${YEAR + 1}-01-15`, 1, null],
    ]);
  });

  test("an import against an old version of the receipt is refused", async () => {
    const file = await filledTemplate(() => {});
    const stale = await admin.post(`/api/pharmacy/purchases/${receipt.id}/import`, {
      params: { version: receipt.version - 1 },
      headers: { "Content-Type": XLSX },
      data: file,
    });
    expect(stale.status()).toBe(409);
  });

  test("a file that is not the template is refused with a clear message", async () => {
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet("Sheet1").addRow(["Item", "Qty"]).commit();
    wb.getWorksheet("Sheet1").addRow(["X", 1]).commit();
    const response = await admin.post(`/api/pharmacy/purchases/${receipt.id}/import`, {
      params: { version: receipt.version },
      headers: { "Content-Type": XLSX },
      data: Buffer.from(await wb.xlsx.writeBuffer()),
    });
    expect(response.status()).toBe(400);
    expect((await response.json()).error).toContain('"Medicine code" column is missing');
  });

  test("the imported opening stock posts like any receipt", async () => {
    const posted = await admin.post(`/api/pharmacy/purchases/${receipt.id}/post`, {
      data: { version: receipt.version },
    });
    expect(posted.status(), await posted.text()).toBe(200);
    const stock = await one(
      `SELECT SUM(s.qty_units)::int AS units FROM pharmacy_stock s
         JOIN pharmacy_batches b ON b.id = s.batch_id WHERE b.medicine_id = $1`,
      [tablet.id],
    );
    expect(stock.units).toBe(40);
  });

  test("the admin imports a filled template from the receipt screen", async ({ page }) => {
    const draft = await (
      await admin.post("/api/pharmacy/purchases", { data: { kind: "opening" } })
    ).json();
    const file = await filledTemplate(({ rowOf, set }) => {
      set(rowOf(syrup.code), {
        Batch: "GEL9",
        Expiry: `06/${YEAR}`,
        "Qty (packs)": 4,
        "MRP per pack": 25,
        "Sale rate per pack": 22,
      });
    });

    await loginAs(page, "pharmacy_admin");
    await gotoReady(
      page,
      `/pharmacy/purchases/${draft.id}`,
      () => page.getByRole("button", { name: "Import from Excel" }),
      { timeout: 30000 },
    );
    await page.getByLabel("Filled stock template").setInputFiles({
      name: "stock.xlsx",
      mimeType: XLSX,
      buffer: file,
    });
    await expect(page.getByText("1 row added from the file.")).toBeVisible();
    await expect(
      page.getByLabel(`Batch for line 1, ${TAG} Antacid Gel`, { exact: true }),
    ).toHaveValue("GEL9");
    await expect(
      page.getByLabel(`Expiry for line 1, ${TAG} Antacid Gel`, { exact: true }),
    ).toContainText(`30 Jun ${YEAR}`);
    await expect(page.getByRole("status").filter({ hasText: "All changes saved" })).toBeVisible();
  });
});
