import "../loadEnv.js";
import pool from "../config/db.js";
import {
  sweepLabOnlyExits,
  LAB_ONLY_EXIT_GRACE_MINUTES,
} from "../services/giniflow/appointmentSync.js";
import { labOnlyPredicate, LAB_ONLY_DOCTOR } from "../services/giniflow/labOnlyVisits.js";

// One-off: close the lab-only visits that were created before the sweep existed.
//
// HealthRay never marks a samples-only registration complete, so every one of
// these has sat open since the day it was made. The sweep added to
// appointmentSync handles new ones; this walks the days already on record.
//
// Dry run by default. Pass --apply to write.

const apply = process.argv.includes("--apply");
const since = process.argv.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a)) || "2026-08-31";

const ist = (t) =>
  t ? new Date(t).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", hour12: false }) : "—";

const days = (
  await pool.query(
    `SELECT DISTINCT visit_date::text AS d FROM giniflow_visits
      WHERE visit_date >= $1::date ORDER BY 1`,
    [since],
  )
).rows.map((r) => r.d);

const preview = (
  await pool.query(
    `SELECT v.visit_date::text AS day, p.file_no, p.name, v.current_status,
            lab.cases, lab.pending,
            lab.last_report,
            round(extract(epoch from (NOW() - lab.last_report)) / 60)::int AS minutes_since_report
       FROM giniflow_visits v
       JOIN patients p ON p.id = v.patient_id
       JOIN LATERAL (
         SELECT count(*)::int AS cases,
                count(*) FILTER (
                  WHERE COALESCE(lc.raw_detail_json, lc.raw_list_json)->>'reported_on' IS NULL
                )::int AS pending,
                max((COALESCE(lc.raw_detail_json, lc.raw_list_json)->>'reported_on')::timestamptz)
                  AS last_report
           FROM lab_cases lc
          WHERE lc.case_date = v.visit_date
            AND (lc.patient_id = v.patient_id
                 OR (lc.patient_id IS NULL
                     AND lc.raw_list_json->'patient'->>'healthray_uid' = p.file_no))
       ) lab ON TRUE
      WHERE v.visit_date >= $1::date
        AND v.current_status NOT IN ('exited', 'dispensed', 'no_show', 'cancelled', 'blocked_reports')
        AND lab.cases > 0
        AND lab.pending = 0
        AND lab.last_report < NOW() - ($2 || ' minutes')::interval
        AND ${labOnlyPredicate("v", "$3")}
      ORDER BY v.visit_date, p.name`,
    [since, LAB_ONLY_EXIT_GRACE_MINUTES, LAB_ONLY_DOCTOR],
  )
).rows;

console.log(
  `Lab-only visits eligible to close (from ${since}, grace ${LAB_ONLY_EXIT_GRACE_MINUTES}m):\n`,
);
for (const r of preview)
  console.log(
    `  ${r.day}  ${(r.file_no || "").padEnd(11)} ${String(r.name).slice(0, 24).padEnd(25)} ` +
      `${r.current_status.padEnd(14)} ${r.cases} case(s), last report ${ist(r.last_report)} (${r.minutes_since_report}m ago)`,
  );
console.log(`\n  total: ${preview.length}`);

if (!apply) {
  console.log("\nDry run. Re-run with --apply to write the exit events.");
  await pool.end();
  process.exit(0);
}

const client = await pool.connect();
let total = 0;
try {
  for (const day of days) {
    const n = await sweepLabOnlyExits(client, day);
    if (n) console.log(`  ${day}: closed ${n}`);
    total += n;
  }
} finally {
  client.release();
}
console.log(`\nClosed ${total} lab-only visit(s).`);
await pool.end();
