import { test, expect } from "@playwright/test";
import { apiAs, loginAs } from "../helpers/auth.mjs";
import { gotoReady } from "../helpers/browser.mjs";
import { financialYearOf } from "../../shared/billingVocab.js";
import { assertTestDatabase } from "../setup/guard.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);

const TAG = `PH42${Date.now().toString(36).toUpperCase()}`;
const dayOffset = (days) => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
};
const FY = financialYearOf(dayOffset(0));

test.describe.configure({ mode: "serial" });

test.describe("PH42 credit limit per patient and the approver's view of the record", () => {
  let admin;
  let pharmacist;
  let patient;
  let batchId;
  let firstBill;

  const setLimit = async (credit_limit) => {
    const current = await (await admin.get("/api/pharmacy/settings")).json();
    const { updated_at, updated_by_name, ...rest } = current;
    const response = await admin.put("/api/pharmacy/settings", {
      data: { ...rest, credit_limit },
    });
    expect(response.status(), await response.text()).toBe(200);
    return response.json();
  };

  const draft = async (qty_units) => {
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
          lines: [{ batch_id: batchId, qty_units }],
        },
      })
    ).json();
  };

  const ask = (bill, amount) =>
    pharmacist.post(`/api/pharmacy/credit/bills/${bill.id}/requests`, {
      data: { version: bill.version, amount, reason: "Will pay on discharge" },
    });

  const approve = (requestId, approved_amount) =>
    admin.post(`/api/pharmacy/credit/requests/${requestId}/decision`, {
      data: { decision: "approve", ...(approved_amount ? { approved_amount } : {}) },
    });

  const history = async () =>
    (await admin.get(`/api/pharmacy/credit/patients/${patient.id}/history`)).json();

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
          name: `${TAG} Pantocid 40`,
          form: "TAB",
          pack_size: 1,
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
              batch_no: "PNT1",
              expiry_date: dayOffset(400),
              qty_packs: 200,
              purchase_rate: "2",
              gst_rate_pct: 12,
              mrp: "4",
              sale_rate: "3.5",
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
          data: { name: `${TAG} Limited`, phone: `88${String(Date.now()).slice(-8)}` },
        })
      ).json()
    ).patient;
  });

  test.afterAll(async () => {
    await setLimit(null).catch(() => {});
    await Promise.all([admin?.dispose(), pharmacist?.dispose()]);
  });

  test("the pharmacy admin sets a credit limit; the pharmacist cannot", async () => {
    const saved = await setLimit("100");
    expect(saved.credit_limit).toBe("100.00");
    const current = await (await admin.get("/api/pharmacy/settings")).json();
    const { updated_at, updated_by_name, ...rest } = current;
    const negative = await admin.put("/api/pharmacy/settings", {
      data: { ...rest, credit_limit: -5 },
    });
    expect(negative.status()).toBe(400);
    const keep = { ...rest };
    delete keep.credit_limit;
    const untouched = await admin.put("/api/pharmacy/settings", { data: keep });
    expect((await untouched.json()).credit_limit).toBe("100.00");
    expect(
      (
        await pharmacist.put("/api/pharmacy/settings", { data: { ...rest, credit_limit: 1 } })
      ).status(),
    ).toBe(403);
  });

  test("credit within the limit is given, and what is owed fills the limit", async () => {
    firstBill = await draft(25);
    expect(firstBill.net_amount).toBe("98.00");
    const asked = await ask(firstBill, 98);
    expect(asked.status(), await asked.text()).toBe(201);
    const request = (await asked.json()).credit;
    expect((await approve(request.id)).status()).toBe(200);
    const fresh = await (await pharmacist.get(`/api/pharmacy/bills/${firstBill.id}`)).json();
    const done = await pharmacist.post(`/api/pharmacy/bills/${firstBill.id}/finalise`, {
      data: { version: fresh.version, payments: [] },
    });
    expect(done.status(), await done.text()).toBe(200);
    firstBill = await done.json();
    expect(firstBill.due_amount).toBe("98.00");
  });

  test("asking for more than the limit allows is refused with the amount still possible", async () => {
    const second = await draft(5);
    const tooMuch = await ask(second, 10);
    expect(tooMuch.status()).toBe(409);
    const body = await tooMuch.json();
    expect(body.error).toContain("at most ₹2.00 more");

    const fits = await ask(second, 2);
    expect(fits.status(), await fits.text()).toBe(201);
    const request = (await fits.json()).credit;
    expect((await approve(request.id)).status()).toBe(200);

    const third = await draft(1);
    const full = await ask(third, 1);
    expect(full.status()).toBe(409);
    expect((await full.json()).error).toContain("Collect what is due before giving more credit");
  });

  test("the approver sees the patient's record: limit, what is owed, bills still due and earlier requests", async () => {
    const record = await history();
    expect(record).toMatchObject({
      credit_limit: "100.00",
      due: "98.00",
      reserved: "2.00",
      room: "0.00",
      credit_bills: 1,
      credit_bills_paid_off: 0,
    });
    expect(record.open_bills.map((b) => [b.bill_no, b.due_amount])).toEqual([
      [firstBill.bill_no, "98.00"],
    ]);
    expect(record.requests.map((r) => r.status)).toEqual(["approved", "used"]);
  });

  test("a limit lowered after asking is checked again at approval", async () => {
    await pharmacist.post(`/api/pharmacy/credit/bills/${firstBill.id}/payments`, {
      data: { version: firstBill.version, payments: [{ mode: "cash", amount: 60 }] },
    });
    const bill = await draft(5);
    const asked = await ask(bill, 15);
    expect(asked.status(), await asked.text()).toBe(201);
    const request = (await asked.json()).credit;
    await setLimit("50");
    const refused = await approve(request.id);
    expect(refused.status()).toBe(409);
    expect((await refused.json()).error).toContain("at most ₹10.00 more");
    expect((await approve(request.id, 10)).status()).toBe(200);
    await setLimit("100");
  });

  test("the dialogs show the limit and the record", async ({ page, browser }) => {
    const bill = await draft(30);
    await loginAs(page, "pharmacy");
    await gotoReady(
      page,
      `/pharmacy/billing/${bill.id}`,
      () => page.getByRole("button", { name: /Ask for credit/ }),
      { timeout: 30000 },
    );
    await page.getByRole("button", { name: /Ask for credit/ }).click();
    const dialog = page.getByRole("dialog", { name: "Ask for credit" });
    await expect(dialog.getByText(/Credit limit ₹100.00 · owes ₹38.00/)).toBeVisible();
    await expect(dialog.getByText("up to ₹50.00 more can be given")).toBeVisible();
    await dialog.getByLabel("Amount to pay later (₹)").fill("60");
    await dialog.getByLabel("Reason").fill("Short today");
    await dialog.getByRole("button", { name: "Send for approval" }).click();
    await expect(
      dialog.getByText("The credit limit allows at most ₹50.00 more for this patient."),
    ).toBeVisible();
    await dialog.getByLabel("Amount to pay later (₹)").fill("8");
    await dialog.getByRole("button", { name: "Send for approval" }).click();
    await expect(dialog).toBeHidden();

    const adminContext = await browser.newContext();
    const approver = await adminContext.newPage();
    await loginAs(approver, "pharmacy_admin");
    await gotoReady(
      approver,
      "/pharmacy/credit",
      () => approver.getByRole("heading", { name: "Pharmacy credit" }),
      { timeout: 30000 },
    );
    await approver.getByRole("button", { name: `Approve credit for ${TAG} Limited` }).click();
    const decide = approver.getByRole("dialog", { name: "Approve credit" });
    await expect(decide.getByRole("table", { name: "Bills still due" })).toContainText(
      firstBill.bill_no,
    );
    await expect(decide.getByRole("table", { name: "Earlier credit requests" })).toContainText(
      "Used on bill",
    );
    await expect(decide.getByLabel("Credit approved (₹)")).toHaveValue("8");
    await decide.getByRole("button", { name: "Approve credit" }).click();
    await expect(decide).toBeHidden();
    await adminContext.close();
  });
});
