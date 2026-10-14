import { test, expect } from "@playwright/test";
import { one, query } from "../helpers/db.mjs";
import { assertTestDatabase } from "../setup/guard.mjs";
import { extraVisit, newTag, setUp, tearDown } from "../billing/phase4/p4-bills-fixture.mjs";
import { db } from "../billing/phase4b/p4b-refunds.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const { getDayBoard, getSlaConfig } = await import("../../server/services/giniflow/board.js");
const { LAB_ONLY_DOCTOR } = await import("../../server/services/giniflow/labOnlyVisits.js");
const { clearFloorSettingsCache } = await import("../../server/services/giniflow/floorSettings.js");
const { addLabOnlyBillingSteps, sweepLabOnlyExits } =
  await import("../../server/services/giniflow/appointmentSync.js");
const { getLabQueue, markLabCaseAction } =
  await import("../../server/services/giniflow/labStation.js");
const { getPaymentQueue, getArrivals } =
  await import("../../server/services/giniflow/receptionStation.js");
const { setStepStatus } = await import("../../server/services/giniflow/journey.js");

const tag = newTag();
let ids;
let hideBefore;
let caseSeq = 0;

async function hideSamplesOnly(hide) {
  await query(
    `INSERT INTO giniflow_floor_settings (key, value) VALUES ('hide_lab_only_patients', $1)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [hide],
  );
  clearFloorSettingsCache();
}

async function labCase(patient, minutesAgo) {
  caseSeq += 1;
  const caseNo = `G88-${caseSeq}-${tag}`;
  await query(
    `INSERT INTO lab_cases (case_no, patient_case_no, case_uid, lab_case_id, patient_id,
                            test_names, case_date, case_status, raw_list_json)
     VALUES ($1, $1, $1, $2, $3, ARRAY['HbA1c'], $4::date, 'Registered',
             jsonb_build_object('registered_at', to_char((NOW() - make_interval(mins => $5)) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')))`,
    [caseNo, 998800 + caseSeq, patient, ids.day, minutesAgo],
  );
  return caseNo;
}

async function samplesOnlyPatient(label) {
  const made = await extraVisit(ids, label, { healthray: false });
  await query(
    `UPDATE appointments SET doctor_id = NULL, doctor_name = $2, visit_type = 'Investigation'
      WHERE id = $1`,
    [made.appointment, LAB_ONLY_DOCTOR],
  );
  await query(
    `UPDATE giniflow_visits SET current_status = 'booked', assigned_doctor_id = NULL WHERE id = $1`,
    [made.visit],
  );
  const fileNo = (await one(`SELECT file_no FROM patients WHERE id = $1`, [made.patient])).file_no;
  return { ...made, fileNo, caseNo: await labCase(made.patient, 90) };
}

const mentions = (data, fileNo) => JSON.stringify(data).includes(fileNo);
const inRoom = async (room, fileNo) =>
  mentions((await getLabQueue(ids.day, null, db, { room })).unified, fileNo);
const onPayments = async (visit) =>
  (await getPaymentQueue(ids.day, db)).healthrayLab.find((l) => l.visitId === visit) || null;
const act = (caseNo, action, room) =>
  markLabCaseAction(caseNo, { action, room, actorRole: "lab" }, db);

test.describe.serial("G88 samples-only patients are worked on the lab stations", () => {
  test.beforeAll(async () => {
    ids = await setUp(tag);
    hideBefore = (
      await query(`SELECT value FROM giniflow_floor_settings WHERE key = 'hide_lab_only_patients'`)
    ).rows[0]?.value;
    await hideSamplesOnly(true);
  });

  test.afterAll(async () => {
    if (hideBefore === undefined) {
      await query(`DELETE FROM giniflow_floor_settings WHERE key = 'hide_lab_only_patients'`);
    } else {
      await hideSamplesOnly(hideBefore);
    }
    clearFloorSettingsCache();
    await query(`DELETE FROM lab_cases WHERE case_no LIKE $1`, [`G88-%-${tag}`]);
    await tearDown(ids);
  });

  test("1. collection shows them, the board and Arrivals do not", async () => {
    const p = await samplesOnlyPatient("Home");
    expect(await inRoom("collection", p.fileNo)).toBe(true);
    const board = await getDayBoard(ids.day, await getSlaConfig(db), new Date(), db);
    expect(mentions(board.columns, p.fileNo)).toBe(false);
    expect(mentions(await getArrivals(ids.day, "", new Date(), db), p.fileNo)).toBe(false);
  });

  test("2. the sync gives them a Lab Billing step and Payments lists them", async () => {
    const p = await samplesOnlyPatient("Pay");
    expect(await onPayments(p.visit)).toBeNull();
    expect(await addLabOnlyBillingSteps(db, ids.day)).toBeGreaterThan(0);
    expect(await addLabOnlyBillingSteps(db, ids.day)).toBe(0);
    expect(await onPayments(p.visit)).toMatchObject({ labBillingStepId: expect.any(String) });
  });

  test("3. collected, sent and received before payment; report waits for payment", async () => {
    const p = await samplesOnlyPatient("Flow");
    await addLabOnlyBillingSteps(db, ids.day);
    await act(p.caseNo, "drawing_started", "collection");
    await act(p.caseNo, "sample_taken", "collection");
    await act(p.caseNo, "sample_sent", "collection");
    expect(await inRoom("processing", p.fileNo)).toBe(true);
    await act(p.caseNo, "sample_received", "processing");
    await act(p.caseNo, "processing", "processing");
    await act(p.caseNo, "results_ready", "processing");
    await query(`UPDATE lab_cases SET pdf_storage_path = 'g88/report.pdf' WHERE case_no = $1`, [
      p.caseNo,
    ]);
    await expect(act(p.caseNo, "report_uploaded", "processing")).rejects.toThrow(
      /lab payment is not cleared .* before the report/,
    );
    const row = await onPayments(p.visit);
    await setStepStatus(row.labBillingStepId, "done", db);
    await act(p.caseNo, "report_uploaded", "processing");
  });

  test("4. an ordinary patient still needs payment before the sample", async () => {
    const { patient } = await extraVisit(ids, "Ordinary", { healthray: false });
    const caseNo = await labCase(patient, 10);
    await expect(act(caseNo, "drawing_started", "collection")).rejects.toThrow(
      /lab payment is not cleared .* before the sample/,
    );
  });

  test("5. a morning sample for a patient who also sees a doctor stays as before", async () => {
    const p = await samplesOnlyPatient("Mixed");
    await query(
      `INSERT INTO appointments (patient_id, patient_name, file_no, appointment_date, visit_type, doctor_name)
       SELECT id, name, file_no, $2::date, 'Follow Up', 'Dr. Someone Else' FROM patients WHERE id = $1`,
      [p.patient, ids.day],
    );
    await query(`UPDATE giniflow_visits SET current_status = 'checked_in' WHERE id = $1`, [
      p.visit,
    ]);
    await query(
      `INSERT INTO giniflow_visit_events (visit_id, status, actor_role, occurred_at)
       VALUES ($1, 'checked_in', 'reception', NOW() - interval '30 minutes')`,
      [p.visit],
    );
    expect(await inRoom("collection", p.fileNo)).toBe(false);
    await addLabOnlyBillingSteps(db, ids.day);
    expect(await onPayments(p.visit)).toBeNull();
  });

  test("6. reports in from HealthRay: they leave only once the lab payment is cleared", async () => {
    const p = await samplesOnlyPatient("Exit");
    await query(
      `UPDATE lab_cases
          SET raw_list_json = raw_list_json || jsonb_build_object('reported_on', to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))
        WHERE case_no = $1`,
      [p.caseNo],
    );
    await addLabOnlyBillingSteps(db, ids.day);
    const sweep = async () => {
      const client = await db.connect();
      try {
        await sweepLabOnlyExits(client, ids.day, -1);
      } finally {
        client.release();
      }
      return (await one(`SELECT current_status FROM giniflow_visits WHERE id = $1`, [p.visit]))
        .current_status;
    };
    expect(await sweep()).toBe("booked");
    await setStepStatus((await onPayments(p.visit)).labBillingStepId, "done", db);
    expect(await sweep()).toBe("exited");
  });
});
