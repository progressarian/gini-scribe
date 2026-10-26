import { test, expect } from "@playwright/test";
import { one, query } from "../helpers/db.mjs";
import { assertTestDatabase } from "../setup/guard.mjs";
import { extraVisit, newTag, setUp, tearDown } from "../billing/phase4/p4-bills-fixture.mjs";
import { db } from "../billing/phase4b/p4b-refunds.mjs";
import { CONSULTANTS } from "../fixtures/data.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const { LAB_ONLY_DOCTOR } = await import("../../server/services/giniflow/labOnlyVisits.js");
const { checkInWithJourney, arriveForAppointment } =
  await import("../../server/services/giniflow/journey.js");
const { getArrivals } = await import("../../server/services/giniflow/receptionStation.js");
const { getStationTimes } = await import("../../server/services/giniflow/statusEngine.js");

const tag = newTag();
let ids;

const LAB_PLAN = [
  { catalogId: "blood_sample", name: "Lab Collection", minutes: 5 },
  { catalogId: "lab_processing_2", name: "Lab Processing", minutes: 60 },
];

const CONSULT_PLAN = [
  { catalogId: "blood_sample", name: "Blood Sample", minutes: 5 },
  { catalogId: "vitals", name: "Vitals", minutes: 5 },
  {
    catalogId: "sd_consult",
    name: "Consultant",
    minutes: 20,
    staffId: String(CONSULTANTS.rahul.id),
    staffName: CONSULTANTS.rahul.name,
  },
];

const failure = (promise) => promise.then(() => null).catch((error) => error);

async function labOnlyCheckedIn(label) {
  const made = await extraVisit(ids, label, { healthray: false });
  await query(
    `UPDATE appointments SET doctor_id = NULL, doctor_name = $2, visit_type = 'Investigation',
                             time_slot = '09:05'
      WHERE id = $1`,
    [made.appointment, LAB_ONLY_DOCTOR],
  );
  await query(
    `UPDATE giniflow_visits SET current_status = 'booked', assigned_doctor_id = NULL WHERE id = $1`,
    [made.visit],
  );
  await checkInWithJourney(made.visit, { visitTypeId: null, steps: LAB_PLAN }, db);
  await query(`UPDATE giniflow_visit_steps SET status = 'done' WHERE visit_id = $1`, [made.visit]);
  return made;
}

const bookedWithRahul = (appointment) =>
  query(
    `UPDATE appointments SET doctor_id = $2, doctor_name = $3, visit_type = 'Follow-Up'
      WHERE id = $1`,
    [appointment, CONSULTANTS.rahul.id, CONSULTANTS.rahul.name],
  );

const rowOf = async (visit) => {
  const day = await getArrivals(ids.day, "", new Date(), db);
  return [...day.expected, ...day.onFloor, ...day.notComing].find((a) => a.visitId === visit);
};

const stepsOf = async (visit) =>
  (
    await query(
      `SELECT step_catalog_id, status FROM giniflow_visit_steps
        WHERE visit_id = $1 ORDER BY step_order`,
      [visit],
    )
  ).rows.map((s) => [s.step_catalog_id, s.status]);

test.describe.serial("G127 a lab-only patient who is then sent to a consultant", () => {
  test.beforeAll(async () => {
    ids = await setUp(tag);
  });

  test.afterAll(async () => {
    await tearDown(ids);
  });

  test("1. the lab booking edited to a consultant shows Arrived for appointment and adds the consultation after the lab", async () => {
    const { appointment, visit } = await labOnlyCheckedIn("Edited");
    expect((await rowOf(visit)).awaitsAppointment).toBeNull();
    await bookedWithRahul(appointment);

    const row = await rowOf(visit);
    expect(row.awaitsAppointment.booking).toContain(CONSULTANTS.rahul.name);
    expect(row.awaitsAppointment.have).toEqual(
      expect.arrayContaining(["blood_sample", "lab_processing_2"]),
    );

    await arriveForAppointment(visit, { visitTypeId: null, steps: CONSULT_PLAN }, db);
    const after = await stepsOf(visit);
    expect(after.filter(([id]) => id === "blood_sample")).toEqual([["blood_sample", "done"]]);
    expect(after).toEqual(
      expect.arrayContaining([
        ["lab_processing_2", "done"],
        ["vitals", "pending"],
        ["sd_consult", "pending"],
      ]),
    );
    const at = (id) => after.findIndex(([s]) => s === id);
    expect(at("lab_processing_2")).toBeLessThan(at("vitals"));

    const v = await one(
      `SELECT current_status, assigned_doctor_id, appointment_id FROM giniflow_visits WHERE id = $1`,
      [visit],
    );
    expect(v).toMatchObject({
      current_status: "checked_in",
      assigned_doctor_id: CONSULTANTS.rahul.id,
      appointment_id: appointment,
    });
    const arrived = await one(
      `SELECT meta FROM giniflow_visit_events
        WHERE visit_id = $1 AND status = 'checked_in' ORDER BY occurred_at DESC LIMIT 1`,
      [visit],
    );
    expect(arrived.meta.reason).toBe("arrived_for_appointment");
    expect((await rowOf(visit)).awaitsAppointment).toBeNull();
  });

  test("2. pressing it twice adds the stops once", async () => {
    const { appointment, visit } = await labOnlyCheckedIn("Twice");
    await bookedWithRahul(appointment);
    await arriveForAppointment(visit, { visitTypeId: null, steps: CONSULT_PLAN }, db);
    const once = await stepsOf(visit);
    const again = await failure(
      arriveForAppointment(visit, { visitTypeId: null, steps: CONSULT_PLAN }, db),
    );
    expect(again?.status).toBe(409);
    expect(await stepsOf(visit)).toEqual(once);
  });

  test("3. a lab-only visit closed after its reports reopens for the appointment", async () => {
    const { appointment, visit } = await labOnlyCheckedIn("Closed");
    await query(`UPDATE giniflow_visits SET current_status = 'exited' WHERE id = $1`, [visit]);
    await query(
      `INSERT INTO giniflow_visit_events (visit_id, status, actor_role, meta)
       VALUES ($1, 'exited', 'system', '{"reason": "lab_only_reports_complete"}')`,
      [visit],
    );
    await bookedWithRahul(appointment);
    expect((await rowOf(visit)).awaitsAppointment).not.toBeNull();
    await arriveForAppointment(visit, { visitTypeId: null, steps: CONSULT_PLAN }, db);
    expect(
      (await one(`SELECT current_status FROM giniflow_visits WHERE id = $1`, [visit]))
        .current_status,
    ).toBe("checked_in");
  });

  test("4. no button and a refusal while the patient has no consultant booking", async () => {
    const { visit } = await labOnlyCheckedIn("LabOnly");
    expect((await rowOf(visit)).awaitsAppointment).toBeNull();
    const refused = await failure(
      arriveForAppointment(visit, { visitTypeId: null, steps: CONSULT_PLAN }, db),
    );
    expect(refused?.status).toBe(409);
  });

  test("5. a plan with no Chief or consultant stop is refused", async () => {
    const { appointment, visit } = await labOnlyCheckedIn("NoConsult");
    await bookedWithRahul(appointment);
    const refused = await failure(
      arriveForAppointment(
        visit,
        { visitTypeId: null, steps: [{ catalogId: "vitals", name: "Vitals", minutes: 5 }] },
        db,
      ),
    );
    expect(refused?.status).toBe(400);
    expect(await stepsOf(visit)).toEqual([
      ["blood_sample", "done"],
      ["lab_processing_2", "done"],
    ]);
  });

  test("6. the timeline starts at the appointment arrival, not the morning lab check-in", async () => {
    const { appointment, visit } = await labOnlyCheckedIn("Timeline");
    await query(
      `UPDATE giniflow_visit_events SET occurred_at = NOW() - interval '3 hours'
        WHERE visit_id = $1 AND status = 'checked_in'`,
      [visit],
    );
    await bookedWithRahul(appointment);
    await arriveForAppointment(visit, { visitTypeId: null, steps: CONSULT_PLAN }, db);
    const arrived = await one(
      `SELECT occurred_at FROM giniflow_visit_events
        WHERE visit_id = $1 AND meta->>'reason' = 'arrived_for_appointment'`,
      [visit],
    );
    const steps = await getStationTimes(db, visit, {}, new Date());
    expect(steps.length).toBeGreaterThan(0);
    for (const step of steps)
      expect(new Date(step.enteredAt).getTime()).toBeGreaterThanOrEqual(
        new Date(arrived.occurred_at).getTime() - 1000,
      );
    expect(steps[0].totalMinutes ?? 0).toBeLessThan(5);
  });
});
