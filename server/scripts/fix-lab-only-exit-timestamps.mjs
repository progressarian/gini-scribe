import "../loadEnv.js";
import pool from "../config/db.js";

// One-off correction. The first run of sweepLabOnlyExits stamped its exit events
// at sweep time instead of at the patient's last report, so three visits closed
// on 5 Sep 2026 carry an exit ~3 hours after the patient actually finished.
// Every later run, and the backfill, set occurred_at correctly.
//
// Scoped to events this sweep wrote (meta.reason = 'lab_only_reports_complete')
// whose timestamp disagrees with the report they were derived from. Dry run by
// default; pass --apply to write.

const apply = process.argv.includes("--apply");

const ist = (t) =>
  t ? new Date(t).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", hour12: false }) : "—";

const SELECT_DRIFTED = `
  SELECT e.id, e.occurred_at, p.file_no, p.name, v.visit_date::text AS visit_date,
         lab.last_report,
         round(extract(epoch from (e.occurred_at - lab.last_report)) / 60)::int AS drift_minutes
    FROM giniflow_visit_events e
    JOIN giniflow_visits v ON v.id = e.visit_id
    JOIN patients p ON p.id = v.patient_id
    JOIN LATERAL (
      SELECT max((COALESCE(lc.raw_detail_json, lc.raw_list_json)->>'reported_on')::timestamptz)
               AS last_report
        FROM lab_cases lc
       WHERE lc.case_date = v.visit_date
         AND (lc.patient_id = v.patient_id
              OR (lc.patient_id IS NULL
                  AND lc.raw_list_json->'patient'->>'healthray_uid' = p.file_no))
    ) lab ON TRUE
   WHERE e.status = 'exited'
     AND e.meta->>'reason' = 'lab_only_reports_complete'
     AND lab.last_report IS NOT NULL
     AND e.occurred_at > lab.last_report + interval '1 minute'
   ORDER BY v.visit_date, p.name`;

const drifted = (await pool.query(SELECT_DRIFTED)).rows;

console.log("Exit events stamped later than the report they were derived from:\n");
for (const r of drifted)
  console.log(
    `  ${r.visit_date}  ${(r.file_no || "").padEnd(11)} ${String(r.name).slice(0, 24).padEnd(25)} ` +
      `exit ${ist(r.occurred_at)}  ->  ${ist(r.last_report)}   (${r.drift_minutes}m too late)`,
  );
console.log(`\n  total: ${drifted.length}`);

if (!apply) {
  console.log("\nDry run. Re-run with --apply to correct them.");
  await pool.end();
  process.exit(0);
}

const client = await pool.connect();
let fixed = 0;
try {
  await client.query("BEGIN");
  for (const r of drifted) {
    const res = await client.query(
      `UPDATE giniflow_visit_events
          SET occurred_at = $2,
              meta = meta || jsonb_build_object(
                'occurred_at_corrected', TRUE,
                'occurred_at_was', $3::text
              )
        WHERE id = $1`,
      [r.id, r.last_report, new Date(r.occurred_at).toISOString()],
    );
    fixed += res.rowCount;
  }
  await client.query("COMMIT");
} catch (e) {
  await client.query("ROLLBACK").catch(() => {});
  throw e;
} finally {
  client.release();
}

console.log(`\nCorrected ${fixed} event(s).`);
console.log("Remaining drifted:", (await pool.query(SELECT_DRIFTED)).rows.length);
await pool.end();
