import { test, expect } from "@playwright/test";
import { query } from "../helpers/db.mjs";
import { apiAs, loginAs } from "../helpers/auth.mjs";
import { gotoReady } from "../helpers/browser.mjs";
import { assertTestDatabase } from "../setup/guard.mjs";
import { extraVisit, newTag, setUp, tearDown } from "../billing/phase4/p4-bills-fixture.mjs";
import { db } from "../billing/phase4b/p4b-refunds.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const pharmacy = await import("../../server/services/giniflow/pharmacyStation.js");

const tag = newTag();
let ids;
let early;
let atDesk;
let ready;
let gone;

async function owedAt(label, status, medicines = ["Amla"]) {
  const made = await extraVisit(ids, label, { healthray: false });
  await query(`UPDATE giniflow_visits SET current_status = $2 WHERE id = $1`, [made.visit, status]);
  const meds = [];
  for (const name of medicines) {
    const { rows } = await query(
      `INSERT INTO medications (patient_id, name, is_active, visit_status, last_prescribed_date)
       VALUES ($1, $2, true, 'current', $3::date) RETURNING id`,
      [made.patient, `${name} ${label} ${tag}`, ids.day],
    );
    meds.push(rows[0].id);
  }
  return { ...made, med: meds[0], meds };
}

const mark = (who, status, reason = null) =>
  pharmacy.markHandoverItem(who.patient, who.med, { status, reason, date: ids.day }, db);

const queue = (q) => pharmacy.getPharmacyQueue(ids.day, new Date(), db, { q });
const names = (rows) => rows.map((row) => row.name);

test.describe.serial("G75 HealthRay medicines wait for Prescription Explain", () => {
  test.beforeAll(async () => {
    ids = await setUp(tag);
    early = await owedAt("HoEarly", "checked_in");
    atDesk = await owedAt("HoDesk", "with_rx");
    ready = await owedAt("HoReady", "pharmacy_pending", ["Amla", "Zinc"]);
    gone = await owedAt("HoGone", "exited", ["Amla", "Zinc"]);
  });

  test.afterAll(async () => {
    const patients = [early.patient, atDesk.patient, ready.patient, gone.patient];
    await query(`DELETE FROM medicine_collections WHERE patient_id = ANY($1)`, [patients]);
    await query(`DELETE FROM medications WHERE patient_id = ANY($1)`, [patients]);
    await tearDown(ids);
  });

  test("1. a patient still at check-in or the Rx desk cannot be marked", async () => {
    for (const who of [early, atDesk]) {
      await expect(mark(who, "given")).rejects.toMatchObject({ status: 409, awaitingRx: true });
      await expect(mark(who, "not_given", "Out of stock")).rejects.toMatchObject({ status: 409 });
      await expect(
        pharmacy.markHandoverAll(who.patient, { date: ids.day }, db),
      ).rejects.toMatchObject({ status: 409 });
      const pane = await pharmacy.getHandoverPatient(who.patient, ids.day, db);
      expect(pane.blockedReason).toMatch(/Prescription Explain/);
    }
    const { rows } = await query(
      `SELECT count(*)::int AS n FROM medicine_collections WHERE patient_id = ANY($1)`,
      [[early.patient, atDesk.patient]],
    );
    expect(rows[0].n).toBe(0);
  });

  test("2. a patient on the To dispense queue is not listed again under HealthRay", async () => {
    const desk = await queue(`HoDesk ${tag}`);
    expect(names(desk.toDispense)).toEqual([`P4 HoDesk ${tag}`]);
    expect(desk.pendingHandover).toEqual([]);

    const atCounter = await queue(`HoReady ${tag}`);
    expect(names(atCounter.toDispense)).toEqual([`P4 HoReady ${tag}`]);
    expect(atCounter.pendingHandover).toEqual([]);

    const waiting = await queue(`HoEarly ${tag}`);
    expect(names(waiting.pendingHandover)).toEqual([`P4 HoEarly ${tag}`]);
    expect(waiting.pendingHandover[0].blockedReason).toMatch(/Prescription Explain/);

    const left = await queue(`HoGone ${tag}`);
    expect(left.pendingHandover[0].gone).toBe(true);
    expect(left.pendingHandover[0].blockedReason).toBeNull();
  });

  test("3. the old Medicine Collection page refuses a patient not yet explained", async ({
    page,
  }) => {
    const admin = await apiAs("admin");
    const one = await admin.post(`/api/medications/${early.med}/collection`, {
      data: { status: "given", date: ids.day },
    });
    expect(one.status()).toBe(409);
    const bulk = await admin.post(`/api/patients/${early.patient}/collection/bulk`, {
      data: { date: ids.day, items: [{ medication_id: early.med, status: "given" }] },
    });
    expect(bulk.status()).toBe(409);
    const view = await admin.get(`/api/patients/${early.patient}/collection?date=${ids.day}`);
    expect((await view.json()).blocked_reason).toMatch(/Prescription Explain/);

    const ok = await admin.post(`/api/medications/${ready.meds[1]}/collection`, {
      data: { status: "given", date: ids.day },
    });
    expect(ok.status()).toBe(201);
    await admin.dispose();

    await loginAs(page, "admin");
    await gotoReady(page, `/medicine-collection`, () => page.getByText(`P4 HoEarly ${tag}`));
    await page.getByText(`P4 HoEarly ${tag}`).click();
    await expect(
      page.getByRole("status").filter({ hasText: "Prescription Explain" }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Save collection" })).toBeDisabled();
    await expect(page.getByRole("button", { name: /Mark all given/ })).toBeDisabled();
    await expect(page.locator(".medcoll-status input[type=radio]").first()).toBeDisabled();
  });

  test("4. a medicine marked not given offers Change, not Dispense", async ({ page }) => {
    await mark(gone, "not_given", "Out of stock");
    await loginAs(page, "admin");
    await gotoReady(page, "/giniflow/station/pharmacy", () =>
      page.getByLabel("Search today's pharmacy patients"),
    );
    await page.getByLabel("Search today's pharmacy patients").fill(`HoEarly ${tag}`);
    await page.locator(".ph-handover-row", { hasText: `HoEarly ${tag}` }).click();
    const pane = page.getByRole("dialog", { name: "Medicines owed" });
    await expect(pane.getByText(/Waiting for Prescription Explain/)).toBeVisible();
    await expect(pane.getByRole("button", { name: "Dispense", exact: true })).toBeDisabled();
    await pane.getByRole("button", { name: "← Back" }).click();

    await page.getByLabel("Search today's pharmacy patients").fill(`HoGone ${tag}`);
    await page.locator(".ph-handover-row", { hasText: `HoGone ${tag}` }).click();
    const amla = pane.locator(".pt-card", { hasText: `Amla HoGone ${tag}` });
    await expect(amla.getByText("✕ Not given — Out of stock")).toBeVisible();
    await expect(amla.getByRole("button", { name: "Dispense", exact: true })).toHaveCount(0);
    await expect(amla.getByRole("button", { name: "Not given" })).toHaveCount(0);
    await amla.getByRole("button", { name: "Change" }).click();
    await expect(amla.getByRole("button", { name: "Dispense", exact: true })).toBeEnabled();
    await amla.getByRole("button", { name: "Cancel" }).click();
    await expect(amla.getByRole("button", { name: "Change" })).toBeVisible();
    await amla.getByRole("button", { name: "Change" }).click();
    await amla.getByRole("button", { name: "Not given" }).click();
    await amla.getByRole("button", { name: "Cancel" }).click();
    await expect(amla.getByRole("button", { name: "Change" })).toBeVisible();

    const zinc = pane.locator(".pt-card", { hasText: `Zinc HoGone ${tag}` });
    await expect(zinc.getByRole("button", { name: "Dispense", exact: true })).toBeEnabled();
  });

  test("5. the Gini Flow dispense card offers Change once a medicine is marked", async ({
    page,
  }) => {
    await pharmacy.dispenseItem(
      ready.visit,
      ready.med,
      { status: "not_given", reason: "Out of stock" },
      db,
    );
    await loginAs(page, "admin");
    await gotoReady(page, "/giniflow/station/pharmacy", () =>
      page.getByLabel("Search today's pharmacy patients"),
    );
    await page.getByLabel("Search today's pharmacy patients").fill(`HoReady ${tag}`);
    await page.locator(".ph-pt", { hasText: `HoReady ${tag}` }).click();
    const amla = page.locator(".ph-med", { hasText: `Amla HoReady ${tag}` });
    await expect(amla.locator(".mm-final")).toHaveText("Not given");
    await expect(amla.getByRole("button", { name: "Dispense", exact: true })).toHaveCount(0);
    await amla.getByRole("button", { name: "Change" }).click();
    await expect(amla.getByRole("button", { name: "Dispense", exact: true })).toBeEnabled();
    await amla.getByRole("button", { name: "Cancel" }).click();
    await expect(amla.locator(".mm-final")).toHaveText("Not given");

    const zinc = page.locator(".ph-med", { hasText: `Zinc HoReady ${tag}` });
    await expect(zinc.locator(".mm-final")).toHaveText("✓ Dispensed");
    await expect(zinc.getByRole("button", { name: "Not given" })).toHaveCount(0);
  });
});
