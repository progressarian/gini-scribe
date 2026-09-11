// The floor's own order of operations, walked end to end
// (docs/gini-flow/39-HYBRID-FLOOR-PLAN.md — the whole plan, as one journey).
//
// This is the SPEC as a test. Every check below is one sentence of what the
// floor asked for:
//
//   1  Reception marks the patient arrived, by hand.
//   2  Then vitals.
//   3  Then Lab 1 or the Machine Room — whichever is in the billing.
//   4  Billed for both? Lab 1 draws first; the machine opens only once the
//      sample is marked collected.
//   5  Then the reports. Only when all are in does the patient reach the
//      consultant.
//   6  The consultant is the one step HealthRay drives.
//   7  Then the prescription counter, by hand.
//   8  Then pharmacy, by hand.
//   9  And if HealthRay has moved the patient on while a station has not
//      recorded its step, the patient stays put here and the desk is named.
//
// Runs on a date of its own inside a transaction that is always rolled back.
//
//   npm run smoke:floor-journey   (from server/)
import "../loadEnv.js";
import pool from "../config/db.js";
import { syncAppointmentsToFlow } from "../services/giniflow/appointmentSync.js";
import { recordHealthrayObservation } from "../services/giniflow/observation.js";
import { getMachineQueue, advanceMachineTest } from "../services/giniflow/machineStation.js";
import { advanceSample } from "../services/giniflow/labStation.js";
import { markArrived } from "../services/giniflow/receptionStation.js";

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

try {
  await client.query("BEGIN");
  const { rows: d } = await client.query(
    `SELECT ((NOW() AT TIME ZONE 'Asia/Kolkata')::date + 123)::text AS day`,
  );
  const day = d[0].day;

  for (const name of ["ABI", "HbA1c"]) {
    await client.query(
      `INSERT INTO giniflow_test_catalog (test_name, category, price, is_active)
       VALUES ($1, $2, 400, TRUE)
       ON CONFLICT (test_name) DO UPDATE
         SET category = EXCLUDED.category, price = 400, is_active = TRUE`,
      [name, name === "ABI" ? "machine" : "lab"],
    );
  }

  // One patient, booked with a consultant, billed for BOTH a blood test and a
  // machine test — the shape that exercises every rule at once.
  const { rows: p } = await client.query(
    `INSERT INTO patients (name, file_no) VALUES ('Probe Journey', $1) RETURNING id`,
    [`ZZFJ_${Date.now()}`],
  );
  const patientId = p[0].id;
  const { rows: a } = await client.query(
    `INSERT INTO appointments (patient_id, appointment_date, status, time_slot, doctor_name)
     VALUES ($1, $2::date, 'checkedin', '10:00', 'Dr. Anil Bhansali') RETURNING id`,
    [patientId, day],
  );
  const apptId = a[0].id;

  const hrSays = (status) =>
    client.query(`UPDATE appointments SET status = $2 WHERE id = $1`, [apptId, status]);

  const statusOf = async () => {
    const { rows } = await client.query(
      `SELECT current_status, behind_station FROM giniflow_visits
        WHERE patient_id = $1 AND visit_date = $2::date`,
      [patientId, day],
    );
    return rows[0] || {};
  };
  const visitId = async () => {
    const { rows } = await client.query(
      `SELECT id FROM giniflow_visits WHERE patient_id = $1 AND visit_date = $2::date`,
      [patientId, day],
    );
    return rows[0]?.id;
  };

  console.log("── 1 · Reception marks the patient arrived, by hand ────────");
  await syncAppointmentsToFlow({ date: day, db });
  const s1 = await statusOf();
  check(
    "HealthRay says checked in; the board still says booked",
    s1.current_status === "booked",
    s1.current_status,
  );
  await recordHealthrayObservation(client, day);
  check("and Reception is named as behind", (await statusOf()).behind_station === "reception");

  const vid = await visitId();
  await markArrived(vid, null, db);
  await recordHealthrayObservation(client, day);
  const s2 = await statusOf();
  check(
    "once the desk taps Arrived, the patient is checked in",
    s2.current_status === "checked_in",
  );
  check("and Reception is no longer behind", s2.behind_station === null, s2.behind_station);

  console.log("\n── 2–4 · Vitals, then Lab 1, then the machine ──────────────");
  const { rows: lab } = await client.query(
    `INSERT INTO giniflow_lab_orders
       (visit_id, urgency, payment_status, amount_total, amount_paid, sample_status, kind)
     VALUES ($1, 'today', 'paid', 400, 400, 'paid', 'lab') RETURNING id`,
    [vid],
  );
  const { rows: mach } = await client.query(
    `INSERT INTO giniflow_lab_orders
       (visit_id, urgency, payment_status, amount_total, amount_paid, sample_status, kind)
     VALUES ($1, 'today', 'paid', 400, 400, 'paid', 'machine') RETURNING id`,
    [vid],
  );
  await client.query(
    `INSERT INTO giniflow_lab_order_tests (lab_order_id, test_name, price)
     VALUES ($1, 'HbA1c', 400), ($2, 'ABI', 400)`,
    [lab[0].id, mach[0].id],
  );

  const noVitalsDraw = await refusal(() =>
    advanceSample(lab[0].id, { to: "sample_collected" }, db),
  );
  check("before vitals, Lab 1 cannot draw", noVitalsDraw?.status === 409, noVitalsDraw?.message);
  const noVitalsMachine = await refusal(() =>
    advanceMachineTest(mach[0].id, { to: "in_progress" }, db),
  );
  check("and the machine cannot start", noVitalsMachine?.status === 409, noVitalsMachine?.message);

  await client.query(
    `INSERT INTO giniflow_visit_events (visit_id, status, actor_role)
     VALUES ($1, 'vitals_done', 'vitals')`,
    [vid],
  );

  const stillBlood = await refusal(() => advanceMachineTest(mach[0].id, { to: "in_progress" }, db));
  check(
    "after vitals the machine STILL waits — blood is billed too",
    stillBlood?.status === 409 && /lab 1|blood/i.test(stillBlood.message),
    stillBlood?.message,
  );
  const drawn = await refusal(() => advanceSample(lab[0].id, { to: "sample_collected" }, db));
  check("Lab 1 draws the sample", drawn === null, drawn?.message);
  const started = await refusal(() => advanceMachineTest(mach[0].id, { to: "in_progress" }, db));
  check("and only then does the machine open", started === null, started?.message);

  console.log("\n── 5 · The patient waits for the reports ───────────────────");
  const { rows: before } = await client.query(
    `SELECT results_status FROM giniflow_visits WHERE id = $1`,
    [vid],
  );
  check("results are not ready while a test is open", before[0].results_status !== "ready");

  await client.query(
    `INSERT INTO lab_results (lab_order_id, patient_id, test_name, result, test_date)
     VALUES ($1, $2, 'ABI Right', 1.1, CURRENT_DATE)`,
    [mach[0].id, patientId],
  );
  await advanceMachineTest(mach[0].id, { to: "done" }, db);
  await advanceMachineTest(mach[0].id, { to: "reported" }, db);
  await advanceSample(lab[0].id, { to: "sample_sent" }, db);
  await advanceSample(lab[0].id, { to: "sample_received" }, db);
  await advanceSample(lab[0].id, { to: "processing" }, db);
  await advanceSample(lab[0].id, { to: "results_ready" }, db);
  await advanceSample(lab[0].id, { to: "uploaded" }, db);
  const { rows: after } = await client.query(
    `SELECT results_status FROM giniflow_visits WHERE id = $1`,
    [vid],
  );
  check(
    "once every report is in, results read ready",
    after[0].results_status === "ready",
    after[0].results_status,
  );

  console.log("\n── 6 · The consultant is the step HealthRay drives ─────────");
  await hrSays("in_visit");
  await syncAppointmentsToFlow({ date: day, db });
  const s3 = await statusOf();
  check(
    "the sync moves the patient to the consultant",
    ["ready_for_doctor", "with_doctor"].includes(s3.current_status),
    s3.current_status,
  );

  console.log("\n── 7–8 · Rx counter, then pharmacy — both by hand ──────────");
  await hrSays("completed");
  await syncAppointmentsToFlow({ date: day, db });
  const s4 = await statusOf();
  check(
    "a finished consultation stops at the Rx desk's queue",
    s4.current_status === "rx_pending",
    s4.current_status,
  );
  check("and never at the exit", s4.current_status !== "exited");
  for (let i = 0; i < 3; i++) await syncAppointmentsToFlow({ date: day, db });
  check(
    "no amount of polling walks them past it",
    (await statusOf()).current_status === "rx_pending",
  );

  console.log("\n── 9 · Stuck here when a station has not recorded its step ──");
  // A second patient: HealthRay has them with a doctor, and nobody at reception
  // or vitals recorded anything. This is the requirement in the floor's words —
  // "in healthray pt is with chief but in scribe pt is stucked in some station".
  const { rows: p2 } = await client.query(
    `INSERT INTO patients (name, file_no) VALUES ('Probe Stuck', $1) RETURNING id`,
    [`ZZFJ_STUCK_${Date.now()}`],
  );
  await client.query(
    `INSERT INTO appointments (patient_id, appointment_date, status, time_slot, doctor_name)
     VALUES ($1, $2::date, 'in_visit', '10:30', 'Dr. Anil Bhansali')`,
    [p2[0].id, day],
  );
  await syncAppointmentsToFlow({ date: day, db });
  await recordHealthrayObservation(client, day);
  const { rows: stuck } = await client.query(
    `SELECT current_status, behind_station, healthray_status FROM giniflow_visits
      WHERE patient_id = $1 AND visit_date = $2::date`,
    [p2[0].id, day],
  );
  check(
    "the desk that owes the step is named",
    stuck[0].behind_station === "reception",
    stuck[0].behind_station,
  );
  check("and HealthRay's own reading is recorded", stuck[0].healthray_status === "in_visit");
  check(
    "THE PATIENT IS HELD AT THE UN-RECORDED STEP",
    stuck[0].current_status === "booked",
    `${stuck[0].current_status} — HealthRay says in_visit`,
  );
} catch (e) {
  check("the journey ran to the end", false, `threw: ${e.message}`);
} finally {
  await client.query("ROLLBACK");
  client.release();
  const { rows: left } = await pool.query(
    `SELECT count(*)::int AS c FROM patients WHERE file_no LIKE 'ZZFJ_%'`,
  );
  check("the synthetic patients left no trace", left[0].c === 0, `${left[0].c} rows`);
  console.log(failures ? `\n${failures} FAILED` : "\nall checks passed");
  await pool.end();
  process.exit(failures ? 1 : 0);
}
