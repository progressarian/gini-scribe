import { test, expect } from "@playwright/test";
import { apiAs, loginAs } from "../helpers/auth.mjs";
import { gotoReady } from "../helpers/browser.mjs";
import { financialYearOf } from "../../shared/billingVocab.js";
import { assertTestDatabase } from "../setup/guard.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);

const TAG = `PH87${Date.now().toString(36).toUpperCase()}`;
const dayOffset = (days) => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
};
const TODAY = dayOffset(0);
const LIVE_WITHIN = { timeout: 5000 };

test.describe.configure({ mode: "serial" });

test.describe("PH87 credit decisions reach open screens without a refresh", () => {
  let admin;
  let pharmacist;
  let patient;
  let batchId;

  const draftWithCredit = async (amount) => {
    const created = await (
      await pharmacist.post("/api/pharmacy/bills", {
        data: { patient_id: patient.id, sale_type: "walkin" },
      })
    ).json();
    const saved = await (
      await pharmacist.put(`/api/pharmacy/bills/${created.id}`, {
        data: {
          version: created.version,
          sale_type: "walkin",
          lines: [{ batch_id: batchId, qty_units: 10 }],
        },
      })
    ).json();
    const asked = await pharmacist.post(`/api/pharmacy/credit/bills/${saved.id}/requests`, {
      data: { version: saved.version, amount, reason: "Short today" },
    });
    expect(asked.status(), await asked.text()).toBe(201);
    return asked.json();
  };

  const openBill = async (page, bill) => {
    await loginAs(page, "pharmacy");
    await gotoReady(
      page,
      `/pharmacy/billing/${bill.id}`,
      () => page.getByText(/is waiting for approval/),
      { timeout: 30000 },
    );
  };

  test.beforeAll(async () => {
    admin = await apiAs("pharmacy_admin");
    pharmacist = await apiAs("pharmacy");
    for (const [series, prefix] of [
      ["PH", "PH/"],
      ["PHR", "PHR/"],
    ]) {
      await admin.put("/api/pharmacy/settings/series", {
        data: { series, fy: financialYearOf(TODAY), prefix, number_width: 6 },
      });
    }
    const vendor = await (
      await admin.post("/api/pharmacy/vendors", {
        data: { name: `${TAG} Vendor`, phone: "9800011122" },
      })
    ).json();
    const medicine = await (
      await admin.post("/api/pharmacy/medicines", {
        data: {
          name: `${TAG} Telma 40`,
          form: "TAB",
          pack_size: 10,
          unit_label: "tab",
          pack_label: "strip",
          gst_rate_pct: 12,
        },
      })
    ).json();
    const receipt = await (
      await admin.post("/api/pharmacy/purchases", {
        data: { vendor_id: vendor.id, invoice_no: TAG, invoice_date: TODAY },
      })
    ).json();
    const saved = await (
      await admin.put(`/api/pharmacy/purchases/${receipt.id}`, {
        data: {
          version: receipt.version,
          vendor_id: vendor.id,
          invoice_no: TAG,
          invoice_date: TODAY,
          lines: [
            {
              medicine_id: medicine.id,
              batch_no: "LIVE1",
              expiry_date: dayOffset(400),
              qty_packs: 10,
              purchase_rate: "20",
              gst_rate_pct: 12,
              mrp: "40",
              sale_rate: "35",
            },
          ],
        },
      })
    ).json();
    const posted = await (
      await admin.post(`/api/pharmacy/purchases/${receipt.id}/post`, {
        data: { version: saved.version },
      })
    ).json();
    batchId = posted.lines[0].batch_id;
    patient = (
      await (
        await pharmacist.post("/api/pharmacy/bills/patients", {
          data: { name: `${TAG} Buyer`, phone: `83${String(Date.now()).slice(-8)}` },
        })
      ).json()
    ).patient;
  });

  test.afterAll(async () => {
    await Promise.all([admin?.dispose(), pharmacist?.dispose()]);
  });

  test("an approval shows on the pharmacist's open bill on its own", async ({ page }) => {
    const bill = await draftWithCredit(10);
    await openBill(page, bill);
    await expect(page.getByRole("button", { name: /Finalise and collect/ })).toBeDisabled();

    const decided = await admin.post(`/api/pharmacy/credit/requests/${bill.credit.id}/decision`, {
      data: { decision: "approve", note: "Regular patient" },
    });
    expect(decided.status(), await decided.text()).toBe(200);

    await expect(page.getByText(/Credit of ₹10\.00 approved by/)).toBeVisible(LIVE_WITHIN);
    await expect(page.getByText(/You can finalise the bill now/)).toBeVisible(LIVE_WITHIN);
    await expect(page.getByRole("button", { name: /Finalise and collect/ })).toBeEnabled();
  });

  test("a refusal also shows on its own", async ({ page }) => {
    const bill = await draftWithCredit(10);
    await openBill(page, bill);
    await admin.post(`/api/pharmacy/credit/requests/${bill.credit.id}/decision`, {
      data: { decision: "reject", note: "Pay in full" },
    });
    await expect(page.getByText(/The credit request was refused/)).toBeVisible(LIVE_WITHIN);
    await expect(page.getByText(/is waiting for approval/)).toHaveCount(0);
  });

  test("a new request appears on the admin's credit page on its own", async ({ page }) => {
    await loginAs(page, "pharmacy_admin");
    await gotoReady(
      page,
      "/pharmacy/credit",
      () => page.getByRole("heading", { name: /credit/i }).first(),
      { timeout: 30000 },
    );
    await page.waitForTimeout(500);
    await expect(page.getByRole("status").filter({ hasText: "Live" })).toBeVisible(LIVE_WITHIN);
    await draftWithCredit(12);
    await expect(page.getByText(`${TAG} Buyer`).first()).toBeVisible(LIVE_WITHIN);
  });

  test("the pharmacy admin can approve a request they raised themselves", async ({ page }) => {
    const created = await (
      await admin.post("/api/pharmacy/bills", {
        data: { patient_id: patient.id, sale_type: "walkin" },
      })
    ).json();
    const saved = await (
      await admin.put(`/api/pharmacy/bills/${created.id}`, {
        data: {
          version: created.version,
          sale_type: "walkin",
          lines: [{ batch_id: batchId, qty_units: 10 }],
        },
      })
    ).json();
    const asked = await admin.post(`/api/pharmacy/credit/bills/${saved.id}/requests`, {
      data: { version: saved.version, amount: 5, reason: "Short today" },
    });
    expect(asked.status(), await asked.text()).toBe(201);
    await loginAs(page, "pharmacy_admin");
    await gotoReady(
      page,
      "/pharmacy/credit?status=pending",
      () => page.getByRole("status").filter({ hasText: "Live" }),
      { timeout: 30000 },
    );
    const row = page
      .getByRole("row")
      .filter({ hasText: "₹5.00" })
      .filter({ hasText: `${TAG} Buyer` });
    await expect(row.getByRole("button", { name: /Approve credit/ })).toBeVisible();
    const decided = await admin.post(
      `/api/pharmacy/credit/requests/${(await asked.json()).credit.id}/decision`,
      { data: { decision: "approve", note: "Own request" } },
    );
    expect(decided.status(), await decided.text()).toBe(200);
    await admin.post(`/api/pharmacy/bills/${saved.id}/discard`, {
      data: { version: saved.version },
    });
  });

  test("the admin approves a waiting request from the bill page", async ({ page }) => {
    const bill = await draftWithCredit(8);
    await loginAs(page, "pharmacy_admin");
    await gotoReady(
      page,
      `/pharmacy/billing/${bill.id}`,
      () => page.getByText(/is waiting for approval/),
      { timeout: 30000 },
    );
    await page.getByRole("button", { name: `Approve credit for ${TAG} Buyer` }).click();
    const dialog = page.getByRole("dialog", { name: "Approve credit" });
    await dialog.getByRole("button", { name: "Approve credit" }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText(/Credit of ₹8\.00 approved by/)).toBeVisible(LIVE_WITHIN);
    await pharmacist.post(`/api/pharmacy/credit/requests/${bill.credit.id}/withdraw`);
  });

  test("the pharmacist sees no approve button on the bill", async ({ page }) => {
    const bill = await draftWithCredit(6);
    await openBill(page, bill);
    await expect(page.getByRole("button", { name: /Approve credit for/ })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Withdraw request" })).toBeVisible();
    await pharmacist.post(`/api/pharmacy/credit/requests/${bill.credit.id}/withdraw`);
  });

  test("the patient's account shows credit requests to the admin only", async ({ page }) => {
    const bill = await draftWithCredit(7);
    await loginAs(page, "pharmacy_admin");
    await gotoReady(
      page,
      `/pharmacy/accounts/${patient.id}`,
      () => page.getByRole("heading", { name: "Credit requests" }),
      { timeout: 30000 },
    );
    const section = page.getByRole("table", { name: "Credit requests for this patient" });
    const row = section.getByRole("row").filter({ hasText: "₹7.00" });
    await expect(row.getByText("Waiting")).toBeVisible();
    await row.getByRole("button", { name: `Refuse credit for ${TAG} Buyer` }).click();
    const dialog = page.getByRole("dialog", { name: "Refuse credit" });
    await dialog.getByLabel(/Why it is refused/).fill("Collect in full today");
    await dialog.getByRole("button", { name: "Refuse credit" }).click();
    await expect(dialog).toBeHidden();
    await expect(row.getByText("Rejected")).toBeVisible(LIVE_WITHIN);

    await loginAs(page, "pharmacy");
    await gotoReady(
      page,
      `/pharmacy/accounts/${patient.id}`,
      () => page.getByText("pharmacy account"),
      { timeout: 30000 },
    );
    await expect(page.getByRole("heading", { name: "Credit requests" })).toHaveCount(0);
    expect(bill.id).toBeTruthy();
  });

  test("a bill finalised on credit appears under Dues on its own", async ({ page }) => {
    const asked = await draftWithCredit(12);
    await admin.post(`/api/pharmacy/credit/requests/${asked.credit.id}/decision`, {
      data: { decision: "approve", note: "Regular patient" },
    });
    await loginAs(page, "pharmacy_admin");
    await gotoReady(
      page,
      "/pharmacy/credit?tab=dues",
      () => page.getByRole("status").filter({ hasText: "Live" }),
      { timeout: 30000 },
    );
    const row = page.getByRole("row").filter({ hasText: `${TAG} Buyer` });
    await expect(row).toHaveCount(0);
    const bill = await (await pharmacist.get(`/api/pharmacy/bills/${asked.id}`)).json();
    const done = await pharmacist.post(`/api/pharmacy/bills/${bill.id}/finalise`, {
      data: {
        version: bill.version,
        payments: [{ mode: "cash", amount: (Number(bill.net_amount) - 12).toFixed(2) }],
      },
    });
    expect(done.status(), await done.text()).toBe(200);
    await expect(row).toHaveCount(1, LIVE_WITHIN);
  });
});
