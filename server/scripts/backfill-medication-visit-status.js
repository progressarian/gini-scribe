/**
 * One-time backfill: stamp `visit_status` ('current' | 'previous') on every
 * patient's active medication rows, then replay the genie sync so the same
 * key lands in Supabase. Safe to re-run — markMedicationVisitStatus is
 * idempotent (skips rows already in the right bucket) and gini_sync_medication
 * upserts by source_id.
 *
 * Run: node server/scripts/backfill-medication-visit-status.js
 *
 * Prereqs:
 *   1. Apply gini-scribe/server/migrations/2026-05-02_med_visit_status.sql
 *   2. Apply myhealthgenie/migrations/2026-05-02_medications_visit_status.sql
 */
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { createRequire } from "module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dotenv = await import("dotenv");
dotenv.config({ path: join(__dirname, "..", ".env") });

const { default: pool } = await import("../config/db.js");
const require = createRequire(import.meta.url);
const { syncMedicationsToGenie } = require("../genie-sync.cjs");

const { rows } = await pool.query(`
  SELECT DISTINCT patient_id
    FROM medications
   WHERE is_active = true
   ORDER BY patient_id
`);
console.log(`Patients to backfill: ${rows.length}`);

let stamped = 0;
let pushed = 0;
let errors = 0;
let processed = 0;
const total = rows.length;
const startedAt = Date.now();

const PROGRESS_EVERY = 25; // log every N patients so you can see it move

function logProgress(pid, force = false) {
  if (!force && processed % PROGRESS_EVERY !== 0) return;
  const elapsedSec = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
  const rate = processed / elapsedSec;
  const remaining = Math.max(0, total - processed);
  const etaSec = rate > 0 ? Math.round(remaining / rate) : 0;
  const etaMin = Math.round(etaSec / 60);
  console.log(
    `[${processed}/${total}] last_pid=${pid} stamped=${stamped} pushed=${pushed} errors=${errors} ` +
      `rate=${rate.toFixed(2)}/s elapsed=${elapsedSec}s eta=${etaMin}m`,
  );
}

// Per-patient: run the same-healthrayId staleness sweep. We skip
// markMedicationVisitStatus here — its last_prescribed_date rule would
// re-promote the rows the sweep just demoted (stale rows share the same
// last_prescribed_date as their survivors). The sweep does NOT touch
// updated_at, so the staleness signal is preserved on re-runs.
const SWEEP_SQL = `
  WITH hr_latest AS (
    SELECT notes, MAX(updated_at) AS max_updated
      FROM medications
     WHERE patient_id = $1
       AND is_active = true
       AND source = 'healthray'
       AND notes LIKE 'healthray:%'
     GROUP BY notes
  )
  UPDATE medications m
     SET visit_status = 'previous'
    FROM hr_latest h
   WHERE m.patient_id = $1
     AND m.notes = h.notes
     AND m.is_active = true
     AND m.source = 'healthray'
     AND m.notes LIKE 'healthray:%'
     AND m.updated_at < h.max_updated - INTERVAL '5 seconds'
     AND m.visit_status IS DISTINCT FROM 'previous'
`;
let demoted = 0;

for (const r of rows) {
  const pid = r.patient_id;
  try {
    const sw = await pool.query(SWEEP_SQL, [pid]);
    demoted += sw.rowCount || 0;
    stamped += 1;
  } catch (e) {
    errors += 1;
    console.warn(`[sweep ${pid}] ${e.message}`);
    processed += 1;
    logProgress(pid);
    continue;
  }
  try {
    const res = await syncMedicationsToGenie(pid, pool);
    pushed += res?.pushed || 0;
    if (res?.errors?.length) errors += res.errors.length;
  } catch (e) {
    errors += 1;
    console.warn(`[push ${pid}] ${e.message}`);
  }
  processed += 1;
  logProgress(pid);
}

logProgress(rows[rows.length - 1]?.patient_id, true);
console.log(
  `Done. patients=${total} stamped=${stamped} demoted=${demoted} medsPushedToGenie=${pushed} errors=${errors}`,
);
await pool.end();
