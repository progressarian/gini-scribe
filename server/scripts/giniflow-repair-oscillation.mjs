// One-off: repair visits whose event log oscillated.
//
// Before the sync collapsed multiple same-day appointments to one row per
// patient, a patient holding two appointments with different statuses had an
// event written for each on every run — the log flip-flopped
// checked_in → cancelled → checked_in indefinitely. Those events are noise, not
// history: they record a sync bug, not anything that happened to the patient.
//
// Keeps the first occurrence of each status and drops the later repeats, then
// re-derives current_status from what survives.
//
//   node scripts/giniflow-repair-oscillation.mjs          # report only
//   node scripts/giniflow-repair-oscillation.mjs --delete
import "../loadEnv.js";
import pool from "../config/db.js";

const doDelete = process.argv.includes("--delete");

const { rows: suspects } = await pool.query(
  `SELECT v.id, p.name, count(*)::int AS events, count(DISTINCT e.status)::int AS distinct_statuses
     FROM giniflow_visits v
     JOIN patients p ON p.id = v.patient_id
     JOIN giniflow_visit_events e ON e.visit_id = v.id
    WHERE v.visit_date = (NOW() AT TIME ZONE 'Asia/Kolkata')::date
    GROUP BY v.id, p.name
   HAVING count(*) > count(DISTINCT e.status)
    ORDER BY count(*) DESC`,
);

console.log(`visits with repeated statuses: ${suspects.length}`);
suspects.forEach((s) =>
  console.log(`   ${s.name}: ${s.events} events across ${s.distinct_statuses} distinct statuses`),
);

if (!doDelete) {
  console.log("\nreport only — re-run with --delete to collapse the repeats");
} else {
  const { rowCount } = await pool.query(
    `DELETE FROM giniflow_visit_events e
      USING (
        SELECT id, row_number() OVER (PARTITION BY visit_id, status ORDER BY occurred_at, id) AS rn
          FROM giniflow_visit_events
         WHERE visit_id IN (SELECT id FROM giniflow_visits
                             WHERE visit_date = (NOW() AT TIME ZONE 'Asia/Kolkata')::date)
      ) dup
      WHERE e.id = dup.id AND dup.rn > 1`,
  );
  const { rowCount: fixed } = await pool.query(
    `UPDATE giniflow_visits v
        SET current_status = (
              SELECT status FROM giniflow_visit_events e
               WHERE e.visit_id = v.id ORDER BY occurred_at DESC, id DESC LIMIT 1
            )
      WHERE v.visit_date = (NOW() AT TIME ZONE 'Asia/Kolkata')::date
        AND EXISTS (SELECT 1 FROM giniflow_visit_events e WHERE e.visit_id = v.id)`,
  );
  console.log(`removed ${rowCount} repeated events; re-derived status on ${fixed} visits`);
}

await pool.end();
