import { test, expect } from "@playwright/test";
import { one, query } from "../helpers/db.mjs";
import { assertTestDatabase } from "../setup/guard.mjs";
import { extraVisit, newTag, setUp, tearDown } from "../billing/phase4/p4-bills-fixture.mjs";
import { db } from "../billing/phase4b/p4b-refunds.mjs";
import { CONSULTANTS } from "../fixtures/data.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const { LAB_ONLY_DOCTOR } = await import("../../server/services/giniflow/labOnlyVisits.js");
const { addLabOnlyBillingSteps, sweepLabOnlyExits, reopenAfterLabOnlyExit } =
  await import("../../server/services/giniflow/appointmentSync.js");
const { setStepStatus, checkInWithJourney, ensurePlan } =
  await import("../../server/services/giniflow/journey.js");

const tag = newTag();
let ids;
let caseSeq = 0;

const PLAN = [
  { catalogId: "vitals", name: "Vitals", minutes: 5 },
  { catalogId: "sd_consult", name: "Consultant", minutes: 20 },
];

async function withClient(work) {
  const client = await db.connect();
  try {
    return await work(client);
  } finally {
    client.release();
  }
}

async function morningSamplePatient(label) {
  const made = await extraVisit(ids, label, { healthray: false });
  await query(
    `UPDATE appointments SET doctor_id = NULL, doctor_name = $2, visit_type = 'Investigation',
                             time_slot = '09:30'
      WHERE id = $1`,
    [made.appointment, LAB_ONLY_DOCTOR],
  );
  await query(
    `UPDATE giniflow_visits SET current_status = 'booked', assigned_doctor_id = NULL WHERE id = $1`,
    [made.visit],
  );
  caseSeq += 1;
  const caseNo = `G89-${caseSeq}-${tag}`;
  await query(
    `INSERT INTO lab_cases (case_no, patient_case_no, case_uid, lab_case_id, patient_id,
                            test_names, case_date, case_status, raw_list_json)
     VALUES ($1, $1, $1, $2, $3, ARRAY['HbA1c'], $4::date, 'Registered',
             jsonb_build_object(
               'registered_at', to_char((NOW() - interval '6 hours') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
               'reported_on', to_char((NOW() - interval '3 hours') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')))`,
    [caseNo, 998900 + caseSeq, made.patient, ids.day],
  );
  return made;
}

async function bookConsultLater(made) {
  const { id } = await one(
    `INSERT INTO appointments (patient_id, patient_name, file_no, appointment_date, time_slot,
                               visit_type, doctor_name, status)
     SELECT p.id, p.name, p.file_no, $2::date, '15:30', 'Follow-Up', d.name, 'checkedin'
       FROM patients p, doctors d WHERE p.id = $1 AND d.id = $3
     RETURNING id`,
    [made.patient, ids.day, CONSULTANTS.rahul.id],
  );
  return id;
}

const steps = async (visit) =>
  (
    await query(
      `SELECT step_order, step_catalog_id, status, source FROM giniflow_visit_steps
        WHERE visit_id = $1 ORDER BY step_order`,
      [visit],
    )
  ).rows;

async function throughMorning(made) {
  await withClient((client) => addLabOnlyBillingSteps(client, ids.day));
  const [billing] = await steps(made.visit);
  expect(billing).toMatchObject({ step_catalog_id: "lab_billing", source: "auto" });
  await setStepStatus(
    (
      await one(
        `SELECT id FROM giniflow_visit_steps WHERE visit_id = $1 AND step_catalog_id = 'lab_billing'`,
        [made.visit],
      )
    ).id,
    "done",
    db,
  );
  await withClient((client) => sweepLabOnlyExits(client, ids.day, -1));
  expect(
    (await one(`SELECT current_status FROM giniflow_visits WHERE id = $1`, [made.visit]))
      .current_status,
  ).toBe("exited");
  await bookConsultLater(made);
  await withClient((client) => reopenAfterLabOnlyExit(client, ids.day));
  await query(`UPDATE giniflow_visits SET assigned_doctor_id = $2 WHERE id = $1`, [
    made.visit,
    CONSULTANTS.rahul.id,
  ]);
  expect(
    (await one(`SELECT current_status FROM giniflow_visits WHERE id = $1`, [made.visit]))
      .current_status,
  ).toBe("booked");
}

test.describe.serial("G89 a morning samples-only patient who then sees a doctor", () => {
  test.beforeAll(async () => {
    ids = await setUp(tag);
  });

  test.afterAll(async () => {
    await query(`DELETE FROM lab_cases WHERE case_no LIKE $1`, [`G89-%-${tag}`]);
    await tearDown(ids);
  });

  test("1. reception's check-in plan is saved after the paid Lab Billing step", async () => {
    const made = await morningSamplePatient("Plan");
    await throughMorning(made);
    await checkInWithJourney(made.visit, { visitTypeId: null, steps: PLAN }, db);
    const after = await steps(made.visit);
    expect(after.map((s) => [s.step_catalog_id, s.status])).toEqual(
      expect.arrayContaining([
        ["lab_billing", "done"],
        ["vitals", "pending"],
        ["sd_consult", "pending"],
      ]),
    );
    expect(after).toHaveLength(3);
    expect(after.map((s) => s.step_order)).toEqual([1, 2, 3]);
    const at = (id) => after.findIndex((s) => s.step_catalog_id === id);
    expect(at("lab_billing")).toBeLessThan(at("sd_consult"));
    expect(
      (await one(`SELECT current_status FROM giniflow_visits WHERE id = $1`, [made.visit]))
        .current_status,
    ).toBe("checked_in");
  });

  test("2. a second press does not add the plan twice", async () => {
    const made = await morningSamplePatient("Twice");
    await throughMorning(made);
    await checkInWithJourney(made.visit, { visitTypeId: null, steps: PLAN }, db);
    await checkInWithJourney(made.visit, { visitTypeId: null, steps: PLAN }, db);
    expect(await steps(made.visit)).toHaveLength(3);
  });

  test("3. with only the Lab Billing step, the default plan is still seeded after it", async () => {
    const made = await morningSamplePatient("Unplanned");
    await throughMorning(made);
    await query(`UPDATE giniflow_visits SET visit_type_id = 'FU_APPT' WHERE id = $1`, [made.visit]);
    expect(await ensurePlan(made.visit, db)).toMatchObject({ seeded: true });
    const after = await steps(made.visit);
    expect(after.length).toBeGreaterThan(1);
    expect(after.filter((s) => s.step_catalog_id === "lab_billing")).toEqual([
      expect.objectContaining({ status: "done", source: "auto" }),
    ]);
    expect(after.map((s) => s.step_order)).toEqual(after.map((_, i) => i + 1));
    expect(await ensurePlan(made.visit, db)).toMatchObject({ seeded: false });
  });
});
