import "../loadEnv.js";
import pool from "../config/db.js";
import { syncAppointmentsToFlow } from "../services/giniflow/appointmentSync.js";
import { advanceMachineTest } from "../services/giniflow/machineStation.js";
import { markArrived } from "../services/giniflow/receptionStation.js";
import { getTestsHold } from "../services/giniflow/testsHold.js";

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "  ok " : "FAIL "} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

const client = await pool.connect();
let depth = 0;
const nested = {
  query: (text, params) => {
    const sql = String(text).trim().toUpperCase();
    if (sql === "BEGIN") return client.query(`SAVEPOINT sp${++depth}`);
    if (sql === "COMMIT") return client.query(`RELEASE SAVEPOINT sp${depth--}`);
    if (sql === "ROLLBACK") return client.query(`ROLLBACK TO SAVEPOINT sp${depth--}`);
    return client.query(text, params);
  },
  release: () => {},
};
const db = { connect: async () => nested, query: (t, p) => client.query(t, p) };

const refusal = async (fn) => {
  try {
    await fn();
    return null;
  } catch (e) {
    return { message: e.message, status: e.status ?? null };
  }
};

const TAG = `ZZDS_${Date.now()}`;
let seq = 0;

try {
  await client.query("BEGIN");
  const { rows: d } = await client.query(
    `SELECT ((NOW() AT TIME ZONE 'Asia/Kolkata')::date + 131)::text AS day`,
  );
  const day = d[0].day;
  const sync = () => syncAppointmentsToFlow({ date: day, db });

  const patient = async ({ vitals = true } = {}) => {
    seq++;
    const { rows: p } = await client.query(
      `INSERT INTO patients (name, file_no) VALUES ($1, $2) RETURNING id, file_no`,
      [`Probe Doctor ${seq}`, `${TAG}_${seq}`],
    );
    const { rows: a } = await client.query(
      `INSERT INTO appointments (patient_id, appointment_date, status, time_slot, doctor_name)
       VALUES ($1, $2::date, 'checkedin', '10:00', 'Dr. Anil Bhansali') RETURNING id`,
      [p[0].id, day],
    );
    await sync();
    const { rows: v } = await client.query(
      `SELECT id FROM giniflow_visits WHERE patient_id = $1 AND visit_date = $2::date`,
      [p[0].id, day],
    );
    await markArrived(v[0].id, null, db);
    if (vitals) {
      await client.query(
        `INSERT INTO giniflow_visit_events (visit_id, status, actor_role) VALUES ($1, 'vitals_done', 'vitals')`,
        [v[0].id],
      );
      await client.query(
        `UPDATE giniflow_visits SET current_status = 'vitals_done' WHERE id = $1`,
        [v[0].id],
      );
    }
    const hr = (status) =>
      client.query(`UPDATE appointments SET status = $2 WHERE id = $1`, [a[0].id, status]);
    const status = async () =>
      (await client.query(`SELECT current_status FROM giniflow_visits WHERE id = $1`, [v[0].id]))
        .rows[0].current_status;
    return { patientId: p[0].id, fileNo: p[0].file_no, visitId: v[0].id, hr, status };
  };

  const order = async (visitId, kind, testName, sampleStatus = "paid") => {
    const { rows } = await client.query(
      `INSERT INTO giniflow_lab_orders
         (visit_id, urgency, payment_status, amount_total, amount_paid, sample_status, kind)
       VALUES ($1, 'today', 'paid', 400, 400, $2, $3) RETURNING id`,
      [visitId, sampleStatus, kind],
    );
    await client.query(
      `INSERT INTO giniflow_lab_order_tests (lab_order_id, test_name, price) VALUES ($1, $2, 400)`,
      [rows[0].id, testName],
    );
    return rows[0].id;
  };

  console.log("── Before the doctors: Scribe's own steps come first ───────");
  const early = await patient({ vitals: false });
  await early.hr("completed");
  await sync();
  check(
    "HealthRay checkout with vitals not recorded moves nothing",
    (await early.status()) === "checked_in",
    await early.status(),
  );

  console.log("\n── With the doctors: HealthRay Engaged ─────────────────────");
  const a = await patient();
  await a.hr("in_visit");
  await sync();
  check(
    "no tests: Engaged takes the patient to the Chief",
    (await a.status()) === "with_sd",
    await a.status(),
  );

  console.log("\n── The Chief orders a machine test ─────────────────────────");
  const abi = await order(a.visitId, "machine", "ABI");
  check("the open test is counted", (await getTestsHold(a.visitId, client)).pending);
  await a.hr("completed");
  await sync();
  check(
    "HealthRay checkout does NOT complete the doctors while the ABI is open in Scribe",
    (await a.status()) === "with_sd",
    await a.status(),
  );
  const started = await refusal(() => advanceMachineTest(abi, { to: "in_progress" }, db));
  check(
    "the Machine Room can start the ABI while HealthRay has him with the Chief",
    started === null,
    started?.message,
  );

  const b = await patient();
  await b.hr("in_visit");
  await sync();
  check(
    "the Chief's room is free for the next patient while the first is away for tests",
    (await b.status()) === "with_sd",
    await b.status(),
  );

  await client.query(
    `INSERT INTO lab_results (lab_order_id, patient_id, test_name, result, test_date)
     VALUES ($1, $2, 'ABI Right', 1.1, CURRENT_DATE)`,
    [abi, a.patientId],
  );
  await advanceMachineTest(abi, { to: "done" }, db);
  check(
    "once the ABI is done in Scribe nothing is open",
    !(await getTestsHold(a.visitId, client)).pending,
  );
  await sync();
  check(
    "the next sync completes the doctors step (HealthRay already checked out)",
    (await a.status()) === "rx_pending",
    await a.status(),
  );
  const { rows: ev } = await client.query(
    `SELECT meta->>'source' AS source FROM giniflow_visit_events
      WHERE visit_id = $1 AND status = 'rx_pending'`,
    [a.visitId],
  );
  check("written by the HealthRay sync", ev[0]?.source === "healthray", ev[0]?.source);

  console.log("\n── A HealthRay lab case counts only when done in Scribe ────");
  const c = await patient();
  await c.hr("in_visit");
  await sync();
  const caseNo = `${TAG}_CASE`;
  await client.query(
    `INSERT INTO lab_cases (case_no, patient_case_no, case_uid, lab_case_id, case_date, patient_id,
                            test_names, raw_list_json, results_synced)
     VALUES ($1, $1, $1, 900000001, $2::date, $3, ARRAY['HBA1C'],
             jsonb_build_object('reported_on', NOW()::text), FALSE)`,
    [caseNo, day, c.patientId],
  );
  await c.hr("completed");
  await sync();
  check(
    "HealthRay's own 'reported' does not release the doctors",
    ["sd_pending", "with_sd"].includes(await c.status()),
    await c.status(),
  );
  await client.query(
    `INSERT INTO giniflow_lab_case_actions (case_no, action, actor_role) VALUES ($1, 'report_uploaded', 'lab')`,
    [caseNo],
  );
  await sync();
  check(
    "the bench's 'report uploaded' in Scribe releases them",
    (await c.status()) === "rx_pending",
    await c.status(),
  );

  console.log("\n── A Scribe lab order stands in for its HealthRay case ─────");
  const e = await patient();
  await e.hr("in_visit");
  await sync();
  await order(e.visitId, "lab", "HbA1c", "uploaded");
  await client.query(
    `INSERT INTO lab_cases (case_no, patient_case_no, case_uid, lab_case_id, case_date, patient_id,
                            test_names, raw_list_json, results_synced)
     VALUES ($1, $1, $1, 900000002, $2::date, $3, ARRAY['HBA1C'], '{}'::jsonb, FALSE)`,
    [`${TAG}_CASE2`, day, e.patientId],
  );
  check(
    "an uploaded Scribe order is done even though the hidden HealthRay case was never tapped",
    !(await getTestsHold(e.visitId, client)).pending,
  );

  console.log("\n── Online journey: Chief Consultation only ─────────────────");
  const o = await patient({ vitals: false });
  await client.query(`UPDATE giniflow_visits SET visit_type_id = 'ONLINE' WHERE id = $1`, [
    o.visitId,
  ]);
  const { rows: os } = await client.query(
    `INSERT INTO giniflow_visit_steps
       (visit_id, step_order, step_catalog_id, step_name, planned_duration_min, station,
        assigned_role, chain_status, status, source)
     VALUES ($1, 1, 'chief_consult', 'Chief Consultation', 50, 'Chief Room', 'chief',
             'with_doctor', 'pending', 'template')
     RETURNING id`,
    [o.visitId],
  );
  await o.hr("in_visit");
  await sync();
  check(
    "HealthRay Engaged takes an online patient to the Chief without vitals",
    ["sd_pending", "with_sd"].includes(await o.status()),
    await o.status(),
  );
  const { rows: stamp } = await client.query(
    `UPDATE appointments a
        SET biomarkers = COALESCE(a.biomarkers, '{}'::jsonb)
                         || jsonb_build_object('engagedEnd', to_jsonb(clock_timestamp()))
       FROM giniflow_visits v
      WHERE v.id = $1 AND a.patient_id = v.patient_id AND a.appointment_date = v.visit_date
      RETURNING (a.biomarkers->>'engagedEnd')::timestamptz AS at`,
    [o.visitId],
  );
  await new Promise((r) => setTimeout(r, 1500));
  await o.hr("completed");
  await sync();
  check(
    "HealthRay Checkout ends the online visit",
    (await o.status()) === "exited",
    await o.status(),
  );
  const { rows: ostep } = await client.query(
    `SELECT status FROM giniflow_visit_steps WHERE id = $1`,
    [os[0].id],
  );
  const { rows: exitEv } = await client.query(
    `SELECT occurred_at FROM giniflow_visit_events WHERE visit_id = $1 AND status = 'exited'`,
    [o.visitId],
  );
  check(
    "the exit is stamped at HealthRay's checkout time, not the sync's",
    exitEv[0] && new Date(exitEv[0].occurred_at).getTime() === new Date(stamp[0].at).getTime(),
    `${exitEv[0]?.occurred_at?.toISOString?.()} vs ${stamp[0].at.toISOString()}`,
  );
  check("Chief Consultation is ticked done", ostep[0].status === "done", ostep[0].status);

  console.log("\n── Absences and the switch ─────────────────────────────────");
  const f = await patient();
  await f.hr("in_visit");
  await sync();
  await order(f.visitId, "machine", "VPT");
  await f.hr("no_show");
  await sync();
  check(
    "HealthRay's no-show does not take a checked-in patient off the floor",
    ["sd_pending", "with_sd"].includes(await f.status()),
    await f.status(),
  );
  await f.hr("cancelled");
  await sync();
  check(
    "nor does HealthRay's cancellation",
    ["sd_pending", "with_sd"].includes(await f.status()),
    await f.status(),
  );

  seq++;
  const { rows: np } = await client.query(
    `INSERT INTO patients (name, file_no) VALUES ($1, $2) RETURNING id`,
    [`Probe Doctor ${seq}`, `${TAG}_${seq}`],
  );
  await client.query(
    `INSERT INTO appointments (patient_id, appointment_date, status, time_slot, doctor_name)
     VALUES ($1, $2::date, 'no_show', '10:00', 'Dr. Anil Bhansali')`,
    [np[0].id, day],
  );
  await sync();
  const { rows: nv } = await client.query(
    `SELECT current_status FROM giniflow_visits WHERE patient_id = $1 AND visit_date = $2::date`,
    [np[0].id, day],
  );
  check(
    "a patient never checked in is still marked no-show",
    nv[0]?.current_status === "no_show",
    nv[0]?.current_status,
  );

  seq++;
  const { rows: lp } = await client.query(
    `INSERT INTO patients (name, file_no) VALUES ($1, $2) RETURNING id`,
    [`Probe Doctor ${seq}`, `${TAG}_${seq}`],
  );
  await client.query(
    `INSERT INTO appointments (patient_id, appointment_date, status, time_slot, doctor_name)
     VALUES ($1, $2::date, 'checkedin', '10:00', 'Dr. Hospital Admin')`,
    [lp[0].id, day],
  );
  await sync();
  const { rows: lv } = await client.query(
    `SELECT id FROM giniflow_visits WHERE patient_id = $1 AND visit_date = $2::date`,
    [lp[0].id, day],
  );
  await markArrived(lv[0].id, null, db);
  await client.query(
    `INSERT INTO lab_cases (case_no, patient_case_no, case_uid, lab_case_id, case_date, patient_id,
                            test_names, raw_list_json, results_synced)
     VALUES ($1, $1, $1, 900000004, $2::date, $3, ARRAY['HBA1C'],
             jsonb_build_object('reported_on', (NOW() - interval '2 hours')::text), FALSE)`,
    [`${TAG}_CASE4`, day, lp[0].id],
  );
  await sync();
  const { rows: ls } = await client.query(
    `SELECT current_status FROM giniflow_visits WHERE id = $1`,
    [lv[0].id],
  );
  check(
    "a lab-only patient is not closed because HealthRay reported the case",
    ls[0].current_status === "checked_in",
    ls[0].current_status,
  );

  const g = await patient();
  await g.hr("in_visit");
  await sync();
  await client.query(
    `INSERT INTO lab_cases (case_no, patient_case_no, case_uid, lab_case_id, case_date, patient_id,
                            test_names, raw_list_json, results_synced)
     VALUES ($1, $1, $1, 900000003, $2::date, $3, ARRAY['TSH'], '{}'::jsonb, FALSE)`,
    [`${TAG}_CASE3`, day, g.patientId],
  );
  await g.hr("completed");
  await sync();
  check(
    "an untouched HealthRay case holds the doctors",
    ["sd_pending", "with_sd"].includes(await g.status()),
    await g.status(),
  );
  process.env.SCRIBE_DOCTORS_WAIT_FOR_TESTS = "0";
  await sync();
  delete process.env.SCRIBE_DOCTORS_WAIT_FOR_TESTS;
  check(
    'SCRIBE_DOCTORS_WAIT_FOR_TESTS="0" releases it, as before this rule',
    (await g.status()) === "rx_pending",
    await g.status(),
  );
} catch (err) {
  check("the scenarios ran to the end", false, `threw: ${err.message}`);
} finally {
  await client.query("ROLLBACK");
  client.release();
  const { rows: left } = await pool.query(
    `SELECT count(*)::int AS c FROM patients WHERE file_no LIKE $1`,
    [`${TAG}%`],
  );
  check("the synthetic patients left no trace", left[0].c === 0, `${left[0].c} rows`);
  console.log(failures ? `\n${failures} FAILED` : "\nall checks passed");
  await pool.end();
  process.exit(failures ? 1 : 0);
}
