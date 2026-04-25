/**
 * One-time backfill: for every patient with any scribe-side data, push labs,
 * meds, diagnoses, documents, appointments, and care team to Genie.
 * Safe to re-run — every helper upserts by source_id.
 *
 * Run: node server/scripts/backfill-all-sync.js
 */
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { createRequire } from "module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dotenv = await import("dotenv");
dotenv.config({ path: join(__dirname, "..", ".env") });

const { default: pool } = await import("../config/db.js");
const require = createRequire(import.meta.url);
const {
  syncLabsToGenie,
  syncMedicationsToGenie,
  syncDiagnosesToGenie,
  syncDocumentsToGenie,
  syncAppointmentToGenie,
  syncCareTeamToGenie,
} = require("../genie-sync.cjs");

const { rows } = await pool.query(`
  SELECT DISTINCT patient_id FROM (
    SELECT patient_id FROM lab_results
    UNION SELECT patient_id FROM medications
    UNION SELECT patient_id FROM diagnoses
    UNION SELECT patient_id FROM documents
       WHERE doc_type IN ('prescription','lab_report','imaging','discharge')
  ) p ORDER BY patient_id
`);
console.log(`Patients to backfill: ${rows.length}`);

const totals = { labs: 0, meds: 0, dx: 0, docs: 0, errors: 0 };
let i = 0;
for (const r of rows) {
  i++;
  const pid = r.patient_id;
  const [labs, meds, dx, docs, appt, ct] = await Promise.all([
    syncLabsToGenie(pid, pool).catch((e) => ({ errors: [{ error: e.message }] })),
    syncMedicationsToGenie(pid, pool).catch((e) => ({ errors: [{ error: e.message }] })),
    syncDiagnosesToGenie(pid, pool).catch((e) => ({ errors: [{ error: e.message }] })),
    syncDocumentsToGenie(pid, pool).catch((e) => ({ errors: [{ error: e.message }] })),
    syncAppointmentToGenie(pid, pool).catch((e) => ({ errors: [{ error: e.message }] })),
    syncCareTeamToGenie(pid, pool).catch((e) => ({ errors: [{ error: e.message }] })),
  ]);
  totals.labs += labs.pushed || 0;
  totals.meds += meds.pushed || 0;
  totals.dx += dx.pushed || 0;
  totals.docs += docs.pushed || 0;
  totals.errors +=
    (labs.errors?.length || 0) +
    (meds.errors?.length || 0) +
    (dx.errors?.length || 0) +
    (docs.errors?.length || 0) +
    (appt.errors?.length || 0) +
    (ct.errors?.length || 0);
  if (i % 25 === 0 || i === rows.length) {
    console.log(
      `  [${i}/${rows.length}] running totals — labs:${totals.labs} meds:${totals.meds} dx:${totals.dx} docs:${totals.docs} errs:${totals.errors}`,
    );
  }
}
console.log("\nDone.");
console.log(totals);
await pool.end();
