import "../loadEnv.js";
import pool from "../config/db.js";
import { collectNoteDates } from "../utils/labDate.js";
import { CANONICAL_TO_BIO, syncBiomarkersFromLatestLabs } from "../services/healthray/db.js";

const APPLY = process.argv.includes("--apply");
const EXTRACT = process.argv.includes("--extract");
const RESYNC = process.argv.includes("--resync");
const BATCH = 100;

const chunk = (list, size) =>
  Array.from({ length: Math.ceil(list.length / size) }, (_, i) =>
    list.slice(i * size, i * size + size),
  );

async function assertDatabaseCalm() {
  const { rows } = await pool.query(
    `SELECT count(*)::int AS slow FROM pg_stat_activity
      WHERE datname = current_database() AND state = 'active'
        AND xact_start < NOW() - INTERVAL '30 seconds' AND pid <> pg_backend_pid()
        AND backend_type = 'client backend'`,
  );
  if (rows[0].slow > 3) {
    throw new Error(`${rows[0].slow} long-running queries right now — try again later`);
  }
}

async function findUndatedNoteLabs(today) {
  const { rows } = await pool.query(
    `SELECT lr.id, lr.patient_id, lr.appointment_id, lr.canonical_name, lr.result,
            a.healthray_clinical_notes AS note
       FROM lab_results lr
       JOIN appointments a ON a.id = lr.appointment_id
      WHERE lr.source = 'healthray'
        AND lr.test_date = $1::date
        AND a.appointment_date = $1::date`,
    [today],
  );
  return rows.filter(
    (r) => r.note && !collectNoteDates(r.note).has(today) && !/\btoday\b/i.test(r.note),
  );
}

async function deleteBatch(rows, today) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`DELETE FROM lab_results WHERE id = ANY($1::int[])`, [
      rows.map((r) => r.id),
    ]);
    const byAppt = new Map();
    for (const r of rows) {
      const key = CANONICAL_TO_BIO[r.canonical_name];
      if (!key) continue;
      byAppt.set(r.appointment_id, [...(byAppt.get(r.appointment_id) || []), key]);
    }
    for (const [apptId, keys] of byAppt) {
      await client.query(
        `UPDATE appointments
            SET biomarkers = (biomarkers - k.stale)
                             || jsonb_build_object('_lab_dates',
                                  COALESCE(biomarkers->'_lab_dates', '{}'::jsonb) - k.stale)
           FROM (SELECT array_agg(key) AS stale
                   FROM unnest($2::text[]) AS key
                  WHERE (SELECT biomarkers->'_lab_dates'->>key FROM appointments WHERE id = $1) = $3
                ) k
          WHERE id = $1 AND biomarkers IS NOT NULL AND k.stale IS NOT NULL`,
        [apptId, keys, today],
      );
    }
    await client.query("COMMIT");
    return byAppt;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

async function extractTodaysBenchReports(today) {
  const { runServerExtraction } = await import("../routes/documents.js");
  const { rows } = await pool.query(
    `SELECT id FROM documents
      WHERE source = 'giniflow_lab' AND doc_type = 'lab_report' AND doc_date = $1::date
        AND (extracted_data IS NULL
             OR (NOT (extracted_data ? 'panels')
                 AND COALESCE(extracted_data->>'extraction_status', 'pending') IN ('pending', 'failed')))
      ORDER BY id`,
    [today],
  );
  console.log(`Bench reports to read: ${rows.length}`);
  let done = 0;
  for (const { id } of rows) {
    const result = await runServerExtraction(id, { skipIfNotPending: false });
    if (result?.success === false) {
      throw new Error(`Document ${id}: ${result.error_message || "extraction failed"}`);
    }
    done += 1;
    console.log(`  [${done}/${rows.length}] document ${id} read`);
  }
}

async function resyncTodaysReportPatients(today) {
  const { rows } = await pool.query(
    `SELECT DISTINCT ON (d.patient_id) d.patient_id, a.id AS appointment_id
       FROM documents d
       JOIN appointments a ON a.patient_id = d.patient_id
      WHERE d.source = 'giniflow_lab' AND d.doc_date = $1::date AND d.extracted_data ? 'panels'
      ORDER BY d.patient_id, a.appointment_date DESC NULLS LAST`,
    [today],
  );
  for (const [i, r] of rows.entries()) {
    await syncBiomarkersFromLatestLabs(r.patient_id, r.appointment_id);
    console.log(`  [${i + 1}/${rows.length}] patient ${r.patient_id} re-synced`);
  }
}

try {
  await assertDatabaseCalm();
  const { rows: dateRow } = await pool.query(
    `SELECT (NOW() AT TIME ZONE 'Asia/Kolkata')::date::text AS today`,
  );
  const today = dateRow[0].today;
  const stale = await findUndatedNoteLabs(today);
  const patients = new Set(stale.map((r) => r.patient_id));
  console.log(
    `${today}: ${stale.length} note values dated today without a date in the note, ${patients.size} patients`,
  );
  for (const r of stale) {
    console.log(
      `  patient ${r.patient_id} appt ${r.appointment_id}: ${r.canonical_name} = ${r.result}`,
    );
  }

  if (!APPLY) {
    console.log(
      "Dry run — nothing changed. Re-run with --apply (and --extract to read today's bench reports).",
    );
  } else {
    const batches = chunk(stale, BATCH);
    const touched = new Map();
    for (const [i, batch] of batches.entries()) {
      const byAppt = await deleteBatch(batch, today);
      for (const r of batch) touched.set(r.appointment_id, r.patient_id);
      console.log(
        `  batch ${i + 1}/${batches.length}: removed ${batch.length} rows (${byAppt.size} appointments)`,
      );
    }
    for (const [apptId, patientId] of touched) {
      await syncBiomarkersFromLatestLabs(patientId, apptId);
    }
    console.log(
      `Removed ${stale.length} rows; biomarkers re-synced for ${touched.size} appointments.`,
    );
    if (EXTRACT) await extractTodaysBenchReports(today);
  }
  if (RESYNC) await resyncTodaysReportPatients(today);
} catch (e) {
  console.error("Stopped:", e.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
