import { test, expect } from "@playwright/test";
import { apiAs, loginAs } from "../helpers/auth.mjs";
import { gotoReady } from "../helpers/browser.mjs";
import { financialYearOf } from "../../shared/billingVocab.js";
import { assertTestDatabase } from "../setup/guard.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);

const { buildPharmacyBillHtml } = await import("../../server/services/pharmacy/billPdf.js");

const TAG = `PH81${Date.now().toString(36).toUpperCase()}`;
const dayOffset = (days) => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
};
const TODAY = dayOffset(0);
const FY = financialYearOf(TODAY);

test.describe.configure({ mode: "serial" });

test.describe("PH81 discounts at the pharmacy counter", () => {
  let admin;
  let pharmacist;
  let patient;
  let batchA;
  let batchB;

  const setMax = async (max_discount_pct) => {
    const current = await (await admin.get("/api/pharmacy/settings")).json();
    const { updated_at, updated_by_name, ...rest } = current;
    const response = await admin.put("/api/pharmacy/settings", {
      data: { ...rest, max_discount_pct },
    });
    expect(response.status(), await response.text()).toBe(200);
  };

  const newBill = async () =>
    (
      await pharmacist.post("/api/pharmacy/bills", {
        data: { patient_id: patient.id, sale_type: "walkin" },
      })
    ).json();

  const save = (bill, lines, extra = {}) =>
    pharmacist.put(`/api/pharmacy/bills/${bill.id}`, {
      data: { version: bill.version, sale_type: "walkin", lines, ...extra },
    });

  const saved = async (bill, lines, extra) => {
    const response = await save(bill, lines, extra);
    expect(response.status(), await response.text()).toBe(200);
    return response.json();
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
    const medicine = (name, gst) =>
      admin
        .post("/api/pharmacy/medicines", {
          data: {
            name: `${TAG} ${name}`,
            form: "TAB",
            pack_size: 10,
            unit_label: "tab",
            pack_label: "strip",
            gst_rate_pct: gst,
          },
        })
        .then((r) => r.json());
    const a = await medicine("Cardace 5", 12);
    const b = await medicine("Shelcal 500", 5);
    const receipt = await (
      await admin.post("/api/pharmacy/purchases", { data: { kind: "opening" } })
    ).json();
    const line = (m, batch_no, gst) => ({
      medicine_id: m.id,
      batch_no,
      expiry_date: dayOffset(400),
      qty_packs: 20,
      purchase_rate: "20",
      gst_rate_pct: gst,
      mrp: "40",
      sale_rate: "35",
    });
    const draft = await (
      await admin.put(`/api/pharmacy/purchases/${receipt.id}`, {
        data: { version: receipt.version, lines: [line(a, "CAR1", 12), line(b, "SHL1", 5)] },
      })
    ).json();
    const posted = await (
      await admin.post(`/api/pharmacy/purchases/${receipt.id}/post`, {
        data: { version: draft.version },
      })
    ).json();
    batchA = posted.lines.find((l) => l.batch_no === "CAR1").batch_id;
    batchB = posted.lines.find((l) => l.batch_no === "SHL1").batch_id;
    patient = (
      await (
        await pharmacist.post("/api/pharmacy/bills/patients", {
          data: { name: `${TAG} Regular`, phone: `87${String(Date.now()).slice(-8)}` },
        })
      ).json()
    ).patient;
  });

  test.afterAll(async () => {
    await setMax(null).catch(() => {});
    await Promise.all([admin?.dispose(), pharmacist?.dispose()]);
  });

  test("a % on one line takes it off that line and GST is worked on the discounted price", async () => {
    const bill = await saved(await newBill(), [
      { batch_id: batchA, qty_units: 10, discount_pct: 10 },
      { batch_id: batchB, qty_units: 10 },
    ]);
    const [a, b] = bill.lines;
    expect(a).toMatchObject({ discount_pct: "10.00", discount_amount: "3.92", total: "35.28" });
    expect(Number(a.taxable) + 2 * Number(a.cgst)).toBeCloseTo(35.28, 2);
    expect(Number(a.cgst)).toBeCloseTo((35.28 - 35.28 / 1.12) / 2, 2);
    expect(b).toMatchObject({ discount_amount: "0.00", total: "36.76", cgst: "0.88" });
    expect(bill).toMatchObject({ discount_amount: "3.92", net_amount: "72.00" });
  });

  test("a bill % or a bill amount is shared across the lines", async () => {
    let bill = await newBill();
    bill = await saved(
      bill,
      [
        { batch_id: batchA, qty_units: 10 },
        { batch_id: batchB, qty_units: 10 },
      ],
      { discount_kind: "percent", discount_value: 10 },
    );
    expect(bill.lines.map((l) => [l.bill_discount, l.total])).toEqual([
      ["3.92", "35.28"],
      ["3.68", "33.08"],
    ]);
    expect(bill).toMatchObject({ discount_kind: "percent", discount_value: "10.00" });
    expect(bill.discount_amount).toBe("7.60");

    bill = await saved(
      bill,
      bill.lines.map((l) => ({ batch_id: l.batch_id, qty_units: l.qty_units })),
      { discount_kind: "amount", discount_value: 10 },
    );
    const shares = bill.lines.map((l) => Number(l.bill_discount));
    expect(shares[0] + shares[1]).toBeCloseTo(10, 2);
    expect(bill.discount_amount).toBe("10.00");
    expect(bill.net_amount).toBe("66.00");

    bill = await saved(
      bill,
      bill.lines.map((l) => ({ batch_id: l.batch_id, qty_units: l.qty_units })),
      { discount_kind: null, discount_value: null },
    );
    expect(bill).toMatchObject({
      discount_kind: null,
      discount_amount: "0.00",
      net_amount: "76.00",
    });

    const over = await save(bill, [{ batch_id: batchA, qty_units: 10 }], {
      discount_kind: "percent",
      discount_value: 120,
    });
    expect(over.status()).toBe(400);
    const wholeBill = await save(bill, [{ batch_id: batchA, qty_units: 10 }], {
      discount_kind: "amount",
      discount_value: 500,
    });
    expect(wholeBill.status()).toBe(400);
    expect((await wholeBill.json()).error).toContain("leaves nothing to charge");
  });

  test("the admin's maximum discount % is enforced on lines, the bill % and the bill amount", async () => {
    await setMax(10);
    const bill = await newBill();
    const line = await save(bill, [{ batch_id: batchA, qty_units: 10, discount_pct: 12 }]);
    expect(line.status()).toBe(409);
    expect((await line.json()).error).toContain("the most allowed is 10%");
    const pct = await save(bill, [{ batch_id: batchA, qty_units: 10 }], {
      discount_kind: "percent",
      discount_value: 15,
    });
    expect(pct.status()).toBe(409);
    const amount = await save(bill, [{ batch_id: batchA, qty_units: 10 }], {
      discount_kind: "amount",
      discount_value: 5,
    });
    expect(amount.status()).toBe(409);
    expect((await amount.json()).error).toContain("Discounts come to");
    expect(
      (await save(bill, [{ batch_id: batchA, qty_units: 10, discount_pct: 10 }])).status(),
    ).toBe(200);
    await setMax(null);
  });

  test("a discounted bill prints the discount, counts in the sales report, and returns refund what was paid", async () => {
    const before = await (
      await admin.get("/api/pharmacy/reports/sales", { params: { from: TODAY, to: TODAY } })
    ).json();
    let bill = await saved(
      await newBill(),
      [{ batch_id: batchA, qty_units: 10, discount_pct: 10 }],
      { discount_kind: "percent", discount_value: 5 },
    );
    const done = await pharmacist.post(`/api/pharmacy/bills/${bill.id}/finalise`, {
      data: {
        version: bill.version,
        payments: [{ mode: "cash", amount: Number(bill.net_amount) }],
      },
    });
    expect(done.status(), await done.text()).toBe(200);
    bill = await done.json();
    expect(bill.lines[0].total).toBe("33.52");

    const html = buildPharmacyBillHtml({ hospital: { name: "Gini" }, bill, settings: {} });
    expect(html).toContain(">Disc<");
    expect(html).toContain("Discount incl. 5% on the bill (₹)");

    const after = await (
      await admin.get("/api/pharmacy/reports/sales", { params: { from: TODAY, to: TODAY } })
    ).json();
    expect(after.totals.discount - before.totals.discount).toBeCloseTo(
      Number(bill.discount_amount),
      2,
    );

    const back = await pharmacist.post(`/api/pharmacy/bills/${bill.id}/returns`, {
      data: {
        version: bill.version,
        reason: "Half not needed",
        lines: [{ line_id: bill.lines[0].id, qty_units: 5 }],
        refund: { mode: "cash" },
      },
    });
    expect(back.status(), await back.text()).toBe(201);
    expect((await back.json()).net_amount).toBe("16.76");
  });

  test("the pharmacist types a line % and a bill % at the counter", async ({ page }) => {
    const bill = await saved(await newBill(), [
      { batch_id: batchA, qty_units: 10 },
      { batch_id: batchB, qty_units: 10 },
    ]);
    await loginAs(page, "pharmacy");
    await gotoReady(
      page,
      `/pharmacy/billing/${bill.id}`,
      () => page.getByRole("button", { name: "Finalise and collect ₹76.00" }),
      { timeout: 30000 },
    );
    const lineInput = page.getByLabel(`Discount % for ${TAG} Cardace 5 batch CAR1`);
    await lineInput.fill("10");
    await lineInput.press("Enter");
    await expect(page.getByRole("button", { name: "Finalise and collect ₹72.00" })).toBeVisible();

    await page.getByLabel("Bill discount", { exact: true }).fill("5");
    await page.getByRole("button", { name: "Apply" }).click();
    await expect(page.getByText("Discount (incl. 5% on the bill)")).toBeVisible();
    await expect(page.getByRole("button", { name: "Finalise and collect ₹68.00" })).toBeVisible();
  });

  test("Enter then Tab on a line % saves the bill once, without a version clash", async ({
    page,
  }) => {
    const bill = await saved(await newBill(), [
      { batch_id: batchA, qty_units: 10 },
      { batch_id: batchB, qty_units: 10 },
    ]);
    const saves = [];
    await page.route(`**/api/pharmacy/bills/${bill.id}`, async (route) => {
      if (route.request().method() !== "PUT") return route.continue();
      saves.push(route.request().postDataJSON());
      await new Promise((resolve) => setTimeout(resolve, 400));
      return route.continue();
    });
    await loginAs(page, "pharmacy");
    await gotoReady(
      page,
      `/pharmacy/billing/${bill.id}`,
      () => page.getByRole("button", { name: "Finalise and collect ₹76.00" }),
      { timeout: 30000 },
    );
    const lineInput = page.getByLabel(`Discount % for ${TAG} Cardace 5 batch CAR1`);
    await lineInput.fill("10");
    await lineInput.press("Enter");
    await page.keyboard.press("Tab");
    await expect(page.getByRole("button", { name: "Finalise and collect ₹72.00" })).toBeVisible();
    await expect(page.getByText("Someone else changed this bill")).toHaveCount(0);
    expect(saves).toHaveLength(1);

    const stored = await (await pharmacist.get(`/api/pharmacy/bills/${bill.id}`)).json();
    expect(stored.version).toBe(bill.version + 1);
    expect(Number(stored.lines.find((l) => l.batch_id === batchA).discount_pct)).toBe(10);
  });
});
