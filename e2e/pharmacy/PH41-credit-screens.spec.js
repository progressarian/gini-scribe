import { test, expect } from "@playwright/test";
import { apiAs, loginAs } from "../helpers/auth.mjs";
import { gotoReady } from "../helpers/browser.mjs";
import { financialYearOf } from "../../shared/billingVocab.js";
import { assertTestDatabase } from "../setup/guard.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);

const TAG = `PH41${Date.now().toString(36).toUpperCase()}`;
const PHONE = `94${String(Date.now()).slice(-8)}`;
const dayOffset = (days) => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
};
const FY = financialYearOf(dayOffset(0));

test.describe.configure({ mode: "serial" });

test.describe("PH41 credit at the counter, approval and dues", () => {
  let admin;
  let pharmacist;
  let bill;

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
    const medicine = await (
      await admin.post("/api/pharmacy/medicines", {
        data: {
          name: `${TAG} Rosuvas 10`,
          form: "TAB",
          pack_size: 10,
          unit_label: "tab",
          pack_label: "strip",
          gst_rate_pct: 12,
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
              batch_no: "ROS1",
              expiry_date: dayOffset(400),
              qty_packs: 5,
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
          data: { name: `${TAG} Credit Walkin`, phone: PHONE },
        })
      ).json()
    ).patient;
    const draft = await (
      await pharmacist.post("/api/pharmacy/bills", {
        data: { patient_id: patient.id, sale_type: "walkin" },
      })
    ).json();
    bill = await (
      await pharmacist.put(`/api/pharmacy/bills/${draft.id}`, {
        data: {
          version: draft.version,
          sale_type: "walkin",
          lines: [{ batch_id: batchId, qty_units: 25 }],
        },
      })
    ).json();
    expect(bill.net_amount).toBe("98.00");
  });

  test.afterAll(async () => {
    await Promise.all([admin?.dispose(), pharmacist?.dispose()]);
  });

  test("ask, approve, part-pay, then collect the due", async ({ page, browser }) => {
    await loginAs(page, "pharmacy");
    await gotoReady(
      page,
      `/pharmacy/billing/${bill.id}`,
      () => page.getByRole("button", { name: /Ask for credit/ }),
      { timeout: 30000 },
    );
    await page.getByRole("button", { name: /Ask for credit/ }).click();
    const ask = page.getByRole("dialog", { name: "Ask for credit" });
    await ask.getByLabel("Amount to pay later (₹)").fill("40");
    await expect(ask.getByText("Collect ₹58.00 now")).toBeVisible();
    await ask.getByLabel("Reason").fill("Will pay on next visit");
    await ask.getByRole("button", { name: "Send for approval" }).click();
    await expect(page.getByText(/waiting for approval. The bill is locked/)).toBeVisible();
    await expect(page.getByRole("button", { name: /Finalise and collect/ })).toBeDisabled();
    await expect(page.getByRole("combobox", { name: "Add medicine" })).toBeDisabled();

    const adminContext = await browser.newContext();
    const approver = await adminContext.newPage();
    await loginAs(approver, "pharmacy_admin");
    await gotoReady(
      approver,
      "/pharmacy/credit",
      () => approver.getByRole("heading", { name: "Pharmacy credit" }),
      { timeout: 30000 },
    );
    await approver.getByRole("button", { name: `Approve credit for ${TAG} Credit Walkin` }).click();
    const decide = approver.getByRole("dialog", { name: "Approve credit" });
    await expect(decide).toContainText("Will pay on next visit");
    await decide.getByLabel("Credit approved (₹)").fill("30");
    await decide.getByRole("button", { name: "Approve credit" }).click();
    await expect(decide).toBeHidden();
    await adminContext.close();

    await page.reload();
    await expect(page.getByText(/Credit of ₹30.00 approved/)).toBeVisible();
    await expect(page.getByText("₹30.00 left as due")).toBeVisible();
    await page.getByRole("button", { name: "Finalise and collect ₹68.00" }).click();
    const confirm = page.getByRole("dialog").filter({ hasText: "Finalise this bill?" });
    await expect(confirm).toContainText("₹30.00 stays due");
    await confirm.getByRole("button", { name: "Finalise bill" }).click();

    await expect(page.getByRole("heading", { name: /Bill PH/ })).toContainText("Due");
    await page.getByRole("button", { name: "Collect due ₹30.00" }).click();
    const collect = page.getByRole("dialog", { name: /Collect due/ });
    await collect.getByLabel("Amount (₹)").fill("10");
    await expect(collect.getByText("₹20.00 left as due")).toBeVisible();
    await collect.getByRole("button", { name: "Collect ₹10.00" }).click();
    await expect(collect).toBeHidden();
    await expect(page.getByRole("button", { name: "Collect due ₹20.00" })).toBeVisible();

    await gotoReady(
      page,
      "/pharmacy/credit?tab=dues",
      () => page.getByRole("table", { name: "Pharmacy dues" }),
      { timeout: 30000 },
    );
    await page.getByLabel("Search dues").fill(PHONE);
    const row = page.getByRole("row").filter({ hasText: `${TAG} Credit Walkin` });
    await expect(row).toContainText("₹20.00");
  });
});
