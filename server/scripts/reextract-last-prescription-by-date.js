/**
 * Re-extract the LAST prescription for each patient with a local appointment on
 * a given date, fetching the prescription FRESH FROM HEALTHRAY (not from our
 * local `documents` table).
 *
 * Flow per patient:
 *   1. Walk our local `appointments` rows with a non-null `healthray_id`,
 *      ordered newest first (capped at MAX_APPTS_WALK).
 *   2. For each HealthRay appointment id, call HealthRay's medical_records
 *      endpoint and look for a prescription record (record_type contains
 *      "Prescription" or "Rx").
 *   3. Take the newest prescription record found (by record app_date_time, then
 *      attachment id).
 *   4. Upsert that record into our `documents` table via `syncDocuments` — this
 *      writes all HealthRay metadata into `notes` (healthray_appt/record/mrid/
 *      rtype) and fires a background PDF download to Supabase.
 *   5. Call `runPrescriptionExtraction(docId)`. Internally that invokes
 *      `resolveDocumentUrl`, which uses the notes metadata to pull the file
 *      fresh from HealthRay, then runs the unified CLINICAL_EXTRACTION_PROMPT
 *      via Claude and syncs diagnoses / medications / labs / vitals / symptoms /
 *      biomarkers.
 *
 * Usage:
 *   node server/scripts/reextract-last-prescription-by-date.js --date=2026-04-25
 *   node server/scripts/reextract-last-prescription-by-date.js --date=2026-04-25 --apply
 */
import { fileURLToPath } from "url";
import { dirname, join } from "path";
const __dirname = dirname(fileURLToPath(import.meta.url));

const dotenv = await import("dotenv");
dotenv.config({ path: join(__dirname, "..", ".env") });

const { default: pool } = await import("../config/db.js");
const { fetchMedicalRecords } = await import("../services/healthray/client.js");
const { syncDocuments } = await import("../services/healthray/db.js");
const { runPrescriptionExtraction } = await import("../routes/documents.js");

const args = process.argv.slice(2);
const DRY = !args.includes("--apply");
const DATE = args.find((a) => a.startsWith("--date="))?.split("=")[1];
const BATCH_DELAY_MS = 1000;
// Cap how far back we look per patient. A patient typically has a prescription
// on their most recent completed visit; walking beyond ~10 appointments is
// unlikely to help and wastes HealthRay API calls.
const MAX_APPTS_WALK = 10;

if (!DATE) {
  console.error("Missing --date=YYYY-MM-DD");
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isPrescription(rec) {
  const rt = (rec?.record_type || "").toLowerCase();
  return rt.includes("prescription") || rt.includes("rx");
}

function compareRecordsNewestFirst(a, b) {
  const ta = a.app_date_time ? Date.parse(a.app_date_time) : 0;
  const tb = b.app_date_time ? Date.parse(b.app_date_time) : 0;
  if (tb !== ta) return tb - ta;
  return (Number(b.id) || 0) - (Number(a.id) || 0);
}

async function findLatestHealthrayPrescription(patientId) {
  const { rows: appts } = await pool.query(
    `SELECT id             AS local_appt_id,
            healthray_id,
            appointment_date
       FROM appointments
      WHERE patient_id = $1
        AND healthray_id IS NOT NULL
      ORDER BY appointment_date DESC NULLS LAST, id DESC
      LIMIT $2`,
    [patientId, MAX_APPTS_WALK],
  );

  for (const appt of appts) {
    let records;
    try {
      records = await fetchMedicalRecords(appt.healthray_id);
    } catch (e) {
      console.error(
        `  [HR]   patient=${patientId} appt=${appt.healthray_id}: fetch failed — ${e.message}`,
      );
      continue;
    }
    const rxRecords = (records || []).filter(isPrescription);
    if (rxRecords.length === 0) continue;
    rxRecords.sort(compareRecordsNewestFirst);
    return {
      record: rxRecords[0],
      healthrayApptId: appt.healthray_id,
      localApptId: appt.local_appt_id,
      apptDate: appt.appointment_date,
    };
  }
  return null;
}

function apptDateToString(apptDate) {
  if (!apptDate) return DATE;
  if (apptDate instanceof Date) return apptDate.toISOString().slice(0, 10);
  return String(apptDate).slice(0, 10);
}

async function run() {
  const { rows: patients } = await pool.query(
    `SELECT DISTINCT COALESCE(p.id, a.patient_id) AS patient_id,
            COALESCE(p.name, a.patient_name) AS patient_name
       FROM appointments a
       LEFT JOIN patients p
         ON (a.file_no IS NOT NULL AND p.file_no = a.file_no)
         OR (a.file_no IS NULL AND p.id = a.patient_id)
      WHERE a.appointment_date = $1
        AND COALESCE(p.id, a.patient_id) IS NOT NULL`,
    [DATE],
  );

  console.log(`\nAppointments on ${DATE}: ${patients.length} unique patient(s)\n`);

  const targets = [];
  const skipped = [];

  for (const pat of patients) {
    const found = await findLatestHealthrayPrescription(pat.patient_id);
    if (!found) {
      skipped.push(pat);
      continue;
    }
    targets.push({ ...pat, ...found });
  }

  console.log(`  To re-extract: ${targets.length}`);
  console.log(`  Skipped (no Healthray prescription): ${skipped.length}\n`);

  for (const t of targets) {
    const rec = t.record;
    console.log(
      `  [extract] patient=${t.patient_id} (${t.patient_name || "?"}) ` +
        `healthray_appt=${t.healthrayApptId} ` +
        `attach=${rec.id} mrid=${rec.medical_record_id || "-"} ` +
        `rtype=${JSON.stringify(rec.record_type)} ` +
        `file=${JSON.stringify(rec.file_name)} ` +
        `app_date=${rec.app_date_time || apptDateToString(t.apptDate)}`,
    );
  }
  for (const s of skipped) {
    console.log(
      `  [skip]    patient=${s.patient_id} (${s.patient_name || "?"}) — no Healthray prescription found`,
    );
  }

  if (DRY) {
    console.log("\nDRY RUN — no changes made. Add --apply to execute.");
    return;
  }

  let ok = 0;
  let fail = 0;
  for (let i = 0; i < targets.length; i++) {
    const t = targets[i];
    const pfx = `  [${i + 1}/${targets.length}]`;
    const rec = t.record;
    console.log(`${pfx} upserting doc patient=${t.patient_id} healthray_attach=${rec.id}...`);
    try {
      await syncDocuments(t.patient_id, [rec], apptDateToString(t.apptDate), t.healthrayApptId);

      const { rows: docRows } = await pool.query(
        `SELECT id FROM documents
          WHERE patient_id = $1
            AND file_name = $2
            AND source = 'healthray'
          LIMIT 1`,
        [t.patient_id, rec.file_name],
      );
      const docId = docRows[0]?.id;
      if (!docId) {
        fail += 1;
        console.error(`${pfx} → could not locate synced document row`);
        continue;
      }

      console.log(`${pfx} extracting doc=${docId}...`);
      const result = await runPrescriptionExtraction(docId);
      if (result?.success) {
        ok += 1;
        console.log(
          `${pfx} → ok doc=${docId} meds=${result.medicinesExtracted} dx=${result.diagnosesExtracted} ` +
            `sx=${result.symptomsExtracted} labs=${result.labsExtracted} vitals=${result.vitalsExtracted}`,
        );
      } else {
        fail += 1;
        console.log(`${pfx} → fail doc=${docId}: ${result?.error || "unknown"}`);
      }
    } catch (e) {
      fail += 1;
      console.error(`${pfx} → crash: ${e.message}`);
    }
    if (i < targets.length - 1) await sleep(BATCH_DELAY_MS);
  }

  console.log(
    `\nSummary: extracted=${ok} failed=${fail} skipped=${skipped.length} total_patients=${patients.length}`,
  );
}

try {
  await run();
} catch (e) {
  console.error("\nFatal:", e);
  process.exitCode = 1;
} finally {
  await pool.end();
}
