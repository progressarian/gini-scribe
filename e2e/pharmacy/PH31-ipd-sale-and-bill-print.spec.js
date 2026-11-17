import { test, expect } from "@playwright/test";
import { apiAs, loginAs } from "../helpers/auth.mjs";
import { gotoReady } from "../helpers/browser.mjs";
import { expectPdfInViewer } from "../helpers/pdfViewer.mjs";
import { gstinCheckCharacter } from "../../shared/pharmacyVocab.js";
import { financialYearOf } from "../../shared/billingVocab.js";
import { assertTestDatabase } from "../setup/guard.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);

const { buildPharmacyBillHtml } = await import("../../server/services/pharmacy/billPdf.js");

const TAG = `PH31${Date.now().toString(36).toUpperCase()}`;
const PHONE = `97${String(Date.now()).slice(-8)}`;
const GSTIN = `03AAPFU0939F1Z${gstinCheckCharacter("03AAPFU0939F1Z")}`;
const dayOffset = (days) => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
};
const FY = financialYearOf(dayOffset(0));

test.describe.configure({ mode: "serial" });

test.describe("PH31 IPD sales and the printed pharmacy bill", () => {
  let admin;
  let pharmacist;
  let patient;
  let controlled;
  let plain;
  let original;

  const settings = async () => (await admin.get("/api/pharmacy/settings")).json();
  const saveSettings = async (patch) => {
    const { updated_at, updated_by_name, ...rest } = await settings();
    const response = await admin.put("/api/pharmacy/settings", { data: { ...rest, ...patch } });
    expect(response.status(), await response.text()).toBe(200);
  };

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
          hsn_code: "30049099",
          ...extra,
        },
      })
      .then((r) => r.json());

  const billFor = async (sale_type, lines, extra = {}) => {
    const draft = await (
      await pharmacist.post("/api/pharmacy/bills", {
        data: { patient_id: patient.id, sale_type, ...extra },
      })
    ).json();
    const saved = await (
      await pharmacist.put(`/api/pharmacy/bills/${draft.id}`, {
        data: { version: draft.version, sale_type, lines, ...extra },
      })
    ).json();
    return saved;
  };

  const finalise = async (bill) => {
    const response = await pharmacist.post(`/api/pharmacy/bills/${bill.id}/finalise`, {
      data: {
        version: bill.version,
        payments: [{ mode: "cash", amount: Number(bill.net_amount) }],
      },
    });
    expect(response.status(), await response.text()).toBe(200);
    return response.json();
  };

  test.beforeAll(async () => {
    admin = await apiAs("pharmacy_admin");
    pharmacist = await apiAs("pharmacy");
    const current = await settings();
    original = { gstin: current.gstin, drug_license_no: current.drug_license_no };
    for (const [series, prefix] of [
      ["PH", "PH/"],
      ["PHR", "PHR/"],
    ]) {
      await admin.put("/api/pharmacy/settings/series", {
        data: { series, fy: FY, prefix, number_width: 6 },
      });
    }
    controlled = await medicine("Alprazolam 0.5", { schedule: "H1" });
    plain = await medicine("Pantoprazole 40");
    const receipt = await (
      await admin.post("/api/pharmacy/purchases", { data: { kind: "opening" } })
    ).json();
    const line = (medicine_id, batch_no) => ({
      medicine_id,
      batch_no,
      expiry_date: dayOffset(400),
      qty_packs: 5,
      purchase_rate: "50",
      gst_rate_pct: 12,
      mrp: "120",
      sale_rate: "100",
      rack_no: "H-1",
    });
    const saved = await (
      await admin.put(`/api/pharmacy/purchases/${receipt.id}`, {
        data: {
          version: receipt.version,
          lines: [line(controlled.id, "ALP1"), line(plain.id, "PAN1")],
        },
      })
    ).json();
    expect(
      (
        await admin.post(`/api/pharmacy/purchases/${receipt.id}/post`, {
          data: { version: saved.version },
        })
      ).status(),
    ).toBe(200);
    patient = (
      await (
        await pharmacist.post("/api/pharmacy/bills/patients", {
          data: { name: `${TAG} Inpatient`, phone: PHONE, age: 70, sex: "Male" },
        })
      ).json()
    ).patient;
    await saveSettings({ gstin: GSTIN, drug_license_no: "PB-MOH-20B-1234" });
  });

  test.afterAll(async () => {
    await saveSettings(original).catch(() => {});
    await Promise.all([admin?.dispose(), pharmacist?.dispose()]);
  });

  test("an IPD bill prints as a pharmacy bill with GST inside the rates", async () => {
    const bill = await finalise(
      await billFor(
        "ipd",
        [
          { batch_id: (await batchOf(controlled.id)).id, qty_units: 10 },
          { batch_id: (await batchOf(plain.id)).id, qty_units: 5 },
        ],
        { ipd_number: "IPD/2026/0042", prescriber_name: "Dr. Mehta" },
      ),
    );
    expect(bill).toMatchObject({
      gst_folded: true,
      cgst_amount: "0.00",
      taxable_amount: "168.00",
      folded_gst_amount: "18.00",
      net_amount: "168.00",
      issued_gstin: GSTIN,
      issued_drug_license: "PB-MOH-20B-1234",
    });

    const html = buildPharmacyBillHtml({ hospital: { name: "Gini Hospital" }, bill, settings: {} });
    expect(html).toContain("PHARMACY BILL");
    expect(html).not.toContain("PHARMACY TAX INVOICE");
    expect(html).not.toContain(">CGST<");
    expect(html).toContain("IPD/2026/0042");
    expect(html).toContain("GST of ₹18.00 is included in the rates");
    expect(html).toContain("Schedule H1 medicines sold on the prescription of Dr. Mehta");
    expect(html).toContain("DRUG LICENCE NO: PB-MOH-20B-1234");
    expect(html).toContain("ALP1");
    expect(html).toContain("30049099");

    const pdf = await pharmacist.get(`/api/pharmacy/bills/${bill.id}/bill.pdf`);
    expect(pdf.status(), await pdf.text()).toBe(200);
    expect(pdf.headers()["content-type"]).toContain("application/pdf");
    expect((await pdf.body()).subarray(0, 5).toString()).toBe("%PDF-");
  });

  test("an OPD bill with a pharmacy GSTIN prints as a tax invoice with the GST split", async () => {
    const bill = await finalise(
      await billFor("opd", [{ batch_id: (await batchOf(plain.id)).id, qty_units: 10 }]),
    );
    const html = buildPharmacyBillHtml({ hospital: { name: "Gini Hospital" }, bill, settings: {} });
    expect(html).toContain("PHARMACY TAX INVOICE");
    expect(html).toContain(">CGST<");
    expect(html).toContain(`GST NO: ${GSTIN}`);
    expect(html).toContain("6.00");
    expect(html).toContain("112.00");
  });

  test("a draft cannot be printed", async () => {
    const draft = await billFor("opd", [{ batch_id: (await batchOf(plain.id)).id, qty_units: 1 }]);
    const response = await pharmacist.get(`/api/pharmacy/bills/${draft.id}/bill.pdf`);
    expect(response.status()).toBe(409);
    await pharmacist.post(`/api/pharmacy/bills/${draft.id}/discard`, {
      data: { version: draft.version },
    });
  });

  test("the pharmacist bills an IPD patient and prints the bill", async ({ page }) => {
    await loginAs(page, "pharmacy");
    await gotoReady(
      page,
      "/pharmacy/billing",
      () => page.getByRole("heading", { name: "Pharmacy bills" }),
      { timeout: 30000 },
    );
    await page.getByRole("button", { name: "New bill" }).click();
    const start = page.getByRole("dialog", { name: "New pharmacy bill" });
    await start.getByLabel("Find patient").fill(PHONE);
    await start.getByRole("radio", { name: new RegExp(`${TAG} Inpatient`) }).check();
    await start.getByRole("radio", { name: /^IPD/ }).check();
    await start.getByRole("button", { name: "Start bill" }).click();
    await expect(start.getByText("Enter the IPD number.")).toBeVisible();
    await start.getByLabel("IPD number").fill("IPD/2026/0077");
    await start.getByRole("button", { name: "Start bill" }).click();

    await expect(page.getByText("IPD · IPD/2026/0077")).toBeVisible();
    await page.getByRole("combobox", { name: "Add medicine" }).fill(`${TAG} Pantoprazole`);
    await page.getByRole("option", { name: new RegExp(`${TAG} Pantoprazole`) }).click();
    const picker = page.getByRole("dialog", { name: /Choose batches/ });
    await picker.getByLabel("Quantity from batch PAN1").fill("10");
    await picker.getByRole("button", { name: "Add to bill" }).click();
    await expect(picker).toBeHidden();

    const totals = page.getByRole("definition").filter({ hasText: "₹12.00" });
    await expect(page.getByText("GST inside the rates")).toBeVisible();
    await expect(totals).toBeVisible();
    await page.getByRole("button", { name: "Finalise and collect ₹112.00" }).click();
    await page
      .getByRole("dialog")
      .filter({ hasText: "Finalise this bill?" })
      .getByRole("button", { name: "Finalise bill" })
      .click();
    await expect(page.getByRole("heading", { name: /Bill PH/ })).toBeVisible();
    await page.getByRole("button", { name: "Print bill" }).click();
    await expectPdfInViewer(page, "/bill.pdf");
  });

  async function batchOf(medicineId) {
    const response = await admin.get("/api/pharmacy/batches", {
      params: { medicine_id: medicineId },
    });
    return (await response.json()).batches[0];
  }
});
