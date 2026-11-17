import { test, expect } from "@playwright/test";
import { apiAs } from "../helpers/auth.mjs";
import { one } from "../helpers/db.mjs";
import { financialYearOf } from "../../shared/billingVocab.js";
import { assertTestDatabase } from "../setup/guard.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);

const TAG = `PH40${Date.now().toString(36).toUpperCase()}`;
const PHONE = `95${String(Date.now()).slice(-8)}`;
const dayOffset = (days) => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
};
const FY = financialYearOf(dayOffset(0));

test.describe.configure({ mode: "serial" });

test.describe("PH40 credit on pharmacy bills", () => {
  let admin;
  let pharmacist;
  let nurse;
  let patient;
  let batchId;
  let bill;

  const draft = async (api = pharmacist, qty_units = 25) => {
    const created = await (
      await api.post("/api/pharmacy/bills", {
        data: { patient_id: patient.id, sale_type: "walkin" },
      })
    ).json();
    return (
      await api.put(`/api/pharmacy/bills/${created.id}`, {
        data: {
          version: created.version,
          sale_type: "walkin",
          lines: [{ batch_id: batchId, qty_units }],
        },
      })
    ).json();
  };
  const reload = async (id) => (await pharmacist.get(`/api/pharmacy/bills/${id}`)).json();
  const ask = (target, amount, api = pharmacist) =>
    api.post(`/api/pharmacy/credit/bills/${target.id}/requests`, {
      data: { version: target.version, amount, reason: "Patient short of cash today" },
    });
  const finalise = (target, amounts) =>
    pharmacist.post(`/api/pharmacy/bills/${target.id}/finalise`, {
      data: {
        version: target.version,
        payments: amounts.map((amount) => ({ mode: "cash", amount })),
      },
    });

  test.beforeAll(async () => {
    admin = await apiAs("pharmacy_admin");
    pharmacist = await apiAs("pharmacy");
    nurse = await apiAs("nurse");
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
          name: `${TAG} Ecosprin 75`,
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
              batch_no: "ECO1",
              expiry_date: dayOffset(400),
              qty_packs: 20,
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
          data: { name: `${TAG} Credit Patient`, phone: PHONE },
        })
      ).json()
    ).patient;
    bill = await draft();
    expect(bill.net_amount).toBe("98.00");
  });

  test.afterAll(async () => {
    await Promise.all([admin?.dispose(), pharmacist?.dispose(), nurse?.dispose()]);
  });

  test("without credit the full amount must be paid", async () => {
    const short = await finalise(bill, [50]);
    expect(short.status()).toBe(409);
    expect((await short.json()).error).toContain("₹48.00 is still to be collected");
    expect((await nurse.get("/api/pharmacy/credit/requests")).status()).toBe(403);
  });

  test("the pharmacist asks for credit and the bill is locked while it waits", async () => {
    const tooMuch = await ask(bill, 120);
    expect(tooMuch.status()).toBe(400);
    const asked = await ask(bill, 48);
    expect(asked.status(), await asked.text()).toBe(201);
    bill = await asked.json();
    expect(bill.credit).toMatchObject({ status: "pending", amount: "48.00" });
    expect((await ask(bill, 10)).status()).toBe(409);

    const edit = await pharmacist.put(`/api/pharmacy/bills/${bill.id}`, {
      data: {
        version: bill.version,
        sale_type: "walkin",
        lines: [{ batch_id: batchId, qty_units: 1 }],
      },
    });
    expect(edit.status()).toBe(409);
    expect((await edit.json()).error).toContain("waiting for approval");
    expect((await finalise(bill, [50])).status()).toBe(409);
    const discard = await pharmacist.post(`/api/pharmacy/bills/${bill.id}/discard`, {
      data: { version: bill.version },
    });
    expect(discard.status()).toBe(409);
  });

  test("only an approver who did not raise it can decide, and a refusal needs a reason", async () => {
    const list = await (await admin.get("/api/pharmacy/credit/requests")).json();
    const request = list.rows.find((r) => r.bill_id === bill.id);
    expect(request).toMatchObject({ amount: "48.00", bill_amount: "98.00", patient_due: "0.00" });

    const byPharmacist = await pharmacist.post(
      `/api/pharmacy/credit/requests/${request.id}/decision`,
      { data: { decision: "approve" } },
    );
    expect(byPharmacist.status()).toBe(403);

    const noReason = await admin.post(`/api/pharmacy/credit/requests/${request.id}/decision`, {
      data: { decision: "reject" },
    });
    expect(noReason.status()).toBe(400);

    const over = await admin.post(`/api/pharmacy/credit/requests/${request.id}/decision`, {
      data: { decision: "approve", approved_amount: 60 },
    });
    expect(over.status()).toBe(400);

    const approved = await admin.post(`/api/pharmacy/credit/requests/${request.id}/decision`, {
      data: { decision: "approve", approved_amount: 40, note: "Known patient" },
    });
    expect(approved.status(), await approved.text()).toBe(200);
    expect(await approved.json()).toMatchObject({ status: "approved", approved_amount: "40.00" });

    const own = await draft(admin, 5);
    const ownAsk = await ask(own, 10, admin);
    expect(ownAsk.status()).toBe(201);
    const ownRequest = (await ownAsk.json()).credit;
    const self = await admin.post(`/api/pharmacy/credit/requests/${ownRequest.id}/decision`, {
      data: { decision: "approve" },
    });
    expect(self.status()).toBe(403);
    expect(
      (await pharmacist.post(`/api/pharmacy/credit/requests/${ownRequest.id}/withdraw`)).status(),
    ).toBe(200);
    const freed = await reload(own.id);
    expect(freed.credit.status).toBe("withdrawn");
    expect(
      (
        await pharmacist.post(`/api/pharmacy/bills/${own.id}/discard`, {
          data: { version: freed.version },
        })
      ).status(),
    ).toBe(200);
  });

  test("after approval the bill is finalised with part payment and the rest is due", async () => {
    bill = await reload(bill.id);
    const tooLittle = await finalise(bill, [50]);
    expect(tooLittle.status()).toBe(409);
    expect((await tooLittle.json()).error).toContain("Collect at least ₹58.00");
    const done = await finalise(bill, [58]);
    expect(done.status(), await done.text()).toBe(200);
    bill = await done.json();
    expect(bill).toMatchObject({
      status: "final",
      pay_later: true,
      paid_amount: "58.00",
      due_amount: "40.00",
      patient_due: "40.00",
    });
    expect(bill.credit.status).toBe("used");

    const found = await (
      await pharmacist.get("/api/pharmacy/bills/patients", { params: { q: PHONE } })
    ).json();
    expect(found.find((p) => p.id === patient.id).pharmacy_due).toBe("40.00");

    const dues = await (
      await pharmacist.get("/api/pharmacy/credit/dues", { params: { q: TAG.toLowerCase() } })
    ).json();
    expect(dues.rows.map((r) => [r.bill_no, r.due_amount])).toEqual([[bill.bill_no, "40.00"]]);
  });

  test("a due is collected later by UPI, never more than what is owed", async () => {
    const pay = (amount, extra = {}) =>
      pharmacist.post(`/api/pharmacy/credit/bills/${bill.id}/payments`, {
        data: {
          version: bill.version,
          payments: [{ mode: "upi", amount, reference: "UTR55", upi_app: "paytm", ...extra }],
        },
      });
    const over = await pay(50);
    expect(over.status()).toBe(409);
    expect((await over.json()).error).toContain("Only ₹40.00 is due");
    const done = await pay(15);
    expect(done.status(), await done.text()).toBe(200);
    bill = await done.json();
    expect(bill.due_amount).toBe("25.00");
    expect(bill.payments.at(-1)).toMatchObject({ mode: "upi", amount: "15.00" });
    expect(bill.payments.at(-1).receipt_no).toMatch(/^PHR/);
  });

  test("a return on a bill with a due clears the due before refunding", async () => {
    const response = await pharmacist.post(`/api/pharmacy/bills/${bill.id}/returns`, {
      data: {
        version: bill.version,
        reason: "Unused strip",
        lines: [{ line_id: bill.lines[0].id, qty_units: 10 }],
        refund: { mode: "cash" },
      },
    });
    expect(response.status(), await response.text()).toBe(201);
    const note = await response.json();
    expect(note).toMatchObject({
      net_amount: "39.20",
      due_adjusted: "25.00",
      paid_amount: "14.20",
    });
    expect(note.payments).toEqual([expect.objectContaining({ direction: "out", amount: "14.20" })]);
    const after = await reload(bill.id);
    expect(after.due_amount).toBe("0.00");
    const audit = await one(
      `SELECT after->>'due_adjusted' AS adjusted FROM billing_audit
        WHERE entity = 'pharmacy_bills' AND entity_id = $1`,
      [note.id],
    );
    expect(audit.adjusted).toBe("25.00");
  });
});
