import "../loadEnv.js";
import pool from "../config/db.js";
import { URINE_MICROALBUMIN } from "../utils/labCanonical.js";
import { syncBiomarkersFromLatestLabs } from "../services/healthray/db.js";

const APPLY = process.argv.includes("--apply");
const sinceArg = process.argv.find((a) => a.startsWith("--since="));
const SINCE = sinceArg ? sinceArg.slice("--since=".length) : "1900-01-01";
const BATCH = 100;

const MISFILED_SQL = `
  SELECT id, patient_id, test_date::date::text AS test_date, result, test_name, unit, source
    FROM lab_results
   WHERE canonical_name = 'UACR'
     AND test_name ~* 'microalbumin'
     AND test_name !~* '(ratio|creat|acr)'
     AND unit ~* '^\\s*(mg|µg|ug|mcg)\\s*/\\s*(l|dl|ml)\\M'
     AND test_date::date >= $1::date
   ORDER BY id
   LIMIT $2`;

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

async function relabelBatch(rows) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`UPDATE lab_results SET canonical_name = $2 WHERE id = ANY($1::int[])`, [
      rows.map((r) => r.id),
      URINE_MICROALBUMIN,
    ]);
    const { rows: appts } = await client.query(
      `UPDATE appointments a
          SET biomarkers = (a.biomarkers - 'uacr')
                           || jsonb_build_object('_lab_dates',
                                COALESCE(a.biomarkers->'_lab_dates', '{}'::jsonb) - 'uacr')
         FROM jsonb_to_recordset($1::jsonb) AS m(patient_id int, test_date text, result text)
        WHERE a.patient_id = m.patient_id
          AND a.biomarkers->'_lab_dates'->>'uacr' = m.test_date
          AND a.biomarkers->>'uacr' ~ '^-?[0-9.]+$'
          AND m.result ~ '^-?[0-9.]+$'
          AND (a.biomarkers->>'uacr')::numeric = m.result::numeric
       RETURNING a.id, a.patient_id`,
      [
        JSON.stringify(
          rows.map(({ patient_id, test_date, result }) => ({
            patient_id,
            test_date,
            result: String(result),
          })),
        ),
      ],
    );
    await client.query("COMMIT");
    return appts;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

try {
  await assertDatabaseCalm();
  if (!APPLY) {
    const { rows } = await pool.query(MISFILED_SQL, [SINCE, 100000]);
    const patients = new Set(rows.map((r) => r.patient_id));
    console.log(
      `Since ${SINCE}: ${rows.length} microalbumin concentration rows filed as UACR, ${patients.size} patients`,
    );
    for (const r of rows.slice(0, 20)) {
      console.log(
        `  #${r.id} patient ${r.patient_id} ${r.test_date} ${r.test_name} = ${r.result} ${r.unit} (${r.source})`,
      );
    }
    console.log("Dry run — nothing changed. Re-run with --apply.");
  } else {
    let total = 0;
    const touched = new Map();
    for (let batch = 1; ; batch += 1) {
      const { rows } = await pool.query(MISFILED_SQL, [SINCE, BATCH]);
      if (!rows.length) break;
      const appts = await relabelBatch(rows);
      for (const a of appts) touched.set(a.id, a.patient_id);
      total += rows.length;
      console.log(
        `  batch ${batch}: relabelled ${rows.length} rows, cleared uACR on ${appts.length} visits`,
      );
    }
    for (const [apptId, patientId] of touched) {
      await syncBiomarkersFromLatestLabs(patientId, apptId);
    }
    console.log(`Relabelled ${total} rows; biomarkers re-synced for ${touched.size} visits.`);
  }
} catch (e) {
  console.error("Stopped:", e.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
