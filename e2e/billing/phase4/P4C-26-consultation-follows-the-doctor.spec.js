import { test, expect } from "@playwright/test";
import { getPool, one, query } from "../../helpers/db.mjs";
import { CONSULTANTS } from "../../fixtures/data.mjs";
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
const { consultationForDesk, draftAtCheckIn } =
  await import("../../../server/services/billing/visitLines.js");

const db = getPool();
const tag = newTag();
let ids;
let autoBefore;

const consultationsOn = async (visitId) => {
  const draft = await bills.openDraft(visitId, desk, db);
  return draft.lines.map((line) => line.service_item_id);
};

async function visitWithoutDoctorLink(label, doctorName) {
  const visit = await extraVisit(ids, label, { visitType: "New Patient" });
  await query(`UPDATE appointments SET doctor_id = NULL, doctor_name = $2 WHERE id = $1`, [
    visit.appointment,
    doctorName,
  ]);
  await query(`UPDATE giniflow_visits SET assigned_doctor_id = NULL WHERE id = $1`, [visit.visit]);
  return visit;
}

test.describe.serial("P4C-26 the automatic consultation follows the patient's doctor", () => {
  test.beforeAll(async () => {
    ids = await setUp(tag);
    autoBefore = await autoConsultation(true);
  });

  test.afterAll(async () => {
    if (autoBefore !== undefined) await autoConsultation(autoBefore);
    await tearDown(ids);
  });

  test("1. a booking with the doctor's name but no doctor link gets that doctor's consultation", async () => {
    const { visit } = await visitWithoutDoctorLink("C26Name", CONSULTANTS.banshali.name);
    await consultationForDesk(visit, desk, db);
    expect(await consultationsOn(visit)).toEqual([ids.consultDoctorNew]);
  });

  test("2. no doctor known means no consultation is added at all — never a hospital default", async () => {
    const { visit } = await visitWithoutDoctorLink("C26None", null);
    const result = await consultationForDesk(visit, desk, db);
    expect(result.added).toEqual([]);
    expect(await consultationsOn(visit)).toEqual([]);
  });

  test("3. a leftover default consultation is swapped for the doctor's own once they are known", async () => {
    const { visit } = await visitWithoutDoctorLink("C26Late", null);
    const draft = await bills.openDraft(visit, desk, db);
    const added = await bills.addLine(draft.id, { item_id: ids.consultNew }, desk, db);
    const leftover = added.lines.find((line) => line.service_item_id === ids.consultNew);
    await query(`UPDATE bill_lines SET source = 'visit' WHERE id = $1`, [leftover.id]);
    expect(await consultationsOn(visit)).toEqual([ids.consultNew]);

    await query(`UPDATE giniflow_visits SET assigned_doctor_id = $2 WHERE id = $1`, [
      visit,
      CONSULTANTS.banshali.id,
    ]);
    const swapped = await consultationForDesk(visit, desk, db);
    expect(swapped).toMatchObject({ ok: true, replaced: true });
    expect(await consultationsOn(visit)).toEqual([ids.consultDoctorNew]);
    const audit = await one(
      `SELECT after ->> 'reason' AS reason FROM billing_audit
        WHERE entity = 'bill_lines' AND action = 'delete' AND before ->> 'visit_id' = $1`,
      [visit],
    );
    expect(audit.reason).toBe(bills.REPLACED_DEFAULT_CONSULTATION);

    const again = await consultationForDesk(visit, desk, db);
    expect(again.added).toEqual([]);
    expect(await consultationsOn(visit)).toEqual([ids.consultDoctorNew]);
  });

  test("4. no consultation is added automatically until HealthRay has billed one", async () => {
    const quiet = await extraVisit(ids, "C26NoHr", { visitType: "New Patient", healthray: false });
    const waiting = await consultationForDesk(quiet.visit, desk, db);
    expect(waiting).toMatchObject({ ok: true, added: [], waiting_for_healthray: true });
    expect(await consultationsOn(quiet.visit)).toEqual([]);

    await healthrayBill(ids, quiet.patient, [
      { desc: "Follow-up Appointment", amount: 1500, category: "consultation", cancelled: true },
    ]);
    expect((await consultationForDesk(quiet.visit, desk, db)).added).toEqual([]);

    await healthrayBill(ids, quiet.patient, [HEALTHRAY_CONSULTATION]);
    await consultationForDesk(quiet.visit, desk, db);
    expect(await consultationsOn(quiet.visit)).toEqual([ids.consultDoctorNew]);
  });

  test("5. check-in adds the consultation only when HealthRay has billed it", async () => {
    const billed = await extraVisit(ids, "C26InBilled", { visitType: "New Patient" });
    const unbilled = await extraVisit(ids, "C26InNot", {
      visitType: "New Patient",
      healthray: false,
    });
    await draftAtCheckIn(billed.visit, desk, db);
    await draftAtCheckIn(unbilled.visit, desk, db);
    expect(await consultationsOn(billed.visit)).toEqual([ids.consultDoctorNew]);
    expect(await consultationsOn(unbilled.visit)).toEqual([]);
  });
});
