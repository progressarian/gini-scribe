import { test, expect } from "@playwright/test";
import ExcelJS from "exceljs";
import { apiAs, loginAs } from "../helpers/auth.mjs";
import { gotoReady } from "../helpers/browser.mjs";
import { assertTestDatabase } from "../setup/guard.mjs";
import { pickOption } from "../helpers/pickers.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);

const TAG = `PH82${Date.now().toString(36).toUpperCase()}`;
const dayOffset = (days) => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
};

test.describe.configure({ mode: "serial" });

test.describe("PH82 the stock list with PTR, LP and margin", () => {
  let admin;
  let pharmacist;
  let vendor;

  const list = async (api, params) =>
    (await api.get("/api/pharmacy/batches/list", { params: { q: TAG, ...params } })).json();

  test.beforeAll(async () => {
    admin = await apiAs("pharmacy_admin");
    pharmacist = await apiAs("pharmacy");
    vendor = await (
      await admin.post("/api/pharmacy/vendors", {
        data: { name: `${TAG} Distributor`, phone: "9811112222" },
      })
    ).json();
    const medicine = (name, form) =>
      admin
        .post("/api/pharmacy/medicines", {
          data: {
            name: `${TAG} ${name}`,
            form,
            pack_size: 10,
            unit_label: form === "INJ" ? "vial" : "tab",
            pack_label: form === "INJ" ? "box" : "strip",
            gst_rate_pct: 12,
          },
        })
        .then((r) => r.json());
    const tab = await medicine("Amlong 5", "TAB");
    const inj = await medicine("Ceftum Inj", "INJ");
    const receipt = await (
      await admin.post("/api/pharmacy/purchases", {
        data: { vendor_id: vendor.id, invoice_no: `${TAG}-1`, invoice_date: dayOffset(0) },
      })
    ).json();
    const saved = await (
      await admin.put(`/api/pharmacy/purchases/${receipt.id}`, {
        data: {
          version: receipt.version,
          vendor_id: vendor.id,
          invoice_no: `${TAG}-1`,
          invoice_date: dayOffset(0),
          lines: [
            {
              medicine_id: tab.id,
              batch_no: "AML1",
              expiry_date: dayOffset(20),
              qty_packs: 10,
              free_packs: 2,
              purchase_rate: "50",
              discount_pct: 10,
              gst_rate_pct: 12,
              mrp: "100",
              sale_rate: "90",
            },
            {
              medicine_id: inj.id,
              batch_no: "CFT1",
              expiry_date: dayOffset(300),
              qty_packs: 5,
              purchase_rate: "200",
              gst_rate_pct: 12,
              mrp: "300",
              sale_rate: "280",
            },
          ],
        },
      })
    ).json();
    const posted = await admin.post(`/api/pharmacy/purchases/${receipt.id}/post`, {
      data: { version: saved.version },
    });
    expect(posted.status(), await posted.text()).toBe(200);
  });

  test.afterAll(async () => {
    await Promise.all([admin?.dispose(), pharmacist?.dispose()]);
  });

  test("LP is the rate after discount, plus GST, spread over free packs; margin is on MRP", async () => {
    const result = await list(admin, {});
    const amlong = result.rows.find((r) => r.batch_no === "AML1");
    expect(amlong).toMatchObject({
      form: "TAB",
      vendor_name: `${TAG} Distributor`,
      ptr: "50.00",
      lp: "42.00",
      margin_pct: "58.00",
      qty_units: 120,
      mrp: "100.00",
    });
    expect(result.forms).toEqual(expect.arrayContaining(["TAB", "INJ"]));
  });

  test("the pharmacist sees the list without purchase cost", async () => {
    const result = await list(pharmacist, { sort: "lp" });
    expect(result.rows.length).toBe(2);
    for (const row of result.rows) {
      expect(row).not.toHaveProperty("ptr");
      expect(row).not.toHaveProperty("lp");
      expect(row).not.toHaveProperty("margin_pct");
    }
  });

  test("filters by type, supplier and expiry, and sorts any column", async () => {
    expect((await list(admin, { form: "INJ" })).rows.map((r) => r.batch_no)).toEqual(["CFT1"]);
    expect((await list(admin, { vendor_id: vendor.id })).total).toBe(2);
    expect((await list(admin, { expiry: "30" })).rows.map((r) => r.batch_no)).toEqual(["AML1"]);
    expect((await list(admin, { expiry: "fresh" })).rows.map((r) => r.batch_no)).toEqual(["CFT1"]);
    const byMargin = await list(admin, { sort: "margin_pct", dir: "desc" });
    expect(byMargin.rows.map((r) => r.batch_no)).toEqual(["AML1", "CFT1"]);
    const byMrp = await list(admin, { sort: "mrp", dir: "desc" });
    expect(byMrp.rows.map((r) => r.batch_no)).toEqual(["CFT1", "AML1"]);
  });

  test("the list downloads as Excel with the cost columns for buyers only", async () => {
    const header = async (api) => {
      const response = await api.get("/api/pharmacy/batches/list.xlsx", { params: { q: TAG } });
      expect(response.status()).toBe(200);
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(await response.body());
      return workbook.worksheets[0].getRow(1).values.filter(Boolean);
    };
    expect(await header(admin)).toEqual(
      expect.arrayContaining(["PTR / pack", "LP / pack", "Margin %"]),
    );
    expect(await header(pharmacist)).not.toContain("LP / pack");
  });

  test("the Stock list tab shows the columns and sorts on a click", async ({ page }) => {
    await loginAs(page, "pharmacy_admin");
    await gotoReady(
      page,
      "/pharmacy/stock?tab=list",
      () => page.getByRole("heading", { name: "Stock list" }),
      { timeout: 30000 },
    );
    await page.getByLabel("Search stock list").fill(TAG);
    const table = page.getByRole("table", { name: "Stock list" });
    await expect(table.getByRole("row")).toHaveCount(3);
    await expect(table).toContainText("58.00%");
    await table.getByRole("button", { name: "MRP" }).click();
    await table.getByRole("button", { name: /MRP/ }).click();
    await expect(table.getByRole("columnheader", { name: /MRP/ })).toHaveAttribute(
      "aria-sort",
      "descending",
    );
    await expect(table.getByRole("row").nth(1)).toContainText("CFT1");
    await pickOption(page, "Item type", "TAB");
    await expect(table.getByRole("row")).toHaveCount(2);
  });
});
