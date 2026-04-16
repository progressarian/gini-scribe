// ── Lab HealthRay Sync — DB operations ──────────────────────────────────────

import pool from "../../config/db.js";
import { extractInvestigationSummary } from "./labHealthrayParser.js";
import { SUPABASE_URL, SUPABASE_SERVICE_KEY, STORAGE_BUCKET } from "../../config/storage.js";
import { createLogger } from "../logger.js";

const { log: labLog } = createLogger("Lab PDF");

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
    ALTER TABLE lab_cases ADD COLUMN IF NOT EXISTS case_source TEXT;
    ALTER TABLE lab_cases ADD COLUMN IF NOT EXISTS retry_count INTEGER DEFAULT 0;
    ALTER TABLE lab_cases ADD COLUMN IF NOT EXISTS last_retry_at TIMESTAMPTZ;
    ALTER TABLE lab_cases ADD COLUMN IF NOT EXISTS retry_abandoned BOOLEAN DEFAULT FALSE;
    ALTER TABLE lab_cases ADD COLUMN IF NOT EXISTS pdf_storage_path TEXT;
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

// ── Download lab report PDF and store in Supabase ──────────────────────────
export async function downloadAndStoreLabPdf(
  patientId,
  caseNo,
  caseUid,
  caseId,
  userId,
  pdfFileName,
  caseDate,
) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    labLog("Skip", "Storage not configured");
    return null;
  }
  if (!patientId) return null;

  // Avoid re-downloading if already stored
  const existing = await pool.query(
    `SELECT pdf_storage_path FROM lab_cases WHERE case_no = $1 AND pdf_storage_path IS NOT NULL`,
    [caseNo],
  );
  if (existing.rows[0]?.pdf_storage_path) return existing.rows[0].pdf_storage_path;

  let result;
  try {
    const { fetchLabReportPdf } = await import("./labHealthrayApi.js");
    result = await fetchLabReportPdf(caseUid, caseId, userId);
  } catch (e) {
    labLog("Error", `PDF fetch failed for case ${caseNo}: ${e.message}`);
    return null;
  }
  if (!result?.buffer?.length) return null;

  const { buffer, contentType } = result;

  // Reject JSON error bodies
  if (contentType === "application/json" || (buffer.length < 2000 && buffer[0] === 0x7b)) {
    labLog("Reject", `JSON response for case ${caseNo}`);
    return null;
  }

  const ext = contentType === "image/jpeg" ? "jpg" : contentType === "image/png" ? "png" : "pdf";
  const fileName = pdfFileName || `lab_case_${caseNo}.${ext}`;
  const storagePath = `patients/${patientId}/lab/${fileName}`;

  try {
    const uploadRes = await fetch(
      `${SUPABASE_URL}/storage/v1/object/${STORAGE_BUCKET}/${storagePath}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
          "Content-Type": contentType || "application/pdf",
          "x-upsert": "true",
        },
        body: buffer,
      },
    );
    if (!uploadRes.ok) {
      const errText = await uploadRes.text().catch(() => "");
      labLog(
        "Error",
        `Supabase upload failed ${uploadRes.status} for case ${caseNo}: ${errText.slice(0, 200)}`,
      );
      return null;
    }

    // Create a documents record for the lab report PDF
    await pool.query(
      `INSERT INTO documents (patient_id, doc_type, title, file_name, storage_path, mime_type, doc_date, source, notes)
       VALUES ($1, 'lab_report', $2, $3, $4, $5, $6, 'lab_healthray', $7)
       ON CONFLICT DO NOTHING`,
      [
        patientId,
        `Lab Report - ${caseNo}`,
        fileName,
        storagePath,
        contentType || "application/pdf",
        caseDate || null,
        `lab_case:${caseNo}`,
      ],
    );

    // Update lab_cases with storage path
    await pool.query(`UPDATE lab_cases SET pdf_storage_path = $1 WHERE case_no = $2`, [
      storagePath,
      caseNo,
    ]);

    labLog("Stored", `${buffer.length} bytes for case ${caseNo} → ${storagePath}`);
    return storagePath;
  } catch (e) {
    labLog("Error", `Storage failed for case ${caseNo}: ${e.message}`);
    return null;
  }
}

// ── Get cases pending retry ─────────────────────────────────────────────────
// Skip outsource-only cases (results never come through this API) and rows
// already abandoned after the retry cap. Throttle each row to one attempt per
// 10 minutes to avoid hammering the API.
export async function getPendingLabCases() {
  const { rows } = await pool.query(
    `SELECT * FROM lab_cases
     WHERE results_synced = FALSE
       AND COALESCE(retry_abandoned, FALSE) = FALSE
       AND (case_source IS NULL OR case_source IN ('inhouse', 'mixed', 'unknown'))
       AND (last_retry_at IS NULL OR last_retry_at < NOW() - INTERVAL '10 minutes')
       AND fetched_at < NOW() - INTERVAL '10 minutes'
     ORDER BY fetched_at ASC
     LIMIT 50`,
  );
  return rows;
}

// Retry budget: ~14 days at one effective attempt per hour (cron is 15 min,
// gated by 10-min last_retry_at — so ~4/hour theoretical, ~1/hour practical).
const RETRY_CAP = 336;

export async function bumpLabCaseRetry(caseNo) {
  const { rows } = await pool.query(
    `UPDATE lab_cases
       SET retry_count = COALESCE(retry_count, 0) + 1,
           last_retry_at = NOW(),
           retry_abandoned = (COALESCE(retry_count, 0) + 1) >= $2
     WHERE case_no = $1
     RETURNING retry_count, retry_abandoned`,
    [caseNo, RETRY_CAP],
  );
  return rows[0] || null;
}

export async function setLabCaseSource(caseNo, source) {
  if (!source) return;
  await pool.query(
    `UPDATE lab_cases SET case_source = $2 WHERE case_no = $1 AND (case_source IS DISTINCT FROM $2)`,
    [caseNo, source],
  );
}

// Mark an outsource-only case as terminal — nothing further to fetch.
export async function abandonLabCase(caseNo, reason) {
  await pool.query(
    `UPDATE lab_cases
       SET retry_abandoned = TRUE,
           results_synced = TRUE,
           synced_at = COALESCE(synced_at, NOW())
     WHERE case_no = $1`,
    [caseNo],
  );
  void reason;
}

// ── Patient name normalization (lab patient → name string) ──────────────────
function buildPatientName(patientObj) {
  if (!patientObj) return null;
  const direct = patientObj.patient_name || patientObj.name;
  if (direct && String(direct).trim() && String(direct).trim() !== ".") {
    return String(direct).trim();
  }
  const parts = [patientObj.first_name, patientObj.middle_name, patientObj.last_name]
    .filter((s) => s && String(s).trim() && String(s).trim() !== ".")
    .map((s) => String(s).trim());
  return parts.length ? parts.join(" ") : null;
}

function ageFromDob(dob) {
  if (!dob) return null;
  const d = new Date(dob);
  if (isNaN(d)) return null;
  const ms = Date.now() - d.getTime();
  return Math.floor(ms / (365.25 * 24 * 3600 * 1000));
}

function normalizeSex(g) {
  if (!g) return null;
  const s = String(g).trim().toLowerCase();
  if (s.startsWith("m")) return "Male";
  if (s.startsWith("f")) return "Female";
  if (s.startsWith("o")) return "Other";
  return null;
}

// ── Match patient — universal P_ file_no first, never phone-only ────────────
// HealthRay's patient.healthray_uid is the authoritative per-patient ID
// (e.g. "P_179589") and is mirrored as patients.file_no in our DB.
// Phone matching is intentionally demoted: shared family/clinic numbers cause
// wrong-patient links (e.g. one phone → many distinct P_XXXXX patients).
export async function matchLabPatient(healthrayUid, patientCaseNo, patientObj) {
  // 1) Exact file_no = healthray_uid (the universal P_ ID)
  if (healthrayUid) {
    const uid = String(healthrayUid).trim();
    const r = await pool.query(`SELECT id FROM patients WHERE file_no = $1 LIMIT 1`, [uid]);
    if (r.rows[0]) return r.rows[0].id;
  }

  // 2) Other identifier-ish fields → file_no exact / P_ prefixed / embedded P_\d+
  const tryIds = new Set();
  if (patientCaseNo) tryIds.add(String(patientCaseNo));
  if (patientObj && typeof patientObj === "object") {
    for (const key of [
      "uhid",
      "patient_uhid",
      "registration_no",
      "reg_no",
      "file_no",
      "patient_id",
      "uid",
      "mr_no",
      "mrn",
      "hospital_no",
      "patient_code",
      "emr_no",
    ]) {
      const val = patientObj[key];
      if (val) tryIds.add(String(val));
    }
  }
  for (const id of tryIds) {
    const r1 = await pool.query(`SELECT id FROM patients WHERE file_no = $1 LIMIT 1`, [id]);
    if (r1.rows[0]) return r1.rows[0].id;

    if (!/^P[_-]/i.test(id)) {
      const r2 = await pool.query(`SELECT id FROM patients WHERE file_no = $1 LIMIT 1`, [
        `P_${id}`,
      ]);
      if (r2.rows[0]) return r2.rows[0].id;
    }

    const pMatch = id.match(/P[_-]?\d+/i);
    if (pMatch) {
      const fileNo = pMatch[0].replace(/-/, "_").toUpperCase();
      const r3 = await pool.query(`SELECT id FROM patients WHERE UPPER(file_no) = $1 LIMIT 1`, [
        fileNo,
      ]);
      if (r3.rows[0]) return r3.rows[0].id;
    }
  }

  // 3) Name + DOB (strong identifier when both present)
  const name = buildPatientName(patientObj);
  const dob = patientObj?.birth_date || patientObj?.dob || null;
  if (name && dob) {
    const r = await pool.query(
      `SELECT id FROM patients
         WHERE LOWER(name) = LOWER($1) AND dob = $2::date
         LIMIT 1`,
      [name, dob],
    );
    if (r.rows[0]) return r.rows[0].id;
  }

  // Phone is intentionally NOT used as a match key — family members often
  // share a number, so matching on phone merges unrelated patients.
  return null;
}

// ── Auto-create a stub patient from the lab API patient object ──────────────
// Only triggers when healthray_uid looks like a real "P_XXXXX" universal ID.
// Avoids merging on phone (would re-create the shared-phone collision).
export async function ensureLabPatient(patientObj) {
  const uid = patientObj?.healthray_uid ? String(patientObj.healthray_uid).trim() : null;
  if (!uid || !/^P_\d+$/i.test(uid)) return null;
  const fileNo = uid.toUpperCase();

  const existing = await pool.query(`SELECT id FROM patients WHERE file_no = $1 LIMIT 1`, [fileNo]);
  if (existing.rows[0]) return existing.rows[0].id;

  const name = buildPatientName(patientObj) || fileNo;
  const phoneRaw =
    patientObj?.mobile_number ||
    patientObj?.phone ||
    patientObj?.mobile ||
    patientObj?.contact_no ||
    null;
  const phone = phoneRaw ? String(phoneRaw).replace(/\s+/g, "") : null;
  const dob = patientObj?.birth_date || patientObj?.dob || null;
  const age = ageFromDob(dob);
  const sex = normalizeSex(patientObj?.gender);

  // Two unique constraints on patients: file_no and phone. The phone is shared
  // across families/patients in HealthRay, so on phone conflict we INSERT
  // without phone — keeping a distinct row per P_XXXXX, never merging by phone.
  const tryInsert = async (withPhone) => {
    const cols = withPhone
      ? `(name, phone, file_no, age, sex, dob)`
      : `(name, file_no, age, sex, dob)`;
    const placeholders = withPhone ? `$1, $2, $3, $4, $5, $6::date` : `$1, $2, $3, $4, $5::date`;
    const params = withPhone ? [name, phone, fileNo, age, sex, dob] : [name, fileNo, age, sex, dob];
    return pool.query(`INSERT INTO patients ${cols} VALUES (${placeholders}) RETURNING id`, params);
  };

  try {
    const ins = await tryInsert(!!phone);
    return ins.rows[0].id;
  } catch (e) {
    if (e.code !== "23505") throw e;
    // file_no race — return whoever already has it
    const byFile = await pool.query(`SELECT id FROM patients WHERE file_no = $1 LIMIT 1`, [fileNo]);
    if (byFile.rows[0]) return byFile.rows[0].id;
    // Phone collision — retry without phone to keep distinct patient
    try {
      const ins2 = await tryInsert(false);
      return ins2.rows[0].id;
    } catch (e2) {
      if (e2.code === "23505") {
        const recheck = await pool.query(`SELECT id FROM patients WHERE file_no = $1 LIMIT 1`, [
          fileNo,
        ]);
        return recheck.rows[0]?.id || null;
      }
      throw e2;
    }
  }
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
         (patient_id, appointment_id, test_date, test_name, canonical_name, result, unit, ref_range, flag, panel_name, source)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'lab_healthray')`,
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
          r.category || null,
        ],
      )
      .catch(() => {});
    written++;
  }

  return written;
}
