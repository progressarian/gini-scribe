/**
 * Re-parse the LAST stored prescription for a single patient and verify every
 * PrescriptionSchema field lands in the right place.
 *
 * The script does NOT re-fetch the prescription from HealthRay — it re-uses
 * the `healthray_clinical_notes` already stored on the most recent appointment.
 * That keeps the test fast and deterministic for parser-output verification.
 *
 * Usage:
 *   # Dry run — parse + print, no DB writes
 *   node server/scripts/resync-last-prescription.js --file=P_176664
 *
 *   # Apply — write parsed output back into appointments + normalized tables
 *   node server/scripts/resync-last-prescription.js --file=P_176664 --apply
 */
import { fileURLToPath } from "url";
import { dirname, join } from "path";
const __dirname = dirname(fileURLToPath(import.meta.url));

const dotenv = await import("dotenv");
dotenv.config({ path: join(__dirname, "..", ".env") });

const { default: pool } = await import("../config/db.js");
const { parsePrescriptionWithAi } = await import("../services/healthray/parser.js");
const {
  ensureSyncColumns,
  syncDiagnoses,
  syncMedications,
  syncStoppedMedications,
  syncLabResults,
  syncSymptoms,
  syncBiomarkersFromLatestLabs,
  stopStaleHealthrayMeds,
} = await import("../services/healthray/db.js");

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const fileArg = args.find((a) => a.startsWith("--file="))?.split("=")[1] || args.find((a) => /^P_/i.test(a));

if (!fileArg) {
  console.error("Usage: node server/scripts/resync-last-prescription.js --file=P_176664 [--apply]");
  process.exit(1);
}
const fileNo = fileArg.toUpperCase();

await ensureSyncColumns();

function summary(parsed) {
  return {
    symptoms: parsed.symptoms?.length || 0,
    diagnoses: parsed.diagnoses?.length || 0,
    medications: parsed.medications?.length || 0,
    previous_medications: parsed.previous_medications?.length || 0,
    labs: parsed.labs?.length || 0,
    vitals: parsed.vitals?.length || 0,
    investigations_to_order: parsed.investigations_to_order?.length || 0,
    follow_up: parsed.follow_up ? "yes" : "no",
    follow_up_with: parsed.follow_up_with ? `"${parsed.follow_up_with.slice(0, 80)}..."` : null,
    advice: parsed.advice ? `"${parsed.advice.slice(0, 80)}..."` : null,
  };
}

async function main() {
  // 1. Locate patient + their most recent appointment with clinical notes
  const { rows: appts } = await pool.query(
    `SELECT a.id, a.healthray_id, a.appointment_date, a.patient_id,
            a.healthray_clinical_notes,
            p.name AS patient_name, p.file_no
       FROM appointments a
       JOIN patients p ON p.id = a.patient_id
      WHERE p.file_no = $1
        AND a.healthray_clinical_notes IS NOT NULL
        AND length(a.healthray_clinical_notes) > 20
      ORDER BY a.appointment_date DESC NULLS LAST, a.id DESC
      LIMIT 1`,
    [fileNo],
  );

  if (!appts[0]) {
    console.error(`No appointment with healthray_clinical_notes found for ${fileNo}`);
    process.exit(2);
  }
  const appt = appts[0];
  console.log(
    `\nPatient: ${appt.patient_name} (${appt.file_no})  patient_id=${appt.patient_id}`,
  );
  console.log(
    `Appt:    id=${appt.id}  healthray_id=${appt.healthray_id}  date=${appt.appointment_date}`,
  );
  console.log(`Clinical notes: ${appt.healthray_clinical_notes.length} chars\n`);

  // 2. Run the parser
  console.log("Running parsePrescriptionWithAi…");
  const t0 = Date.now();
  const parsed = await parsePrescriptionWithAi(appt.healthray_clinical_notes);
  console.log(`  → ${Date.now() - t0}ms`);
  if (!parsed) {
    console.error("Parser returned null. Check ANTHROPIC_API_KEY and note length.");
    process.exit(3);
  }

  console.log("\nParsed summary (counts):");
  console.dir(summary(parsed), { depth: null });

  console.log("\n────────── FULL EXTRACTION OUTPUT ──────────");
  console.log(JSON.stringify(parsed, null, 2));
  console.log("──────────────────────────────────────────────\n");

  if (!APPLY) {
    console.log("\nDRY RUN — no DB writes. Re-run with --apply to write results.\n");
    return;
  }

  // 3. Persist — same writes the cron sync would do
  console.log("\n--apply set → writing to DB…");
  await pool.query(
    `UPDATE appointments SET
       healthray_diagnoses             = $2::jsonb,
       healthray_medications           = $3::jsonb,
       healthray_previous_medications  = $4::jsonb,
       healthray_labs                  = $5::jsonb,
       healthray_advice                = $6,
       healthray_investigations        = $7::jsonb,
       healthray_follow_up             = $8::jsonb,
       follow_up_with                  = COALESCE($9, follow_up_with),
       updated_at                      = NOW()
     WHERE id = $1`,
    [
      appt.id,
      JSON.stringify(parsed.diagnoses || []),
      JSON.stringify(parsed.medications || []),
      JSON.stringify(parsed.previous_medications || []),
      JSON.stringify(parsed.labs || []),
      parsed.advice || null,
      JSON.stringify(parsed.investigations_to_order || []),
      parsed.follow_up ? JSON.stringify(parsed.follow_up) : null,
      parsed.follow_up_with || null,
    ],
  );

  if (parsed.diagnoses?.length)
    await syncDiagnoses(appt.patient_id, appt.healthray_id, parsed.diagnoses);
  if (parsed.symptoms?.length)
    await syncSymptoms(appt.patient_id, appt.id, parsed.symptoms);
  if (parsed.medications?.length) {
    await syncMedications(
      appt.patient_id,
      appt.healthray_id,
      appt.appointment_date,
      parsed.medications,
    );
    await stopStaleHealthrayMeds(appt.patient_id, appt.healthray_id, appt.appointment_date);
  }
  if (parsed.previous_medications?.length)
    await syncStoppedMedications(
      appt.patient_id,
      appt.healthray_id,
      parsed.previous_medications,
      parsed.medications || [],
    );
  if (parsed.labs?.length)
    await syncLabResults(appt.patient_id, appt.id, appt.appointment_date, parsed.labs);
  await syncBiomarkersFromLatestLabs(appt.patient_id, appt.id);

  // 4. Read back & verify
  const { rows: stored } = await pool.query(
    `SELECT
       healthray_advice,
       follow_up_with,
       jsonb_array_length(healthray_diagnoses)             AS dx,
       jsonb_array_length(healthray_medications)           AS meds,
       jsonb_array_length(healthray_previous_medications)  AS prev,
       jsonb_array_length(healthray_labs)                  AS labs,
       jsonb_array_length(healthray_investigations)        AS inv,
       (healthray_follow_up IS NOT NULL)                   AS has_follow_up,
       (SELECT COUNT(*)::int FROM visit_symptoms
         WHERE appointment_id = $1)                        AS sx,
       (SELECT COUNT(*)::int FROM medications
         WHERE patient_id = $2 AND source = 'healthray'
           AND last_prescribed_date = $3)                  AS meds_table,
       (SELECT COUNT(*)::int FROM medications
         WHERE patient_id = $2 AND source = 'healthray'
           AND last_prescribed_date = $3
           AND instructions IS NOT NULL
           AND length(instructions) > 0)                   AS meds_with_instructions,
       (SELECT COUNT(*)::int FROM lab_results
         WHERE appointment_id = $1 AND source = 'healthray') AS labs_table
     FROM appointments WHERE id = $1`,
    [appt.id, appt.patient_id, appt.appointment_date],
  );

  console.log("\nDB state after write:");
  console.dir(stored[0], { depth: null });
  console.log(
    `\nExpected vs actual:\n` +
      `  diagnoses:           parsed=${parsed.diagnoses?.length || 0}            stored=${stored[0].dx}\n` +
      `  medications:         parsed=${parsed.medications?.length || 0}            stored=${stored[0].meds}    meds_table=${stored[0].meds_table}    with_instructions=${stored[0].meds_with_instructions}\n` +
      `  previous_meds:       parsed=${parsed.previous_medications?.length || 0}            stored=${stored[0].prev}\n` +
      `  labs:                parsed=${parsed.labs?.length || 0}            stored=${stored[0].labs}    labs_table=${stored[0].labs_table}\n` +
      `  symptoms:            parsed=${parsed.symptoms?.length || 0}            stored=${stored[0].sx} (visit_symptoms)\n` +
      `  investigations:      parsed=${parsed.investigations_to_order?.length || 0}            stored=${stored[0].inv}\n` +
      `  follow_up:           parsed=${parsed.follow_up ? "yes" : "no"}            stored=${stored[0].has_follow_up ? "yes" : "no"}\n` +
      `  follow_up_with:      parsed=${parsed.follow_up_with ? "yes" : "no"}            stored=${stored[0].follow_up_with ? "yes" : "no"}\n` +
      `  advice:              parsed=${parsed.advice ? "yes" : "no"}            stored=${stored[0].healthray_advice ? "yes" : "no"}\n`,
  );
  console.log("Done.\n");
}

try {
  await main();
} catch (e) {
  console.error("\nFatal:", e);
  process.exitCode = 1;
} finally {
  await pool.end();
}
