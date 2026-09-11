// The hybrid floor, steps 5 and 6: the order the patient walks the floor in
// (docs/gini-flow/39-HYBRID-FLOOR-PLAN.md §3).
//
//   vitals  →  Lab 1 draw  →  Machine Room
//
// Two rules, both enforced in the SERVICE and not only by hiding a button — a
// stale tab is exactly the case hiding does not cover:
//
//   G1  Neither bench starts before vitals are recorded. Samples-only
//       registrations are exempt; they never take vitals.
//   G2  A patient billed for blood as well as a machine is drawn first.
//
// Both apply to the START of the work only. A test already on the machine, or a
// tube already drawn, must never become unfinishable because of a box nobody
// ticked upstream.
//
// Runs on a date of its own inside a transaction that is always rolled back.
//
//   npm run smoke:routing-gates   (from server/)
import "../loadEnv.js";
import pool from "../config/db.js";
import { getMachineQueue, advanceMachineTest } from "../services/giniflow/machineStation.js";
import { advanceSample } from "../services/giniflow/labStation.js";
import { UNDRAWN_SAMPLE_STATUSES } from "../../shared/labStages.js";

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

console.log("── The shared vocabulary ───────────────────────────────────");
check(
  "one definition of a tube still in the patient",
  UNDRAWN_SAMPLE_STATUSES.join(",") === "ordered,payment_pending,paid",
  UNDRAWN_SAMPLE_STATUSES.join(" "),
);

try {
  await client.query("BEGIN");
  const { rows: d } = await client.query(
    `SELECT ((NOW() AT TIME ZONE 'Asia/Kolkata')::date + 122)::text AS day`,
  );
  const day = d[0].day;

  // P2 — one patient per machine — is a real rule, so every case below gets a
  // machine of its own or they block each other rather than the thing under test.
  for (const name of ["ABI", "VPT", "Fundus", "TMT"]) {
    await client.query(
      `INSERT INTO giniflow_test_catalog (test_name, category, price, is_active)
       VALUES ($1, 'machine', 400, TRUE)
       ON CONFLICT (test_name) DO UPDATE
         SET category = 'machine', price = 400, is_active = TRUE`,
      [name],
    );
  }

  const make = async (tag, { doctor = "Dr. Anil Bhansali", status = "vitals_done" } = {}) => {
    const { rows: p } = await client.query(
      `INSERT INTO patients (name, file_no) VALUES ($1, $2) RETURNING id`,
      [`Probe ${tag}`, `ZZRG_${tag}_${Date.now()}`],
    );
    await client.query(
      `INSERT INTO appointments (patient_id, appointment_date, status, time_slot, doctor_name)
       VALUES ($1, $2::date, 'checkedin', '10:00', $3)`,
      [p[0].id, day, doctor],
    );
    const { rows: v } = await client.query(
      `INSERT INTO giniflow_visits (patient_id, visit_date, current_status, results_status)
       VALUES ($1, $2::date, $3, 'none') RETURNING id`,
      [p[0].id, day, status],
    );
    return { patientId: p[0].id, visitId: v[0].id };
  };

  const order = async (visitId, kind, sampleStatus = "paid", testName = null) => {
    const { rows } = await client.query(
      `INSERT INTO giniflow_lab_orders
         (visit_id, urgency, payment_status, amount_total, amount_paid, sample_status, kind)
       VALUES ($1, 'today', 'paid', 400, 400, $2, $3) RETURNING id`,
      [visitId, sampleStatus, kind],
    );
    await client.query(
      `INSERT INTO giniflow_lab_order_tests (lab_order_id, test_name, price)
       VALUES ($1, $2, 400)`,
      [rows[0].id, testName || (kind === "machine" ? "ABI" : "HbA1c")],
    );
    return rows[0].id;
  };

  const recordVitals = (visitId) =>
    client.query(
      `INSERT INTO giniflow_visit_events (visit_id, status, actor_role)
       VALUES ($1, 'vitals_done', 'vitals')`,
      [visitId],
    );

  const machineCard = async (visitId) => {
    const q = await getMachineQueue(day, null, db);
    return [...q.ordered, ...q.in_progress].find((o) => o.visitId === visitId) || null;
  };

  console.log("\n── G1 · the machine will not start before vitals ───────────");
  const noVitals = await make("NOVITALS");
  const mOrder = await order(noVitals.visitId, "machine");
  const card1 = await machineCard(noVitals.visitId);
  check("the card offers no Start button", card1?.nextAction === null, card1?.blockedReason);
  check("and says why, in the floor's words", /vitals/i.test(card1?.blockedReason || ""));
  const r1 = await refusal(() => advanceMachineTest(mOrder, { to: "in_progress" }, db));
  check(
    "the service refuses it too — a stale tab is not a loophole",
    r1?.status === 409,
    r1?.message,
  );

  console.log("\n── G1 · once vitals are recorded, it starts ────────────────");
  await recordVitals(noVitals.visitId);
  const card2 = await machineCard(noVitals.visitId);
  check("the Start button appears", card2?.nextAction?.to === "in_progress", card2?.blockedReason);
  const ok1 = await refusal(() => advanceMachineTest(mOrder, { to: "in_progress" }, db));
  check("and the service accepts it", ok1 === null, ok1?.message);

  console.log("\n── G1 · a running test never becomes unfinishable ──────────");
  // Vitals are deliberately NOT recorded for this one, and the test is already
  // on the machine. The gate must not trap it there.
  const midTest = await make("MIDTEST");
  const midOrder = await order(midTest.visitId, "machine", "in_progress", "VPT");
  const r2 = await refusal(() => advanceMachineTest(midOrder, { to: "done" }, db));
  check(
    "vitals are not what stops it — the evidence gate is",
    r2 !== null &&
      !/vitals/i.test(r2.message) &&
      /type the values|attach the report/i.test(r2.message),
    r2?.message,
  );
  // With a value typed in, the test finishes — proving the upstream gate never
  // reaches a test already on the machine.
  await client.query(
    `INSERT INTO lab_results (lab_order_id, patient_id, test_name, result, test_date)
     VALUES ($1, $2, 'VPT Right', 12, CURRENT_DATE)`,
    [midOrder, midTest.patientId],
  );
  const ok0 = await refusal(() => advanceMachineTest(midOrder, { to: "done" }, db));
  check("and it finishes with no vitals ever recorded", ok0 === null, ok0?.message);

  console.log("\n── G1 · the lab draw waits for vitals too ──────────────────");
  const labNoVitals = await make("LABNOVIT");
  const lOrder = await order(labNoVitals.visitId, "lab");
  const r3 = await refusal(() => advanceSample(lOrder, { to: "sample_collected" }, db));
  check("the draw is refused", r3?.status === 409, r3?.message);
  await recordVitals(labNoVitals.visitId);
  const ok2 = await refusal(() => advanceSample(lOrder, { to: "sample_collected" }, db));
  check("and allowed once vitals are in", ok2 === null, ok2?.message);

  console.log("\n── G1 · samples-only patients are exempt ───────────────────");
  // They never take vitals and never see a doctor, so requiring the step would
  // strand every one of them — 7 of 15 walk-ins on the day this was written.
  const labOnly = await make("LABONLY", { doctor: "Dr. Hospital Admin", status: "checked_in" });
  const loOrder = await order(labOnly.visitId, "lab");
  const ok3 = await refusal(() => advanceSample(loOrder, { to: "sample_collected" }, db));
  check("a samples-only draw goes ahead with no vitals", ok3 === null, ok3?.message);

  console.log("\n── G2 · blood before the machine ───────────────────────────");
  const both = await make("BOTH");
  await recordVitals(both.visitId);
  const bothLab = await order(both.visitId, "lab");
  const bothMachine = await order(both.visitId, "machine", "paid", "Fundus");
  const card3 = await machineCard(both.visitId);
  check("the machine card is blocked", card3?.nextAction === null, card3?.blockedReason);
  check(
    "and names Lab 1, not vitals",
    /lab 1|blood/i.test(card3?.blockedReason || ""),
    card3?.blockedReason,
  );
  check(
    "the card is still VISIBLE — the technician sees who is coming",
    !!card3,
    "blocked, not hidden",
  );
  const r4 = await refusal(() => advanceMachineTest(bothMachine, { to: "in_progress" }, db));
  check("the service refuses the start", r4?.status === 409, r4?.message);

  console.log("\n── G2 · once the tube is drawn, the machine opens ──────────");
  await advanceSample(bothLab, { to: "sample_collected" }, db);
  const card4 = await machineCard(both.visitId);
  check("the Start button appears", card4?.nextAction?.to === "in_progress", card4?.blockedReason);
  const ok4 = await refusal(() => advanceMachineTest(bothMachine, { to: "in_progress" }, db));
  check("and the service accepts it", ok4 === null, ok4?.message);

  console.log("\n── G2 · a machine-only patient is never gated on blood ─────");
  const machineOnly = await make("MACHONLY");
  await recordVitals(machineOnly.visitId);
  const moOrder = await order(machineOnly.visitId, "machine", "paid", "TMT");
  const card5 = await machineCard(machineOnly.visitId);
  check(
    "no lab order, no wait",
    card5?.nextAction?.to === "in_progress",
    card5?.blockedReason || "offered",
  );
  const ok5 = await refusal(() => advanceMachineTest(moOrder, { to: "in_progress" }, db));
  check("and it starts", ok5 === null, ok5?.message);
} catch (e) {
  check("the suite ran to the end", false, `threw: ${e.message}`);
} finally {
  await client.query("ROLLBACK");
  client.release();
  const { rows: left } = await pool.query(
    `SELECT count(*)::int AS c FROM patients WHERE file_no LIKE 'ZZRG_%'`,
  );
  check("the synthetic patients left no trace", left[0].c === 0, `${left[0].c} rows`);
  console.log(failures ? `\n${failures} FAILED` : "\nall checks passed");
  await pool.end();
  process.exit(failures ? 1 : 0);
}
