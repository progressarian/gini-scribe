import { test, expect } from "@playwright/test";
import { apiAs, loginAs } from "../helpers/auth.mjs";
import { gotoReady } from "../helpers/browser.mjs";
import { one, query } from "../helpers/db.mjs";
import { buildPatient, insertRow } from "../helpers/builders.mjs";
import { financialYearOf } from "../../shared/billingVocab.js";
import { assertTestDatabase } from "../setup/guard.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);

const TAG = `PH88${Date.now().toString(36).toUpperCase()}`;
const dayOffset = (days) => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
};
const TODAY = dayOffset(0);
const YESTERDAY = dayOffset(-1);

test.describe.configure({ mode: "serial" });

test.describe("PH88 the pharmacy works today's prescriptions like medicine collection", () => {
  let admin;
  let mainAdmin;
  let pharmacist;
  let reception;
  let medicines;
  let people;
  let meds;
  let bill;

  const queue = async (api, params = {}) =>
    api.get("/api/pharmacy/prescriptions", { params: { date: TODAY, q: TAG, ...params } });
  const detail = async (patient) =>
    (
      await pharmacist.get(`/api/pharmacy/prescriptions/patients/${patient.id}`, {
        params: { date: TODAY },
      })
    ).json();
  const itemOf = (data, medication) => data.items.find((i) => i.medication_id === medication.id);

  const prescribe = (patient, name) =>
    insertRow("medications", {
      patient_id: patient.id,
      name: `${TAG} ${name}`,
      frequency: "1-0-1",
      is_active: true,
      visit_status: "current",
      last_prescribed_date: TODAY,
    });

  const person = async (name, status) => {
    const patient = await buildPatient({ name: `${TAG} ${name}` });
    if (status) {
      await insertRow("giniflow_visits", {
        patient_id: patient.id,
        visit_date: TODAY,
        current_status: status,
      });
    }
    return patient;
  };

  test.beforeAll(async () => {
    admin = await apiAs("pharmacy_admin");
    mainAdmin = await apiAs("admin");
    pharmacist = await apiAs("pharmacy");
    reception = await apiAs("reception");
    for (const [series, prefix] of [
      ["PH", "PH/"],
      ["PHR", "PHR/"],
    ]) {
      await admin.put("/api/pharmacy/settings/series", {
        data: { series, fy: financialYearOf(TODAY), prefix, number_width: 6 },
      });
    }
    const medicine = async (name) =>
      (
        await admin.post("/api/pharmacy/medicines", {
          data: {
            name: `${TAG} ${name}`,
            form: "TAB",
            pack_size: 10,
            unit_label: "tab",
            pack_label: "strip",
            gst_rate_pct: 12,
            allow_loose_sale: true,
          },
        })
      ).json();
    medicines = {
      telma: await medicine("Telma 40"),
      glycomet: await medicine("Glycomet 500"),
      amlong: await medicine("Amlong 5"),
    };
    const receipt = await (
      await admin.post("/api/pharmacy/purchases", { data: { kind: "opening" } })
    ).json();
    const line = (m, batch_no, days, packs) => ({
      medicine_id: m.id,
      batch_no,
      expiry_date: dayOffset(days),
      qty_packs: packs,
      purchase_rate: "20",
      gst_rate_pct: 12,
      mrp: "40",
      sale_rate: "35",
    });
    const saved = await (
      await admin.put(`/api/pharmacy/purchases/${receipt.id}`, {
        data: {
          version: receipt.version,
          lines: [
            line(medicines.telma, "TNEAR", 20, 1),
            line(medicines.telma, "TFAR", 400, 5),
            line(medicines.amlong, "AML1", 400, 3),
          ],
        },
      })
    ).json();
    const posted = await admin.post(`/api/pharmacy/purchases/${receipt.id}/post`, {
      data: { version: saved.version },
    });
    expect(posted.status(), await posted.text()).toBe(200);

    people = {
      ready: await person("Ready Patient", "pharmacy_pending"),
      coming: await person("Coming Patient", "rx_pending"),
      done: await person("Done Patient", "dispensed"),
      screen: await person("Screen Patient", "pharmacy_pending"),
    };
    meds = {
      telma: await prescribe(people.ready, "Telma 40"),
      glycomet: await prescribe(people.ready, "Glycomet 500"),
      brandX: await prescribe(people.ready, "Brand X 5"),
      brandY: await prescribe(people.ready, "Brand Y 10"),
    };
    await prescribe(people.coming, "Telma 40");
    await prescribe(people.done, "Telma 40");
    await prescribe(people.screen, "Telma 40");
    await prescribe(people.screen, "Brand Z 2");
    await insertRow("medicine_collections", {
      medication_id: meds.telma.id,
      patient_id: people.ready.id,
      collected_date: YESTERDAY,
      status: "given",
      qty_note: "30 tab on bill PH/000001",
    });
  });

  test.afterAll(async () => {
    await Promise.all([admin, mainAdmin, pharmacist, reception].map((api) => api?.dispose()));
  });

  test("patients are grouped by where they are, with today's progress and last collection", async () => {
    const all = await (await queue(pharmacist, { category: "all" })).json();
    expect(all.categories).toMatchObject({ ready: 2, coming: 1, done: 1, all: 4 });
    const ready = await (await queue(pharmacist)).json();
    expect(ready.rows.map((r) => r.name).sort()).toEqual([
      `${TAG} Ready Patient`,
      `${TAG} Screen Patient`,
    ]);
    expect(ready.rows.find((r) => r.patient_id === people.ready.id)).toMatchObject({
      category: "ready",
      status_label: "At pharmacy",
      total: 4,
      pending: 4,
      last_collected: YESTERDAY,
      has_draft: false,
    });
    const coming = await (await queue(pharmacist, { category: "coming" })).json();
    expect(coming.rows.map((r) => r.name)).toEqual([`${TAG} Coming Patient`]);
    expect((await queue(reception)).status()).toBe(403);
  });

  test("the prescription shows stock, last given and whether marking waits", async () => {
    const data = await detail(people.ready);
    expect(data.visit.status_label).toBe("At pharmacy");
    expect(data.marking_blocked).toBeNull();
    expect(data.last_collection).toMatchObject({ date: YESTERDAY, given: 1 });
    const telma = itemOf(data, meds.telma);
    expect(telma.medicine.name).toBe(`${TAG} Telma 40`);
    expect(telma.last_given_on).toBe(YESTERDAY);
    expect(telma.last_given_note).toContain("30 tab");
    expect(telma.batches.map((b) => b.batch_no)).toEqual(["TNEAR", "TFAR"]);
    expect(itemOf(data, meds.glycomet).medicine.sellable_units).toBe(0);
    expect(itemOf(data, meds.brandX).medicine).toBeNull();
    const coming = await detail(people.coming);
    expect(coming.marking_blocked).toBeTruthy();
  });

  test("asking for a missing medicine alerts the pharmacy admin only", async () => {
    const asked = await pharmacist.post(
      `/api/pharmacy/prescriptions/patients/${people.ready.id}/requests`,
      { data: { medication_id: meds.brandY.id } },
    );
    expect(asked.status(), await asked.text()).toBe(201);
    const alerts = async (api) =>
      (await (await api.get("/api/notifications")).json()).rows.filter(
        (n) => n.kind === "medicine_request" && n.title.includes(`${TAG} Brand Y 10`),
      );
    expect(await alerts(admin)).toHaveLength(1);
    expect(await alerts(pharmacist)).toHaveLength(0);
    expect(await alerts(mainAdmin)).toHaveLength(0);
  });

  test("decisions are saved against the patient's own draft bill", async () => {
    const data = await detail(people.ready);
    const telma = itemOf(data, meds.telma);
    const amlongBatch = (
      await (
        await pharmacist.get("/api/pharmacy/batches", {
          params: { medicine_id: medicines.amlong.id },
        })
      ).json()
    ).batches[0];
    const draft = await (
      await pharmacist.post("/api/pharmacy/bills", {
        data: { patient_id: people.ready.id, sale_type: "opd" },
      })
    ).json();
    const saved = await pharmacist.put(`/api/pharmacy/bills/${draft.id}`, {
      data: {
        version: draft.version,
        sale_type: "opd",
        lines: [
          { batch_id: telma.batches[0].id, qty_units: 10, near_expiry_ok: true },
          { batch_id: telma.batches[1].id, qty_units: 10 },
          { batch_id: amlongBatch.id, qty_units: 10 },
        ],
      },
    });
    expect(saved.status(), await saved.text()).toBe(200);
    bill = await saved.json();

    const path = `/api/pharmacy/prescriptions/patients/${people.ready.id}/outcomes`;
    const missingReason = await pharmacist.post(path, {
      data: {
        bill_id: bill.id,
        outcomes: [{ medication_id: meds.glycomet.id, outcome: "not_given" }],
      },
    });
    expect(missingReason.status()).toBe(400);
    const other = await insertRow("medications", {
      patient_id: people.coming.id,
      name: `${TAG} Not Theirs`,
      is_active: true,
    });
    const notTheirs = await pharmacist.post(path, {
      data: {
        bill_id: bill.id,
        outcomes: [{ medication_id: other.id, outcome: "not_given", reason: "other" }],
      },
    });
    expect(notTheirs.status()).toBe(400);
    const wrongPatient = await pharmacist.post(
      `/api/pharmacy/prescriptions/patients/${people.coming.id}/outcomes`,
      {
        data: {
          bill_id: bill.id,
          outcomes: [{ medication_id: other.id, outcome: "not_given", reason: "other" }],
        },
      },
    );
    expect(wrongPatient.status()).toBe(409);

    const decided = await pharmacist.post(path, {
      data: {
        bill_id: bill.id,
        outcomes: [
          { medication_id: meds.glycomet.id, outcome: "not_given", reason: "out_of_stock" },
          {
            medication_id: meds.brandX.id,
            outcome: "substitute",
            medicine_id: medicines.amlong.id,
          },
          { medication_id: meds.brandY.id, outcome: "requested" },
        ],
      },
    });
    expect(decided.status(), await decided.text()).toBe(200);
    const undo = await pharmacist.post(path, {
      data: {
        bill_id: bill.id,
        outcomes: [{ medication_id: meds.glycomet.id, outcome: "pending" }],
      },
    });
    expect((await undo.json()).outcomes.map((o) => o.outcome).sort()).toEqual([
      "requested",
      "substitute",
    ]);
    await pharmacist.post(path, {
      data: {
        bill_id: bill.id,
        outcomes: [
          { medication_id: meds.glycomet.id, outcome: "not_given", reason: "out_of_stock" },
        ],
      },
    });

    const after = await detail(people.ready);
    expect(after.draft_bill_id).toBe(bill.id);
    expect(after.outcomes).toHaveLength(3);
    const row = (await (await queue(pharmacist)).json()).rows.find(
      (r) => r.patient_id === people.ready.id,
    );
    expect(row.has_draft).toBe(true);
  });

  test("the pharmacist bills from the prescription on the same screen", async ({ page }) => {
    await loginAs(page, "pharmacy");
    await page.setViewportSize({ width: 1366, height: 860 });
    await gotoReady(
      page,
      `/pharmacy/prescriptions?date=${TODAY}`,
      () => page.getByRole("heading", { name: "Prescriptions", exact: true }),
      { timeout: 30000 },
    );
    await page.getByLabel("Search", { exact: true }).fill(TAG);
    await expect(page.getByRole("button", { name: /^Ready at counter \(2\)/ })).toBeVisible();
    await page.getByRole("button", { name: new RegExp(`${TAG} Screen Patient`) }).click();

    const scrolls = await page.evaluate(() =>
      [".prx-list", ".prx-detail"].map(
        (s) => getComputedStyle(document.querySelector(s)).overflowY,
      ),
    );
    expect(scrolls).toEqual(["auto", "auto"]);

    const rx = page.getByRole("table", { name: "Prescription medicines" });
    await expect(rx).toContainText(`${TAG} Telma 40`);
    await expect(rx).toContainText(`${TAG} Brand Z 2`);
    await page.getByRole("button", { name: "Start bill", exact: true }).click();
    await expect(page.getByRole("heading", { name: /New pharmacy bill/ })).toBeVisible();

    const telmaRow = rx.getByRole("row").filter({ hasText: `${TAG} Telma 40` });
    await telmaRow.getByRole("button", { name: "Add" }).click();
    const picker = page.getByRole("dialog", { name: /Choose batches/ });
    await picker.getByLabel(/^Quantity needed/).fill("20");
    await picker.getByRole("button", { name: /Auto-fill/ }).click();
    await picker.getByLabel("Near expiry checked").check();
    await picker.getByRole("button", { name: "Add to bill" }).click();
    await expect(picker).toBeHidden();
    await expect(telmaRow).toContainText("On bill");

    const zRow = rx.getByRole("row").filter({ hasText: `${TAG} Brand Z 2` });
    await zRow.getByRole("button", { name: "Substitute" }).click();
    await page.getByRole("combobox", { name: /Substitute for/ }).fill(`${TAG} Amlong`);
    await page.getByRole("option", { name: new RegExp(`${TAG} Amlong 5`) }).click();
    const subPicker = page.getByRole("dialog", { name: /Choose batches/ });
    await subPicker.getByLabel(/^Quantity needed/).fill("10");
    await subPicker.getByRole("button", { name: /Auto-fill/ }).click();
    await subPicker.getByRole("button", { name: "Add to bill" }).click();
    await expect(subPicker).toBeHidden();
    await expect(zRow).toContainText("Substitute on bill");

    const lines = page.getByRole("table", { name: "Medicines on this bill" });
    await expect(lines).toContainText(`${TAG} Telma 40`);
    await expect(lines).toContainText(`${TAG} Amlong 5`);
    await expect(page.getByRole("button", { name: /Finalise and collect/ })).toBeVisible();
  });

  test("finalising marks given, substitute and not-given lines in medicine collection", async () => {
    const done = await pharmacist.post(`/api/pharmacy/bills/${bill.id}/finalise`, {
      data: {
        version: bill.version,
        payments: [{ mode: "cash", amount: Number(bill.net_amount) }],
      },
    });
    expect(done.status(), await done.text()).toBe(200);
    const { rows: marks } = await query(
      `SELECT medication_id, status, reason, qty_note FROM medicine_collections
        WHERE patient_id = $1 AND collected_date = $2::date`,
      [people.ready.id, TODAY],
    );
    const mark = (m) => marks.find((r) => r.medication_id === m.id);
    expect(mark(meds.telma)).toMatchObject({ status: "given" });
    expect(mark(meds.glycomet)).toMatchObject({ status: "not_given", reason: "out_of_stock" });
    expect(mark(meds.brandX).status).toBe("given");
    expect(mark(meds.brandX).qty_note).toContain(`Substitute ${TAG} Amlong 5`);
    expect(mark(meds.brandY)).toMatchObject({ status: "not_given", reason: "not_available" });
    const row = (await (await queue(pharmacist, { category: "all" })).json()).rows.find(
      (r) => r.patient_id === people.ready.id,
    );
    expect(row).toMatchObject({ has_final: true, given: 2 });
    expect(
      await one(`SELECT count(*)::int AS n FROM pharmacy_bill_med_outcomes WHERE bill_id = $1`, [
        bill.id,
      ]),
    ).toEqual({ n: 3 });
  });
});
