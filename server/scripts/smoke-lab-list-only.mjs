// The lab's one exception: HealthRay says WHO, the bench says WHAT HAPPENED
// (docs/gini-flow/39-HYBRID-FLOOR-PLAN.md §15).
//
// The Chief and the consultants order lab tests in HealthRay, not in Scribe, so
// the case LIST syncs — otherwise those ~40 tests a day reach no bench at all.
// Three things must hold:
//
//   L1  The list arrives: a HealthRay case puts the patient on the lab screen.
//   L2  No step comes with it. HealthRay's own clocks are ignored, so the ladder
//       only moves when the bench taps it — and the bench is never refused on
//       the strength of a clock nobody here set.
//   L3  NO DOUBLE ROWS. Once the same patient's tests are raised in Scribe, the
//       hospital's case for them drops off the list; one tube, one card.
//
// Runs on a date of its own inside a transaction that is always rolled back.
//
//   npm run smoke:lab-list-only   (from server/)
import "../loadEnv.js";
import pool from "../config/db.js";
import { getLabQueue, advanceSample } from "../services/giniflow/labStation.js";

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

console.log("── The switches ────────────────────────────────────────────");
const { labCaseListOnly, labStepsAreManual, manualFloor } =
  await import("../../shared/manualFloor.js");
check("the manual floor is on", manualFloor());
check("the case list syncs", labCaseListOnly(), "HealthRay says who needs a test");
check("and every lab step is the bench's own", labStepsAreManual());

console.log("\n── The sync fetches the list and stops there ───────────────");
const labSyncSrc = await (
  await import("fs/promises")
).readFile(new URL("../services/cron/labSync.js", import.meta.url), "utf8");
check(
  "list-only returns before the detail fetch",
  /if \(listOnly\) return \{ listed: true, written: 0 \};/.test(labSyncSrc),
);
const beforeDetail = labSyncSrc.indexOf("if (listOnly) return");
check(
  "so no results are parsed and no PDF is rendered",
  beforeDetail > 0 &&
    beforeDetail < labSyncSrc.indexOf("parseLabCaseResults(detail)") &&
    beforeDetail < labSyncSrc.indexOf("downloadAndStoreLabPdf(") &&
    beforeDetail < labSyncSrc.indexOf("fetchLabCaseDetail(caseUid"),
  "the two heaviest calls per case, and the WAF's favourite",
);

try {
  await client.query("BEGIN");
  const { rows: d } = await client.query(
    `SELECT ((NOW() AT TIME ZONE 'Asia/Kolkata')::date + 124)::text AS day`,
  );
  const day = d[0].day;

  // A patient the hospital raised a lab case for, exactly as the list-only sync
  // writes it: an anchor row with the list payload, no detail, no results.
  // `phlebotomy_status: Completed` is deliberate — it is the field that would
  // silently lift the tube to "collected" if the clocks were still read.
  const { rows: p } = await client.query(
    `INSERT INTO patients (name, file_no) VALUES ('Probe LabList', $1) RETURNING id`,
    [`ZZLL_${Date.now()}`],
  );
  const patientId = p[0].id;
  const caseNo = `ZZLLCASE_${Date.now()}`;
  await client.query(
    `INSERT INTO lab_cases
       (case_no, patient_case_no, case_uid, lab_case_id, case_date, test_names,
        case_status, results_synced, patient_id, raw_list_json)
     VALUES ($1, $2, $1, $6, $3::date, ARRAY['HbA1c'], 'In Process', FALSE, $4, $5::jsonb)`,
    [
      caseNo,
      caseNo,
      day,
      patientId,
      JSON.stringify({
        patient: { patient_name: "Probe LabList", healthray_uid: "ZZLL" },
        phlebotomy_status: "Completed",
      }),
      Math.floor(Math.random() * 1e9),
    ],
  );

  console.log("\n── L1 · the patient reaches the bench ──────────────────────");
  const q1 = await getLabQueue(day, null, db);
  const mine = q1.healthray.find((h) => h.name === "Probe LabList");
  check("a HealthRay case puts them on the lab screen", !!mine, `${q1.healthray.length} cases`);
  check("with the test named", (mine?.caseList || []).length >= 1 || mine?.cases >= 1);

  console.log("\n── L2 · no step comes with the list ────────────────────────");
  check(
    "the tube reads NOT drawn, despite HealthRay saying phlebotomy is complete",
    mine?.stage?.key === "pending",
    `${mine?.stage?.key} — ${mine?.stage?.label}`,
  );
  check(
    "so the bench is offered the draw",
    mine?.caseList?.[0]?.nextAction?.action === "sample_taken",
    mine?.caseList?.[0]?.nextAction?.label || "no action offered",
  );
  check(
    "and the tube is not marked collected",
    mine?.caseList?.[0]?.collected === false,
    `collected=${mine?.caseList?.[0]?.collected}`,
  );

  console.log("\n── L3 · no double rows ─────────────────────────────────────");
  const { rows: v } = await client.query(
    `INSERT INTO giniflow_visits (patient_id, visit_date, current_status, results_status)
     VALUES ($1, $2::date, 'vitals_done', 'none') RETURNING id`,
    [patientId, day],
  );
  const { rows: o } = await client.query(
    `INSERT INTO giniflow_lab_orders
       (visit_id, urgency, payment_status, amount_total, amount_paid, sample_status, kind)
     VALUES ($1, 'today', 'paid', 250, 250, 'paid', 'lab') RETURNING id`,
    [v[0].id],
  );
  await client.query(
    `INSERT INTO giniflow_lab_order_tests (lab_order_id, test_name, price)
     VALUES ($1, 'HbA1c', 250)`,
    [o[0].id],
  );

  const q2 = await getLabQueue(day, null, db);
  const stillListed = q2.healthray.filter((h) => h.name === "Probe LabList");
  check(
    "the hospital's case drops off once Scribe has the order",
    stillListed.length === 0,
    `${stillListed.length} HealthRay rows left`,
  );
  const asOrder = q2.unified.filter((u) => u.patientId === patientId);
  check("and the patient appears exactly once", asOrder.length === 1, `${asOrder.length} rows`);
  check(
    "as the Scribe order the bench works",
    asOrder[0]?.source !== "healthray",
    asOrder[0]?.source,
  );

  console.log("\n── L2 again · the bench is never refused by a clock ────────");
  // A case with HealthRay's own timestamps all over it. Before this change the
  // ladder read those, and the floor's tap was refused with "the lab has already
  // taken this case past collection".
  const stampedNo = `ZZLLSTAMP_${Date.now()}`;
  await client.query(
    `INSERT INTO lab_cases
       (case_no, patient_case_no, case_uid, lab_case_id, case_date, test_names,
        case_status, results_synced, patient_id, raw_list_json, raw_detail_json)
     VALUES ($1, $2, $1, $7, $3::date, ARRAY['TSH'], 'In Process', FALSE, $4, $5::jsonb, $6::jsonb)`,
    [
      stampedNo,
      stampedNo,
      day,
      patientId,
      JSON.stringify({ patient: { patient_name: "Probe LabList", healthray_uid: "ZZLL" } }),
      JSON.stringify({ collected_on: "2026-09-11 09:00:00", received_on: "2026-09-11 09:30:00" }),
      Math.floor(Math.random() * 1e9),
    ],
  );
  const { markLabCaseAction } = await import("../services/giniflow/labStation.js");
  const tapped = await refusal(() =>
    markLabCaseAction(stampedNo, { action: "sample_taken", actorId: null }, db),
  );
  check(
    "the bench may record the draw even on a case HealthRay has clocked",
    tapped === null,
    tapped?.message,
  );
} catch (e) {
  check("the suite ran to the end", false, `threw: ${e.message}`);
} finally {
  await client.query("ROLLBACK");
  client.release();
  const { rows: left } = await pool.query(
    `SELECT count(*)::int AS c FROM patients WHERE file_no LIKE 'ZZLL_%'`,
  );
  check("the synthetic patients left no trace", left[0].c === 0, `${left[0].c} rows`);
  console.log(failures ? `\n${failures} FAILED` : "\nall checks passed");
  await pool.end();
  process.exit(failures ? 1 : 0);
}
