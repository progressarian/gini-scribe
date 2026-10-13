import { test, expect } from "@playwright/test";
import { getPool, one, query } from "../../helpers/db.mjs";
import { loginAs } from "../../helpers/auth.mjs";
import { gotoReady } from "../../helpers/browser.mjs";
import { assertTestDatabase } from "../../setup/guard.mjs";
import {
  autoConsultation,
  desk,
  extraVisit,
  newTag,
  setUp,
  subCategory,
  tearDown,
} from "./p4-bills-fixture.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const bills = await import("../../../server/services/billing/bills.js");

const db = getPool();
const tag = newTag();
let ids;
let autoBefore;
let sub;
const laterVisits = [];

const profileOf = (patient) =>
  one(`SELECT scheme_code FROM patients WHERE id = $1`, [patient]).then((r) => r.scheme_code);

async function nextVisit(patient) {
  const made = await one(
    `INSERT INTO giniflow_visits (patient_id, visit_date) VALUES ($1, $2::date + 1) RETURNING id`,
    [patient, ids.day],
  );
  laterVisits.push(made.id);
  return made.id;
}

test.describe
  .serial("P4C-46 a category confirmed at the counter becomes the patient's category", () => {
  test.beforeAll(async () => {
    ids = await setUp(tag);
    autoBefore = await autoConsultation(false);
    sub = await subCategory(ids, "Keep");
  });

  test.afterAll(async () => {
    if (autoBefore !== undefined) await autoConsultation(autoBefore);
    await query(`DELETE FROM bills WHERE visit_id = ANY($1::uuid[])`, [laterVisits]).catch(
      () => {},
    );
    await query(`DELETE FROM giniflow_visits WHERE id = ANY($1::uuid[])`, [laterVisits]);
    await tearDown(ids);
  });

  test("1. confirming saves it to the profile once, audited, and the next visit's bill starts with it", async () => {
    const { patient, visit } = await extraVisit(ids, "Keep", { healthray: false });
    const draft = await bills.openDraft(visit, desk, db);
    const set = await bills.setCategory(draft.id, { category: sub }, desk, db);
    expect(set.category).toBe(sub);
    expect(set.profile_saved).toBe(true);
    expect(await profileOf(patient)).toBe(sub);
    const audit = await one(
      `SELECT before ->> 'scheme_code' AS was, after ->> 'scheme_code' AS now,
              after ->> 'reason' AS reason, actor_id
         FROM billing_audit WHERE entity = 'patients' AND entity_id = $1`,
      [String(patient)],
    );
    expect(audit).toMatchObject({
      was: null,
      now: sub,
      reason: "Saved from the billing counter",
      actor_id: desk.actorId,
    });

    const again = await bills.setCategory(draft.id, { category: sub }, desk, db);
    expect(again.profile_saved).toBe(false);

    const later = await bills.openDraft(await nextVisit(patient), desk, db);
    expect(later.category).toBe(sub);
  });

  test("2. confirming General takes the category off the profile", async () => {
    const { patient, visit } = await extraVisit(ids, "Lapse", { healthray: false });
    const draft = await bills.openDraft(visit, desk, db);
    await bills.setCategory(draft.id, { category: sub }, desk, db);
    const cleared = await bills.setCategory(draft.id, { category: null }, desk, db);
    expect(cleared.category).toBeNull();
    expect(cleared.profile_saved).toBe(true);
    expect(await profileOf(patient)).toBeNull();
  });

  test("2b. saving only a card number leaves the profile alone", async () => {
    const { patient, visit } = await extraVisit(ids, "Card", { healthray: false });
    const draft = await bills.openDraft(visit, desk, db);
    const set = await bills.setCategory(draft.id, { scheme_ref: "CGHS12345" }, desk, db);
    expect(set.profile_saved).toBe(false);
    expect(await profileOf(patient)).toBeNull();
  });

  test("3. the counter confirms it and says it was saved for future visits", async ({ page }) => {
    const { patient, visit } = await extraVisit(ids, "KeepUi", { healthray: false });
    await loginAs(page, "reception");
    const head = () => page.getByRole("region", { name: "Patient", exact: true });
    await gotoReady(page, `/giniflow/station/reception?tab=bill&visit=${visit}`, head);
    await expect(head().getByRole("checkbox")).toHaveCount(0);
    await head().getByLabel("Category").selectOption(sub);
    await head().getByRole("button", { name: "Confirm category" }).click();
    await expect(head()).toContainText("Saved to the patient's profile — future bills start as");
    expect(await profileOf(patient)).toBe(sub);
  });
});
