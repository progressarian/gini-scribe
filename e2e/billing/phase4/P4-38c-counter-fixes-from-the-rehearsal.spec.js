import { test, expect } from "@playwright/test";
import { getPool, one, query } from "../../helpers/db.mjs";
import { apiAs, loginAs } from "../../helpers/auth.mjs";
import { gotoReady } from "../../helpers/browser.mjs";
import { assertTestDatabase } from "../../setup/guard.mjs";
import { USERS } from "../../fixtures/data.mjs";
import { rupees } from "../../../src/components/billing/format.js";
import { PRICES, ensureSeries, newDayTag, seedDay, tearDownDay } from "./p438-floor-day.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const visitLines = await import("../../../server/services/billing/visitLines.js");
const bills = await import("../../../server/services/billing/bills.js");

const db = getPool();
const tag = newDayTag();
const desk = { actorId: USERS.reception.id, ip: "10.9.38.3", role: "reception" };
let day;

const COUNTER = "/giniflow/station/billing";
const region = (page, name) => page.getByRole("region", { name, exact: true });
const lineRow = (page, name) =>
  page.getByRole("table", { name: "Bill lines" }).getByRole("row").filter({ hasText: name });
const railRow = (page, patient) =>
  page.getByRole("complementary", { name: "Today's patients" }).getByRole("button", {
    name: new RegExp(patient.name),
  });

async function orderTests(visitId, tests) {
  const admin = await apiAs("admin");
  const response = await admin.post(`/api/giniflow/stations/doctor/${visitId}/tests`, {
    data: { urgency: "today", tests },
  });
  expect(response.status(), await response.text()).toBe(200);
  await admin.dispose();
}

async function finalBill(patient, extra = {}) {
  await ensureSeries(day);
  const draft = await bills.openDraft(patient.visit, desk, db);
  if (extra.category) await bills.setCategory(draft.id, { category: extra.category }, desk, db);
  const priced = await bills.readBill(draft.id, db);
  return bills.finaliseBill(draft.id, { version: priced.version, pay_later: true }, desk, db);
}

async function openCounter(page, visitId) {
  await loginAs(page, "reception");
  await gotoReady(page, `${COUNTER}?visit=${visitId}`, () => region(page, "Bill actions"));
}

test.describe.serial("P4-38c counter fixes found by the floor-trial rehearsal", () => {
  test.beforeAll(async () => {
    day = await seedDay(tag);
    for (const patient of Object.values(day.patients)) {
      await query(`UPDATE giniflow_visits SET current_status = 'checked_in' WHERE id = $1`, [
        patient.visit,
      ]);
      await visitLines.consultationForDesk(patient.visit, desk, db);
    }
  });

  test.afterAll(async () => {
    await tearDownDay(day);
  });

  test("1. an accepted code says what it is and what it took off, not just its letters", async ({
    page,
  }) => {
    await openCounter(page, day.patients.gen.visit);
    const box = region(page, "Discount codes");
    await box.getByLabel("Discount code").fill(day.code);
    await box.getByRole("button", { name: "Apply code" }).click();
    const chip = box.getByRole("list", { name: "Codes on this bill" }).getByRole("listitem");
    await expect(chip).toContainText(day.code);
    await expect(chip).toContainText(day.codeName);
    await expect(chip).toContainText(rupees(PRICES.rahulNew * 0.1));
  });

  test("2. a test the MO orders while the draft is open reaches the counter without a reload", async ({
    page,
  }) => {
    await openCounter(page, day.patients.paid.visit);
    await expect(lineRow(page, `Consultation Dr Beant Follow Up ${tag}`)).toBeVisible();
    await orderTests(day.patients.paid.visit, [day.tests.hba1c]);
    await expect(lineRow(page, `HbA1c ${tag}`)).toBeVisible({ timeout: 25000 });
  });

  test("3. pressing the patient who is already open reads their bill again", async ({ page }) => {
    const patient = day.patients.ref;
    await openCounter(page, patient.visit);
    await expect(lineRow(page, `Consultation Dr Rahul Follow Up ${tag}`)).toBeVisible();
    const draft = await one(`SELECT id FROM bills WHERE visit_id = $1 AND status = 'draft'`, [
      patient.visit,
    ]);
    await bills.addLine(draft.id, { item_id: day.items.dressing }, desk, db);
    await railRow(page, patient).click();
    await expect(lineRow(page, `Dressing ${tag}`)).toBeVisible({ timeout: 5000 });
  });

  test("4. a test ordered after the bill was made final: the counter offers the new draft", async ({
    page,
  }) => {
    const patient = day.patients.pens;
    await query(`UPDATE patients SET scheme_code = NULL WHERE id = $1`, [patient.id]);
    const draft = await bills.openDraft(patient.visit, desk, db);
    await bills.setCategory(draft.id, { category: null }, desk, db);
    await openCounter(page, patient.visit);
    await ensureSeries(day);
    await region(page, "Totals and payment").getByLabel("Pay later").check();
    const [pdf] = await Promise.all([
      page.context().waitForEvent("page"),
      region(page, "Bill actions").getByRole("button", { name: "Finalise & print" }).click(),
    ]);
    await pdf.close();
    await expect(region(page, "Bill lines").getByRole("heading")).not.toHaveText(
      "This bill · draft",
    );
    const first = await one(`SELECT bill_no FROM bills WHERE id = $1`, [draft.id]);
    await expect(region(page, "Bill lines").getByRole("heading")).toHaveText(
      `This bill · ${first.bill_no}`,
    );
    await orderTests(patient.visit, [day.tests.lipid]);
    const offer = page.getByRole("button", { name: "Open the new draft bill" });
    await expect(offer).toBeVisible({ timeout: 25000 });
    await offer.click();
    await expect(region(page, "Bill lines").getByRole("heading")).toHaveText("This bill · draft");
    await expect(lineRow(page, `Lipid profile ${tag}`)).toBeVisible();
    await expect(region(page, "Earlier bills on this visit")).toContainText(first.bill_no);
  });

  test("5. after cancelling an unpaid bill the desk can start the visit's bill again", async ({
    page,
  }) => {
    const patient = day.patients.cancel;
    await openCounter(page, patient.visit);
    await ensureSeries(day);
    await region(page, "Totals and payment").getByLabel("Pay later").check();
    const [pdf] = await Promise.all([
      page.context().waitForEvent("page"),
      region(page, "Bill actions").getByRole("button", { name: "Finalise & print" }).click(),
    ]);
    await pdf.close();
    await expect(
      region(page, "Bill actions").getByRole("button", { name: "Cancel unpaid bill" }),
    ).toBeVisible();
    const first = await one(`SELECT bill_no FROM bills WHERE visit_id = $1 AND status = 'final'`, [
      patient.visit,
    ]);
    await region(page, "Bill actions").getByRole("button", { name: "Cancel unpaid bill" }).click();
    await page.getByRole("dialog").getByRole("textbox").fill("Wrong doctor on the bill");
    await page.getByRole("dialog").getByRole("button", { name: "Cancel bill" }).click();
    const again = page.getByRole("button", { name: "Start a new bill for this visit" });
    await expect(again).toBeVisible();
    await again.click();
    await expect(region(page, "Bill lines").getByRole("heading")).toHaveText("This bill · draft");
    await expect(region(page, "Earlier bills on this visit")).toContainText(first.bill_no);
  });

  test("6. an empty draft does not tell the desk that no payment is needed", async ({ page }) => {
    const patient = day.patients.later;
    await query(`UPDATE giniflow_visits SET appointment_id = NULL WHERE id = $1`, [patient.visit]);
    const draft = await bills.openDraft(patient.visit, desk, db);
    for (const line of draft.lines) {
      await bills.removeLine(draft.id, line.id, { reason: "Start empty" }, desk, db);
    }
    await openCounter(page, patient.visit);
    await expect(region(page, "Bill lines")).toContainText("Nothing on this bill yet.");
    await expect(region(page, "Totals and payment")).not.toContainText(
      "No payment is needed on this bill.",
    );
  });

  test("7. a final bill from earlier can be opened again from the visit's list, to cancel or reprint", async ({
    page,
  }) => {
    const patient = day.patients.gen;
    const first = await finalBill(patient);
    await openCounter(page, patient.visit);
    const earlier = region(page, "Earlier bills on this visit");
    await earlier.getByRole("button", { name: `Open bill ${first.bill_no}` }).click();
    await expect(region(page, "Bill lines").getByRole("heading")).toHaveText(
      `This bill · ${first.bill_no}`,
    );
    await expect(page.getByRole("heading", { name: patient.name })).toBeVisible();
    await region(page, "Bill actions").getByRole("button", { name: "Cancel unpaid bill" }).click();
    await page.getByRole("dialog").getByRole("textbox").fill("Billed to the wrong category");
    await page.getByRole("dialog").getByRole("button", { name: "Cancel bill" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect((await one(`SELECT status FROM bills WHERE id = $1`, [first.id])).status).toBe(
      "cancelled",
    );
  });

  test("8. a patient with no category is General, and can be billed without inventing one", async ({
    page,
  }) => {
    const patient = day.patients.ref;
    await query(`UPDATE patients SET scheme_code = NULL WHERE id = $1`, [patient.id]);
    await query(
      `UPDATE bills SET scheme_code = NULL, scheme_label = NULL, payer_name = NULL
        WHERE visit_id = $1 AND status = 'draft'`,
      [patient.visit],
    );
    await openCounter(page, patient.visit);
    const header = region(page, "Patient");
    await expect(header.locator(".bc-head__cat")).toHaveText("General");
    await expect(header.getByLabel("Category")).toHaveValue("");
    await expect(header.getByLabel("Category").locator("option").first()).toHaveText(
      "General (no category)",
    );
    await ensureSeries(day);
    await region(page, "Totals and payment").getByLabel("Pay later").check();
    const finalise = region(page, "Bill actions").getByRole("button", { name: "Finalise & print" });
    await expect(finalise).toBeEnabled();
    const [pdf] = await Promise.all([page.context().waitForEvent("page"), finalise.click()]);
    await pdf.close();
    await expect(
      region(page, "Bill actions").getByRole("button", { name: "Cancel unpaid bill" }),
    ).toBeVisible();
  });

  test("9. a patient recorded under a parent category must still choose its sub-category", async ({
    page,
  }) => {
    const patient = day.patients.paid;
    await query(`UPDATE patients SET scheme_code = $2 WHERE id = $1`, [patient.id, day.cghs]);
    const draft = await bills.openDraft(patient.visit, desk, db);
    await query(`UPDATE bills SET scheme_code = NULL WHERE id = $1`, [draft.id]);
    await openCounter(page, patient.visit);
    await expect(region(page, "Patient").locator(".bc-head__cat")).toHaveText(
      "Category not confirmed",
    );
    await expect(
      page.getByRole("list", { name: "Before this bill can be made final" }),
    ).toContainText("Choose a sub-category before this bill can be made final.");
    await expect(
      region(page, "Bill actions").getByRole("button", { name: "Finalise & print" }),
    ).toBeDisabled();
  });

  test("10. results still showing an older search cannot be added while the search catches up", async ({
    page,
  }) => {
    const patient = day.patients.later;
    await openCounter(page, patient.visit);
    const box = region(page, "Add items");
    const results = box.getByRole("list", { name: "Item search results" });
    await expect(results.getByRole("listitem").first()).toBeVisible();
    await box.getByLabel("Search items").fill(`Dressing ${tag}`);
    await results.getByRole("button", { name: "Add", exact: true }).first().click();
    const added = page.getByRole("table", { name: "Bill lines" }).getByRole("row");
    await expect(added.filter({ hasText: `Dressing ${tag}` })).toHaveCount(1);
    const draft = await one(
      `SELECT count(*)::int AS n FROM bill_lines l JOIN bills b ON b.id = l.bill_id
        WHERE b.visit_id = $1 AND b.status = 'draft' AND l.source = 'added'`,
      [patient.visit],
    );
    expect(draft.n).toBe(1);
  });
});
