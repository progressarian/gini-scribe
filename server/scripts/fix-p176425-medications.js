/**
 * One-off repair for patient P_176425 (id=1430).
 *
 * Bug: every active healthray-source medication was attached to consultation 87712
 * (visit_date 2025-08-18, the OLDEST consult), regardless of which Rx batch it came
 * from. When the visit page opened, the reconcile sweep
 * (PATCH /visit/:patientId/medications/reconcile, server/routes/visit.js:2492)
 * deactivated every active med because consult 87712 isn't on the latest visit_date.
 *
 * This script:
 *   1. Builds a healthray_id → consultation_id map by joining appointments to
 *      consultations on (patient_id, visit_date = appointment_date).
 *   2. Re-attaches each healthray med to the consultation matching its Rx doc_date.
 *   3. Reactivates rows that were stopped by today's reconcile sweep.
 *   4. Re-stamps last_prescribed_date per healthray batch from appointments.appointment_date.
 *   5. Refreshes visit_status via markMedicationVisitStatus.
 *   6. Pushes to Genie.
 *
 * Run dry: node server/scripts/fix-p176425-medications.js
 * Apply:   node server/scripts/fix-p176425-medications.js --apply
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
const FILE_NO = "P_176425";

const patRes = await pool.query(
  `SELECT id, file_no, name FROM patients WHERE file_no = $1`,
  [FILE_NO],
);
if (!patRes.rowCount) {
  console.error(`No patient with file_no=${FILE_NO}`);
  await pool.end();
  process.exit(1);
}
const PATIENT_ID = patRes.rows[0].id;
console.log(`Patient: id=${PATIENT_ID} file_no=${FILE_NO} name=${patRes.rows[0].name}`);

// Build healthray_id → consultation_id map (per patient, visit_date = appointment_date)
const mapRes = await pool.query(
  `SELECT a.healthray_id::text AS healthray_id,
          a.appointment_date,
          c.id AS consultation_id,
          c.visit_date
     FROM appointments a
     JOIN consultations c
       ON c.patient_id = a.patient_id
      AND c.visit_date = a.appointment_date
    WHERE a.patient_id = $1
      AND a.healthray_id IS NOT NULL
    ORDER BY a.appointment_date`,
  [PATIENT_ID],
);
const hrToConsult = new Map();
for (const r of mapRes.rows) {
  // If multiple consults share the same visit_date, prefer the lowest id (oldest)
  // so the choice is deterministic across re-runs. Either is correct for reconcile —
  // both have the same visit_date and reconcile only compares dates.
  if (!hrToConsult.has(r.healthray_id)) {
    hrToConsult.set(r.healthray_id, {
      consultation_id: r.consultation_id,
      appointment_date: r.appointment_date,
    });
  }
}
console.log(`\nhealthray_id → consultation map (${hrToConsult.size}):`);
for (const [hid, v] of hrToConsult.entries()) {
  console.log(`  healthray:${hid}  →  consult ${v.consultation_id} (${v.appointment_date})`);
}

// Show current state
const before = await pool.query(
  `SELECT id, name, dose, notes, consultation_id, is_active, visit_status,
          last_prescribed_date, stopped_date, stop_reason
     FROM medications
    WHERE patient_id = $1
      AND notes LIKE 'healthray:%'
    ORDER BY notes, id`,
  [PATIENT_ID],
);
console.log(`\nBefore (${before.rows.length} healthray meds):`);
for (const r of before.rows) {
  const hid = String(r.notes).slice("healthray:".length);
  const target = hrToConsult.get(hid);
  const willMove = target && target.consultation_id !== r.consultation_id;
  const willActivate = !r.is_active && r.stop_reason === "Previous visit";
  console.log(
    `  [${r.id}] ${r.name}${r.dose ? " " + r.dose : ""}` +
      `  notes=${r.notes}  consult=${r.consultation_id}  active=${r.is_active}` +
      `  lpd=${r.last_prescribed_date}` +
      (willMove ? `  → move to consult ${target.consultation_id}` : "") +
      (willActivate ? "  → reactivate" : ""),
  );
}

if (!APPLY) {
  console.log("\n[dry-run] pass --apply to write changes.");
  await pool.end();
  process.exit(0);
}

// 1) Re-attach to correct consultation per healthray_id
let moved = 0;
for (const [hid, v] of hrToConsult.entries()) {
  const r = await pool.query(
    `UPDATE medications
        SET consultation_id = $1, updated_at = NOW()
      WHERE patient_id = $2
        AND notes = 'healthray:' || $3
        AND (consultation_id IS DISTINCT FROM $1)
      RETURNING id`,
    [v.consultation_id, PATIENT_ID, hid],
  );
  moved += r.rowCount;
}
console.log(`\nRe-attached ${moved} med rows to their batch's consultation.`);

// 2) Reactivate rows stopped by today's reconcile sweep
const react = await pool.query(
  `UPDATE medications
      SET is_active = true,
          stopped_date = NULL,
          stop_reason = NULL,
          updated_at = NOW()
    WHERE patient_id = $1
      AND stop_reason = 'Previous visit'
      AND stopped_date::date = CURRENT_DATE
      AND notes LIKE 'healthray:%'
    RETURNING id`,
  [PATIENT_ID],
);
console.log(`Reactivated ${react.rowCount} rows stopped today by reconcile.`);

// 3) Re-stamp last_prescribed_date from appointments.appointment_date per batch
const lpd = await pool.query(
  `UPDATE medications m
      SET last_prescribed_date = a.appointment_date,
          updated_at = NOW()
     FROM appointments a
    WHERE m.patient_id = $1
      AND a.patient_id = $1
      AND a.healthray_id IS NOT NULL
      AND m.notes = 'healthray:' || a.healthray_id::text
      AND a.appointment_date > COALESCE(m.last_prescribed_date, '1900-01-01'::date)
    RETURNING m.id`,
  [PATIENT_ID],
);
console.log(`Bumped last_prescribed_date on ${lpd.rowCount} rows.`);

// 4) Refresh visit_status
await markMedicationVisitStatus(PATIENT_ID, pool);
console.log("Refreshed visit_status.");

// Show after state
const after = await pool.query(
  `SELECT id, name, dose, notes, consultation_id, is_active, visit_status,
          last_prescribed_date
     FROM medications
    WHERE patient_id = $1
      AND notes LIKE 'healthray:%'
    ORDER BY notes, id`,
  [PATIENT_ID],
);
console.log(`\nAfter (${after.rows.length} healthray meds):`);
for (const r of after.rows) {
  console.log(
    `  [${r.id}] ${r.name}${r.dose ? " " + r.dose : ""}` +
      `  notes=${r.notes}  consult=${r.consultation_id}  active=${r.is_active}` +
      `  visit_status=${r.visit_status}  lpd=${r.last_prescribed_date}`,
  );
}

// 5) Push to Genie
console.log("\nPushing to Genie…");
const res = await syncMedicationsToGenie(PATIENT_ID, pool);
console.log(
  `  pushed=${res?.pushed || 0} total=${res?.total || 0} errors=${res?.errors?.length || 0}`,
);
if (res?.errors?.length) {
  for (const e of res.errors) console.log(`    ! ${e.name}: ${e.error}`);
}

await pool.end();
