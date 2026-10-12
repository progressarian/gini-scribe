import { test, expect } from "@playwright/test";
import { query } from "../helpers/db.mjs";
import { assertTestDatabase } from "../setup/guard.mjs";
import { extraVisit, newTag, setUp, tearDown } from "../billing/phase4/p4-bills-fixture.mjs";
import { db } from "../billing/phase4b/p4b-refunds.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
await import("../../server/services/giniflow/board.js");
const { scanTargets } = await import("../../server/services/giniflow/machineSync.js");
const { LAB_ONLY_DOCTOR } = await import("../../server/services/giniflow/labOnlyVisits.js");

const tag = newTag();
let ids;

async function labOnlyVisit(label, appointmentStatus) {
  const made = await extraVisit(ids, label, { healthray: false });
  await query(
    `UPDATE appointments
        SET doctor_id = NULL, doctor_name = $2, visit_type = 'Investigation', status = $3,
            healthray_patient_id = $4
      WHERE id = $1`,
    [made.appointment, LAB_ONLY_DOCTOR, appointmentStatus, `hr-${label}-${ids.tag}`],
  );
  await query(
    `UPDATE giniflow_visits SET current_status = 'booked', assigned_doctor_id = NULL WHERE id = $1`,
    [made.visit],
  );
  return made;
}

const scanned = async (visit) =>
  (await scanTargets(ids.day, db, 500)).some((row) => row.visit_id === visit);

test.describe
  .serial("G79 a lab-only patient's bill is read once HealthRay shows them arrived", () => {
  test.beforeAll(async () => {
    ids = await setUp(tag);
  });

  test.afterAll(async () => {
    await tearDown(ids);
  });

  test("1. checked in on HealthRay but still booked in Scribe: the bill is read", async () => {
    const made = await labOnlyVisit("LabArrived", "checkedin");
    expect(await scanned(made.visit)).toBe(true);
  });

  test("2. not yet arrived anywhere: the bill is left alone", async () => {
    const made = await labOnlyVisit("LabBooked", "scheduled");
    expect(await scanned(made.visit)).toBe(false);
  });
});
