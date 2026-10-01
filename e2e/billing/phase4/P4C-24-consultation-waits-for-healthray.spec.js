import { test, expect } from "@playwright/test";
import { getPool, query } from "../../helpers/db.mjs";
import { assertTestDatabase } from "../../setup/guard.mjs";
import {
  autoConsultation,
  desk,
  extraVisit,
  HEALTHRAY_CONSULTATION,
  healthrayBill,
  newTag,
  setUp,
  tearDown,
} from "./p4-bills-fixture.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const bills = await import("../../../server/services/billing/bills.js");
const { consultationSuggestion } = await import("../../../server/services/billing/visitLines.js");

const db = getPool();
const tag = newTag();
let ids;
let autoBefore;
let visit;
let billId;

const suggestion = () => consultationSuggestion(billId, desk, db);

test.describe
  .serial("P4C-24 the consultation is suggested only once HealthRay has billed it", () => {
  test.beforeAll(async () => {
    ids = await setUp(tag);
    autoBefore = await autoConsultation(false);
    visit = await extraVisit(ids, "C24", { visitType: "Follow Up", healthray: false });
    billId = (await bills.openDraft(visit.visit, desk, db)).id;
  });

  test.afterAll(async () => {
    if (autoBefore !== undefined) await autoConsultation(autoBefore);
    await tearDown(ids);
  });

  test("1. a booked Follow Up with no HealthRay bill yet suggests nothing", async () => {
    expect((await suggestion()).shown).toBe(false);
  });

  test("2. a HealthRay bill without a consultation still suggests nothing", async () => {
    await healthrayBill(ids, visit.patient, [{ desc: "CBC", amount: 300, category: "lab" }]);
    expect((await suggestion()).shown).toBe(false);
  });

  test("3. a cancelled HealthRay consultation does not count", async () => {
    await query(`UPDATE giniflow_patient_bills SET items = $2::jsonb WHERE patient_id = $1`, [
      visit.patient,
      JSON.stringify([{ ...HEALTHRAY_CONSULTATION, cancelled: true }]),
    ]);
    expect((await suggestion()).shown).toBe(false);
  });

  test("4. once HealthRay bills the consultation, the booked doctor's consultation is suggested", async () => {
    await query(`UPDATE giniflow_patient_bills SET items = $2::jsonb WHERE patient_id = $1`, [
      visit.patient,
      JSON.stringify([HEALTHRAY_CONSULTATION]),
    ]);
    const body = await suggestion();
    expect(body.shown).toBe(true);
    expect(body.visit_type).toBe("Follow Up");
    expect(body.suggested?.item_id).toBe(ids.consultFu);
  });

  test("5. once the consultation is on the bill, it is no longer suggested", async () => {
    await bills.addLine(billId, { item_id: ids.consultFu }, desk, db);
    expect((await suggestion()).shown).toBe(false);
  });
});
