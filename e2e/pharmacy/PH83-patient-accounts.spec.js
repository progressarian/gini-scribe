import { test, expect } from "@playwright/test";
import { apiAs, loginAs } from "../helpers/auth.mjs";
import { gotoReady } from "../helpers/browser.mjs";
import { one } from "../helpers/db.mjs";
import { financialYearOf } from "../../shared/billingVocab.js";
import { assertTestDatabase } from "../setup/guard.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);

const TAG = `PH83${Date.now().toString(36).toUpperCase()}`;
const dayOffset = (days) => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
};
const FY = financialYearOf(dayOffset(0));

test.describe.configure({ mode: "serial" });

test.describe("PH83 deposits, write-offs, vouchers and the patient ledger", () => {
  let admin;
  let pharmacist;
  let patient;
  let batchId;
  let creditBill;

  const account = async (api = pharmacist) =>
    (await api.get(`/api/pharmacy/accounts/${patient.id}`)).json();

  const draft = async (qty_units, discount_pct = 0) => {
    const created = await (
      await pharmacist.post("/api/pharmacy/bills", {
        data: { patient_id: patient.id, sale_type: "walkin" },
      })
    ).json();
    return (
      await pharmacist.put(`/api/pharmacy/bills/${created.id}`, {
        data: {
          version: created.version,
          sale_type: "walkin",
          lines: [{ batch_id: batchId, qty_units, discount_pct }],
        },
      })
    ).json();
  };

  const ledgerRow = async (params = {}) => {
    const result = await (
      await admin.get("/api/pharmacy/accounts/ledger", { params: { q: TAG, ...params } })
    ).json();
    return result.rows.find((r) => r.patient_id === patient.id);
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
    const medicine = await (
      await admin.post("/api/pharmacy/medicines", {
        data: {
          name: `${TAG} Glycomet GP1`,
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
              batch_no: "GGP1",
              expiry_date: dayOffset(400),
              qty_packs: 30,
              purchase_rate: "20",
              gst_rate_pct: 12,
              mrp: "40",
              sale_rate: "35",
            },
          ],
        },
      })
    ).json();
    batchId = (
      await (
        await admin.post(`/api/pharmacy/purchases/${receipt.id}/post`, {
          data: { version: saved.version },
        })
      ).json()
    ).lines[0].batch_id;
    patient = (
      await (
        await pharmacist.post("/api/pharmacy/bills/patients", {
          data: { name: `${TAG} Account Holder`, phone: `86${String(Date.now()).slice(-8)}` },
        })
      ).json()
    ).patient;
  });

  test.afterAll(async () => {
    await Promise.all([admin?.dispose(), pharmacist?.dispose()]);
  });

  test("a deposit is received with a receipt and shows as the account balance", async () => {
    const response = await pharmacist.post(`/api/pharmacy/accounts/${patient.id}/deposits`, {
      data: { mode: "upi", amount: 200, reference: "UTR900", upi_app: "paytm" },
    });
    expect(response.status(), await response.text()).toBe(201);
    expect((await response.json()).balance).toBe("200.00");
    const payment = await one(
      `SELECT receipt_no, bill_id FROM pharmacy_payments WHERE patient_id = $1 AND bill_id IS NULL`,
      [patient.id],
    );
    expect(payment.receipt_no).toMatch(/^PHR/);
    const noRef = await pharmacist.post(`/api/pharmacy/accounts/${patient.id}/deposits`, {
      data: { mode: "card", amount: 10 },
    });
    expect(noRef.status()).toBe(400);
  });

  test("a bill is paid partly from the deposit, never more than what is left", async () => {
    const bill = await draft(30);
    expect(bill.net_amount).toBe("118.00");
    expect(bill.patient_balance).toBe("200.00");
    const tooMuch = await pharmacist.post(`/api/pharmacy/bills/${bill.id}/finalise`, {
      data: {
        version: bill.version,
        payments: [
          { mode: "deposit", amount: 100 },
          { mode: "deposit", amount: 18 },
        ],
      },
    });
    expect(tooMuch.status()).toBe(200);
    const after = await account();
    expect(after.balance).toBe("82.00");
    const used = await one(
      `SELECT kind, amount FROM pharmacy_account_entries WHERE patient_id = $1 AND kind = 'deposit_used'
        ORDER BY id LIMIT 1`,
      [patient.id],
    );
    expect(used).toEqual({ kind: "deposit_used", amount: "100.00" });

    const second = await draft(30);
    const over = await pharmacist.post(`/api/pharmacy/bills/${second.id}/finalise`, {
      data: { version: second.version, payments: [{ mode: "deposit", amount: 118 }] },
    });
    expect(over.status()).toBe(409);
    expect((await over.json()).error).toContain("Only ₹82.00 is left");
    await pharmacist.post(`/api/pharmacy/bills/${second.id}/discard`, {
      data: { version: second.version },
    });
  });

  test("the deposit balance is refunded with a reason, never more than is left", async () => {
    const over = await pharmacist.post(`/api/pharmacy/accounts/${patient.id}/deposit-refunds`, {
      data: { mode: "cash", amount: 90, reason: "Going home" },
    });
    expect(over.status()).toBe(409);
    const noReason = await pharmacist.post(`/api/pharmacy/accounts/${patient.id}/deposit-refunds`, {
      data: { mode: "cash", amount: 20 },
    });
    expect(noReason.status()).toBe(400);
    const done = await pharmacist.post(`/api/pharmacy/accounts/${patient.id}/deposit-refunds`, {
      data: { mode: "cash", amount: 20, reason: "Going home" },
    });
    expect(done.status(), await done.text()).toBe(201);
    expect((await done.json()).balance).toBe("62.00");
  });

  test("only the admin writes off a due or adds a manual voucher", async () => {
    let bill = await draft(20, 10);
    const asked = await (
      await pharmacist.post(`/api/pharmacy/credit/bills/${bill.id}/requests`, {
        data: { version: bill.version, amount: Number(bill.net_amount), reason: "Admitted" },
      })
    ).json();
    await admin.post(`/api/pharmacy/credit/requests/${asked.credit.id}/decision`, {
      data: { decision: "approve" },
    });
    bill = await (await pharmacist.get(`/api/pharmacy/bills/${bill.id}`)).json();
    creditBill = await (
      await pharmacist.post(`/api/pharmacy/bills/${bill.id}/finalise`, {
        data: { version: bill.version, payments: [] },
      })
    ).json();
    expect(creditBill.due_amount).toBe(creditBill.net_amount);

    const byPharmacist = await pharmacist.post(
      `/api/pharmacy/accounts/bills/${creditBill.id}/write-off`,
      { data: { amount: 10, reason: "Old balance" } },
    );
    expect(byPharmacist.status()).toBe(403);
    const tooMuch = await admin.post(`/api/pharmacy/accounts/bills/${creditBill.id}/write-off`, {
      data: { amount: 1000, reason: "Old balance" },
    });
    expect(tooMuch.status()).toBe(409);
    const written = await admin.post(`/api/pharmacy/accounts/bills/${creditBill.id}/write-off`, {
      data: { amount: 10, reason: "Patient in hardship" },
    });
    expect(written.status(), await written.text()).toBe(200);
    const after = await (await pharmacist.get(`/api/pharmacy/bills/${creditBill.id}`)).json();
    expect(Number(after.due_amount)).toBeCloseTo(Number(creditBill.net_amount) - 10, 2);

    expect(
      (
        await pharmacist.post(`/api/pharmacy/accounts/${patient.id}/vouchers`, {
          data: { kind: "credit", amount: 5, reason: "Goodwill" },
        })
      ).status(),
    ).toBe(403);
    const credit = await admin.post(`/api/pharmacy/accounts/${patient.id}/vouchers`, {
      data: { kind: "credit", amount: 15, reason: "Goodwill" },
    });
    expect((await credit.json()).balance).toBe("77.00");
    const debit = await admin.post(`/api/pharmacy/accounts/${patient.id}/vouchers`, {
      data: { kind: "debit", amount: 500, reason: "Correction" },
    });
    expect(debit.status()).toBe(409);
    await admin.post(`/api/pharmacy/accounts/${patient.id}/vouchers`, {
      data: { kind: "debit", amount: 7, reason: "Correction" },
    });
  });

  test("the ledger adds up every column for the patient and sorts and filters", async () => {
    expect((await pharmacist.get("/api/pharmacy/accounts/ledger")).status()).toBe(403);
    const row = await ledgerRow();
    expect(row).toMatchObject({
      payer: "Self",
      total_amount: (118 + Number(creditBill.net_amount)).toFixed(2),
      paid: "0.00",
      write_off: "10.00",
      deposit: "200.00",
      deposit_refund: "20.00",
      voucher_manual: "8.00",
      balance: "70.00",
    });
    expect(Number(row.discounts)).toBeGreaterThan(0);
    expect(Number(row.due)).toBeCloseTo(Number(creditBill.net_amount) - 10, 2);
    expect(await ledgerRow({ only: "due" })).toBeTruthy();
    const sorted = await (
      await admin.get("/api/pharmacy/accounts/ledger", { params: { sort: "deposit", dir: "desc" } })
    ).json();
    const deposits = sorted.rows.map((r) => Number(r.deposit));
    expect([...deposits].sort((a, b) => b - a)).toEqual(deposits);

    const statement = (await account(admin)).statement.map((s) => s.kind);
    expect(statement).toEqual(
      expect.arrayContaining([
        "bill",
        "payment",
        "deposit",
        "deposit_refund",
        "write_off",
        "voucher_credit",
        "voucher_debit",
      ]),
    );
  });

  test("the pharmacist takes a deposit and pays a bill from it on screen", async ({ page }) => {
    await loginAs(page, "pharmacy");
    await gotoReady(
      page,
      `/pharmacy/accounts/${patient.id}`,
      () => page.getByRole("button", { name: "Receive deposit" }),
      { timeout: 30000 },
    );
    await page.getByRole("button", { name: "Receive deposit" }).click();
    const dialog = page.getByRole("dialog", { name: "Receive deposit" });
    await dialog.getByLabel("Amount (₹)").fill("50");
    await dialog.getByRole("button", { name: "Receive ₹50.00" }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText("₹120.00").first()).toBeVisible();

    const bill = await draft(10);
    await gotoReady(
      page,
      `/pharmacy/billing/${bill.id}`,
      () => page.getByRole("button", { name: /Finalise and collect/ }),
      { timeout: 30000 },
    );
    const pay = page.getByRole("group", { name: "Payment 1" });
    await pay.getByLabel("Mode").selectOption("deposit");
    await expect(pay.getByLabel("Reference")).toHaveCount(0);
    await page.getByRole("button", { name: "Finalise and collect ₹39.00" }).click();
    await page
      .getByRole("dialog")
      .filter({ hasText: "Finalise this bill?" })
      .getByRole("button", { name: "Finalise bill" })
      .click();
    await expect(page.getByRole("table", { name: "Payments received" })).toContainText(
      "From deposit",
    );
  });
});
