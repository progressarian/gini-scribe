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
const { markMedicationVisitStatus } = await import("../services/medication/visitStatus.js");
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

for (const r of rows) {
  const pid = r.patient_id;
  try {
    await markMedicationVisitStatus(pid);
    stamped += 1;
  } catch (e) {
    errors += 1;
    console.warn(`[stamp ${pid}] ${e.message}`);
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
  `Done. patients=${total} stamped=${stamped} medsPushedToGenie=${pushed} errors=${errors}`,
);
await pool.end();
