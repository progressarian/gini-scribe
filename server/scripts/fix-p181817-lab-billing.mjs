import "../loadEnv.js";
import pool from "../config/db.js";

const FILE_NO = "P_181817";
const DAY = "2026-09-19";
const apply = process.argv.includes("--apply");

const { rows: visits } = await pool.query(
  `SELECT v.id, v.current_status, p.name, p.id AS patient_id
     FROM giniflow_visits v JOIN patients p ON p.id = v.patient_id
    WHERE p.file_no = $1 AND v.visit_date = $2::date AND v.merged_into_visit_id IS NULL`,
  [FILE_NO, DAY],
);
if (visits.length !== 1) {
  console.error(`Expected one visit for ${FILE_NO} on ${DAY}, found ${visits.length}`);
  process.exit(1);
}
const visit = visits[0];

const { rows: labOrders } = await pool.query(
  `SELECT id, payment_status FROM giniflow_lab_orders
    WHERE visit_id = $1 AND urgency = 'today' AND kind = 'lab'`,
  [visit.id],
);
const { rows: machinePaid } = await pool.query(
  `SELECT min(e.occurred_at) AS at FROM giniflow_lab_order_events e
     JOIN giniflow_test_cancellations c ON c.order_id = e.lab_order_id
    WHERE c.visit_id = $1 AND e.track = 'payment' AND e.status = 'paid'`,
  [visit.id],
);
const { rows: step } = await pool.query(
  `SELECT id, status, completed_at FROM giniflow_visit_steps
    WHERE visit_id = $1 AND step_catalog_id = 'lab_billing'`,
  [visit.id],
);
const { rows: benchActions } = await pool.query(
  `SELECT a.case_no, a.action, a.created_at FROM giniflow_lab_case_actions a
    WHERE a.case_no IN (SELECT lc.case_no FROM lab_cases lc
                         WHERE lc.case_date = $2::date
                           AND (lc.patient_id = $1
                                OR lc.raw_list_json->'patient'->>'healthray_uid' = $3))
    ORDER BY a.created_at`,
  [visit.patient_id, DAY, FILE_NO],
);

console.log(`${visit.name} (${FILE_NO}) · ${DAY} · ${visit.current_status}`);
console.log(
  `Lab Billing step: ${step[0]?.status ?? "none"} (done at ${step[0]?.completed_at ?? "—"})`,
);
console.log(`Scribe lab orders: ${labOrders.length}`);
console.log(`Machine payment recorded at: ${machinePaid[0]?.at ?? "—"}`);
console.log(
  `Lab bench actions on her case: ${benchActions.map((a) => a.action).join(", ") || "none"}`,
);

if (step[0]?.status !== "done") {
  console.log("Nothing to fix — Lab Billing is not marked done.");
  await pool.end();
  process.exit(0);
}
if (labOrders.length) {
  console.error("Not changing anything: she has a Scribe lab order — look at it by hand.");
  await pool.end();
  process.exit(1);
}
if (benchActions.some((a) => a.action !== "cancelled")) {
  console.error(
    "Not changing anything: the lab bench has already worked her case — reopening payment now would not undo that.",
  );
  await pool.end();
  process.exit(1);
}

console.log(
  "Will set Lab Billing back to pending: it was ticked by her machine-test payment, not by a lab payment.",
);
if (!apply) {
  console.log("Dry run — re-run with --apply.");
  await pool.end();
  process.exit(0);
}

const client = await pool.connect();
try {
  await client.query("BEGIN");
  const { rowCount } = await client.query(
    `UPDATE giniflow_visit_steps SET status = 'pending', started_at = NULL, completed_at = NULL
      WHERE id = $1 AND status = 'done'`,
    [step[0].id],
  );
  if (rowCount !== 1) throw new Error("The step changed while the script ran");
  await client.query("COMMIT");
  console.log(
    "Done — Lab Billing is pending; reception clears it once she pays for her lab tests.",
  );
} catch (e) {
  await client.query("ROLLBACK");
  console.error("Rolled back:", e.message);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
