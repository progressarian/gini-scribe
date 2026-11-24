import { test, expect } from "@playwright/test";
import { apiAs, loginAs } from "../helpers/auth.mjs";
import { gotoReady } from "../helpers/browser.mjs";
import { one, query } from "../helpers/db.mjs";
import { buildPatient, insertRow } from "../helpers/builders.mjs";
import { financialYearOf } from "../../shared/billingVocab.js";
import { suggestedUnits } from "../../shared/rxQuantity.js";
import { assertTestDatabase } from "../setup/guard.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);

const TAG = `PH32${Date.now().toString(36).toUpperCase()}`;
const dayOffset = (days) => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
};
const TODAY = dayOffset(0);
const FY = financialYearOf(TODAY);

test.describe.configure({ mode: "serial" });

test.describe("PH32 billing from today's prescription", () => {
  let admin;
  let pharmacist;
  let patient;
  let visit;
  let metformin;
  let medications;
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
    metformin = await (
      await admin.post("/api/pharmacy/medicines", {
        data: {
          name: `${TAG} Glycomet 500`,
          form: "TAB",
          pack_size: 10,
          unit_label: "tab",
          pack_label: "strip",
          gst_rate_pct: 12,
          allow_loose_sale: true,
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
              medicine_id: metformin.id,
              batch_no: "GLY1",
              expiry_date: dayOffset(500),
              qty_packs: 10,
              purchase_rate: "10",
              gst_rate_pct: 12,
              mrp: "25",
              sale_rate: "20",
            },
          ],
        },
      })
    ).json();
    await admin.post(`/api/pharmacy/purchases/${receipt.id}/post`, {
      data: { version: saved.version },
    });

    patient = await buildPatient({ name: `${TAG} Visit Patient` });
    visit = await insertRow("giniflow_visits", {
      patient_id: patient.id,
      visit_date: TODAY,
      current_status: "pharmacy_pending",
    });
    const rx = (medicine_name, extra) =>
      insertRow("giniflow_rx_items", {
        visit_id: visit.id,
        medicine_name,
        change_type: "continued",
        ...extra,
      });
    await rx(`${TAG} Glycomet 500`, { dose: "500 mg", frequency: "1-0-1", duration: "30 days" });
    await rx(`${TAG} Not Stocked 5`, { dose: "5 mg", frequency: "OD", duration: "30 days" });
    await rx(`${TAG} Stopped 10`, { change_type: "stopped" });
    await rx(`${TAG} Pending 20`, { approval_status: "pending" });
    medications = {
      glycomet: await insertRow("medications", {
        patient_id: patient.id,
        name: `${TAG} Glycomet 500`,
        is_active: true,
      }),
      other: await insertRow("medications", {
        patient_id: patient.id,
        name: `${TAG} Not Stocked 5`,
        is_active: true,
      }),
    };
  });

  test.afterAll(async () => {
    await Promise.all([admin?.dispose(), pharmacist?.dispose()]);
  });

  test("quantities are suggested only when frequency and duration are clear", () => {
    expect(suggestedUnits({ frequency: "1-0-1", duration: "30 days" })).toBe(60);
    expect(suggestedUnits({ frequency: "½-0-½", duration: "2 weeks" })).toBe(14);
    expect(suggestedUnits({ frequency: "BD", duration: "1 month" })).toBe(60);
    expect(suggestedUnits({ frequency: "SOS", duration: "5 days" })).toBeNull();
    expect(suggestedUnits({ frequency: "1-0-1", duration: "till next visit" })).toBeNull();
  });

  test("a bill for today's visit lists the dispensable prescription with stock", async () => {
    const created = await pharmacist.post("/api/pharmacy/bills", {
      data: { patient_id: patient.id, sale_type: "opd" },
    });
    expect(created.status(), await created.text()).toBe(201);
    bill = await created.json();
    expect(bill.visit_id).toBe(visit.id);

    const again = await (
      await pharmacist.post("/api/pharmacy/bills", {
        data: { patient_id: patient.id, sale_type: "opd", visit_id: visit.id },
      })
    ).json();
    expect(again.id).toBe(bill.id);

    const rx = await (await pharmacist.get(`/api/pharmacy/bills/${bill.id}/prescription`)).json();
    expect(rx.items.map((i) => i.medicine_name)).toEqual([
      `${TAG} Glycomet 500`,
      `${TAG} Not Stocked 5`,
    ]);
    expect(rx.items[0]).toMatchObject({
      frequency: "1-0-1",
      duration: "30 days",
      suggested_units: 60,
      on_bill: false,
      medicine: { id: metformin.id, sellable_units: 100 },
    });
    expect(rx.items[1].medicine).toBeNull();
  });

  test("the pharmacist adds the prescribed medicine with the suggested quantity", async ({
    page,
  }) => {
    await loginAs(page, "pharmacy");
    await gotoReady(
      page,
      `/pharmacy/billing/${bill.id}`,
      () => page.getByRole("heading", { name: "Today's prescription" }),
      { timeout: 30000 },
    );
    const rx = page.getByRole("region", { name: "Today's prescription" });
    await expect(rx).toContainText("Not in the medicine list");
    await rx.getByRole("button", { name: `Add ${TAG} Glycomet 500 to the bill` }).click();
    const picker = page.getByRole("dialog", { name: /Choose batches/ });
    await expect(picker).toContainText("Prescribed: ");
    await expect(picker.getByLabel("Quantity needed (tab)")).toHaveValue("60");
    await expect(picker.getByLabel("Quantity from batch GLY1")).toHaveValue("60");
    await picker.getByRole("button", { name: "Add to bill" }).click();
    await expect(picker).toBeHidden();
    await expect(rx.getByText("On bill")).toBeVisible();
    await expect(page.getByRole("button", { name: "Finalise and collect ₹134.00" })).toBeVisible();
  });

  test("finalising marks the billed medicine as given on the pharmacy station", async () => {
    const current = await (await pharmacist.get(`/api/pharmacy/bills/${bill.id}`)).json();
    const done = await pharmacist.post(`/api/pharmacy/bills/${bill.id}/finalise`, {
      data: {
        version: current.version,
        payments: [{ mode: "cash", amount: Number(current.net_amount) }],
      },
    });
    expect(done.status(), await done.text()).toBe(200);
    const final = await done.json();
    const mark = await one(
      `SELECT status, qty_note FROM medicine_collections
        WHERE medication_id = $1 AND collected_date = $2::date`,
      [medications.glycomet.id, TODAY],
    );
    expect(mark).toEqual({ status: "given", qty_note: `60 tab on bill ${final.bill_no}` });
    const other = await query(`SELECT 1 FROM medicine_collections WHERE medication_id = $1`, [
      medications.other.id,
    ]);
    expect(other.rows).toHaveLength(0);
  });
});
