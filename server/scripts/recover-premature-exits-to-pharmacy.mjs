import "../loadEnv.js";
import pool from "../config/db.js";

const APPLY = process.argv.includes("--apply");
const DAY = process.argv.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a)) || null;

const CANDIDATES_SQL = `
  SELECT v.id AS visit_id, v.patient_id, p.name, p.file_no, v.visit_date::text AS visit_date,
         jsonb_array_length(COALESCE(a.healthray_medications, '[]'::jsonb)) AS hr_meds,
         exited.occurred_at AS exited_at,
         (SELECT count(*)::int FROM medicine_collections c
            JOIN medications m ON m.id = c.medication_id
           WHERE m.patient_id = v.patient_id AND c.collected_date = v.visit_date) AS collected
    FROM giniflow_visits v
    JOIN patients p ON p.id = v.patient_id
    JOIN appointments a ON a.id = v.appointment_id
    JOIN LATERAL (
      SELECT occurred_at, meta FROM giniflow_visit_events e
       WHERE e.visit_id = v.id AND e.status = 'exited'
       ORDER BY e.occurred_at DESC LIMIT 1
    ) exited ON TRUE
   WHERE v.visit_date = COALESCE($1::date, (NOW() AT TIME ZONE 'Asia/Kolkata')::date)
     AND v.current_status = 'exited'
     AND exited.meta->>'source' = 'healthray'
     AND jsonb_array_length(COALESCE(a.healthray_medications, '[]'::jsonb)) > 0
     AND NOT EXISTS (
       SELECT 1 FROM giniflow_visit_events e2
        WHERE e2.visit_id = v.id AND e2.status IN ('pharmacy_pending', 'dispensed')
     )
     AND NOT EXISTS (
       SELECT 1 FROM medicine_collections c
         JOIN medications m ON m.id = c.medication_id
        WHERE m.patient_id = v.patient_id AND c.collected_date = v.visit_date
     )
   ORDER BY exited.occurred_at`;

const { rows: candidates } = await pool.query(CANDIDATES_SQL, [DAY]);

console.log(`${APPLY ? "APPLY" : "DRY RUN"} — ${candidates.length} premature exit(s)\n`);
console.table(
  candidates.map((c) => ({
    name: c.name.slice(0, 24),
    file_no: c.file_no,
    day: c.visit_date,
    hr_meds: c.hr_meds,
    collected: c.collected,
    exited_at: new Date(c.exited_at).toLocaleTimeString("en-IN", {
      timeZone: "Asia/Kolkata",
      hour12: false,
    }),
  })),
);

if (!candidates.length) {
  console.log("Nothing to recover.");
  await pool.end();
  process.exit(0);
}

console.log(
  "\nThis writes pharmacy_pending AFTER an exited event, which advanceStatus refuses as a\n" +
    "backwards move. It is written directly and flagged as a correction, because the exit was\n" +
    "recorded on evidence that was wrong: the prescription had not been extracted yet.",
);

if (!APPLY) {
  console.log("\nNothing written. Re-run with --apply.");
  await pool.end();
  process.exit(0);
}

let moved = 0;
let failed = 0;

for (const c of candidates) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rowCount } = await client.query(
      `UPDATE giniflow_visits
          SET current_status = 'pharmacy_pending', queue_position = NULL, updated_at = NOW()
        WHERE id = $1 AND current_status = 'exited'`,
      [c.visit_id],
    );
    if (!rowCount) throw new Error("visit is no longer exited");

    await client.query(
      `INSERT INTO giniflow_visit_events (visit_id, status, actor_role, meta)
       VALUES ($1, 'pharmacy_pending', 'system', $2::jsonb)`,
      [
        c.visit_id,
        JSON.stringify({
          source: "recover-premature-exits-to-pharmacy",
          correction: true,
          corrected_from: "exited",
          reason: "exited before the prescription was extracted; medicines never collected",
          healthray_medication_count: c.hr_meds,
          original_exit_at: c.exited_at,
        }),
      ],
    );

    await client.query("COMMIT");
    moved += 1;
  } catch (e) {
    await client.query("ROLLBACK");
    failed += 1;
    console.error(`  ${c.name}: ${e.message}`);
  } finally {
    client.release();
  }
}

console.log(`\nmoved ${moved} to pharmacy, failed ${failed}`);
await pool.end();
