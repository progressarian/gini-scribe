import { test, expect } from "@playwright/test";
import { one, query } from "../helpers/db.mjs";
import { assertTestDatabase } from "../setup/guard.mjs";
import { extraVisit, newTag, setUp, tearDown } from "../billing/phase4/p4-bills-fixture.mjs";
import { db } from "../billing/phase4b/p4b-refunds.mjs";
import { USERS } from "../fixtures/data.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
await import("../../server/services/giniflow/board.js");
const { LAB_ONLY_DOCTOR } = await import("../../server/services/giniflow/labOnlyVisits.js");
const { CONSULT_STATUSES } = await import("../../shared/labOnly.js");
const { clearFloorSettingsCache } = await import("../../server/services/giniflow/floorSettings.js");
const { addLabOnlyBillingSteps, sweepLabOnlyExits } =
  await import("../../server/services/giniflow/appointmentSync.js");
const lab = await import("../../server/services/giniflow/labStation.js");
const machine = await import("../../server/services/giniflow/machineStation.js");
const reception = await import("../../server/services/giniflow/receptionStation.js");
const journey = await import("../../server/services/giniflow/journey.js");
const { getMachines } = await import("../../server/services/giniflow/machineCatalog.js");

const tag = newTag();
let ids;
let hideBefore;
let caseSeq = 0;
let ecg;

const LAB_STEPS = (tests) => [
  { catalogId: "lab_billing", name: "Lab Billing", minutes: 5 },
  { catalogId: "blood_sample", name: "Blood Sample", minutes: 5, tests },
  { catalogId: "lab_processing_2", name: "Lab Processing", minutes: 60 },
];

async function hideSamplesOnly(hide) {
  await query(
    `INSERT INTO giniflow_floor_settings (key, value) VALUES ('hide_lab_only_patients', $1)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [hide],
  );
  clearFloorSettingsCache();
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
  return { ...made, fileNo };
}

async function healthrayCase(patient) {
  caseSeq += 1;
  const caseNo = `G101-${caseSeq}-${tag}`;
  await query(
    `INSERT INTO lab_cases (case_no, patient_case_no, case_uid, lab_case_id, patient_id,
                            test_names, case_date, case_status, raw_list_json)
     VALUES ($1, $1, $1, $2, $3, ARRAY['HbA1c', 'Fasting Blood Sugar'], $4::date, 'Registered',
             jsonb_build_object('registered_at', to_char((NOW() - interval '2 hours') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')))`,
    [caseNo, 999100 + caseSeq, patient, ids.day],
  );
  return caseNo;
}

const steps = async (visit) =>
  (
    await query(
      `SELECT step_catalog_id, status, chain_status FROM giniflow_visit_steps
        WHERE visit_id = $1 ORDER BY step_order`,
      [visit],
    )
  ).rows;
const named = async (visit) =>
  (
    await query(
      `SELECT step_catalog_id, step_name FROM giniflow_visit_steps
        WHERE visit_id = $1 ORDER BY step_order`,
      [visit],
    )
  ).rows.map((r) => [r.step_catalog_id, r.step_name]);
const stepMap = async (visit) =>
  Object.fromEntries((await steps(visit)).map((s) => [s.step_catalog_id, s.status]));
const status = async (visit) =>
  (await one(`SELECT current_status FROM giniflow_visits WHERE id = $1`, [visit])).current_status;
const mentions = (data, fileNo) => JSON.stringify(data).includes(fileNo);
const orderOf = async (visit, kind) =>
  one(
    `SELECT id, payment_status, sample_status FROM giniflow_lab_orders
      WHERE visit_id = $1 AND kind = $2`,
    [visit, kind],
  );
const sweep = async () => {
  const client = await db.connect();
  try {
    return await sweepLabOnlyExits(client, ids.day, -1);
  } finally {
    client.release();
  }
};
const openJourney = async (visit) => {
  await journey.ensurePlan(visit, db);
  await journey.syncLabStepsFromLab(db, visit);
  return steps(visit);
};

test.describe.serial("G101 every lab-only flow, end to end", () => {
  test.beforeAll(async () => {
    ids = await setUp(tag);
    hideBefore = (
      await query(`SELECT value FROM giniflow_floor_settings WHERE key = 'hide_lab_only_patients'`)
    ).rows[0]?.value;
    await hideSamplesOnly(true);
    ecg = (await getMachines(db)).find((m) => m.id === "ecg") || (await getMachines(db))[0];
  });

  test.afterAll(async () => {
    if (hideBefore === undefined) {
      await query(`DELETE FROM giniflow_floor_settings WHERE key = 'hide_lab_only_patients'`);
    } else {
      await hideSamplesOnly(hideBefore);
    }
    await query(`DELETE FROM lab_cases WHERE case_no LIKE $1`, [`G101-%-${tag}`]);
    await tearDown(ids);
  });

  test("A. blood tests booked in HealthRay: Payments, lab rooms, report after payment, exit, clean journey", async () => {
    const p = await samplesOnlyPatient("HrBlood");
    const caseNo = await healthrayCase(p.patient);
    expect(
      (await reception.getArrivals(ids.day, "", new Date(), db)).expected.find(
        (a) => a.visitId === p.visit,
      )?.samplesOnly,
    ).toBe(true);

    await addLabOnlyBillingSteps(db, ids.day);
    const pay = (await reception.getPaymentQueue(ids.day, db)).healthrayLab.find(
      (l) => l.visitId === p.visit,
    );
    expect(pay?.labBillingStepId).toEqual(expect.any(String));

    const act = (action, room) =>
      lab.markLabCaseAction(caseNo, { action, room, actorRole: "lab" }, db);
    expect(
      mentions(
        (await lab.getLabQueue(ids.day, null, db, { room: "collection" })).unified,
        p.fileNo,
      ),
    ).toBe(true);
    await act("drawing_started", "collection");
    await act("sample_taken", "collection");
    await act("sample_sent", "collection");
    await act("sample_received", "processing");
    await act("processing", "processing");
    await act("results_ready", "processing");
    await query(
      `UPDATE lab_cases
          SET pdf_storage_path = 'g101/report.pdf',
              raw_list_json = raw_list_json || jsonb_build_object('reported_on', to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))
        WHERE case_no = $1`,
      [caseNo],
    );
    await expect(act("report_uploaded", "processing")).rejects.toThrow(
      /lab payment is not cleared/,
    );
    await sweep();
    expect(await status(p.visit)).not.toBe("exited");

    await journey.setStepStatus(pay.labBillingStepId, "done", db);
    await act("report_uploaded", "processing");
    await sweep();
    expect(await status(p.visit)).toBe("exited");

    const after = await openJourney(p.visit);
    expect(after.filter((s) => CONSULT_STATUSES.includes(s.chain_status))).toEqual([]);
    expect(after.map((s) => s.step_catalog_id)).not.toContain("billing");
    expect(await stepMap(p.visit)).toMatchObject({
      lab_billing: "done",
      blood_sample: "done",
      lab_processing_2: "done",
      report_upload: "done",
    });
    expect((await named(p.visit))[0]).toEqual(["lab_billing", "Lab Billing"]);
  });

  test("B. blood tests checked in at Arrivals: Billing, Check-in, Lab Collection, Lab Processing, Report Upload; exit at results ready", async () => {
    const p = await samplesOnlyPatient("DeskBlood");
    await journey.checkInWithJourney(
      p.visit,
      { steps: LAB_STEPS([ids.hba1cName]), actorId: USERS.reception?.id ?? null },
      db,
    );
    expect(await status(p.visit)).toBe("checked_in");
    expect(await named(p.visit)).toEqual([
      ["lab_billing", "Lab Billing"],
      ["check_in", "Check-in"],
      ["blood_sample", "Lab Collection"],
      ["lab_processing_2", "Lab Processing"],
      ["report_upload", "Report Upload"],
    ]);
    expect((await stepMap(p.visit)).check_in).toBe("done");

    const order = await orderOf(p.visit, "lab");
    expect(order.payment_status).not.toBe("paid");
    expect(mentions(await reception.getPaymentQueue(ids.day, db), p.fileNo)).toBe(true);
    await expect(
      lab.advanceSample(order.id, { to: "drawing", actorId: USERS.lab.id }, db),
    ).rejects.toThrow();

    await reception.clearPayment(
      order.id,
      { method: "paid", actorId: USERS.reception.id, confirmNotOnBill: true },
      db,
    );
    expect((await stepMap(p.visit)).lab_billing).toBe("done");
    expect(
      mentions(
        (await lab.getLabQueue(ids.day, null, db, { room: "collection" })).unified,
        p.fileNo,
      ),
    ).toBe(true);

    const to = (status, room) =>
      lab.advanceSample(order.id, { to: status, actorId: USERS.lab.id, room }, db);
    await to("drawing", "collection");
    await to("sample_collected", "collection");
    expect((await stepMap(p.visit)).blood_sample).toBe("done");
    await to("sample_sent", "collection");
    await to("sample_received", "processing");
    await to("processing", "processing");
    await sweep();
    expect(await status(p.visit)).toBe("checked_in");
    await to("results_ready", "processing");
    expect((await stepMap(p.visit)).lab_processing_2).toBe("done");
    expect((await stepMap(p.visit)).report_upload).toBe("pending");

    await sweep();
    expect(await status(p.visit)).toBe("exited");
  });

  test("D. Report Upload ticks when the report is uploaded", async () => {
    const p = await samplesOnlyPatient("Upload");
    await journey.checkInWithJourney(
      p.visit,
      { steps: LAB_STEPS([ids.hba1cName]), actorId: USERS.reception.id },
      db,
    );
    const order = await orderOf(p.visit, "lab");
    await reception.clearPayment(
      order.id,
      { method: "paid", actorId: USERS.reception.id, confirmNotOnBill: true },
      db,
    );
    const to = (status, room, extra = {}) =>
      lab.advanceSample(order.id, { to: status, actorId: USERS.lab.id, room, ...extra }, db);
    for (const [status, room] of [
      ["drawing", "collection"],
      ["sample_collected", "collection"],
      ["sample_sent", "collection"],
      ["sample_received", "processing"],
      ["processing", "processing"],
      ["results_ready", "processing"],
    ])
      await to(status, room);
    await to("uploaded", "processing", { reportUrl: "https://example.test/r.pdf" });
    expect(await stepMap(p.visit)).toMatchObject({
      lab_billing: "done",
      check_in: "done",
      blood_sample: "done",
      lab_processing_2: "done",
      report_upload: "done",
    });
  });

  test("E. unpaid: results ready does not end the visit", async () => {
    const p = await samplesOnlyPatient("Unpaid");
    const caseNo = await healthrayCase(p.patient);
    await addLabOnlyBillingSteps(db, ids.day);
    for (const action of ["drawing_started", "sample_taken", "sample_sent"])
      await lab.markLabCaseAction(caseNo, { action, room: "collection", actorRole: "lab" }, db);
    for (const action of ["sample_received", "processing", "results_ready"])
      await lab.markLabCaseAction(caseNo, { action, room: "processing", actorRole: "lab" }, db);
    await sweep();
    expect(await status(p.visit)).not.toBe("exited");
    const pay = (await reception.getPaymentQueue(ids.day, db)).healthrayLab.find(
      (l) => l.visitId === p.visit,
    );
    await journey.setStepStatus(pay.labBillingStepId, "done", db);
    await sweep();
    expect(await status(p.visit)).toBe("exited");
  });

  test("C. machine test only: Billing, Check-in, ECG; Payments, machine room, exit", async () => {
    test.skip(!ecg, "no machine in the test catalogue");
    const p = await samplesOnlyPatient("Machine");
    await journey.checkInWithJourney(
      p.visit,
      {
        steps: [
          { catalogId: "lab_billing", name: "Lab Billing", minutes: 5 },
          { catalogId: ecg.id, name: ecg.name, minutes: 10, machine: true },
        ],
        actorId: null,
      },
      db,
    );
    expect(await status(p.visit)).toBe("checked_in");
    expect((await named(p.visit)).map(([id]) => id)).toEqual(["lab_billing", "check_in", ecg.id]);
    expect((await named(p.visit))[0][1]).toBe("Lab Billing");

    const order = await orderOf(p.visit, "machine");
    expect(order).toBeTruthy();
    expect(mentions(await reception.getPaymentQueue(ids.day, db), p.fileNo)).toBe(true);

    await reception.clearPayment(
      order.id,
      { method: "paid", actorId: USERS.reception.id, confirmNotOnBill: true },
      db,
    );
    expect((await stepMap(p.visit)).lab_billing).toBe("done");

    expect(mentions(await machine.getMachineQueue(ids.day, null, db), p.fileNo)).toBe(true);
    await machine.advanceMachineTest(order.id, { to: "in_progress", actorId: null }, db);
    await machine.advanceMachineTest(
      order.id,
      { to: "done", actorId: null, reportUrl: "https://example.test/ecg.pdf" },
      db,
    );
    expect((await stepMap(p.visit))[ecg.id]).toBe("done");
    expect(await status(p.visit)).not.toMatch(/vitals|sd|doctor|rx|pharmacy/);

    await sweep();
    expect(await status(p.visit)).toBe("exited");
    const after = await openJourney(p.visit);
    expect(after.filter((s) => CONSULT_STATUSES.includes(s.chain_status))).toEqual([]);
  });
});
