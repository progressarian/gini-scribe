// ── Lab HealthRay Sync — DB operations ──────────────────────────────────────

import pool from "../../config/db.js";
import { LIVE_LAB_CASE_SQL } from "../giniflow/testsHold.js";
import { isNonTest } from "../../utils/nonTests.js";
import { inflateSync } from "zlib";
import { extractInvestigationSummary, isLabCasePrintable } from "./labHealthrayParser.js";
import { SUPABASE_URL, SUPABASE_SERVICE_KEY, STORAGE_BUCKET } from "../../config/storage.js";
import { createLogger } from "../logger.js";

const { log: labLog } = createLogger("Lab PDF");

const SOURCE_PRIORITY = {
  opd: 1,
  report_extract: 2,
  lab_healthray: 3,
  vitals_sheet: 4,
  prescription_parsed: 5,
  healthray: 6,
};

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
    ALTER TABLE lab_cases ADD COLUMN IF NOT EXISTS pdf_unavailable BOOLEAN DEFAULT FALSE;
    -- PDF download backoff schedule. Initial attempt happens at sync time;
    -- failures schedule a retry via pdf_next_attempt_at (30–40 min, then 4 h
    -- repeating for up to 3 days from pdf_first_attempt_at).
    ALTER TABLE lab_cases ADD COLUMN IF NOT EXISTS pdf_attempt_count INTEGER DEFAULT 0;
    ALTER TABLE lab_cases ADD COLUMN IF NOT EXISTS pdf_first_attempt_at TIMESTAMPTZ;
    ALTER TABLE lab_cases ADD COLUMN IF NOT EXISTS pdf_last_attempt_at TIMESTAMPTZ;
    ALTER TABLE lab_cases ADD COLUMN IF NOT EXISTS pdf_next_attempt_at TIMESTAMPTZ;
    -- Safety net: even with the in-flight gates (isLabCasePrintable +
    -- looksLikeBlankLabPdf), a placeholder PDF could slip through. The blank
    -- sweep re-validates each stored PDF once it is at least 2 hours old.
    -- pdf_blank_checked_at = NOW() means we have confirmed the file is real.
    ALTER TABLE lab_cases ADD COLUMN IF NOT EXISTS pdf_blank_checked_at TIMESTAMPTZ;
    CREATE INDEX IF NOT EXISTS idx_lab_cases_patient    ON lab_cases(patient_id);
    CREATE INDEX IF NOT EXISTS idx_lab_cases_appt       ON lab_cases(appointment_id);
    CREATE INDEX IF NOT EXISTS idx_lab_cases_date       ON lab_cases(case_date);
    CREATE INDEX IF NOT EXISTS idx_lab_cases_pending    ON lab_cases(results_synced) WHERE results_synced = FALSE;
    CREATE INDEX IF NOT EXISTS idx_lab_cases_pdf_retry  ON lab_cases(pdf_next_attempt_at)
      WHERE pdf_storage_path IS NULL AND COALESCE(pdf_unavailable, FALSE) = FALSE;
  `);
  tableReady = true;
}
export async function getMaxCaseNo() {
  const { rows } = await pool.query(
    `SELECT MAX(case_no::integer) AS max_no FROM lab_cases WHERE case_no ~ '^[0-9]+$'`,
  );
  return rows[0]?.max_no || 0;
}

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
export async function linkLabCasePatient(caseNo, patientId) {
  if (!patientId) return;
  await pool.query(
    `UPDATE lab_cases SET patient_id = $2
      WHERE case_no = $1 AND patient_id IS DISTINCT FROM $2 AND patient_id IS NULL`,
    [caseNo, patientId],
  );
}
const PDF_RETRY_BUDGET_MS = 3 * 24 * 60 * 60 * 1000;
const PDF_FIRST_BACKOFF_MIN_MS = 30 * 60 * 1000;
const PDF_FIRST_BACKOFF_JITTER_MS = 10 * 60 * 1000; // → 30–40 min
const PDF_LATER_BACKOFF_MS = 4 * 60 * 60 * 1000;

function looksLikeBlankLabPdf(buffer) {
  if (buffer.length >= 61_000) return false;
  const ascii = buffer.toString("latin1");
  let cursor = 0;
  let totalTj = 0;
  while (true) {
    const sStart = ascii.indexOf("stream\n", cursor);
    if (sStart < 0) break;
    const dataStart = sStart + "stream\n".length;
    const sEnd = ascii.indexOf("\nendstream", dataStart);
    if (sEnd < 0) break;
    let decoded = buffer.subarray(dataStart, sEnd);
    try {
      decoded = inflateSync(decoded);
    } catch {}
    const text = decoded.toString("latin1");
    totalTj += (text.match(/\bTj\b/g) || []).length + (text.match(/\bTJ\b/g) || []).length;
    if (totalTj >= 60) return false; // early exit — clearly a real report
    cursor = sEnd;
  }
  return totalTj < 60;
}

function computePdfNextAttemptDelayMs(attemptCount) {
  if (attemptCount <= 1) {
    return PDF_FIRST_BACKOFF_MIN_MS + Math.floor(Math.random() * PDF_FIRST_BACKOFF_JITTER_MS);
  }
  return PDF_LATER_BACKOFF_MS;
}

async function recordPdfAttemptStart(caseNo) {
  const { rows } = await pool.query(
    `UPDATE lab_cases
        SET pdf_attempt_count   = COALESCE(pdf_attempt_count, 0) + 1,
            pdf_first_attempt_at = COALESCE(pdf_first_attempt_at, NOW()),
            pdf_last_attempt_at  = NOW()
      WHERE case_no = $1
      RETURNING pdf_attempt_count, pdf_first_attempt_at`,
    [caseNo],
  );
  return rows[0] || { pdf_attempt_count: 1, pdf_first_attempt_at: new Date() };
}

async function schedulePdfRetry(caseNo, attemptCount, firstAttemptAt) {
  const ageMs = firstAttemptAt ? Date.now() - new Date(firstAttemptAt).getTime() : 0;
  if (ageMs >= PDF_RETRY_BUDGET_MS) {
    // Exhausted 3-day budget — mark unavailable so retry loops stop hitting it.
    await pool.query(
      `UPDATE lab_cases
          SET pdf_unavailable = TRUE,
              pdf_next_attempt_at = NULL
        WHERE case_no = $1`,
      [caseNo],
    );
    labLog(
      "Abandon",
      `case ${caseNo}: PDF retry budget exhausted after ${attemptCount} attempts — marked unavailable`,
    );
    return null;
  }
  const delayMs = computePdfNextAttemptDelayMs(attemptCount);
  const nextAt = new Date(Date.now() + delayMs);
  await pool.query(`UPDATE lab_cases SET pdf_next_attempt_at = $2 WHERE case_no = $1`, [
    caseNo,
    nextAt,
  ]);
  const minutes = Math.round(delayMs / 60000);
  labLog("Retry", `case ${caseNo}: attempt ${attemptCount} failed — next try in ${minutes} min`);
  return nextAt;
}

export async function downloadAndStoreLabPdf(
  patientId,
  caseNo,
  caseUid,
  caseId,
  userId,
  pdfFileName,
  caseDate,
  caseDetail = null,
) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    labLog("Skip", "Storage not configured");
    return null;
  }
  if (!patientId) {
    labLog("Skip", `case ${caseNo}: no patientId`);
    return null;
  }

  const { rows: pre } = await pool.query(
    `SELECT pdf_storage_path, pdf_unavailable, pdf_next_attempt_at, case_status
       FROM lab_cases WHERE case_no = $1`,
    [caseNo],
  );
  if (pre[0]?.pdf_storage_path) return pre[0].pdf_storage_path;
  if (pre[0]?.pdf_unavailable) {
    labLog("Skip", `case ${caseNo}: pdf_unavailable=true`);
    return null;
  }
  if (pre[0]?.pdf_next_attempt_at && new Date(pre[0].pdf_next_attempt_at) > new Date()) {
    const minLeft = Math.round(
      (new Date(pre[0].pdf_next_attempt_at).getTime() - Date.now()) / 60000,
    );
    labLog("Skip", `case ${caseNo}: next retry in ${minLeft} min`);
    return null;
  }
  let detailForGate = caseDetail;
  if (!detailForGate) {
    try {
      const { fetchLabCaseDetail } = await import("./labHealthrayApi.js");
      detailForGate = await fetchLabCaseDetail(caseUid, caseId, userId);
    } catch (e) {
      labLog("Error", `case ${caseNo}: detail fetch failed before PDF gate — ${e.message}`);
      // Fall through; the post-fetch content-emptiness gate is the safety net.
    }
  }
  const printable = isLabCasePrintable(pre[0]?.case_status, detailForGate);
  if (!printable.ready) {
    const attempt = await recordPdfAttemptStart(caseNo);
    await schedulePdfRetry(caseNo, attempt.pdf_attempt_count, attempt.pdf_first_attempt_at);
    labLog("Skip", `case ${caseNo}: ${printable.reason} — deferring PDF download`);
    return null;
  }

  const attempt = await recordPdfAttemptStart(caseNo);
  const attemptCount = attempt.pdf_attempt_count;
  const firstAttemptAt = attempt.pdf_first_attempt_at;

  let result;
  try {
    const { fetchLabReportPdf } = await import("./labHealthrayApi.js");
    result = await fetchLabReportPdf(caseUid, caseId, userId);
  } catch (e) {
    labLog("Error", `PDF fetch failed for case ${caseNo}: ${e.message}`);
    await schedulePdfRetry(caseNo, attemptCount, firstAttemptAt);
    return null;
  }
  if (result?.unavailable) {
    await pool.query(
      `UPDATE lab_cases
          SET pdf_unavailable = TRUE,
              pdf_next_attempt_at = NULL
        WHERE case_no = $1`,
      [caseNo],
    );
    labLog("Skip", `case ${caseNo}: marked pdf_unavailable (no report on HealthRay)`);
    return null;
  }
  if (!result?.buffer?.length) {
    labLog(
      "Skip",
      `case ${caseNo}: API returned empty/null (uid=${caseUid}, id=${caseId}, user=${userId})`,
    );
    await schedulePdfRetry(caseNo, attemptCount, firstAttemptAt);
    return null;
  }
  const { buffer, contentType } = result;

  if (contentType === "application/json" || (buffer.length < 2000 && buffer[0] === 0x7b)) {
    labLog("Reject", `JSON response for case ${caseNo}`);
    await schedulePdfRetry(caseNo, attemptCount, firstAttemptAt);
    return null;
  }

  const isPdf = !contentType || contentType === "application/pdf";
  if (isPdf) {
    const head = buffer.subarray(0, 5).toString("ascii");
    const tail = buffer.subarray(-1024).toString("ascii");
    if (head !== "%PDF-" || !tail.includes("%%EOF")) {
      labLog(
        "Reject",
        `Invalid PDF for case ${caseNo} (head="${head}", hasEOF=${tail.includes("%%EOF")}, bytes=${buffer.length})`,
      );
      await schedulePdfRetry(caseNo, attemptCount, firstAttemptAt);
      return null;
    }

    if (looksLikeBlankLabPdf(buffer)) {
      labLog(
        "Reject",
        `Blank/template PDF for case ${caseNo} (bytes=${buffer.length}) — scheduling retry`,
      );
      await schedulePdfRetry(caseNo, attemptCount, firstAttemptAt);
      return null;
    }
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
      await schedulePdfRetry(caseNo, attemptCount, firstAttemptAt);
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

    await pool.query(
      `UPDATE lab_cases
          SET pdf_storage_path = $1,
              pdf_unavailable = FALSE,
              pdf_next_attempt_at = NULL,
              pdf_blank_checked_at = NULL
        WHERE case_no = $2`,
      [storagePath, caseNo],
    );

    labLog("Stored", `${buffer.length} bytes for case ${caseNo} → ${storagePath}`);
    return storagePath;
  } catch (e) {
    labLog("Error", `Storage failed for case ${caseNo}: ${e.message}`);
    await schedulePdfRetry(caseNo, attemptCount, firstAttemptAt);
    return null;
  }
}
const BLANK_RECHECK_AGE_MS = 2 * 60 * 60 * 1000; // 2 hours

async function fetchStoredPdfBuffer(storagePath) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return null;
  const sign = await fetch(
    `${SUPABASE_URL}/storage/v1/object/sign/${STORAGE_BUCKET}/${storagePath}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ expiresIn: 60 }),
    },
  );
  if (!sign.ok) return null;
  const sj = await sign.json();
  const signed = sj.signedURL || sj.signedUrl;
  if (!signed) return null;
  const url = signed.startsWith("http") ? signed : `${SUPABASE_URL}/storage/v1${signed}`;
  const r = await fetch(url);
  if (!r.ok) return null;
  return Buffer.from(await r.arrayBuffer());
}

async function deleteSupabaseObject(storagePath) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return false;
  const r = await fetch(`${SUPABASE_URL}/storage/v1/object/${STORAGE_BUCKET}/${storagePath}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` },
  });
  return r.ok;
}

export async function sweepBlankStoredLabPdfs({ limit = 50 } = {}) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return { scanned: 0, blanks: 0, verified: 0, errors: 0 };
  }
  const { rows } = await pool.query(
    `SELECT lc.case_no, lc.patient_id, lc.pdf_storage_path,
            lc.pdf_attempt_count, lc.pdf_first_attempt_at
       FROM lab_cases lc
      WHERE lc.pdf_storage_path IS NOT NULL
        AND lc.pdf_blank_checked_at IS NULL
        AND COALESCE(lc.pdf_first_attempt_at, lc.fetched_at)
              < NOW() - ($1 || ' milliseconds')::interval
      ORDER BY COALESCE(lc.pdf_first_attempt_at, lc.fetched_at) ASC
      LIMIT $2`,
    [BLANK_RECHECK_AGE_MS, limit],
  );
  if (!rows.length) return { scanned: 0, blanks: 0, verified: 0, errors: 0 };

  let blanks = 0;
  let verified = 0;
  let errors = 0;
  for (const row of rows) {
    try {
      const buf = await fetchStoredPdfBuffer(row.pdf_storage_path);
      if (!buf) {
        errors++;
        labLog("Sweep", `case ${row.case_no}: fetch failed — skipping`);
        continue;
      }
      if (looksLikeBlankLabPdf(buf)) {
        await deleteSupabaseObject(row.pdf_storage_path);
        await pool.query(
          `DELETE FROM documents
             WHERE patient_id = $1 AND source = 'lab_healthray' AND notes = $2`,
          [row.patient_id, `lab_case:${row.case_no}`],
        );
        await pool.query(
          `UPDATE lab_cases
              SET pdf_storage_path     = NULL,
                  pdf_unavailable      = FALSE,
                  pdf_attempt_count    = 0,
                  pdf_first_attempt_at = NULL,
                  pdf_last_attempt_at  = NULL,
                  pdf_next_attempt_at  = NULL,
                  pdf_blank_checked_at = NULL
            WHERE case_no = $1`,
          [row.case_no],
        );
        blanks++;
        labLog(
          "Sweep",
          `case ${row.case_no}: blank PDF cleared (bytes=${buf.length}) — retry cron will re-download`,
        );
      } else {
        await pool.query(`UPDATE lab_cases SET pdf_blank_checked_at = NOW() WHERE case_no = $1`, [
          row.case_no,
        ]);
        verified++;
      }
    } catch (e) {
      errors++;
      labLog("Sweep", `case ${row.case_no} error: ${e.message}`);
    }
  }
  labLog(
    "Sweep",
    `Done — scanned=${rows.length} blanks=${blanks} verified=${verified} errors=${errors}`,
  );
  return { scanned: rows.length, blanks, verified, errors };
}

export async function getPdfPendingCases({ limit = 50 } = {}) {
  const { rows } = await pool.query(
    `SELECT case_no, patient_case_no, case_uid, lab_case_id, lab_user_id,
            patient_id, pdf_file_name, case_date, case_status, results_synced,
            pdf_attempt_count, pdf_first_attempt_at, pdf_next_attempt_at
       FROM lab_cases
      WHERE patient_id IS NOT NULL
        AND pdf_storage_path IS NULL
        AND COALESCE(pdf_unavailable, FALSE) = FALSE
        AND COALESCE(retry_abandoned, FALSE) = FALSE
        AND LOWER(REGEXP_REPLACE(COALESCE(case_status, ''), '[\\s_]', '', 'g')) <> 'cancelled'
        AND (pdf_next_attempt_at IS NULL OR pdf_next_attempt_at <= NOW())
      ORDER BY pdf_next_attempt_at ASC NULLS FIRST, case_date DESC
      LIMIT $1`,
    [limit],
  );
  return rows;
}

export async function getPartialLabCases({ limit = 50 } = {}) {
  const { rows } = await pool.query(
    `SELECT * FROM lab_cases
      WHERE results_synced = TRUE
        AND COALESCE(retry_abandoned, FALSE) = FALSE
        AND (case_source IS NULL OR case_source IN ('inhouse', 'mixed', 'unknown'))
        AND pdf_storage_path IS NULL
        AND COALESCE(pdf_unavailable, FALSE) = FALSE
        AND raw_detail_json->>'reported_on' IS NULL
        AND case_date >= CURRENT_DATE - INTERVAL '7 days'
        AND (last_retry_at IS NULL OR last_retry_at < NOW() - INTERVAL '5 minutes')
      ORDER BY last_retry_at ASC NULLS FIRST, case_date DESC
      LIMIT $1`,
    [limit],
  );
  return rows;
}

export async function clearLabCasePdfBackoff(caseNo) {
  await pool.query(`UPDATE lab_cases SET pdf_next_attempt_at = NULL WHERE case_no = $1`, [caseNo]);
}
export async function touchLabCaseRetryAt(caseNo) {
  await pool.query(`UPDATE lab_cases SET last_retry_at = NOW() WHERE case_no = $1`, [caseNo]);
}
export async function getPendingLabCases() {
  const { rows } = await pool.query(
    `SELECT lc.* FROM lab_cases lc
     WHERE lc.results_synced = FALSE
       AND ${LIVE_LAB_CASE_SQL("lc")}
       AND COALESCE(retry_abandoned, FALSE) = FALSE
       AND (case_source IS NULL OR case_source IN ('inhouse', 'mixed', 'unknown'))
       AND (last_retry_at IS NULL OR last_retry_at < NOW() - INTERVAL '10 minutes')
       AND fetched_at < NOW() - INTERVAL '10 minutes'
     ORDER BY fetched_at ASC
     LIMIT 50`,
  );
  return rows;
}
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

export async function matchLabPatient(healthrayUid, patientCaseNo, patientObj) {
  // 1) Exact file_no = healthray_uid (the universal P_ ID)
  if (healthrayUid) {
    const uid = String(healthrayUid).trim();
    const r = await pool.query(`SELECT id FROM patients WHERE file_no = $1 LIMIT 1`, [uid]);
    if (r.rows[0]) return r.rows[0].id;
  }

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

  return null;
}

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

export async function linkLabAppointment(healthrayOrderId) {
  if (!healthrayOrderId) return null;
  const { rows } = await pool.query(`SELECT id FROM appointments WHERE healthray_id = $1 LIMIT 1`, [
    String(healthrayOrderId),
  ]);
  return rows[0]?.id || null;
}
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
    if (r.value === null) continue;
    if (isNonTest(r.canonicalName) || isNonTest(r.testName)) continue;

    await pool.query(
      `DELETE FROM lab_results
       WHERE patient_id = $1 AND canonical_name = $2 AND test_date::date = $3::date AND source = 'lab_healthray'`,
      [patientId, r.canonicalName, caseDate],
    );

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
