// ── Lab HealthRay Sync — DB operations ──────────────────────────────────────

import pool from "../../config/db.js";
import { extractInvestigationSummary } from "./labHealthrayParser.js";

// Source priority — lower number wins (lab_healthray = 3, between report_extract and vitals_sheet)
const SOURCE_PRIORITY = {
  opd: 1,
  report_extract: 2,
  lab_healthray: 3,
  vitals_sheet: 4,
  prescription_parsed: 5,
  healthray: 6,
};

// ── Ensure lab_cases table exists ───────────────────────────────────────────
let tableReady = false;
export async function ensureLabCasesTable() {
  if (tableReady) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS lab_cases (
      id              SERIAL PRIMARY KEY,
      case_no         TEXT UNIQUE NOT NULL,
      patient_case_no TEXT NOT NULL,
      case_uid        TEXT NOT NULL,
      lab_case_id     INTEGER NOT NULL,
      lab_user_id     INTEGER,
      patient_id      INTEGER REFERENCES patients(id),
      appointment_id  INTEGER REFERENCES appointments(id),
      lab_branch_id   INTEGER DEFAULT 226,
      test_names      TEXT[],
      case_date       DATE,
      case_status     TEXT,
      pdf_file_name   TEXT,
      results_synced  BOOLEAN DEFAULT FALSE,
      raw_list_json   JSONB,
      raw_detail_json JSONB,
      investigation_summary JSONB,
      fetched_at      TIMESTAMPTZ DEFAULT NOW(),
      synced_at       TIMESTAMPTZ
    );
    ALTER TABLE lab_cases ADD COLUMN IF NOT EXISTS investigation_summary JSONB;
    CREATE INDEX IF NOT EXISTS idx_lab_cases_patient    ON lab_cases(patient_id);
    CREATE INDEX IF NOT EXISTS idx_lab_cases_appt       ON lab_cases(appointment_id);
    CREATE INDEX IF NOT EXISTS idx_lab_cases_date       ON lab_cases(case_date);
    CREATE INDEX IF NOT EXISTS idx_lab_cases_pending    ON lab_cases(results_synced) WHERE results_synced = FALSE;
  `);
  tableReady = true;
}

// ── Get highest case_no already processed ───────────────────────────────────
export async function getMaxCaseNo() {
  const { rows } = await pool.query(
    `SELECT MAX(case_no::integer) AS max_no FROM lab_cases WHERE case_no ~ '^[0-9]+$'`,
  );
  return rows[0]?.max_no || 0;
}

// ── Insert new case row (crash-safe anchor before fetching detail) ───────────
// Returns inserted id, or null if case_no already exists (UNIQUE conflict)
export async function insertLabCase({
  caseNo,
  patientCaseNo,
  caseUid,
  labCaseId,
  labUserId,
  labBranchId,
  testNames,
  caseDate,
  caseStatus,
  pdfFileName,
  rawListJson,
}) {
  try {
    const { rows } = await pool.query(
      `INSERT INTO lab_cases
         (case_no, patient_case_no, case_uid, lab_case_id, lab_user_id,
          lab_branch_id, test_names, case_date, case_status, pdf_file_name, raw_list_json)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)
       ON CONFLICT (case_no) DO NOTHING
       RETURNING id`,
      [
        caseNo,
        patientCaseNo,
        caseUid,
        labCaseId,
        labUserId || null,
        labBranchId || 226,
        testNames || [],
        caseDate || null,
        caseStatus || null,
        pdfFileName || null,
        JSON.stringify(rawListJson),
      ],
    );
    return rows[0]?.id || null; // null = already existed, skip
  } catch {
    return null;
  }
}

// ── Update case after detail fetch + lab_results written ────────────────────
export async function markLabCaseSynced(caseNo, { patientId, appointmentId, rawDetailJson }) {
  const summary = rawDetailJson ? extractInvestigationSummary(rawDetailJson) : null;
  await pool.query(
    `UPDATE lab_cases
     SET results_synced        = TRUE,
         patient_id            = COALESCE($2, patient_id),
         appointment_id        = COALESCE($3, appointment_id),
         raw_detail_json       = $4::jsonb,
         investigation_summary = $5::jsonb,
         synced_at             = NOW()
     WHERE case_no = $1`,
    [
      caseNo,
      patientId || null,
      appointmentId || null,
      JSON.stringify(rawDetailJson),
      summary ? JSON.stringify(summary) : null,
    ],
  );
}

// ── Get cases pending retry (results_synced=false, older than 10 min) ────────
export async function getPendingLabCases() {
  const { rows } = await pool.query(
    `SELECT * FROM lab_cases
     WHERE results_synced = FALSE
       AND fetched_at < NOW() - INTERVAL '10 minutes'
     ORDER BY fetched_at ASC
     LIMIT 50`,
  );
  return rows;
}

// ── Match patient by healthray_uid → patients.file_no ───────────────────────
export async function matchLabPatient(healthrayUid, patientCaseNo) {
  // Try multiple matching strategies
  if (healthrayUid) {
    // 1. Exact file_no match
    const r1 = await pool.query(`SELECT id FROM patients WHERE file_no = $1 LIMIT 1`, [
      healthrayUid,
    ]);
    if (r1.rows[0]) return r1.rows[0].id;

    // 2. Match as P_ prefixed file number
    if (!healthrayUid.startsWith("P_")) {
      const r2 = await pool.query(`SELECT id FROM patients WHERE file_no = $1 LIMIT 1`, [
        `P_${healthrayUid}`,
      ]);
      if (r2.rows[0]) return r2.rows[0].id;
    }

    // 3. Match by phone
    const r3 = await pool.query(`SELECT id FROM patients WHERE phone = $1 OR phone = $2 LIMIT 1`, [
      healthrayUid,
      `+91${healthrayUid}`,
    ]);
    if (r3.rows[0]) return r3.rows[0].id;
  }

  // 4. Try extracting file_no from patientCaseNo (format often contains the Gini ID)
  if (patientCaseNo) {
    const fileMatch = patientCaseNo.match(/P[_-]?\d+/i);
    if (fileMatch) {
      const fileNo = fileMatch[0].replace(/-/, "_").toUpperCase();
      const r4 = await pool.query(`SELECT id FROM patients WHERE UPPER(file_no) = $1 LIMIT 1`, [
        fileNo,
      ]);
      if (r4.rows[0]) return r4.rows[0].id;
    }
  }

  return null;
}

// ── Link appointment via healthray_order_id ──────────────────────────────────
export async function linkLabAppointment(healthrayOrderId) {
  if (!healthrayOrderId) return null;
  const { rows } = await pool.query(`SELECT id FROM appointments WHERE healthray_id = $1 LIMIT 1`, [
    String(healthrayOrderId),
  ]);
  return rows[0]?.id || null;
}

// ── Write lab results from parsed case ──────────────────────────────────────
// Patch ref_range + flag onto existing lab_healthray rows — no deletes/inserts
export async function patchLabRanges(patientId, caseDate, results) {
  if (!patientId || !results.length) return 0;
  let updated = 0;
  for (const r of results) {
    if (!r.refRange && !r.flag) continue;
    const { rowCount } = await pool.query(
      `UPDATE lab_results
       SET ref_range = COALESCE(ref_range, $1),
           flag      = COALESCE(flag,      $2)
       WHERE patient_id = $3
         AND canonical_name = $4
         AND test_date::date = $5::date
         AND source = 'lab_healthray'`,
      [r.refRange || null, r.flag || null, patientId, r.canonicalName, caseDate],
    );
    updated += rowCount;
  }
  return updated;
}

export async function syncLabCaseResults(patientId, appointmentId, caseDate, results) {
  if (!patientId || !results.length) return 0;

  // Clear existing lab_healthray results for this appointment to allow re-sync
  if (appointmentId) {
    await pool.query(
      `DELETE FROM lab_results WHERE appointment_id = $1 AND source = 'lab_healthray'`,
      [appointmentId],
    );
  }

  let written = 0;
  for (const r of results) {
    if (r.value === null) continue; // skip non-numeric results (e.g. "Positive", "Negative")

    // Always remove any existing lab_healthray row for same patient+test+date
    // Handles re-sync when appointmentId is null (no matching appointment)
    await pool.query(
      `DELETE FROM lab_results
       WHERE patient_id = $1 AND canonical_name = $2 AND test_date::date = $3::date AND source = 'lab_healthray'`,
      [patientId, r.canonicalName, caseDate],
    );

    // Skip if a better-or-equal source already exists for same patient + test + date
    const existing = await pool.query(
      `SELECT source FROM lab_results
       WHERE patient_id = $1 AND canonical_name = $2 AND test_date::date = $3::date
       ORDER BY CASE source
         WHEN 'opd'              THEN 1
         WHEN 'report_extract'   THEN 2
         WHEN 'lab_healthray'    THEN 3
         WHEN 'vitals_sheet'     THEN 4
         WHEN 'prescription_parsed' THEN 5
         WHEN 'healthray'        THEN 6
         ELSE 7
       END ASC LIMIT 1`,
      [patientId, r.canonicalName, caseDate],
    );
    if (existing.rows[0]) {
      const existingPriority = SOURCE_PRIORITY[existing.rows[0].source] ?? 99;
      if (existingPriority <= SOURCE_PRIORITY.lab_healthray) continue;
    }

    await pool
      .query(
        `INSERT INTO lab_results
         (patient_id, appointment_id, test_date, test_name, canonical_name, result, unit, ref_range, flag, source)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'lab_healthray')`,
        [
          patientId,
          appointmentId || null,
          caseDate,
          r.name,
          r.canonicalName,
          r.value,
          r.unit || null,
          r.refRange || null,
          r.flag || null,
        ],
      )
      .catch(() => {});
    written++;
  }

  return written;
}
