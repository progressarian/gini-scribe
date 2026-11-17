import { test, expect } from "@playwright/test";
import ExcelJS from "exceljs";
import { apiAs, loginAs } from "../helpers/auth.mjs";
import { gotoReady } from "../helpers/browser.mjs";
import { financialYearOf } from "../../shared/billingVocab.js";
import { assertTestDatabase } from "../setup/guard.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);

const TAG = `PH70${Date.now().toString(36).toUpperCase()}`;
const dayOffset = (days) => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
};
const TODAY = dayOffset(0);
const FY = financialYearOf(TODAY);

test.describe.configure({ mode: "serial" });

test.describe("PH70 pharmacy reports and dashboard", () => {
  let admin;
  let pharmacist;
  let before;
  let bill;

  const report = async (key, params = { from: TODAY, to: TODAY }) => {
    const response = await admin.get(`/api/pharmacy/reports/${key}`, { params });
    expect(response.status(), await response.text()).toBe(200);
    return response.json();
  };

  test.beforeAll(async () => {
    admin = await apiAs("pharmacy_admin");
    pharmacist = await apiAs("pharmacy");
    for (const [series, prefix] of [
      ["PH", "PH/"],
      ["PHR", "PHR/"],
    ]) {
      await admin.put("/api/pharmacy/settings/series", {
        data: { series, fy: FY, prefix, number_width: 6 },
      });
    }
    before = {
      sales: await report("sales"),
      gst: await report("gst"),
      h1: await report("h1_register"),
    };
    const medicine = await (
      await admin.post("/api/pharmacy/medicines", {
        data: {
          name: `${TAG} Clonazepam 0.5`,
          form: "TAB",
          pack_size: 10,
          unit_label: "tab",
          pack_label: "strip",
          gst_rate_pct: 12,
          hsn_code: "30049011",
          schedule: "H1",
        },
      })
    ).json();
    const receipt = await (
      await admin.post("/api/pharmacy/purchases", { data: { kind: "opening" } })
    ).json();
    const saved = await (
      await admin.put(`/api/pharmacy/purchases/${receipt.id}`, {
        data: {
          version: receipt.version,
          lines: [
            {
              medicine_id: medicine.id,
              batch_no: "CLZ1",
              expiry_date: dayOffset(400),
              qty_packs: 3,
              purchase_rate: "20",
              gst_rate_pct: 12,
              mrp: "40",
              sale_rate: "35",
            },
          ],
        },
      })
    ).json();
    const batchId = (
      await (
        await admin.post(`/api/pharmacy/purchases/${receipt.id}/post`, {
          data: { version: saved.version },
        })
      ).json()
    ).lines[0].batch_id;
    const patient = (
      await (
        await pharmacist.post("/api/pharmacy/bills/patients", {
          data: { name: `${TAG} Patient`, phone: `90${String(Date.now()).slice(-8)}` },
        })
      ).json()
    ).patient;
    const draft = await (
      await pharmacist.post("/api/pharmacy/bills", {
        data: { patient_id: patient.id, sale_type: "opd", prescriber_name: "Dr. Kaur" },
      })
    ).json();
    const priced = await (
      await pharmacist.put(`/api/pharmacy/bills/${draft.id}`, {
        data: {
          version: draft.version,
          sale_type: "opd",
          prescriber_name: "Dr. Kaur",
          lines: [{ batch_id: batchId, qty_units: 10 }],
        },
      })
    ).json();
    bill = await (
      await pharmacist.post(`/api/pharmacy/bills/${draft.id}/finalise`, {
        data: {
          version: priced.version,
          payments: [{ mode: "card", amount: 39, reference: "CARD1" }],
        },
      })
    ).json();
    expect(bill.status).toBe("final");
  });

  test.afterAll(async () => {
    await Promise.all([admin?.dispose(), pharmacist?.dispose()]);
  });

  test("only report users can open pharmacy reports", async () => {
    expect((await pharmacist.get("/api/pharmacy/reports")).status()).toBe(403);
    expect((await pharmacist.get("/api/pharmacy/reports/dashboard")).status()).toBe(403);
    const list = await (await admin.get("/api/pharmacy/reports")).json();
    expect(list.map((r) => r.key)).toEqual(
      expect.arrayContaining(["sales", "gst", "h1_register", "darpan", "stock_value"]),
    );
    expect((await admin.get("/api/pharmacy/reports/nope")).status()).toBe(404);
    const backwards = await admin.get("/api/pharmacy/reports/sales", {
      params: { from: TODAY, to: dayOffset(-1) },
    });
    expect(backwards.status()).toBe(400);
  });

  test("a sale shows in daily sales, the GST summary and the H1 register", async () => {
    const sales = await report("sales");
    expect(sales.totals.net_sales - before.sales.totals.net_sales).toBeCloseTo(39, 2);
    expect(sales.totals.gst - before.sales.totals.gst).toBeCloseTo(4.2, 2);

    const gst = await report("gst");
    const row = gst.rows.find((r) => r.hsn_code === "30049011");
    expect(row).toMatchObject({ rate: "12.00", treatment: "GST charged" });
    expect(Number(row.cgst)).toBeGreaterThanOrEqual(2.1);

    const h1 = await report("h1_register");
    expect(h1.rows.length).toBe(before.h1.rows.length + 1);
    expect(h1.rows.find((r) => r.bill_no === bill.bill_no)).toMatchObject({
      patient: `${TAG} Patient`,
      prescriber: "Dr. Kaur",
      schedule: "H1",
      batch_no: "CLZ1",
      qty_units: 10,
    });

    const collections = await report("collections");
    expect(collections.rows.some((r) => r.mode === "card")).toBe(true);
  });

  test("stock value and the DARPAN reconciliation need no dates", async () => {
    const stock = await report("stock_value", {});
    const line = stock.rows.find((r) => r.medicine === `${TAG} Clonazepam 0.5`);
    expect(line).toMatchObject({ units: 20, cost_value: "40.00", mrp_value: "80.00" });
    const darpan = await report("darpan", {});
    expect(darpan.rows.find((r) => r.medicine === `${TAG} Clonazepam 0.5`)).toMatchObject({
      darpan_qty: "Not in DARPAN",
      scribe_units: 20,
      status: "Only in Scribe",
    });
  });

  test("any report downloads as Excel with a total row", async () => {
    const response = await admin.get("/api/pharmacy/reports/sales/export.xlsx", {
      params: { from: TODAY, to: TODAY },
    });
    expect(response.status()).toBe(200);
    expect(response.headers()["content-disposition"]).toContain(
      `Pharmacy_sales_${TODAY}_to_${TODAY}`,
    );
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(await response.body());
    const sheet = workbook.worksheets[0];
    expect(sheet.getRow(1).getCell(1).value).toBe("Date");
    expect(sheet.getRow(sheet.rowCount).getCell(1).value).toBe("Total");
  });

  test("the dashboard and reports pages show today's figures", async ({ page }) => {
    const dashboard = await (await admin.get("/api/pharmacy/reports/dashboard")).json();
    expect(dashboard.recent.map((b) => b.id)).toContain(bill.id);

    await loginAs(page, "pharmacy_admin");
    await gotoReady(
      page,
      "/pharmacy/dashboard",
      () => page.getByRole("heading", { name: "Pharmacy today" }),
      { timeout: 30000 },
    );
    await expect(page.getByText("Net sales today")).toBeVisible();
    await expect(page.getByRole("table", { name: "Latest bills" })).toContainText(bill.bill_no);

    await page.getByRole("link", { name: "Reports" }).click();
    await expect(page.getByRole("heading", { name: "Pharmacy reports" })).toBeVisible();
    await page.getByRole("combobox", { name: "Report", exact: true }).selectOption("h1_register");
    await expect(page.getByRole("table", { name: "Schedule H1 / X register" })).toContainText(
      `${TAG} Patient`,
    );
    await page.getByRole("combobox", { name: "Report", exact: true }).selectOption("stock_value");
    await expect(page.getByLabel("From", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("table", { name: "Stock valuation" })).toContainText(
      `${TAG} Clonazepam 0.5`,
    );
  });
});
