/**
 * Cross-patient backfill: re-attach HealthRay medications to the consultation
 * whose visit_date matches the medication's source Rx (`notes = healthray:<id>`).
 *
 * Bug: `markAppointmentAsSeen` previously did a greedy bulk update —
 *   UPDATE medications SET consultation_id = $1
 *    WHERE patient_id = $2 AND is_active = true AND consultation_id IS NULL
 * — so the first appointment processed for a patient grabbed every orphaned
 * med across every Rx batch. As a result, ~69k active medications across
 * ~5.6k patients are tied to the wrong consultation, and the visit-page
 * reconcile sweep then deactivates them with stop_reason='Previous visit'.
 *
 * The code-side fix is already in `server/services/healthray/db.js`
 * (markAppointmentAsSeen now scopes the attach to the appointment's healthray
 * batch). This script repairs the existing data.
 *
 * Steps:
 *   1) Build target consult per (patient_id, healthray_id) by joining
 *      appointments → consultations on (patient_id, visit_date = appointment_date).
 *   2) UPDATE medications.consultation_id where it differs from the target.
 *   3) UPDATE medications.last_prescribed_date = appointment_date where lower.
 *   4) Reactivate rows stopped today (CURRENT_DATE) by reconcile —
 *      stop_reason='Previous visit' AND notes LIKE 'healthray:%'.
 *   5) Run markMedicationVisitStatus per affected patient.
 *   6) Push to Genie per affected patient (parallel-limited).
 *
 * Run dry: node server/scripts/backfill-healthray-med-consultations.js
 * Apply:   node server/scripts/backfill-healthray-med-consultations.js --apply
 * Skip Genie push (DB-only): add --no-push
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

const APPLY = process.argv.includes("--apply");
const NO_PUSH = process.argv.includes("--no-push");

console.log(`Mode: ${APPLY ? "APPLY" : "dry-run"}${NO_PUSH ? " (no Genie push)" : ""}`);

// 1) Preview impact — counts before
const before = await pool.query(`
  WITH meds AS (
    SELECT m.id, m.patient_id, m.consultation_id, m.is_active,
           m.last_prescribed_date,
           REPLACE(m.notes, 'healthray:', '') AS hr_id
      FROM medications m
     WHERE m.source = 'healthray'
       AND m.notes LIKE 'healthray:%'
  ),
  target AS (
    SELECT m.id, m.patient_id, m.is_active, m.consultation_id AS current_consult,
           m.last_prescribed_date,
           a.appointment_date,
           c.id AS target_consult
      FROM meds m
      LEFT JOIN appointments a
        ON a.healthray_id::text = m.hr_id AND a.patient_id = m.patient_id
      LEFT JOIN consultations c
        ON c.patient_id = m.patient_id AND c.visit_date = a.appointment_date
  )
  SELECT
    COUNT(*) AS healthray_meds_total,
    COUNT(*) FILTER (WHERE is_active = true) AS active_total,
    COUNT(*) FILTER (WHERE target_consult IS NOT NULL AND current_consult IS DISTINCT FROM target_consult) AS will_reattach,
    COUNT(*) FILTER (WHERE target_consult IS NOT NULL
                       AND appointment_date > COALESCE(last_prescribed_date, '1900-01-01'::date)) AS will_bump_lpd,
    COUNT(DISTINCT patient_id) FILTER (WHERE target_consult IS NOT NULL AND current_consult IS DISTINCT FROM target_consult) AS impacted_patients,
    COUNT(*) FILTER (WHERE target_consult IS NULL) AS no_target_skip
  FROM target
`);
console.log("\nImpact preview:");
console.log(before.rows[0]);

const todayReconcile = await pool.query(`
  SELECT COUNT(*) AS n
    FROM medications
   WHERE notes LIKE 'healthray:%'
     AND is_active = false
     AND stop_reason = 'Previous visit'
     AND stopped_date::date = CURRENT_DATE
`);
console.log(`Rows stopped today by reconcile (will reactivate): ${todayReconcile.rows[0].n}`);

if (!APPLY) {
  console.log("\n[dry-run] pass --apply to write changes.");
  await pool.end();
  process.exit(0);
}

// 2) Re-attach consultation_id where it doesn't match the target
console.log("\nStep 1/4: re-attaching consultation_id…");
const t1 = Date.now();
const reattach = await pool.query(`
  WITH target AS (
    SELECT m.id AS med_id, c.id AS target_consult
      FROM medications m
      JOIN appointments a
        ON a.healthray_id::text = REPLACE(m.notes, 'healthray:', '')
       AND a.patient_id = m.patient_id
      JOIN consultations c
        ON c.patient_id = m.patient_id
       AND c.visit_date = a.appointment_date
     WHERE m.source = 'healthray'
       AND m.notes LIKE 'healthray:%'
       AND (m.consultation_id IS DISTINCT FROM c.id)
  )
  UPDATE medications m
     SET consultation_id = t.target_consult,
         updated_at = NOW()
    FROM target t
   WHERE m.id = t.med_id
  RETURNING m.id, m.patient_id
`);
console.log(`  re-attached ${reattach.rowCount} rows in ${Math.round((Date.now() - t1) / 1000)}s`);
const impactedPatients = new Set(reattach.rows.map((r) => r.patient_id));

// 3) Bump last_prescribed_date to appointment_date when older
console.log("\nStep 2/4: bumping last_prescribed_date…");
const t2 = Date.now();
const bumped = await pool.query(`
  UPDATE medications m
     SET last_prescribed_date = a.appointment_date,
         updated_at = NOW()
    FROM appointments a
   WHERE m.source = 'healthray'
     AND m.notes LIKE 'healthray:%'
     AND a.healthray_id::text = REPLACE(m.notes, 'healthray:', '')
     AND a.patient_id = m.patient_id
     AND a.appointment_date > COALESCE(m.last_prescribed_date, '1900-01-01'::date)
  RETURNING m.id, m.patient_id
`);
console.log(`  bumped ${bumped.rowCount} rows in ${Math.round((Date.now() - t2) / 1000)}s`);
for (const r of bumped.rows) impactedPatients.add(r.patient_id);

// 4) Reactivate rows stopped today by the reconcile sweep
console.log("\nStep 3/4: reactivating rows stopped today by reconcile…");
const t3 = Date.now();
const react = await pool.query(`
  UPDATE medications
     SET is_active = true,
         stopped_date = NULL,
         stop_reason = NULL,
         updated_at = NOW()
   WHERE notes LIKE 'healthray:%'
     AND is_active = false
     AND stop_reason = 'Previous visit'
     AND stopped_date::date = CURRENT_DATE
  RETURNING id, patient_id
`);
console.log(`  reactivated ${react.rowCount} rows in ${Math.round((Date.now() - t3) / 1000)}s`);
for (const r of react.rows) impactedPatients.add(r.patient_id);

console.log(`\nUnique patients touched: ${impactedPatients.size}`);

// 5) Refresh visit_status per impacted patient
console.log("\nStep 4/4: refreshing visit_status per patient…");
const t4 = Date.now();
let i = 0;
for (const pid of impactedPatients) {
  await markMedicationVisitStatus(pid, pool);
  if (++i % 200 === 0) console.log(`  visit_status: ${i}/${impactedPatients.size}`);
}
console.log(
  `  visit_status refreshed for ${i} patients in ${Math.round((Date.now() - t4) / 1000)}s`,
);

// 6) Push to Genie (limited concurrency to avoid throttling). Skipped if --no-push.
if (NO_PUSH) {
  console.log("\nGenie push skipped (--no-push).");
} else {
  console.log("\nPushing to Genie (concurrency=4)…");
  const t5 = Date.now();
  const ids = [...impactedPatients];
  const concurrency = 4;
  let cursor = 0;
  let pushed = 0;
  let errors = 0;
  async function worker() {
    while (true) {
      const idx = cursor++;
      if (idx >= ids.length) return;
      const pid = ids[idx];
      try {
        await syncMedicationsToGenie(pid, pool);
        pushed++;
      } catch (e) {
        errors++;
        console.warn(`  push failed for patient ${pid}: ${e.message}`);
      }
      if ((pushed + errors) % 200 === 0) {
        console.log(`  genie push: ${pushed + errors}/${ids.length}`);
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  console.log(`  pushed ${pushed} (errors ${errors}) in ${Math.round((Date.now() - t5) / 1000)}s`);
}

await pool.end();
console.log("\nDone.");
