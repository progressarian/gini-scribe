import { test, expect } from "@playwright/test";
import { one, query } from "../helpers/db.mjs";
import { CONSULTANTS } from "../fixtures/data.mjs";
import { assertTestDatabase } from "../setup/guard.mjs";
import { extraVisit, newTag, setUp, tearDown } from "../billing/phase4/p4-bills-fixture.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const { upsertAppointment } = await import("../../server/services/healthray/db.js");
const { LAB_ONLY_DOCTOR } = await import("../../shared/labOnly.js");

const tag = newTag();
let ids;

const STEPS = [
  ["billing", null, "pending"],
  ["vitals", "with_vitals", "done"],
  ["blood_sample", null, "done"],
  ["wait_chief", "ready_for_doctor", "pending"],
  ["mo_assessment", "with_sd", "pending"],
  ["rx_explain", "with_rx", "pending"],
  ["pharmacy", "dispensed", "pending"],
];

async function bookedWithBanshali(label, status) {
  const made = await extraVisit(ids, label, { visitType: "Follow Up", healthray: false });
  await query(
    `UPDATE appointments SET doctor_name = $2, time_slot = '4:30 PM to 5 PM' WHERE id = $1`,
    [made.appointment, CONSULTANTS.banshali.name],
  );
  await query(
    `UPDATE giniflow_visits SET current_status = $2, appointment_time = '16:30',
            planned_total_min = 70 WHERE id = $1`,
    [made.visit, status],
  );
  for (const [order, [catalogId, chain, stepStatus]] of STEPS.entries())
    await query(
      `INSERT INTO giniflow_visit_steps
         (visit_id, step_order, step_catalog_id, step_name, chain_status, status, planned_duration_min)
       VALUES ($1, $2, $3, $3, $4, $5, 10)`,
      [made.visit, order + 1, catalogId, chain, stepStatus],
    );
  return made;
}

const rebookToLabOnly = (appointment) =>
  upsertAppointment(appointment, {
    localDoctorName: LAB_ONLY_DOCTOR,
    timeSlot: "08:50",
    visitType: "Investigation",
  });

const visitOf = (visit) =>
  one(
    `SELECT v.assigned_doctor_id, v.appointment_time::text AS time, v.planned_total_min,
            array(SELECT s.step_catalog_id FROM giniflow_visit_steps s
                   WHERE s.visit_id = v.id ORDER BY s.step_order) AS steps
       FROM giniflow_visits v WHERE v.id = $1`,
    [visit],
  );

test.describe
  .serial("G126 HealthRay moving a booking to Hospital Admin makes the visit lab-only", () => {
  test.beforeAll(async () => {
    ids = await setUp(tag);
  });

  test.afterAll(async () => {
    await tearDown(ids);
  });

  test("1. the booked consultant is released, the time follows, consult stops are dropped", async () => {
    const { appointment, visit } = await bookedWithBanshali("Rebooked", "vitals_done");
    await rebookToLabOnly(appointment);
    const after = await visitOf(visit);
    expect(after.assigned_doctor_id).toBeNull();
    expect(after.time).toBe("08:50:00");
    expect(after.steps).toEqual(["vitals", "blood_sample"]);
    expect(after.planned_total_min).toBe(20);
  });

  test("2. a patient the Chief has already called keeps the consultant", async () => {
    const { appointment, visit } = await bookedWithBanshali("WithChief", "with_sd");
    await rebookToLabOnly(appointment);
    const after = await visitOf(visit);
    expect(after.assigned_doctor_id).toBe(CONSULTANTS.banshali.id);
    expect(after.steps).toHaveLength(STEPS.length);
  });

  test("3. a consultant the floor chose (not the booked one) is kept", async () => {
    const { appointment, visit } = await bookedWithBanshali("Reassigned", "vitals_done");
    await query(`UPDATE giniflow_visits SET assigned_doctor_id = $2 WHERE id = $1`, [
      visit,
      CONSULTANTS.rahul.id,
    ]);
    await rebookToLabOnly(appointment);
    const after = await visitOf(visit);
    expect(after.assigned_doctor_id).toBe(CONSULTANTS.rahul.id);
    expect(after.time).toBe("16:30:00");
  });

  test("4. an ordinary HealthRay re-sync of the same consultant changes nothing", async () => {
    const { appointment, visit } = await bookedWithBanshali("Unchanged", "vitals_done");
    await upsertAppointment(appointment, {
      localDoctorName: CONSULTANTS.banshali.name,
      visitType: "Follow Up",
    });
    const after = await visitOf(visit);
    expect(after.assigned_doctor_id).toBe(CONSULTANTS.banshali.id);
    expect(after.steps).toHaveLength(STEPS.length);
  });
});
