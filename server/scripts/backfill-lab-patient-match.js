/**
 * One-off backfill: re-match orphan lab_cases (patient_id IS NULL) using the
 * universal P_XXXXX file_no flow, auto-creating stub patients when needed,
 * and (re)writing lab_results from the already-stored raw_detail_json — no
 * lab API calls.
 *
 * Run:
 *   node server/scripts/backfill-lab-patient-match.js
 *   node server/scripts/backfill-lab-patient-match.js --dry-run
 *   node server/scripts/backfill-lab-patient-match.js --limit=200
 */
import { fileURLToPath } from "url";
import { dirname, join } from "path";
const __dirname = dirname(fileURLToPath(import.meta.url));

const dotenv = await import("dotenv");
dotenv.config({ path: join(__dirname, "..", ".env") });

const { default: pool } = await import("../config/db.js");
const {
  matchLabPatient,
  ensureLabPatient,
  linkLabAppointment,
  syncLabCaseResults,
  setLabCaseSource,
  abandonLabCase,
} = await import("../services/lab/db.js");
const { parseLabCaseResults, classifyCaseSource, countInhouseProgress } =
  await import("../services/lab/labHealthrayParser.js");

const dryRun = process.argv.includes("--dry-run");
const limitArg = process.argv.find((a) => a.startsWith("--limit="));
const limit = limitArg ? parseInt(limitArg.split("=")[1], 10) : 1000;

console.log(`Backfill lab patient match — dry-run=${dryRun} limit=${limit}`);

const { rows } = await pool.query(
  `SELECT case_no, patient_case_no, case_uid, lab_case_id, case_date,
          appointment_id, raw_list_json, raw_detail_json, case_source
     FROM lab_cases
    WHERE patient_id IS NULL
    ORDER BY fetched_at DESC
    LIMIT $1`,
  [limit],
);

console.log(`Found ${rows.length} orphan lab_cases`);

let matched = 0;
let created = 0;
let written = 0;
let outsourceAbandoned = 0;
let stillUnmatched = 0;

for (const row of rows) {
  const patientObj = row.raw_list_json?.patient || null;
  if (!patientObj) {
    stillUnmatched++;
    continue;
  }

  const detailSource = row.raw_detail_json
    ? classifyCaseSource(row.raw_detail_json)
    : classifyCaseSource(row.raw_list_json);
  const caseSource = detailSource === "unknown" ? "unknown" : detailSource;

  // Outsource-only — no in-house results expected; mark abandoned.
  if (caseSource === "outsource") {
    if (!dryRun) {
      await setLabCaseSource(row.case_no, "outsource");
      await abandonLabCase(row.case_no, "outsource-only");
    }
    outsourceAbandoned++;
    console.log(`  ${row.patient_case_no}: outsource-only → abandoned`);
    continue;
  }

  // Match patient
  let patientId = await matchLabPatient(patientObj.healthray_uid, row.patient_case_no, patientObj);
  let didCreate = false;
  if (!patientId) {
    if (dryRun) {
      const uid = patientObj.healthray_uid;
      console.log(
        `  ${row.patient_case_no}: would create patient file_no=${uid} name=${patientObj.patient_name || patientObj.first_name}`,
      );
    } else {
      patientId = await ensureLabPatient(patientObj);
      if (patientId) didCreate = true;
    }
  }

  if (!patientId) {
    stillUnmatched++;
    console.log(
      `  ${row.patient_case_no}: no P_ uid (uid=${patientObj.healthray_uid || "—"}) — skipped`,
    );
    continue;
  }

  matched++;
  if (didCreate) created++;

  if (!row.raw_detail_json) {
    console.log(`  ${row.patient_case_no}: matched but no raw_detail_json on file`);
    continue;
  }

  const detail = row.raw_detail_json;
  const results = parseLabCaseResults(detail);
  const caseDate =
    typeof row.case_date === "string"
      ? row.case_date.slice(0, 10)
      : row.case_date?.toISOString().slice(0, 10) || null;

  let appointmentId = row.appointment_id;
  if (!appointmentId && detail.healthray_order_id) {
    appointmentId = await linkLabAppointment(detail.healthray_order_id);
  }

  if (dryRun) {
    const { expected, ready } = countInhouseProgress(detail);
    console.log(
      `  ${row.patient_case_no}: would write ~${results.length} results | ${ready}/${expected} ready`,
    );
    continue;
  }

  const w = await syncLabCaseResults(patientId, appointmentId, caseDate, results);
  written += w;

  // Persist patient_id and source on the row
  await pool.query(
    `UPDATE lab_cases
       SET patient_id = $2,
           appointment_id = COALESCE($3, appointment_id),
           case_source = COALESCE($4, case_source),
           results_synced = CASE WHEN $5 > 0 THEN TRUE ELSE results_synced END,
           synced_at = CASE WHEN $5 > 0 THEN NOW() ELSE synced_at END
     WHERE case_no = $1`,
    [row.case_no, patientId, appointmentId || null, caseSource, w],
  );

  console.log(
    `  ${row.patient_case_no}: patient=${patientId}${didCreate ? " (NEW)" : ""} | src=${caseSource} | ${w} results written`,
  );
}

console.log(
  `\nDone: matched=${matched} created=${created} written=${written} outsourceAbandoned=${outsourceAbandoned} stillUnmatched=${stillUnmatched}`,
);

await pool.end();
