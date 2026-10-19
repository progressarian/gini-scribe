import { test, expect } from "@playwright/test";
import { one, query } from "../helpers/db.mjs";
import { assertTestDatabase } from "../setup/guard.mjs";
import { extraVisit, newTag, setUp, tearDown } from "../billing/phase4/p4-bills-fixture.mjs";
import { db } from "../billing/phase4b/p4b-refunds.mjs";
import { CONSULTANTS } from "../fixtures/data.mjs";

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
const { setStepStatus, checkInWithJourney, ensurePlan, defaultPlan, syncLabStepsFromLab } =
  await import("../../server/services/giniflow/journey.js");
const { CONSULT_STATUSES } = await import("../../shared/labOnly.js");
const { stepsAllowedByBill } = await import("../../server/services/giniflow/patientBill.js");
const { getMachines } = await import("../../server/services/giniflow/machineCatalog.js");

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

  test("1. collection and Arrivals show them, the board does not", async () => {
    const p = await samplesOnlyPatient("Home");
    expect(await inRoom("collection", p.fileNo)).toBe(true);
    const board = await getDayBoard(ids.day, await getSlaConfig(db), new Date(), db);
    expect(mentions(board.columns, p.fileNo)).toBe(false);
    const arrivals = await getArrivals(ids.day, "", new Date(), db);
    expect(arrivals.expected.find((a) => a.visitId === p.visit)?.samplesOnly).toBe(true);
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

  test("7. checked in at Arrivals with a Blood Sample step: checked in, and the lab order waits for payment", async () => {
    const p = await samplesOnlyPatient("Arrive");
    await query(`DELETE FROM lab_cases WHERE case_no = $1`, [p.caseNo]);
    await checkInWithJourney(
      p.visit,
      {
        steps: [
          { catalogId: "blood_sample", name: "Blood Sample", minutes: 5, tests: [ids.hba1cName] },
        ],
        actorId: null,
      },
      db,
    );
    expect(
      (await one(`SELECT current_status FROM giniflow_visits WHERE id = $1`, [p.visit]))
        .current_status,
    ).toBe("checked_in");
    const order = await one(
      `SELECT o.kind, o.payment_status, array_agg(t.test_name) AS tests
         FROM giniflow_lab_orders o JOIN giniflow_lab_order_tests t ON t.lab_order_id = o.id
        WHERE o.visit_id = $1 GROUP BY o.id`,
      [p.visit],
    );
    expect(order).toMatchObject({ kind: "lab", tests: [ids.hba1cName] });
    expect(order.payment_status).not.toBe("paid");
    expect(mentions(await getPaymentQueue(ids.day, db), p.fileNo)).toBe(true);
    const arrivals = await getArrivals(ids.day, "", new Date(), db);
    expect(arrivals.onFloor.map((a) => a.visitId)).toContain(p.visit);
  });

  const stepIds = async (visit) =>
    (
      await query(
        `SELECT step_catalog_id, chain_status FROM giniflow_visit_steps
          WHERE visit_id = $1 ORDER BY step_order`,
        [visit],
      )
    ).rows;
  const consultLeg = (rows) => rows.filter((r) => CONSULT_STATUSES.includes(r.chain_status));
  const PLAN = [
    { catalogId: "vitals", name: "Vitals", minutes: 5 },
    { catalogId: "sd_consult", name: "SD Consultation", minutes: 20 },
    { catalogId: "blood_sample", name: "Blood Sample", minutes: 5, tests: [ids?.hba1cName] },
    { catalogId: "pharmacy", name: "Pharmacy / Exit", minutes: 10 },
  ];

  test("8. opening the journey of an exited samples-only patient adds no consultation steps", async () => {
    const p = await samplesOnlyPatient("Opened");
    const template = await defaultPlan("FU_APPT", db);
    expect(template.some((s) => CONSULT_STATUSES.includes(s.chainStatus))).toBe(true);
    await query(
      `UPDATE giniflow_visits SET visit_type_id = 'FU_APPT', current_status = 'exited' WHERE id = $1`,
      [p.visit],
    );
    await ensurePlan(p.visit, db);
    expect(consultLeg(await stepIds(p.visit))).toEqual([]);
  });

  test("8b. after the sync's Lab Billing step, the journey adds no Billing and no second Lab Billing", async () => {
    const p = await samplesOnlyPatient("NoDupes");
    await addLabOnlyBillingSteps(db, ids.day);
    await query(`UPDATE giniflow_visits SET visit_type_id = 'FU_APPT_TESTS' WHERE id = $1`, [
      p.visit,
    ]);
    const template = (await defaultPlan("FU_APPT_TESTS", db)).map((s) => s.catalogId);
    expect(template).toEqual(expect.arrayContaining(["billing", "lab_billing"]));
    await ensurePlan(p.visit, db);
    const rows = (await stepIds(p.visit)).map((r) => r.step_catalog_id);
    expect(rows.filter((id) => id === "lab_billing")).toHaveLength(1);
    expect(rows).not.toContain("billing");
    expect(rows).toContain("blood_sample");
  });

  test("8c. Lab Processing is ticked once the lab has reported every case", async () => {
    const p = await samplesOnlyPatient("Processed");
    await query(
      `INSERT INTO flow_step_catalog (id, name, station, assigned_role, default_duration_min)
       VALUES ('lab_processing_2', 'Lab Processing', 'Lab', 'lab_tech', 60)
       ON CONFLICT (id) DO NOTHING`,
    );
    await query(
      `INSERT INTO giniflow_visit_steps (visit_id, step_order, step_catalog_id, step_name, status, source)
       VALUES ($1, 1, 'lab_processing_2', 'Lab Processing', 'skipped', 'template')`,
      [p.visit],
    );
    const status = async () =>
      (
        await one(
          `SELECT status FROM giniflow_visit_steps
            WHERE visit_id = $1 AND step_catalog_id = 'lab_processing_2'`,
          [p.visit],
        )
      ).status;
    await syncLabStepsFromLab(db, p.visit);
    expect(await status()).toBe("skipped");
    await act(p.caseNo, "drawing_started", "collection");
    await act(p.caseNo, "sample_taken", "collection");
    await act(p.caseNo, "sample_sent", "collection");
    await act(p.caseNo, "sample_received", "processing");
    await act(p.caseNo, "processing", "processing");
    await act(p.caseNo, "results_ready", "processing");
    await query(
      `UPDATE lab_cases
          SET pdf_storage_path = 'g88/report.pdf',
              raw_list_json = raw_list_json || jsonb_build_object('reported_on', to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))
        WHERE case_no = $1`,
      [p.caseNo],
    );
    await addLabOnlyBillingSteps(db, ids.day);
    await setStepStatus((await onPayments(p.visit)).labBillingStepId, "done", db);
    await act(p.caseNo, "report_uploaded", "processing");
    await syncLabStepsFromLab(db, p.visit);
    expect(await status()).toBe("done");
  });

  test("9. checked in with a consultation journey and no consultant: only the tests are kept", async () => {
    const p = await samplesOnlyPatient("NoDoctor");
    await query(`DELETE FROM lab_cases WHERE case_no = $1`, [p.caseNo]);
    const steps = PLAN.map((s) => (s.tests ? { ...s, tests: [ids.hba1cName] } : s));
    await checkInWithJourney(p.visit, { steps, actorId: null }, db);
    const rows = await stepIds(p.visit);
    expect(consultLeg(rows)).toEqual([]);
    expect(rows.map((r) => r.step_catalog_id)).toContain("blood_sample");
    expect(
      await one(`SELECT current_status, assigned_doctor_id FROM giniflow_visits WHERE id = $1`, [
        p.visit,
      ]),
    ).toEqual({ current_status: "checked_in", assigned_doctor_id: null });
  });

  test("10. checked in with a consultant picked: the patient keeps the consultation", async () => {
    const p = await samplesOnlyPatient("WithDoctor");
    await query(`DELETE FROM lab_cases WHERE case_no = $1`, [p.caseNo]);
    const steps = PLAN.map((s) =>
      s.catalogId === "sd_consult"
        ? { ...s, staffId: CONSULTANTS.rahul.id }
        : s.tests
          ? { ...s, tests: [ids.hba1cName] }
          : s,
    );
    await checkInWithJourney(p.visit, { steps, actorId: null }, db);
    const rows = await stepIds(p.visit);
    expect(rows.map((r) => r.step_catalog_id)).toEqual(
      expect.arrayContaining(["vitals", "sd_consult", "pharmacy"]),
    );
    expect(
      (await one(`SELECT assigned_doctor_id FROM giniflow_visits WHERE id = $1`, [p.visit]))
        .assigned_doctor_id,
    ).toBe(CONSULTANTS.rahul.id);
  });

  test("11. a machine-only bill keeps Lab Billing and the machine; a lab bill keeps Lab Processing", async () => {
    const machines = await getMachines(db);
    const step = (catalogId, machine = false) => ({ catalogId, machine, source: "template" });
    const plan = [
      step("lab_billing"),
      step("blood_sample"),
      step("lab_processing_2"),
      step("ecg", true),
    ];
    const catalogIds = (steps) => steps.map((s) => s.catalogId);
    const billed = (items) => ({ status: "billed", items });
    expect(
      catalogIds(
        stepsAllowedByBill(
          plan,
          billed([{ desc: "ECG", category: "procedure", amount: 300 }]),
          machines,
        ),
      ),
    ).toEqual(["lab_billing", "ecg"]);
    expect(
      catalogIds(
        stepsAllowedByBill(
          plan,
          billed([{ desc: ids.hba1cName, category: "lab", amount: 250 }]),
          machines,
        ),
      ),
    ).toEqual(["lab_billing", "blood_sample", "lab_processing_2"]);
  });
});
