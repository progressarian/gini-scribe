import { test, expect } from "@playwright/test";
import ExcelJS from "exceljs";
import { apiAs, loginAs } from "../helpers/auth.mjs";
import { gotoReady } from "../helpers/browser.mjs";
import { financialYearOf } from "../../shared/billingVocab.js";
import { assertTestDatabase } from "../setup/guard.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);

const TAG = `PH84${Date.now().toString(36).toUpperCase()}`;
const dayOffset = (days) => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
};
const TODAY = dayOffset(0);
const FY = financialYearOf(TODAY);

test.describe.configure({ mode: "serial" });

test.describe("PH84 top selling items, merged or split by supplier", () => {
  let admin;
  let pharmacist;
  let patient;
  let vendorA;
  let vendorB;
  let batch = {};

  const report = async (params = {}) => {
    const response = await admin.get("/api/pharmacy/reports/top-items", {
      params: { from: TODAY, to: TODAY, q: TAG, ...params },
    });
    expect(response.status(), await response.text()).toBe(200);
    return response.json();
  };

  const sell = async (batchId, qty_units) => {
    const draft = await (
      await pharmacist.post("/api/pharmacy/bills", {
        data: { patient_id: patient.id, sale_type: "walkin" },
      })
    ).json();
    const saved = await (
      await pharmacist.put(`/api/pharmacy/bills/${draft.id}`, {
        data: {
          version: draft.version,
          sale_type: "walkin",
          lines: [{ batch_id: batchId, qty_units }],
        },
      })
    ).json();
    const done = await pharmacist.post(`/api/pharmacy/bills/${draft.id}/finalise`, {
      data: {
        version: saved.version,
        payments: [{ mode: "cash", amount: Number(saved.net_amount) }],
      },
    });
    expect(done.status(), await done.text()).toBe(200);
    return done.json();
  };

  const receive = async (vendor, lines) => {
    const receipt = await (
      await admin.post("/api/pharmacy/purchases", {
        data: { vendor_id: vendor.id, invoice_no: `${TAG}-${vendor.id}`, invoice_date: TODAY },
      })
    ).json();
    const saved = await (
      await admin.put(`/api/pharmacy/purchases/${receipt.id}`, {
        data: {
          version: receipt.version,
          vendor_id: vendor.id,
          invoice_no: `${TAG}-${vendor.id}`,
          invoice_date: TODAY,
          lines,
        },
      })
    ).json();
    const posted = await admin.post(`/api/pharmacy/purchases/${receipt.id}/post`, {
      data: { version: saved.version },
    });
    expect(posted.status(), await posted.text()).toBe(200);
    return (await posted.json()).lines;
  };

  test.beforeAll(async () => {
    admin = await apiAs("pharmacy_admin");
    pharmacist = await apiAs("pharmacy");
    for (const [series, prefix] of [
      ["PH", "PH/"],
      ["PHR", "PHR/"],
      ["PHCN", "PHCN/"],
    ]) {
      await admin.put("/api/pharmacy/settings/series", {
        data: { series, fy: FY, prefix, number_width: 6 },
      });
    }
    const vendor = (name) =>
      admin
        .post("/api/pharmacy/vendors", { data: { name: `${TAG} ${name}`, phone: "9800011122" } })
        .then((r) => r.json());
    vendorA = await vendor("Alpha Pharma");
    vendorB = await vendor("Beta Medicos");
    const medicine = (name, form, manufacturer) =>
      admin
        .post("/api/pharmacy/medicines", {
          data: {
            name: `${TAG} ${name}`,
            form,
            manufacturer,
            pack_size: 10,
            unit_label: "tab",
            pack_label: "strip",
            gst_rate_pct: 12,
          },
        })
        .then((r) => r.json());
    const telma = await medicine("Telma 40", "TAB", "Glenmark");
    const augmentin = await medicine("Augmentin 625", "TAB", "GSK");
    const line = (m, batch_no) => ({
      medicine_id: m.id,
      batch_no,
      expiry_date: dayOffset(400),
      qty_packs: 10,
      purchase_rate: "20",
      gst_rate_pct: 12,
      mrp: "40",
      sale_rate: "35",
    });
    const fromA = await receive(vendorA, [line(telma, "TLA1"), line(augmentin, "AUG1")]);
    const fromB = await receive(vendorB, [line(telma, "TLB1")]);
    for (const l of [...fromA, ...fromB]) batch[l.batch_no] = l.batch_id;
    patient = (
      await (
        await pharmacist.post("/api/pharmacy/bills/patients", {
          data: { name: `${TAG} Buyer`, phone: `85${String(Date.now()).slice(-8)}` },
        })
      ).json()
    ).patient;

    await sell(batch.TLA1, 30);
    const fromBeta = await sell(batch.TLB1, 20);
    await sell(batch.AUG1, 10);
    const back = await pharmacist.post(`/api/pharmacy/bills/${fromBeta.id}/returns`, {
      data: {
        version: fromBeta.version,
        reason: "Not needed",
        lines: [{ line_id: fromBeta.lines[0].id, qty_units: 5 }],
        refund: { mode: "cash" },
      },
    });
    expect(back.status(), await back.text()).toBe(201);
  });

  test.afterAll(async () => {
    await Promise.all([admin?.dispose(), pharmacist?.dispose()]);
  });

  test("one row per item with both suppliers merged, returns netted off", async () => {
    const result = await report();
    expect(result.rows.map((r) => r.medicine_name)).toEqual([
      `${TAG} Telma 40`,
      `${TAG} Augmentin 625`,
    ]);
    const telma = result.rows[0];
    expect(telma).toMatchObject({
      company: "Glenmark",
      sold_qty: 50,
      returned_qty: 5,
      net_qty: 45,
      sale_amount: "196.00",
      net_amount: "176.40",
    });
    expect(telma.vendor_name).toBe(`${TAG} Alpha Pharma, ${TAG} Beta Medicos`);
    expect(result.totals).toMatchObject({ sold_qty: 60, returned_qty: 5, net_qty: 55 });
  });

  test("split by supplier shows the same item once for each supplier", async () => {
    const result = await report({ group: "vendor", sort: "sold_qty", dir: "desc" });
    expect(
      result.rows.map((r) => [
        r.medicine_name.replace(`${TAG} `, ""),
        r.vendor_name.replace(`${TAG} `, ""),
        r.net_qty,
      ]),
    ).toEqual([
      ["Telma 40", "Alpha Pharma", 30],
      ["Telma 40", "Beta Medicos", 15],
      ["Augmentin 625", "Alpha Pharma", 10],
    ]);
  });

  test("filters by supplier and sorts any column both ways", async () => {
    const beta = await report({ vendor_id: vendorB.id });
    expect(beta.rows.map((r) => [r.medicine_name, r.sold_qty])).toEqual([[`${TAG} Telma 40`, 20]]);
    const byName = await report({ sort: "medicine_name", dir: "asc" });
    expect(byName.rows[0].medicine_name).toBe(`${TAG} Augmentin 625`);
    const byReturns = await report({ sort: "returned_qty", dir: "desc" });
    expect(byReturns.rows[0].returned_qty).toBe(5);
    expect((await report({ form: "INJ" })).rows).toHaveLength(0);
    const backwards = await admin.get("/api/pharmacy/reports/top-items", {
      params: { from: TODAY, to: dayOffset(-1) },
    });
    expect(backwards.status()).toBe(400);
    expect((await pharmacist.get("/api/pharmacy/reports/top-items")).status()).toBe(403);
  });

  test("the report downloads as Excel with serial numbers", async () => {
    const response = await admin.get("/api/pharmacy/reports/top-items.xlsx", {
      params: { from: TODAY, to: TODAY, q: TAG, group: "vendor" },
    });
    expect(response.status()).toBe(200);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(await response.body());
    const sheet = workbook.worksheets[0];
    expect(sheet.getRow(1).values.filter(Boolean)).toEqual(
      expect.arrayContaining(["Sr no", "Item name", "Company", "Supplier", "Net sales amount"]),
    );
    expect(sheet.rowCount).toBe(4);
    expect(sheet.getRow(2).getCell(1).value).toBe(1);
  });

  test("the page sorts on a click and switches between merged and split", async ({ page }) => {
    await loginAs(page, "pharmacy_admin");
    await gotoReady(
      page,
      "/pharmacy/reports/top-items",
      () => page.getByRole("heading", { name: "Top selling items" }),
      { timeout: 30000 },
    );
    await page.getByLabel("Search", { exact: true }).fill(TAG);
    const table = page.getByRole("table", { name: "Top selling items" });
    await expect(table.getByRole("row")).toHaveCount(4);
    await expect(table.getByRole("row").nth(1)).toContainText("Telma 40");
    await table.getByRole("button", { name: /Net sales amount/ }).click();
    await expect(table.getByRole("row").nth(1)).toContainText("Augmentin 625");
    await page.getByText("Split by supplier").click();
    await expect(table.getByRole("row")).toHaveCount(5);
    await expect(table).toContainText(`${TAG} Beta Medicos`);
  });
});
