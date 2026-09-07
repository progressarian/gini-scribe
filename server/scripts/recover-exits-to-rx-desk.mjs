import "../loadEnv.js";
import pool from "../config/db.js";
import { LAB_ONLY_DOCTOR, labOnlyPredicate } from "../services/giniflow/labOnlyVisits.js";

const APPLY = process.argv.includes("--apply");
const DAY = process.argv.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a)) || null;

const CANDIDATES_SQL = `
  SELECT v.id AS visit_id, v.patient_id, p.name, p.file_no, v.visit_date::text AS visit_date,
         exited.occurred_at AS exited_at,
         exited.meta->>'reason' AS exit_reason,
         (SELECT count(*)::int FROM medications m
           WHERE m.patient_id = v.patient_id AND m.is_active) AS active_meds
    FROM giniflow_visits v
    JOIN patients p ON p.id = v.patient_id
    JOIN LATERAL (
      SELECT occurred_at, meta FROM giniflow_visit_events e
       WHERE e.visit_id = v.id AND e.status = 'exited'
       ORDER BY e.occurred_at DESC LIMIT 1
    ) exited ON TRUE
   WHERE v.visit_date = COALESCE($1::date, (NOW() AT TIME ZONE 'Asia/Kolkata')::date)
     AND v.current_status = 'exited'
     AND exited.meta->>'source' = 'healthray'
     AND NOT COALESCE(p.is_blocked, FALSE)
     AND NOT ${labOnlyPredicate("v", "$2")}
     AND v.patient_id IN (
       SELECT m.patient_id FROM medications m
        WHERE (m.created_at AT TIME ZONE 'Asia/Kolkata')::date = v.visit_date
          AND m.is_active
          AND NOT EXISTS (
            SELECT 1 FROM medicine_collections c
             WHERE c.medication_id = m.id AND c.collected_date = v.visit_date
          )
       UNION
       SELECT a.patient_id FROM appointments a
        WHERE a.appointment_date = v.visit_date
          AND a.patient_id IS NOT NULL
          AND jsonb_array_length(COALESCE(a.healthray_medications, '[]'::jsonb)) > 0
          AND NOT EXISTS (
            SELECT 1 FROM medicine_collections c
              JOIN medications m2 ON m2.id = c.medication_id
             WHERE m2.patient_id = a.patient_id AND c.collected_date = v.visit_date
          )
     )
     AND NOT EXISTS (
       SELECT 1 FROM giniflow_visit_events e2
        WHERE e2.visit_id = v.id AND e2.status IN ('rx_pending', 'with_rx', 'dispensed')
     )
   ORDER BY exited.occurred_at`;

const { rows: candidates } = await pool.query(CANDIDATES_SQL, [DAY, LAB_ONLY_DOCTOR]);

console.log(
  `${APPLY ? "APPLY" : "DRY RUN"} — ${candidates.length} patient(s) to put back on the desk\n`,
);
console.table(
  candidates.map((c) => ({
    name: c.name.slice(0, 24),
    file_no: c.file_no,
    day: c.visit_date,
    active_meds: c.active_meds,
    exit_reason: c.exit_reason || "healthray completed",
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
  "\nThis writes rx_pending AFTER an exited event, which advanceStatus refuses as a backwards\n" +
    "move. It is written directly and flagged as a correction, because the exit was recorded by\n" +
    "a sync that had nowhere to park these patients: they were closed with medicines nobody has\n" +
    "collected and nobody has explained. See docs/gini-flow/30-COMPLETION-AUTHORITY-PLAN.md.\n" +
    "\nA patient who has genuinely gone home will be swept out again by the 30-minute grace window.",
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
          SET current_status = 'rx_pending', queue_position = NULL, updated_at = NOW()
        WHERE id = $1 AND current_status = 'exited'`,
      [c.visit_id],
    );
    if (!rowCount) throw new Error("visit is no longer exited");

    await client.query(
      `INSERT INTO giniflow_visit_events (visit_id, status, actor_role, meta)
       VALUES ($1, 'rx_pending', 'system', $2::jsonb)`,
      [
        c.visit_id,
        JSON.stringify({
          source: "recover-exits-to-rx-desk",
          correction: true,
          corrected_from: "exited",
          reason: "closed with medicines neither explained nor collected",
          original_exit_at: c.exited_at,
          original_exit_reason: c.exit_reason || null,
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

console.log(`\nmoved ${moved}, failed ${failed}`);
await pool.end();
