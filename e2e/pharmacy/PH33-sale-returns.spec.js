import { test, expect } from "@playwright/test";
import { apiAs, loginAs } from "../helpers/auth.mjs";
import { gotoReady } from "../helpers/browser.mjs";
import { one, query } from "../helpers/db.mjs";
import { financialYearOf } from "../../shared/billingVocab.js";
import { assertTestDatabase } from "../setup/guard.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);

const { buildPharmacyBillHtml } = await import("../../server/services/pharmacy/billPdf.js");

const TAG = `PH33${Date.now().toString(36).toUpperCase()}`;
const PHONE = `96${String(Date.now()).slice(-8)}`;
const dayOffset = (days) => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
};
const FY = financialYearOf(dayOffset(0));

test.describe.configure({ mode: "serial" });

test.describe("PH33 sale returns and pharmacy credit notes", () => {
  let admin;
  let pharmacist;
  let patient;
  let tablet;
  let batch;
  let bill;

  const units = () =>
    one(`SELECT qty_units FROM pharmacy_stock WHERE batch_id = $1`, [batch.id]).then(
      (r) => r.qty_units,
    );

  const sell = async (qty_units) => {
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
          lines: [{ batch_id: batch.id, qty_units }],
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

  const giveBack = (target, lines, extra = {}) =>
    pharmacist.post(`/api/pharmacy/bills/${target.id}/returns`, {
      data: {
        version: target.version,
        reason: "Patient brought back unused strips",
        lines,
        refund: { mode: "cash" },
        ...extra,
      },
    });

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
    tablet = await (
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
      await admin.post("/api/pharmacy/purchases", { data: { kind: "opening" } })
    ).json();
    const saved = await (
      await admin.put(`/api/pharmacy/purchases/${receipt.id}`, {
        data: {
          version: receipt.version,
          lines: [
            {
              medicine_id: tablet.id,
              batch_no: "TEL1",
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
    batch = { id: posted.lines[0].batch_id };
    patient = (
      await (
        await pharmacist.post("/api/pharmacy/bills/patients", {
          data: { name: `${TAG} Returner`, phone: PHONE },
        })
      ).json()
    ).patient;
    bill = await sell(25);
    expect(bill.net_amount).toBe("98.00");
  });

  test.afterAll(async () => {
    await Promise.all([admin?.dispose(), pharmacist?.dispose()]);
  });

  test("a partial return makes a credit note, refunds and puts stock back in the same batch", async () => {
    const before = await units();
    const response = await giveBack(bill, [{ line_id: bill.lines[0].id, qty_units: 10 }]);
    expect(response.status(), await response.text()).toBe(201);
    const note = await response.json();
    expect(note).toMatchObject({
      bill_type: "credit_note",
      status: "final",
      original_bill_id: bill.id,
      original_bill_no: bill.bill_no,
      net_amount: "39.20",
      paid_amount: "39.20",
    });
    expect(note.bill_no).toMatch(/^PHCN/);
    expect(note.lines[0]).toMatchObject({ qty_units: 10, batch_no: "TEL1", total: "39.20" });
    expect(note.payments).toEqual([
      expect.objectContaining({ direction: "out", mode: "cash", amount: "39.20" }),
    ]);
    expect(await units()).toBe(before + 10);
    const move = await one(
      `SELECT kind, delta_units FROM pharmacy_stock_movements WHERE ref_id = $1`,
      [note.id],
    );
    expect(move).toEqual({ kind: "sale_return", delta_units: 10 });

    const html = buildPharmacyBillHtml({ hospital: { name: "Gini" }, bill: note, settings: {} });
    expect(html).toContain("PHARMACY CREDIT NOTE");
    expect(html).toContain(bill.bill_no);
    expect(html).toContain("Patient brought back unused strips");
  });

  test("more than what is left cannot be returned, and an old version is refused", async () => {
    const stale = await giveBack(bill, [{ line_id: bill.lines[0].id, qty_units: 1 }]);
    expect(stale.status()).toBe(409);
    bill = await (await pharmacist.get(`/api/pharmacy/bills/${bill.id}`)).json();
    const tooMany = await giveBack(bill, [{ line_id: bill.lines[0].id, qty_units: 16 }]);
    expect(tooMany.status()).toBe(409);
    expect((await tooMany.json()).error).toContain("Only 15 tab");
    const noRef = await giveBack(bill, [{ line_id: bill.lines[0].id, qty_units: 1 }], {
      refund: { mode: "card" },
    });
    expect(noRef.status()).toBe(400);
  });

  test("returning the rest refunds exactly what was charged in total", async () => {
    const response = await giveBack(bill, [{ line_id: bill.lines[0].id, qty_units: 15 }]);
    expect(response.status(), await response.text()).toBe(201);
    const note = await response.json();
    expect(note.lines[0].total).toBe("58.80");
    const returns = await (await pharmacist.get(`/api/pharmacy/bills/${bill.id}/returns`)).json();
    expect(returns.notes).toHaveLength(2);
    expect(returns.returned_units[bill.lines[0].id]).toBe(25);
    const credited = await one(
      `SELECT SUM(cl.total)::text AS total FROM pharmacy_bill_lines cl
         JOIN pharmacy_bills c ON c.id = cl.bill_id WHERE c.original_bill_id = $1`,
      [bill.id],
    );
    expect(credited.total).toBe(bill.lines[0].total);
  });

  test("an expired medicine cannot go back into stock", async () => {
    const sold = await sell(5);
    await query(`UPDATE pharmacy_bill_lines SET expiry_date = $2 WHERE bill_id = $1`, [
      sold.id,
      dayOffset(-1),
    ]);
    const response = await giveBack(sold, [{ line_id: sold.lines[0].id, qty_units: 5 }]);
    expect(response.status()).toBe(409);
    expect((await response.json()).error).toContain("has expired");
  });

  test("the pharmacist records a return from the bill screen", async ({ page }) => {
    const sold = await sell(10);
    await loginAs(page, "pharmacy");
    await gotoReady(
      page,
      `/pharmacy/billing/${sold.id}`,
      () => page.getByRole("button", { name: "Return medicines" }),
      { timeout: 30000 },
    );
    await page.getByRole("button", { name: "Return medicines" }).click();
    const dialog = page.getByRole("dialog", { name: /Return medicines/ });
    await dialog.getByLabel(`Returning ${TAG} Telma 40 batch TEL1`).fill("5");
    await dialog.getByLabel("Reason").fill("Dose changed by doctor");
    await expect(dialog.getByText(/^Refund ₹19.60 by Cash/)).toBeVisible();
    await dialog.getByRole("button", { name: "Review return" }).click();
    await expect(dialog.getByText(/It cannot be undone/)).toBeVisible();
    await dialog.getByRole("button", { name: "Confirm refund of ₹19.60" }).click();
    await expect(page.getByRole("heading", { name: /Credit note PHCN/ })).toBeVisible();
    await expect(page.getByRole("table", { name: "Refund paid" })).toContainText("₹19.60");
    await page.getByRole("link", { name: `bill ${sold.bill_no}` }).click();
    await expect(page.getByRole("table", { name: "Credit notes for this bill" })).toContainText(
      "Dose changed by doctor",
    );
  });
});
