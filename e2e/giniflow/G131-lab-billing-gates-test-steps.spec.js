import { test, expect } from "@playwright/test";
import { query } from "../helpers/db.mjs";
import { assertTestDatabase } from "../setup/guard.mjs";
import { extraVisit, newTag, setUp, tearDown } from "../billing/phase4/p4-bills-fixture.mjs";
import { db } from "../billing/phase4b/p4b-refunds.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
await import("../../server/services/giniflow/board.js");
const journey = await import("../../server/services/giniflow/journey.js");

const tag = newTag();
let ids;
const caseNos = [];

const PLAN = [
  ["lab_billing", "Lab Billing", "pending"],
  ["check_in", "Check-in", "done"],
  ["blood_sample", "Lab Collection", "pending"],
  ["lab_processing_2", "Lab Processing", "pending"],
  ["report_upload", "Report Upload", "pending"],
  ["ecg", "ECG", "pending"],
];

async function labOnlyVisit(label) {
  const made = await extraVisit(ids, label, { healthray: false });
  await query(`DELETE FROM giniflow_visit_steps WHERE visit_id = $1`, [made.visit]);
  await query(`UPDATE giniflow_visits SET current_status = 'checked_in' WHERE id = $1`, [
    made.visit,
  ]);
  for (const [i, [catalogId, name, status]] of PLAN.entries()) {
    await query(
      `INSERT INTO giniflow_visit_steps
         (visit_id, step_order, step_catalog_id, step_name, planned_duration_min, status, source)
       VALUES ($1, $2, $3, $4, 5, $5, $6)`,
      [made.visit, i + 1, catalogId, name, status, catalogId === "ecg" ? "added" : "template"],
    );
  }
  return made;
}

async function collectedInHealthray(made) {
  const caseNo = `G131-${caseNos.length + 1}-${tag}`;
  caseNos.push(caseNo);
  const at = new Date().toISOString();
  await query(
    `INSERT INTO lab_cases (case_no, patient_case_no, case_uid, lab_case_id, patient_id,
                            test_names, case_date, case_status, raw_list_json)
     VALUES ($1, $1, $1, $2, $3, ARRAY['HbA1c'], $4::date, 'Registered',
             jsonb_build_object('phlebotomy_status', 'Completed', 'collected_on', $5::text,
                                'reported_on', $5::text))`,
    [caseNo, 999300 + caseNos.length, made.patient, ids.day, at],
  );
  await query(
    `INSERT INTO giniflow_lab_case_actions (case_no, action) VALUES ($1, 'sample_taken'),
            ($1, 'report_uploaded')`,
    [caseNo],
  );
}

const stepOf = async (visit, catalogId) =>
  (
    await query(
      `SELECT id, status FROM giniflow_visit_steps WHERE visit_id = $1 AND step_catalog_id = $2`,
      [visit, catalogId],
    )
  ).rows[0];

const refusal = async (promise) => {
  try {
    await promise;
  } catch (error) {
    return { status: error.status, message: error.message };
  }
  return null;
};

const LAB_BILLING_FIRST = {
  status: 409,
  message: "Lab Billing comes first — clear the test payment on the Payments tab",
};

test.describe.serial("G131 no test stop is done in Scribe before Lab Billing", () => {
  test.beforeAll(async () => {
    ids = await setUp(tag);
  });

  test.afterAll(async () => {
    await query(`DELETE FROM giniflow_lab_case_actions WHERE case_no = ANY($1)`, [caseNos]);
    await query(`DELETE FROM lab_cases WHERE case_no = ANY($1)`, [caseNos]);
    await tearDown(ids);
  });

  test("1. a sample taken in HealthRay's lab leaves Lab Collection pending while Lab Billing is", async () => {
    const made = await labOnlyVisit("GateHr");
    await collectedInHealthray(made);
    await journey.syncLabStepsFromLab(db, made.visit);
    expect((await stepOf(made.visit, "lab_billing")).status).toBe("pending");
    expect((await stepOf(made.visit, "blood_sample")).status).toBe("pending");
    expect((await stepOf(made.visit, "report_upload")).status).toBe("pending");
  });

  test("2. ticking Lab Collection or a machine stop by hand is refused until Lab Billing is done", async () => {
    const made = await labOnlyVisit("GateHand");
    for (const id of ["blood_sample", "lab_processing_2", "report_upload", "ecg"]) {
      const step = await stepOf(made.visit, id);
      expect(await refusal(journey.setStepStatus(step.id, "done", db))).toEqual(LAB_BILLING_FIRST);
      expect((await stepOf(made.visit, id)).status).toBe("pending");
    }
  });

  test("3. once Lab Billing is done, the HealthRay sample catches up and the stops can be ticked", async () => {
    const made = await labOnlyVisit("GateAfter");
    await collectedInHealthray(made);
    await journey.syncLabStepsFromLab(db, made.visit);
    expect((await stepOf(made.visit, "blood_sample")).status).toBe("pending");

    await journey.setStepStatus((await stepOf(made.visit, "lab_billing")).id, "done", db);
    expect((await stepOf(made.visit, "blood_sample")).status).toBe("done");
    expect((await stepOf(made.visit, "report_upload")).status).toBe("done");

    await journey.setStepStatus((await stepOf(made.visit, "ecg")).id, "done", db);
    expect((await stepOf(made.visit, "ecg")).status).toBe("done");
  });

  test("4. a journey without a Lab Billing stop is not held", async () => {
    const made = await labOnlyVisit("GateNoBilling");
    await query(
      `DELETE FROM giniflow_visit_steps WHERE visit_id = $1 AND step_catalog_id = 'lab_billing'`,
      [made.visit],
    );
    await collectedInHealthray(made);
    await journey.syncLabStepsFromLab(db, made.visit);
    expect((await stepOf(made.visit, "blood_sample")).status).toBe("done");
  });
});
