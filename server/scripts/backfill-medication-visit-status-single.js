/**
 * Single-patient dry-run / backfill for medication visit_status.
 *
 * Runs the same logic as backfill-medication-visit-status.js but scoped to
 * one patient (looked up by file_no). Useful to verify the demotion rule
 * before running across the whole DB.
 *
 * Usage:
 *   node server/scripts/backfill-medication-visit-status-single.js P_175778
 *   node server/scripts/backfill-medication-visit-status-single.js 175778
 *   node server/scripts/backfill-medication-visit-status-single.js --dry P_175778
 *   node server/scripts/backfill-medication-visit-status-single.js --no-push P_175778
 *
 * Flags:
 *   --dry       Print before/after preview; do NOT update or push.
 *   --no-push   Do the DB update but skip the Genie push.
 */
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { createRequire } from "module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dotenv = await import("dotenv");
dotenv.config({ path: join(__dirname, "..", ".env") });

const argv = process.argv.slice(2);
const DRY = argv.includes("--dry");
const NO_PUSH = argv.includes("--no-push");
const rawId = argv.find((a) => !a.startsWith("--"));
if (!rawId) {
  console.error("Missing patient identifier. Pass file_no (e.g. P_175778) or numeric patient_id.");
  process.exit(1);
}

const { default: pool } = await import("../config/db.js");
const require = createRequire(import.meta.url);
const { syncMedicationsToGenie } = require("../genie-sync.cjs");

// Resolve patient_id from either a numeric id or a file_no string.
async function resolvePatient(id) {
  if (/^\d+$/.test(id)) {
    const r = await pool.query(
      `SELECT id, file_no, name FROM patients WHERE id = $1`,
      [Number(id)],
    );
    if (r.rows[0]) return r.rows[0];
  }
  // Try file_no exact, then with/without P_ prefix.
  const candidates = [id, id.replace(/^P_?/i, ""), `P_${id.replace(/^P_?/i, "")}`];
  for (const c of candidates) {
    const r = await pool.query(
      `SELECT id, file_no, name FROM patients WHERE file_no = $1 LIMIT 1`,
      [c],
    );
    if (r.rows[0]) return r.rows[0];
  }
  return null;
}

const patient = await resolvePatient(rawId);
if (!patient) {
  console.error(`No patient found for "${rawId}".`);
  await pool.end();
  process.exit(1);
}
console.log(`Patient: id=${patient.id} file_no=${patient.file_no} name=${patient.name}`);

// Show all active healthray-tagged rows grouped by notes, with their updated_at
// and current visit_status, so you can eyeball the data.
const before = await pool.query(
  `SELECT id, name, dose, notes, visit_status, last_prescribed_date,
          updated_at,
          MAX(updated_at) OVER (PARTITION BY notes) AS group_max
     FROM medications
    WHERE patient_id = $1
      AND is_active = true
    ORDER BY notes NULLS LAST, updated_at DESC`,
  [patient.id],
);

console.log(`\nActive medications (${before.rows.length}):`);
for (const r of before.rows) {
  const stale =
    r.notes &&
    String(r.notes).startsWith("healthray:") &&
    r.group_max &&
    new Date(r.updated_at).getTime() <
      new Date(r.group_max).getTime() - 5000;
  console.log(
    `  [${r.id}] ${r.name} ${r.dose || ""}  status=${r.visit_status}  notes=${r.notes || "-"}  ` +
      `updated_at=${new Date(r.updated_at).toISOString()}${stale ? "  ← STALE" : ""}`,
  );
}

if (DRY) {
  console.log("\n--dry: skipping update.");
  await pool.end();
  process.exit(0);
}

// Same-healthrayId staleness sweep, scoped to this patient. Demotes any row
// tagged `healthray:<id>` whose updated_at is more than 5s behind the freshest
// row in that tag. We deliberately skip markMedicationVisitStatus here — its
// last_prescribed_date rule would re-promote these rows because the stale
// ones share last_prescribed_date with the survivors. The sweep also does
// NOT touch updated_at, so the staleness signal is preserved on re-runs.
const sweep = await pool.query(
  `WITH hr_latest AS (
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
    RETURNING m.id, m.name, m.dose`,
  [patient.id],
);
console.log(`\nStale same-healthrayId rows demoted: ${sweep.rowCount}`);
for (const r of sweep.rows) {
  console.log(`  → previous: [${r.id}] ${r.name} ${r.dose || ""}`);
}

// Step 3: show final state.
const after = await pool.query(
  `SELECT id, name, dose, visit_status, notes
     FROM medications
    WHERE patient_id = $1
      AND is_active = true
    ORDER BY visit_status, name`,
  [patient.id],
);
console.log(`\nAfter backfill:`);
for (const r of after.rows) {
  console.log(`  [${r.id}] ${r.name} ${r.dose || ""}  status=${r.visit_status}  notes=${r.notes || "-"}`);
}

// Step 4: optionally push to Genie.
if (!NO_PUSH) {
  console.log("\nPushing to Genie…");
  const res = await syncMedicationsToGenie(patient.id, pool);
  console.log(
    `  pushed=${res?.pushed || 0} total=${res?.total || 0} errors=${res?.errors?.length || 0}`,
  );
  if (res?.errors?.length) {
    for (const e of res.errors) console.log(`    ! ${e.name}: ${e.error}`);
  }
} else {
  console.log("\n--no-push: skipping Genie sync.");
}

await pool.end();
