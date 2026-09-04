import "../loadEnv.js";
import pool from "../config/db.js";
import { advanceStatus } from "../services/giniflow/statusEngine.js";

const APPLY = process.argv.includes("--apply");

const PAIRS_SQL = `
  WITH dup AS (
    SELECT appointment_id FROM giniflow_visits
     WHERE appointment_id IS NOT NULL
     GROUP BY appointment_id HAVING count(*) > 1
  )
  SELECT gv.id AS ghost_id, gv.patient_id AS ghost_patient, gv.current_status AS ghost_status,
         gv.visit_date::text AS visit_date, gv.appointment_id,
         sv.id AS survivor_id, sv.patient_id AS survivor_patient, sv.current_status AS survivor_status,
         (SELECT count(*) FROM giniflow_vitals WHERE visit_id = gv.id)::int AS ghost_vitals,
         (SELECT count(*) FROM giniflow_vitals WHERE visit_id = sv.id)::int AS survivor_vitals,
         (SELECT count(*) FROM giniflow_visit_events WHERE visit_id = gv.id)::int AS ghost_events
    FROM giniflow_visits gv
    JOIN dup d ON d.appointment_id = gv.appointment_id
    JOIN appointments a ON a.id = gv.appointment_id
    JOIN giniflow_visits sv
      ON sv.appointment_id = gv.appointment_id AND sv.patient_id = a.patient_id
   WHERE gv.patient_id IS DISTINCT FROM a.patient_id
   ORDER BY gv.visit_date, gv.appointment_id`;

const { rows: pairs } = await pool.query(PAIRS_SQL);

console.log(`${APPLY ? "APPLY" : "DRY RUN"} — ${pairs.length} ghost visit(s)\n`);
console.table(
  pairs.map((p) => ({
    day: p.visit_date,
    appt: p.appointment_id,
    ghost: p.ghost_id.slice(0, 8),
    ghost_status: p.ghost_status,
    survivor: p.survivor_id.slice(0, 8),
    events_kept: p.ghost_events,
    vitals_moved: p.ghost_vitals > 0 && p.survivor_vitals === 0 ? p.ghost_vitals : 0,
    vitals_left: p.ghost_vitals > 0 && p.survivor_vitals > 0 ? p.ghost_vitals : 0,
  })),
);

const totals = pairs.reduce(
  (acc, p) => ({
    move: acc.move + (p.ghost_vitals > 0 && p.survivor_vitals === 0 ? p.ghost_vitals : 0),
    keep: acc.keep + (p.ghost_vitals > 0 && p.survivor_vitals > 0 ? p.ghost_vitals : 0),
    events: acc.events + p.ghost_events,
  }),
  { move: 0, keep: 0, events: 0 },
);
console.log(
  `\nvitals to move: ${totals.move} · vitals left on ghost (survivor already has one): ${totals.keep} · events preserved in place: ${totals.events}`,
);

if (!APPLY) {
  console.log("\nNothing written. Re-run with --apply to perform the merge.");
  await pool.end();
  process.exit(0);
}

let merged = 0;
let failed = 0;

for (const p of pairs) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    if (p.ghost_vitals > 0 && p.survivor_vitals === 0) {
      await client.query(`UPDATE giniflow_vitals SET visit_id = $1 WHERE visit_id = $2`, [
        p.survivor_id,
        p.ghost_id,
      ]);
    }

    if (p.ghost_status !== "cancelled") {
      await advanceStatus(client, {
        visitId: p.ghost_id,
        toStatus: "cancelled",
        actorRole: "system",
        allowSkip: true,
        meta: {
          source: "merge-ghost-giniflow-visits",
          reason: "duplicate patient record for one appointment",
          merged_into_visit: p.survivor_id,
          survivor_patient_id: p.survivor_patient,
          detached_appointment_id: p.appointment_id,
          vitals_moved: p.ghost_vitals > 0 && p.survivor_vitals === 0 ? p.ghost_vitals : 0,
        },
      });
    }

    await client.query(
      `UPDATE giniflow_visits
          SET appointment_id = NULL, merged_into_visit_id = $2, updated_at = NOW()
        WHERE id = $1`,
      [p.ghost_id, p.survivor_id],
    );

    await client.query("COMMIT");
    merged += 1;
  } catch (e) {
    await client.query("ROLLBACK");
    failed += 1;
    console.error(`  ghost ${p.ghost_id}: ${e.message}`);
  } finally {
    client.release();
  }
}

console.log(`\nmerged ${merged}, failed ${failed}`);
await pool.end();
