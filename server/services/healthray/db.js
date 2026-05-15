// ── HealthRay Sync DB operations ────────────────────────────────────────────

import pool from "../../config/db.js";
import { SUPABASE_URL, SUPABASE_SERVICE_KEY, STORAGE_BUCKET } from "../../config/storage.js";
import { mapRecordType, toISTDate } from "./mappers.js";
import { createLogger } from "../logger.js";
import { normalizeTestName } from "../../utils/labNormalization.js";
import { parseLabDate } from "../../utils/labDate.js";
import { stripFormPrefix, canonicalMedKey, routeForForm } from "../medication/normalize.js";
import { enrichMedWithDays } from "../medication/daysOfWeek.js";
import { findEarliestStartDates, resolveStartedDate } from "../medication/historicalStart.js";
import { markMedicationVisitStatus } from "../medication/visitStatus.js";
import { savePrescriptionForVisit, buildVisitPayloadFromDb } from "../prescriptionAutoSave.js";
import { normalizeWhenToTake } from "../../schemas/index.js";

// Build the visit payload from current DB state and persist a prescription
// PDF document for an appointment that has just been marked as seen. Always
// invoked outside the transaction in markAppointmentAsSeen so a slow PDF
// render or storage upload doesn't hold DB locks.
async function autoSavePrescriptionAfterSeen(patientId, appointmentId, consultationId) {
  if (!patientId) return;
  const payload = await buildVisitPayloadFromDb(patientId, { appointmentId });
  if (!payload) return;
  await savePrescriptionForVisit(patientId, payload, {
    appointmentId,
    consultationId,
    source: "visit",
    titlePrefix: "Prescription — Visit",
  });
}
const { log, error } = createLogger("HealthRay Sync");

// ── Download HealthRay file and store in Supabase ───────────────────────────
export async function downloadAndStore(
  patientId,
  docId,
  fileUrl,
  fileName,
  attachmentId,
  recordType,
  medicalRecordId,
) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    log("DB", `downloadAndStore skip: storage not configured`);
    return null;
  }

  let buffer, contentType;

  // 1. Try the actual PDF download endpoint (not thumbnail)
  if (attachmentId) {
    try {
      const { downloadMedicalRecordFile } = await import("./client.js");
      const result = await downloadMedicalRecordFile(
        attachmentId,
        recordType || "Prescription/Rx",
        medicalRecordId || null, // null = omit medical_record_id from URL; attachment ID in path is primary key
      );
      if (result?.buffer?.length > 0) {
        buffer = result.buffer;
        contentType = result.contentType;
        log(
          "DB",
          `downloadAndStore: got actual file via download endpoint — ${buffer.length} bytes (${contentType}) for doc ${docId}`,
        );
      }
    } catch (e) {
      log("DB", `downloadAndStore: download endpoint failed for doc ${docId}: ${e.message}`);
    }
  }

  // 2. Fallback: download from the thumbnail/file URL
  if (!buffer && fileUrl) {
    try {
      const fileRes = await fetch(fileUrl);
      if (fileRes.ok) {
        buffer = Buffer.from(await fileRes.arrayBuffer());
        contentType = fileRes.headers.get("content-type")?.split(";")[0].trim();
      } else {
        log("DB", `downloadAndStore: thumbnail fetch failed ${fileRes.status} for doc ${docId}`);
      }
    } catch (e) {
      log("DB", `downloadAndStore: thumbnail fetch error for doc ${docId}: ${e.message}`);
    }
  }

  if (!buffer || buffer.length === 0) return null;

  // Reject JSON responses — HealthRay returns HTTP 200 with JSON error body when auth/params fail
  if (contentType === "application/json" || buffer.slice(0, 1).toString() === "{") {
    log("DB", `downloadAndStore: rejecting JSON response for doc ${docId} (HealthRay error body)`);
    return null;
  }

  // Detect MIME from actual content or filename when S3 returns generic type
  if (!contentType || contentType === "application/octet-stream") {
    const urlPath = (fileUrl || "").split("?")[0];
    const urlExt = urlPath.split(".").pop().toLowerCase();
    const extMime = {
      pdf: "application/pdf",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      png: "image/png",
    };
    contentType =
      extMime[urlExt] || extMime[fileName?.split(".").pop().toLowerCase()] || "application/pdf";
  }
  log("DB", `downloadAndStore: storing ${buffer.length} bytes (${contentType}) for doc ${docId}`);

  try {
    const extMap = { "application/pdf": "pdf", "image/jpeg": "jpg", "image/png": "png" };
    const ext = extMap[contentType] || fileName?.split(".").pop() || "pdf";
    const storageName = fileName?.replace(/\.[^.]+$/, `.${ext}`) || `healthray_${docId}.${ext}`;
    const storagePath = `patients/${patientId}/healthray/${storageName}`;

    const uploadRes = await fetch(
      `${SUPABASE_URL}/storage/v1/object/${STORAGE_BUCKET}/${storagePath}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
          "Content-Type": contentType,
          "x-upsert": "true",
        },
        body: buffer,
      },
    );
    if (!uploadRes.ok) {
      const errText = await uploadRes.text().catch(() => "");
      error(
        "downloadAndStore",
        `Supabase upload failed ${uploadRes.status} for doc ${docId}: ${errText.slice(0, 200)}`,
      );
      return null;
    }

    await pool.query(`UPDATE documents SET storage_path = $1, mime_type = $2 WHERE id = $3`, [
      storagePath,
      contentType,
      docId,
    ]);
    return storagePath;
  } catch (e) {
    error("downloadAndStore", `Failed for doc ${docId}: ${e.message}`);
    return null;
  }
}

// ── Ensure sync columns exist ───────────────────────────────────────────────
let columnsReady = false;
export async function ensureSyncColumns() {
  if (columnsReady) return;
  await pool.query(`
    ALTER TABLE appointments
      ADD COLUMN IF NOT EXISTS healthray_id TEXT;
    ALTER TABLE appointments
      ADD COLUMN IF NOT EXISTS healthray_clinical_notes TEXT;
    ALTER TABLE appointments
      ADD COLUMN IF NOT EXISTS healthray_diagnoses JSONB DEFAULT '[]'::jsonb;
    ALTER TABLE appointments
      ADD COLUMN IF NOT EXISTS healthray_medications JSONB DEFAULT '[]'::jsonb;
    ALTER TABLE appointments
      ADD COLUMN IF NOT EXISTS healthray_previous_medications JSONB DEFAULT '[]'::jsonb;
    ALTER TABLE appointments
      ADD COLUMN IF NOT EXISTS healthray_labs JSONB DEFAULT '[]'::jsonb;
    ALTER TABLE appointments
      ADD COLUMN IF NOT EXISTS healthray_advice TEXT;
    ALTER TABLE appointments
      ADD COLUMN IF NOT EXISTS healthray_investigations JSONB DEFAULT '[]'::jsonb;
    ALTER TABLE appointments
      ADD COLUMN IF NOT EXISTS healthray_follow_up JSONB;
    ALTER TABLE doctors
      ADD COLUMN IF NOT EXISTS healthray_id INTEGER;
    ALTER TABLE vitals
      ADD COLUMN IF NOT EXISTS appointment_id INTEGER;
    ALTER TABLE vitals
      ADD COLUMN IF NOT EXISTS waist REAL;
    ALTER TABLE vitals
      ADD COLUMN IF NOT EXISTS body_fat REAL;
    ALTER TABLE vitals
      ADD COLUMN IF NOT EXISTS muscle_mass REAL;
    ALTER TABLE vitals
      ADD COLUMN IF NOT EXISTS pulse REAL;
    ALTER TABLE vitals
      ADD COLUMN IF NOT EXISTS bp_standing_sys REAL;
    ALTER TABLE vitals
      ADD COLUMN IF NOT EXISTS bp_standing_dia REAL;
    ALTER TABLE vitals
      ADD COLUMN IF NOT EXISTS source TEXT;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_appt_healthray
      ON appointments(healthray_id) WHERE healthray_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_doc_healthray
      ON doctors(healthray_id) WHERE healthray_id IS NOT NULL;
    ALTER TABLE medications
      ADD COLUMN IF NOT EXISTS parent_medication_id INTEGER REFERENCES medications(id) ON DELETE SET NULL;
    ALTER TABLE medications
      ADD COLUMN IF NOT EXISTS support_condition TEXT;
    CREATE INDEX IF NOT EXISTS idx_medications_parent
      ON medications(parent_medication_id);
  `);

  // Stops TOCTOU duplicates from sheets sync, walk-in clicks, and no-show
  // placeholders inserting a second row for the same booking. Two rows with
  // the same (file_no, date, time, doctor) but different `status` are kept
  // (e.g. a cancelled stub + the real seen visit), so status is part of the
  // dedup key. Different time_slot OR different doctor still creates a new
  // row (a patient seeing two doctors back-to-back is allowed). Run separately
  // so any leftover duplicates don't abort the whole bootstrap.
  try {
    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_appt_patient_day_slot_doc_status
        ON appointments(file_no, appointment_date, time_slot, doctor_name, status)
        WHERE file_no IS NOT NULL
          AND appointment_date IS NOT NULL
          AND time_slot IS NOT NULL
          AND doctor_name IS NOT NULL
          AND status IS NOT NULL;
    `);
  } catch (e) {
    console.warn(
      `[ensureSyncColumns] Skipping idx_appt_patient_day_slot_doc_status (existing duplicates block creation): ${e.message}`,
    );
  }

  columnsReady = true;
}

// ── Find previous appointment with clinical notes for same patient ──────────
// Matches by file_no only — phone is shared across family members.
export async function findAppointmentWithNotes(fileNo, _phone, excludeHealthrayId) {
  if (!fileNo) return { rows: [] };
  return pool.query(
    `SELECT healthray_id FROM appointments
     WHERE healthray_clinical_notes IS NOT NULL AND LENGTH(healthray_clinical_notes) > 20
       AND healthray_id != $2
       AND file_no = $1
     ORDER BY appointment_date DESC LIMIT 1`,
    [fileNo, excludeHealthrayId],
  );
}

// ── Return JSONB array lengths for prescription fields on an appointment ──
// Used by the sync flow to detect whether an appointment already carries a
// prior good enrichment, so a flaky re-parse (AI returns null / empty) cannot
// silently overwrite it with blank arrays.
export async function getAppointmentEnrichmentCounts(appointmentId) {
  if (!appointmentId) return null;
  const { rows } = await pool.query(
    `SELECT
       jsonb_array_length(COALESCE(healthray_diagnoses, '[]'::jsonb))             AS dx,
       jsonb_array_length(COALESCE(healthray_medications, '[]'::jsonb))           AS meds,
       jsonb_array_length(COALESCE(healthray_previous_medications, '[]'::jsonb))  AS prev_meds
       FROM appointments
      WHERE id = $1`,
    [appointmentId],
  );
  return rows[0] || null;
}

// ── Find existing appointment by healthray_id, or by file_no + date (sheet import) ──
export async function findAppointment(healthrayId, fileNo, apptDate) {
  // First try exact healthray_id match
  const { rows } = await pool.query(
    `SELECT id, patient_id, healthray_clinical_notes, compliance, source, healthray_investigations, healthray_follow_up FROM appointments WHERE healthray_id = $1`,
    [healthrayId],
  );
  if (rows[0]) return rows[0];

  // Then try matching a sheet-imported appointment by file_no + date
  if (fileNo && apptDate) {
    const { rows: sheetRows } = await pool.query(
      `SELECT id, patient_id, healthray_clinical_notes, compliance, source FROM appointments
       WHERE file_no = $1 AND appointment_date = $2 AND healthray_id IS NULL
       LIMIT 1`,
      [fileNo, apptDate],
    );
    if (sheetRows[0]) return sheetRows[0];
  }

  return null;
}

// ── Upsert patient ──────────────────────────────────────────────────────────
export async function upsertPatient({
  name,
  phone,
  fileNo,
  age,
  sex,
  address,
  dob,
  email,
  bloodGroup,
  abhaId,
  healthId,
}) {
  // Match by file_no only. Phone is shared across family members so matching
  // on phone would merge unrelated patients.
  const existing = fileNo
    ? await pool.query(`SELECT id FROM patients WHERE file_no = $1 LIMIT 1`, [fileNo])
    : { rows: [] };

  if (existing.rows[0]) return existing.rows[0].id;

  try {
    const res = await pool.query(
      `INSERT INTO patients (name, phone, file_no, age, sex, address, dob, email, blood_group, abha_id, health_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7::date, $8, $9, $10, $11)
       RETURNING id`,
      [name, phone, fileNo, age, sex, address, dob, email, bloodGroup, abhaId, healthId],
    );
    return res.rows[0].id;
  } catch (e) {
    if (e.code === "23505") {
      // If file_no already exists, use it. Otherwise the conflict is on
      // phone (shared family number) — retry without phone so we create a
      // distinct patient instead of merging into the phone owner's record.
      if (fileNo) {
        const byFile = await pool.query(`SELECT id FROM patients WHERE file_no = $1 LIMIT 1`, [
          fileNo,
        ]);
        if (byFile.rows[0]) return byFile.rows[0].id;
      }
      const res2 = await pool
        .query(
          `INSERT INTO patients (name, file_no, age, sex, address, dob, email, blood_group, abha_id, health_id)
           VALUES ($1, $2, $3, $4, $5, $6::date, $7, $8, $9, $10)
           RETURNING id`,
          [name, fileNo, age, sex, address, dob, email, bloodGroup, abhaId, healthId],
        )
        .catch(() => null);
      return res2?.rows[0]?.id || null;
    }
    throw e;
  }
}

// ── Sync doctors ────────────────────────────────────────────────────────────
// Optimization: we used to issue up to 3 SELECTs per HealthRay doctor. For a
// 50-doctor sync that was ~150 round-trips. Now we pull the local doctor table
// once and match in memory; only missing rows produce an INSERT.
export async function syncDoctors(rayDoctors) {
  const mapping = new Map();

  const { rows: localRows } = await pool.query(
    `SELECT id, name, short_name, phone, healthray_id FROM doctors`,
  );

  const stripName = (s) =>
    (s || "")
      .replace(/^Dr\.?\s*/i, "")
      .trim()
      .toLowerCase();

  const byHrid = new Map();
  const byPhone = new Map();
  const normalizedLocals = localRows.map((r) => {
    const n1 = stripName(r.name);
    const n2 = (r.short_name || "").trim().toLowerCase();
    if (r.healthray_id != null) byHrid.set(String(r.healthray_id), r);
    if (r.phone) byPhone.set(String(r.phone), r);
    return { row: r, n1, n2 };
  });

  for (const rd of rayDoctors) {
    if (rd.is_deactivated) continue;

    const hrid = rd.id;
    const rayName = rd.doctor_name;
    const specialty = rd.specialty_name || null;
    const phone = rd.mobile_no || null;

    let local = byHrid.get(String(hrid)) || null;
    if (!local && phone) local = byPhone.get(String(phone)) || null;
    if (!local) {
      const needle = stripName(rayName);
      if (needle) {
        const hit = normalizedLocals.find(
          (x) => (x.n1 && x.n1.includes(needle)) || (x.n2 && x.n2.includes(needle)),
        );
        if (hit) local = hit.row;
      }
    }

    if (local) {
      await pool.query(
        `UPDATE doctors SET healthray_id = $2, specialty = COALESCE(specialty, $3) WHERE id = $1`,
        [local.id, hrid, specialty],
      );
      mapping.set(hrid, local.name);
    } else {
      const res = await pool.query(
        `INSERT INTO doctors (name, specialty, phone, role, healthray_id, is_active)
         VALUES ($1, $2, $3, 'consultant', $4, true)
         ON CONFLICT DO NOTHING
         RETURNING id, name`,
        [rayName, specialty, phone, hrid],
      );
      if (res.rows[0]) {
        mapping.set(hrid, res.rows[0].name);
        log("DB", `New doctor created: ${rayName}`);
      } else {
        mapping.set(hrid, rayName);
      }
    }
  }

  return mapping;
}

// ── Insert or update appointment ────────────────────────────────────────────
export async function upsertAppointment(existingId, data) {
  const {
    patientId,
    name,
    fileNo,
    phone,
    localDoctorName,
    apptDate,
    timeSlot,
    visitType,
    status,
    isWalkin,
    age,
    sex,
    notes,
    healthrayId,
    opdVitals,
    biomarkers,
    compliance,
    clinicalRaw,
    healthrayDiagnoses,
    healthrayMedications,
    healthrayLabs,
    healthrayAdvice,
    healthrayInvestigations,
    healthrayFollowUp,
    healthrayPreviousMedications,
  } = data;

  if (existingId) {
    const { rows } = await pool.query(
      `UPDATE appointments SET
        patient_id = COALESCE($11, patient_id),
        patient_name = COALESCE($12, patient_name),
        phone = COALESCE($13, phone),
        doctor_name = COALESCE($14, doctor_name),
        time_slot = COALESCE($15, time_slot),
        visit_type = COALESCE($16, visit_type),
        is_walkin = COALESCE($17, is_walkin),
        age = COALESCE($18, age),
        sex = COALESCE($19, sex),
        notes = COALESCE($20, notes),
        healthray_id = COALESCE($21, healthray_id),
        source = COALESCE(source, 'healthray'),
        opd_vitals = $2::jsonb, biomarkers = $3::jsonb, compliance = $10::jsonb,
        healthray_clinical_notes = $4, healthray_diagnoses = $5::jsonb,
        healthray_medications = $6::jsonb, healthray_labs = $7::jsonb,
        healthray_advice = $8, status = COALESCE($9, status),
        healthray_investigations = $22::jsonb, healthray_follow_up = $23::jsonb,
        healthray_previous_medications = $24::jsonb,
        updated_at = NOW()
       WHERE id = $1 RETURNING id`,
      [
        existingId,
        JSON.stringify(opdVitals),
        JSON.stringify(biomarkers),
        clinicalRaw,
        JSON.stringify(healthrayDiagnoses),
        JSON.stringify(healthrayMedications),
        JSON.stringify(healthrayLabs),
        healthrayAdvice,
        status,
        JSON.stringify(compliance),
        patientId,
        name,
        phone,
        localDoctorName,
        timeSlot,
        visitType,
        isWalkin,
        age,
        sex,
        notes,
        healthrayId,
        JSON.stringify(healthrayInvestigations || []),
        healthrayFollowUp ? JSON.stringify(healthrayFollowUp) : null,
        JSON.stringify(healthrayPreviousMedications || []),
      ],
    );
    return rows[0].id;
  }

  const { rows } = await pool.query(
    `INSERT INTO appointments
       (patient_id, patient_name, file_no, phone, doctor_name,
        appointment_date, time_slot, visit_type, status, is_walkin,
        age, sex, notes, healthray_id, opd_vitals, biomarkers, compliance,
        healthray_clinical_notes, healthray_diagnoses, healthray_medications,
        healthray_labs, healthray_advice, healthray_investigations, healthray_follow_up,
        healthray_previous_medications)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16::jsonb,$17::jsonb,$18,$19::jsonb,$20::jsonb,$21::jsonb,$22,$23::jsonb,$24::jsonb,$25::jsonb)
     RETURNING id`,
    [
      patientId,
      name,
      fileNo,
      phone,
      localDoctorName,
      apptDate,
      timeSlot,
      visitType,
      status,
      isWalkin,
      age,
      sex,
      notes,
      healthrayId,
      JSON.stringify(opdVitals),
      JSON.stringify(biomarkers),
      JSON.stringify(compliance),
      clinicalRaw,
      JSON.stringify(healthrayDiagnoses),
      JSON.stringify(healthrayMedications),
      JSON.stringify(healthrayLabs),
      healthrayAdvice,
      JSON.stringify(healthrayInvestigations || []),
      healthrayFollowUp ? JSON.stringify(healthrayFollowUp) : null,
      JSON.stringify(healthrayPreviousMedications || []),
    ],
  );
  return rows[0].id;
}

// Source priority — lower number wins
const SOURCE_PRIORITY = {
  opd: 1,
  report_extract: 2,
  lab_healthray: 3,
  vitals_sheet: 4,
  prescription_parsed: 5,
  healthray: 6,
};

function normalizeCanonicalName(name) {
  return normalizeTestName(name);
}

// ── Sync parsed labs → lab_results table ────────────────────────────────────
export async function syncLabResults(patientId, apptId, apptDate, labs) {
  if (!patientId || labs.length === 0) return;

  await pool.query(`DELETE FROM lab_results WHERE appointment_id = $1 AND source = 'healthray'`, [
    apptId,
  ]);

  // Deduplicate: when the same test+value appears multiple times (e.g. once in
  // OBSERVATIONS with no date and once under FOLLOW UP with a specific date),
  // keep only the entry with the specific date to avoid duplicate rows.
  const seen = new Map();
  const dedupedLabs = [];
  for (const lab of labs) {
    const v = parseFloat(lab.value);
    if (isNaN(v)) continue;
    const cn = normalizeCanonicalName(lab.test);
    const key = `${cn}|${v}`;
    const prev = seen.get(key);
    if (!prev) {
      seen.set(key, { lab, index: dedupedLabs.length });
      dedupedLabs.push(lab);
    } else if (!prev.lab.date && lab.date) {
      // Replace fallback-date entry with specific-date entry
      dedupedLabs[prev.index] = lab;
      seen.set(key, { lab, index: prev.index });
    }
    // If prev already has a specific date, keep it (skip current)
  }

  for (const lab of dedupedLabs) {
    const val = parseFloat(lab.value);
    if (isNaN(val)) continue;
    const canonicalName = normalizeCanonicalName(lab.test);
    // Only accept labs with an explicit date in the notes. Clinical notes often
    // carry forward historical sections (e.g. "PATIENT VISITED TODAY HBA1C: 11.5"
    // copied from an earlier visit) — anchoring those undated values to the
    // current appointment date makes stale readings look like today's labs and
    // overwrites the genuine current reading. P_137100 (appt 31150): the
    // undated 11.5 was old text while the dated "LABS (19/4/26) HBA1C-7.9" was
    // the real recent value.
    if (!lab.date) continue;
    const labDate = parseLabDate(lab.date, apptDate);
    if (!labDate) continue;

    // One reading per (patient, canonical test, date). Whichever source got
    // there first wins — skip if anything already exists for this combination.
    // IS NOT DISTINCT FROM handles the null-date case (undated OBSERVATION labs).
    const existing = await pool.query(
      `SELECT id FROM lab_results
       WHERE patient_id = $1 AND canonical_name = $2 AND test_date IS NOT DISTINCT FROM $3::date
       LIMIT 1`,
      [patientId, canonicalName, labDate],
    );
    if (existing.rows[0]) continue;

    await pool
      .query(
        `INSERT INTO lab_results
         (patient_id, appointment_id, test_date, test_name, canonical_name, result, unit, source)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'healthray')`,
        [patientId, apptId, labDate, lab.test, canonicalName, val, lab.unit || null],
      )
      .catch((e) =>
        error(
          "syncLabResults",
          `INSERT failed for patient=${patientId} appt=${apptId} test="${lab.test}" canonical="${canonicalName}": ${e.message}`,
        ),
      );
  }
}

// ── Sync parsed medications → medications table ─────────────────────────────
// ── Normalize diagnosis name → canonical ID to prevent duplicates ───────────
function normalizeDiagnosisId(name) {
  // Check full name (with parentheticals) first, for conditions whose qualifier may be inside parens
  const fullLower = name.toLowerCase().trim();

  // Defensive: a diagnosis name with no alphabetic characters is never a real
  // condition — signal "skip" so the caller doesn't insert it.
  if (!/[a-z]/.test(fullLower)) return null;

  // MNG with retrosternal extension — qualifier sometimes in parens: "MNG(With retristernal extension...)"
  if (/\bmng\b|multinodular goiter/.test(fullLower) && /retrosternal|retristernal/.test(fullLower))
    return "mng_with_retrosternal_extension";

  // Strip parenthetical qualifiers before matching — "(Since 1998)", "(Seronegative)", etc.
  const n = fullLower
    .replace(/\([^)]*\)/g, "")
    .trim()
    .replace(/\s+/g, " ");

  // Type 2 Diabetes — catches T2DM, DM2, Type 2 DM, Type II DM, T2 DM, etc.
  if (/type\s*2|type\s*ii|t2\b|dm\s*2|dm2/.test(n) && /diabet|dm\b/.test(n))
    return "type_2_diabetes_mellitus";
  if (/^t2dm$/.test(n.replace(/\s/g, ""))) return "type_2_diabetes_mellitus";

  // Type 1 Diabetes
  if (/type\s*1|type\s*i\b|t1\b|dm\s*1|dm1/.test(n) && /diabet|dm\b/.test(n))
    return "type_1_diabetes_mellitus";

  // Hypertension
  if (/^(htn|hypertension|essential hypertension|high blood pressure|high bp)$/.test(n))
    return "hypertension";

  // Thyroid conditions — order matters: specific before generic
  if (/graves.*disease|graves.*hyperthyroid/.test(n)) return "graves_disease";
  if (/graves.*dermopathy|\bdermopathy\b/.test(n)) return "graves_dermopathy";
  if (/graves/.test(n)) return "graves_disease";
  if (/hypothyroid|hypothyrod/.test(n)) return "hypothyroidism"; // catches "hypothyrodism" typo
  if (/hyperthyroid/.test(n)) return "hyperthyroidism";
  if (/hashimoto/.test(n)) return "hashimoto_thyroiditis";

  // Neuropathy — diabetic context and plain both map to same
  if (/neuropathy/.test(n)) return "diabetic_neuropathy";

  // Nephropathy
  if (/nephropathy/.test(n)) return "diabetic_nephropathy";
  if (/chronic kidney disease|ckd/.test(n)) {
    const stage = n.match(/stage\s*(\d)/);
    return stage ? `ckd_stage_${stage[1]}` : "chronic_kidney_disease";
  }

  // Heart & vascular conditions
  if (/heart failure.*preserved|hfpef|hfp\b/.test(n)) return "heart_failure_preserved_ef";
  if (/heart failure/.test(n)) return "heart_failure";
  if (/coronary artery disease|\bcad\b/.test(n)) return "coronary_artery_disease";
  if (/atrial fibrillation|af\b|afib/.test(n)) return "atrial_fibrillation";
  if (/myocardial infarction|\bmi\b.*heart|heart.*\bmi\b/.test(n)) return "myocardial_infarction";
  if (/cerebrovascular accident|cva\b|stroke/.test(n)) return "cerebrovascular_accident";
  if (/peripheral vascular disease|pvd\b/.test(n)) return "peripheral_vascular_disease";

  // Sleep & respiratory
  if (/obstructive sleep apnea|osas\b|osa\b/.test(n)) return "obstructive_sleep_apnea";

  // Thyroid eye disease
  if (/thyroid.*(orbitopathy|ophthalmopathy|eye disease)|tao\b|ted\b/.test(n))
    return "thyroid_associated_orbitopathy";

  // Retinopathy — "mild DR" / "mild diabetic retinopathy" severity qualifiers → canonical
  if (/\bmild\s+dr\b|mild.*diabet.*retin|diabet.*retin.*mild/.test(n))
    return "diabetic_retinopathy";
  if (/retinopathy/.test(n)) return "diabetic_retinopathy";

  // Dyslipidemia
  if (/dyslipidemia|hyperlipidemia|hypercholesterol/.test(n)) return "dyslipidemia";

  // Obesity / adiposity
  if (/^obesity$/.test(n)) return "obesity";
  if (/dual adiposity/.test(n)) return "dual_adiposity";
  if (/central adiposity|visceral adiposity/.test(n)) return "central_adiposity";
  if (/adiposity/.test(n)) return "dual_adiposity";

  // MASLD / fatty liver — also matches M.A.S.L.D with dots, asld/nafld/mafld variants
  if (
    /^m\.?a\.?s\.?l\.?d$|^asld$|masld|mafld|nafld|non.alcoholic fatty liver|metabolic.*steatotic liver|metabolic.*fatty liver/.test(
      n,
    )
  )
    return "masld";

  // Prediabetes
  if (/pre.?diabet|impaired fasting|impaired glucose/.test(n)) return "prediabetes";

  // Metabolic syndrome
  if (/metabolic syndrome/.test(n)) return "metabolic_syndrome";

  // Acanthosis nigricans — short "acanthosis" maps to full canonical
  if (/acanthosis/.test(n)) return "acanthosis_nigricans";

  // Hyposomatotropism — catches typo "hyposomatotropisim"
  if (/hyposomatotropi/.test(n)) return "hyposomatotropism";

  // Hypertriglyceridemia (catches misspellings like hypertriglycerdemia)
  if (/hypertriglycer/.test(n)) return "hypertriglyceridemia";

  // PCOS
  if (/polycystic ovary|pcos|pcod/.test(n)) return "pcos";

  // Depression / anxiety
  if (/^depression$/.test(n)) return "depression";
  if (/^anxiety$/.test(n)) return "anxiety";

  // Pancreatitis
  if (/pancreatitis/.test(n)) return "pancreatitis";
  if (/pancreatic exocrine insufficiency|pei\b/.test(n)) return "pancreatic_exocrine_insufficiency";

  // AIDP / GBS
  if (/aidp|guillain.barr/.test(n)) return "aidp";

  // Carpal tunnel syndrome (with or without laterality — lt/rt/bilateral)
  if (/carpal tunnel/.test(n)) return "carpal_tunnel_syndrome";

  // Osteoporosis
  if (/osteoporosis/.test(n)) {
    if (/post.?menopausal/.test(n)) return "post_menopausal_osteoporosis";
    return "osteoporosis";
  }

  // Thalassemia (catches double-L typo "thallasemia")
  if (/thal+asemia|thalassemia/.test(n)) {
    if (/minor/.test(n)) return "thalassemia_minor";
    if (/major/.test(n)) return "thalassemia_major";
    return "thalassemia";
  }

  // Tendinitis — catches achillis/achilles spelling variants
  if (/achil+[ei]s?\s+tendin/.test(n)) return "achilles_tendinitis";

  // Surgical/procedural qualifiers — collapse to base diagnosis
  if (/\bca\s*colon\b|\bcolorectal\s*(ca|cancer)\b|\bcolon\s*ca\b/.test(n)) return "ca_colon";
  if (/\bgsd\b/.test(n)) return "gsd";
  if (/\btkr\b|\btotal\s+knee\s+replacement/.test(n)) return "tkr_b_l";

  // Non-medical descriptors — return null to signal "skip this"
  if (/^non.obese$|^non.smoker$|^non.alcoholic$/.test(n)) return null;
  if (/^allergic to\b/.test(n)) return null; // allergy note, not a diagnosis
  if (/^intensive.*program$|^.*management program$/.test(n)) return null; // program labels, not diagnoses

  // Default: slugify (using stripped name without parentheticals)
  return n
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 100);
}

// ── Sync diagnoses from HealthRay clinical notes ────────────────────────────
// Detect negative/absent findings that should not be stored as diagnoses
function isAbsentFinding(dx) {
  // Explicit status field set by AI
  if (dx.status === "Absent") return true;
  // Explicit present — never treat as absent
  if (dx.status === "Present") return false;
  const name = (dx.name || "").toLowerCase().trim();
  const details = (dx.details || "").toLowerCase().trim();
  // Name ends with "-" (e.g. "CAD-", "CVA-")
  if (name.endsWith("-")) return true;
  // Details explicitly say absent/negative/no
  if (/\babsent\b|\bnegative\b|\bnot present\b|\bno history\b|\bruled out\b/.test(details))
    return true;
  // Details contain "(-)" marker
  if (details.includes("(-)")) return true;
  return false;
}

// Strip "+" suffix from diagnosis name (e.g. "NEUROPATHY+" → "NEUROPATHY")
function stripPlusSuffix(name) {
  return (name || "").replace(/\s*\+\s*$/, "").trim();
}

// Old diagnosis_id values that were renamed — deactivate stale rows before upserting canonical
const DIAGNOSIS_ID_RENAMES = {
  type_2_dm: "type_2_diabetes_mellitus",
  t2dm: "type_2_diabetes_mellitus",
  dm2: "type_2_diabetes_mellitus",
  asld: "masld",
  nafld: "masld",
  mafld: "masld",
  nephropathy: "diabetic_nephropathy",
  neuropathy: "diabetic_neuropathy",
  aidp_post_ivig_transfusion: "aidp",
  htn: "hypertension",
  essential_hypertension: "hypertension",
  cad: "coronary_artery_disease",
  mng_with_retristernal_extension: "mng_with_retrosternal_extension",
  sunclinical_hypothyrodism: "hypothyroidism",
  subclinical_hypothyrodism: "hypothyroidism",
  subclinical_hypothyroidism: "hypothyroidism",
  thallasemia_minor: "thalassemia_minor",
  thallasemia_major: "thalassemia_major",
  thallasemia: "thalassemia",
  hashimoto_s_thyroiditis: "hashimoto_thyroiditis",
  hashimotos_thyroiditis: "hashimoto_thyroiditis",
  mild_dr: "diabetic_retinopathy",
  m_a_s_l_d: "masld",
  achillis_tendinitis: "achilles_tendinitis",
  ca_colon_s_p_op_chemo: "ca_colon",
  gsd_s_p_op: "gsd",
  tkr_b_l_2024: "tkr_b_l",
  balanoprosthitis: "balanoposthitis",
  osas: "obstructive_sleep_apnea",
  seropositive_hashimoto_s_thyroiditis: "hashimoto_thyroiditis",
  seronegative_hashimoto_s_thyroiditis: "hashimoto_thyroiditis",
  type_2_pge: "pge_type_2",
  hypo: "hypothyroidism",
  // Acanthosis — short form deactivated in favour of full canonical
  acanthosis: "acanthosis_nigricans",
  // Hyposomatotropism typo
  hyposomatotropisim: "hyposomatotropism",
  hyposomatotropis: "hyposomatotropism",
};

export async function syncDiagnoses(patientId, healthrayId, diagnoses, options = {}) {
  const { sweepStale = false } = options;
  if (!patientId || !diagnoses || diagnoses.length === 0) return;

  // Deactivate stale duplicate rows for known renamed IDs before upserting
  const oldIds = Object.keys(DIAGNOSIS_ID_RENAMES);
  if (oldIds.length) {
    const placeholders = oldIds.map((_, i) => `$${i + 2}`).join(",");
    await pool
      .query(
        `UPDATE diagnoses SET is_active = false, updated_at = NOW()
         WHERE patient_id = $1 AND diagnosis_id IN (${placeholders})`,
        [patientId, ...oldIds],
      )
      .catch((e) =>
        error("syncDiagnoses", `dedup-rename UPDATE failed for patient=${patientId}: ${e.message}`),
      );
  }

  const keptIds = [];
  for (const dx of diagnoses) {
    if (!dx.name) continue;
    if (isAbsentFinding(dx)) continue;
    // Strip "+" suffix the AI may leave on condition names (e.g. "NEUROPATHY+" → "NEUROPATHY")
    const cleanName = stripPlusSuffix(dx.name);
    if (!cleanName) continue;
    // Reject names with no alphabetic chars (e.g. stray numeric tokens like "24009"
    // that the AI sometimes lifts out of dates/IDs/lab values in the DIAGNOSIS block).
    if (!/[a-zA-Z]/.test(cleanName)) continue;
    const diagId = normalizeDiagnosisId(dx.id || cleanName);
    if (!diagId) continue; // null = non-medical descriptor, skip
    keptIds.push(diagId);

    await pool
      .query(
        `INSERT INTO diagnoses (patient_id, diagnosis_id, label, status, notes)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (patient_id, diagnosis_id) DO UPDATE SET
           label = EXCLUDED.label,
           status = COALESCE(EXCLUDED.status, diagnoses.status),
           notes = COALESCE(EXCLUDED.notes, diagnoses.notes),
           is_active = true,
           updated_at = NOW()`,
        [
          patientId,
          diagId,
          cleanName,
          dx.status || "Active",
          `healthray:${healthrayId}${dx.details ? " — " + dx.details : ""}`,
        ],
      )
      .catch((e) =>
        error(
          "syncDiagnoses",
          `UPSERT failed for patient=${patientId} diagnosis_id="${diagId}" label="${cleanName}": ${e.message}`,
        ),
      );
  }

  // Opt-in stale sweep — used by the prescription re-extraction path so the
  // latest prescription becomes the sole source of truth for the patient's
  // diagnoses. HealthRay cron path leaves sweepStale=false (additive-only).
  // Only touches auto-synced rows (notes prefixed 'healthray:'); manually
  // added or consultation-scoped diagnoses (different notes prefix) are
  // preserved.
  if (sweepStale && keptIds.length > 0) {
    await pool
      .query(
        `UPDATE diagnoses
            SET is_active = false,
                notes = COALESCE(notes, '') ||
                        ' — superseded by healthray:' || $2::text,
                updated_at = NOW()
          WHERE patient_id = $1
            AND is_active = true
            AND notes LIKE 'healthray:%'
            AND diagnosis_id <> ALL($3::text[])`,
        [patientId, String(healthrayId), keptIds],
      )
      .catch((e) =>
        error("syncDiagnoses", `stale-sweep UPDATE failed for patient=${patientId}: ${e.message}`),
      );
  }
}

// ── Sync symptoms from HealthRay clinical notes ─────────────────────────────
export async function syncSymptoms(patientId, apptId, symptoms) {
  if (!patientId || !symptoms?.length) return;
  for (const sy of symptoms) {
    if (!sy.name) continue;
    const symptomId = sy.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .slice(0, 100);

    // Parse since_date — AI may return YYYY-MM-DD string or null
    let sinceDate = null;
    if (sy.since_date) {
      const d = new Date(sy.since_date);
      if (!isNaN(d.getTime())) sinceDate = sy.since_date.slice(0, 10);
    }

    // Normalize severity to allowed values
    const rawSev = (sy.severity || "").toLowerCase().trim();
    const severity = ["mild", "moderate", "severe"].includes(rawSev) ? rawSev : null;

    await pool
      .query(
        `INSERT INTO visit_symptoms
           (patient_id, symptom_id, label, appointment_id, since_date, severity, related_to)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (patient_id, symptom_id) DO UPDATE SET
           label       = EXCLUDED.label,
           appointment_id = EXCLUDED.appointment_id,
           since_date  = COALESCE(EXCLUDED.since_date, visit_symptoms.since_date),
           severity    = COALESCE(EXCLUDED.severity,   visit_symptoms.severity),
           related_to  = COALESCE(EXCLUDED.related_to, visit_symptoms.related_to),
           updated_at  = NOW()`,
        [patientId, symptomId, sy.name, apptId, sinceDate, severity, sy.related_to || null],
      )
      .catch((e) =>
        error(
          "syncSymptoms",
          `UPSERT failed for patient=${patientId} appt=${apptId} symptom_id="${symptomId}": ${e.message}`,
        ),
      );
  }
}

// ── Sync stopped/previous medications from HealthRay ──────────────────────────
export async function syncStoppedMedications(
  patientId,
  healthrayId,
  stoppedMeds,
  currentMeds = [],
) {
  if (!patientId || !stoppedMeds || stoppedMeds.length === 0) return;

  // Build set of current prescription pharmacy_match keys so we don't accidentally
  // stop a medication that changed frequency/dose but is still being prescribed
  // e.g. "CCM OD" in previous + "CCM BD" in current → don't stop CCM
  const currentMatchKeys = new Set(
    currentMeds.map((m) => normalizeMedName(m.name || "")).filter(Boolean),
  );

  for (const med of stoppedMeds) {
    if (!med.name) continue;

    // Skip if this med is still in the current prescription (frequency/dose change)
    if (currentMatchKeys.has(normalizeMedName(med.name))) continue;

    const reason = `healthray:${healthrayId}${med.reason ? " — " + med.reason : med.status || ""}`;

    // Always compare on the canonical key, never on the raw name. Once the
    // one-time normalize-medication-names.js migration has run, every row has
    // pharmacy_match set and the brand name stripped, so this match is exact.
    const cleanMedName = stripFormPrefix(med.name).name || med.name;
    const matchKey = normalizeMedName(med.name);

    // Try to mark existing active med as stopped (by canonical name + dose)
    const updateRes = await pool
      .query(
        `UPDATE medications
         SET is_active = false,
             stopped_date = CURRENT_DATE,
             stop_reason = $2,
             updated_at = NOW()
         WHERE patient_id = $1
           AND UPPER(COALESCE(pharmacy_match, name)) = $3
           AND (($4::text IS NULL AND dose IS NULL) OR dose = $4)
           AND is_active = true`,
        [patientId, reason, matchKey, med.dose || null],
      )
      .catch((e) => {
        error(
          "syncStoppedMedications",
          `stop UPDATE failed for patient=${patientId} med="${med.name}" dose="${med.dose || ""}": ${e.message}`,
        );
        return { rowCount: 0 };
      });

    // If no existing active medicine found, insert as a new stopped entry (for dose changes).
    // Use ON CONFLICT DO NOTHING so duplicate canonical names (patient_inactive_name_uniq)
    // are silently skipped — avoids a flawed check-then-insert that breaks on NULL dose.
    if (updateRes.rowCount === 0) {
      await pool
        .query(
          `INSERT INTO medications
             (patient_id, name, pharmacy_match, dose, frequency, is_active, stopped_date, stop_reason, notes)
           VALUES ($1, $2, $3, $4, $5, false, CURRENT_DATE, $6, $7)
           ON CONFLICT (patient_id, UPPER(COALESCE(pharmacy_match, name))) WHERE is_active = false
           DO NOTHING`,
          [
            patientId,
            cleanMedName,
            matchKey,
            med.dose || null,
            med.frequency || null,
            reason,
            `Previous dose (stopped)`,
          ],
        )
        .catch((e) =>
          error(
            "syncStoppedMedications",
            `historical INSERT failed for patient=${patientId} med="${med.name}" dose="${med.dose || ""}": ${e.message}`,
          ),
        );
    }
  }
}

// Canonical key delegated to the shared medication normaliser.
// See server/services/medication/normalize.js for the full contract.
const normalizeMedName = canonicalMedKey;

export async function syncMedications(patientId, healthrayId, apptDate, meds) {
  if (!patientId || meds.length === 0) return;

  // Capture sync start so we can identify rows tagged with the same
  // healthrayId that were NOT touched by this run — those belong to an
  // older extraction of the same prescription and should be demoted to
  // `visit_status = 'previous'`. (HealthRay sometimes returns a partial
  // prescription first, then the full one a few minutes later; without
  // this, the dropped meds stay marked 'current'.)
  const syncStart = new Date();

  // Historical started_date lookup — if the patient was already on this drug
  // in an earlier prescription, backdate started_date to the first known
  // occurrence instead of stamping it with the current apptDate.
  const canonicalKeys = meds
    .filter((m) => m?.name)
    .map((m) => {
      const { name } = stripFormPrefix(m.name);
      return canonicalMedKey(name || m.name).slice(0, 200);
    })
    .filter(Boolean);
  const earliestByKey = await findEarliestStartDates(pool, patientId, canonicalKeys, null);

  for (const rawMed of meds) {
    if (!rawMed.name) continue;
    // Default weekly meds' day-of-week to the prescription weekday when the
    // source text doesn't pin a specific day. Also normalises the frequency
    // string to include the canonical "· Mon, Wed" suffix.
    const med = enrichMedWithDays(rawMed, apptDate);
    const daysOfWeek =
      Array.isArray(med.days_of_week) && med.days_of_week.length ? med.days_of_week : null;
    // Strip dosage-form prefix so the stored `name` is the clean brand — the
    // prefix becomes the route (Oral/SC/Topical/...) and never survives in
    // `name`, which is what the stop-medicine matcher reads.
    const { name: cleanName, form: detectedForm } = stripFormPrefix(med.name);
    const storedName = cleanName || med.name;
    const pharmacyMatch = normalizeMedName(storedName);
    const storedRoute = med.route || routeForForm(detectedForm) || "Oral";
    const startedDate = resolveStartedDate(earliestByKey, pharmacyMatch, apptDate);
    // Common side effects extracted by the AI parser. Capped at 3 entries and
    // serialised as JSON so the DB column (jsonb) round-trips cleanly even
    // when downstream callers pass a literal JS array.
    const sideEffectsJson = Array.isArray(med.common_side_effects)
      ? JSON.stringify(med.common_side_effects.slice(0, 3))
      : null;
    const instructions =
      typeof med.instructions === "string" && med.instructions.trim()
        ? med.instructions.trim()
        : null;
    const params = [
      patientId,
      storedName,
      pharmacyMatch,
      med.dose || null,
      med.frequency || null,
      med.timing || null,
      storedRoute,
      startedDate,
      `healthray:${healthrayId}`,
      apptDate || null,
      sideEffectsJson,
      normalizeWhenToTake(med.when_to_take),
      daysOfWeek,
      instructions,
    ];

    // Step 1: reactivate any existing inactive row with the same name first.
    // Without this, syncMedications creates a duplicate active row (because the
    // ON CONFLICT below can't match the partial inactive index), and the next
    // reconcile then fails with a unique constraint violation when it tries to
    // stop both rows.
    // Also clear consultation_id/document_id so HealthRay takes ownership —
    // otherwise old consultation-linked rows stay filtered out by latest_cons.
    // Step 1: reactivate any existing inactive row with the same canonical name.
    // Note: use a separate param array without med.name ($2 in the INSERT params)
    // so PostgreSQL doesn't complain about an untyped unused parameter.
    const updateParams = [
      patientId, // $1
      pharmacyMatch, // $2
      med.dose || null, // $3
      med.frequency || null, // $4
      med.timing || null, // $5
      med.route || "Oral", // $6
      startedDate, // $7 — earliest known start, falls back to apptDate
      `healthray:${healthrayId}`, // $8
      apptDate || null, // $9 — date this prescription was issued
      normalizeWhenToTake(med.when_to_take), // $10
      daysOfWeek, // $11 — int[] (0..6) weekday(s) for weekly meds, or null
      typeof med.instructions === "string" && med.instructions.trim()
        ? med.instructions.trim()
        : null, // $12 — extra administration directive
    ];
    await pool
      .query(
        `UPDATE medications
         SET is_active = true,
             pharmacy_match = $2,
             dose = COALESCE($3, dose),
             frequency = COALESCE($4, frequency),
             timing = COALESCE($5, timing),
             when_to_take = COALESCE($10::when_to_take_pill[], when_to_take),
             route = COALESCE($6, route),
             started_date = LEAST(started_date, $7),
             last_prescribed_date = GREATEST(COALESCE(last_prescribed_date, $9::date), $9::date),
             notes = $8,
             days_of_week = COALESCE($11::int[], days_of_week),
             instructions = COALESCE($12::text, instructions),
             stopped_date = NULL,
             stop_reason = NULL,
             consultation_id = NULL,
             document_id = NULL,
             updated_at = NOW()
         WHERE patient_id = $1
           AND UPPER(COALESCE(pharmacy_match, name)) = $2
           AND is_active = false
           AND NOT EXISTS (
             SELECT 1 FROM medications
             WHERE patient_id = $1
               AND UPPER(COALESCE(pharmacy_match, name)) = $2
               AND is_active = true
           )`,
        updateParams,
      )
      .catch((e) =>
        error(
          "syncMedications",
          `reactivate UPDATE failed for patient=${patientId} med="${med.name}" canonical="${pharmacyMatch}": ${e.message}`,
        ),
      );

    // Step 2: insert or upsert the active row (pharmacy_match ensures canonical dedup).
    await pool
      .query(
        `INSERT INTO medications
         (patient_id, name, pharmacy_match, dose, frequency, timing, when_to_take, route, is_active, started_date, notes, last_prescribed_date, source, common_side_effects, days_of_week, instructions)
         VALUES ($1, $2, $3, $4, $5, $6, $12::when_to_take_pill[], $7, true, $8, $9, $10, 'healthray', COALESCE($11::jsonb, '[]'::jsonb), $13::int[], $14::text)
         ON CONFLICT (patient_id, UPPER(COALESCE(pharmacy_match, name))) WHERE is_active = true
         DO UPDATE SET
           dose = COALESCE(EXCLUDED.dose, medications.dose),
           frequency = COALESCE(EXCLUDED.frequency, medications.frequency),
           timing = COALESCE(EXCLUDED.timing, medications.timing),
           when_to_take = COALESCE(EXCLUDED.when_to_take, medications.when_to_take),
           route = COALESCE(EXCLUDED.route, medications.route),
           started_date = LEAST(medications.started_date, EXCLUDED.started_date),
           last_prescribed_date = GREATEST(COALESCE(medications.last_prescribed_date, EXCLUDED.last_prescribed_date), EXCLUDED.last_prescribed_date),
           notes = EXCLUDED.notes,
           pharmacy_match = EXCLUDED.pharmacy_match,
           days_of_week = COALESCE(EXCLUDED.days_of_week, medications.days_of_week),
           instructions = COALESCE(EXCLUDED.instructions, medications.instructions),
           common_side_effects = CASE
             WHEN jsonb_array_length(COALESCE(EXCLUDED.common_side_effects, '[]'::jsonb)) > 0
               THEN EXCLUDED.common_side_effects
             ELSE medications.common_side_effects
           END,
           source = 'healthray',
           consultation_id = NULL,
           document_id = NULL,
           updated_at = NOW()`,
        params,
      )
      .catch((e) =>
        error(
          "syncMedications",
          `UPSERT failed for patient=${patientId} med="${med.name}" canonical="${pharmacyMatch}": ${e.message}`,
        ),
      );
  }

  // Step 3: dedup — remove older active healthray rows that are superseded.
  // First pass: rows WITH pharmacy_match — keep newest per canonical name.
  // Second pass: rows WITHOUT pharmacy_match whose name normalises to the same
  //   value as an existing active row that HAS pharmacy_match (old pre-normalisation rows).
  await pool
    .query(
      `DELETE FROM medications
       WHERE patient_id = $1
         AND is_active = true
         AND source = 'healthray'
         AND pharmacy_match IS NOT NULL
         AND id NOT IN (
           SELECT DISTINCT ON (UPPER(pharmacy_match)) id
           FROM medications
           WHERE patient_id = $1 AND is_active = true
             AND source = 'healthray' AND pharmacy_match IS NOT NULL
           ORDER BY UPPER(pharmacy_match), started_date DESC NULLS LAST, created_at DESC
         )`,
      [patientId],
    )
    .catch((e) =>
      error(
        "syncMedications",
        `dedup pass 1 (pharmacy_match) DELETE failed for patient=${patientId}: ${e.message}`,
      ),
    );

  // Remove old null-pharmacy_match rows whose normalised name matches a row that
  // now has pharmacy_match set (i.e. the canonical version already exists).
  await pool
    .query(
      `DELETE FROM medications old
       WHERE old.patient_id = $1
         AND old.is_active = true
         AND old.source = 'healthray'
         AND old.pharmacy_match IS NULL
         AND EXISTS (
           SELECT 1 FROM medications newer
           WHERE newer.patient_id = $1
             AND newer.is_active = true
             AND newer.pharmacy_match IS NOT NULL
             AND UPPER(newer.pharmacy_match) = (
               SELECT UPPER(REGEXP_REPLACE(
                 REGEXP_REPLACE(old.name,
                   E'^(tab\\.?\\s+|tablet\\s+|inj\\.?\\s+|injection\\s+|cap\\.?\\s+|capsule\\s+|syp\\.?\\s+|syrup\\s+|drops?\\s+|oint\\.?\\s+|ointment\\s+|gel\\s+|cream\\s+|spray\\s+|sachet\\s+|pwd\\.?\\s+|powder\\s+)', '', 'i'),
                 E'\\s*\\([\\d\\s+.\\/mg%KkUuIL]+\\)\\s*$', '', 'i'))
             )
         )`,
      [patientId],
    )
    .catch((e) =>
      error(
        "syncMedications",
        `dedup pass 2 (null pharmacy_match) DELETE failed for patient=${patientId}: ${e.message}`,
      ),
    );

  // Pass 3: pharmacy_match prefix dedup — when HealthRay sends both a short name
  // ("CRESAR AM") and a longer one with dose appended ("CRESAR AM 5+40"), both get
  // synced with the same healthray ID so stopStaleHealthrayMeds won't clean them up.
  // Keep the longer/newer entry; remove the shorter one that is a leading prefix of it.
  await pool
    .query(
      `DELETE FROM medications short_entry
       WHERE short_entry.patient_id = $1
         AND short_entry.is_active = true
         AND short_entry.source = 'healthray'
         AND short_entry.pharmacy_match IS NOT NULL
         AND EXISTS (
           SELECT 1 FROM medications longer_entry
           WHERE longer_entry.patient_id = $1
             AND longer_entry.is_active = true
             AND longer_entry.source = 'healthray'
             AND longer_entry.id != short_entry.id
             AND longer_entry.pharmacy_match IS NOT NULL
             AND LENGTH(longer_entry.pharmacy_match) > LENGTH(short_entry.pharmacy_match)
             AND UPPER(longer_entry.pharmacy_match) LIKE UPPER(short_entry.pharmacy_match) || ' %'
             AND longer_entry.created_at >= short_entry.created_at
         )`,
      [patientId],
    )
    .catch((e) =>
      error(
        "syncMedications",
        `dedup pass 3 (prefix match) DELETE failed for patient=${patientId}: ${e.message}`,
      ),
    );

  // Pass 4: link support / conditional medications to their parent.
  // Each med with `support_for: "<parent brand>"` becomes a child row
  // pointing at the parent's id, with `support_condition` set.
  await linkSupportMedications(patientId, meds);

  // Pass 5: stamp visit_status on every active row so consumers can filter
  // on the column instead of re-deriving "current vs previous visit" from
  // last_prescribed_date at render time.
  await markMedicationVisitStatus(patientId).catch((e) =>
    error(
      "syncMedications",
      `markMedicationVisitStatus failed for patient=${patientId}: ${e.message}`,
    ),
  );

  // Pass 6: demote same-healthrayId rows not touched in this sync.
  // When HealthRay re-emits the same prescription (same healthray ID) with
  // fewer meds, the previously-synced ones keep `notes = healthray:<id>` so
  // stopStaleHealthrayMeds won't deactivate them, and they share the same
  // last_prescribed_date so markMedicationVisitStatus keeps them 'current'.
  // The only signal we have is `updated_at` — anything tagged with this id
  // whose `updated_at` predates this sync run is from an older extraction.
  await pool
    .query(
      `UPDATE medications
         SET visit_status = 'previous',
             updated_at = NOW()
       WHERE patient_id = $1
         AND is_active = true
         AND source = 'healthray'
         AND notes LIKE 'healthray:' || $2 || '%'
         AND updated_at < $3
         AND visit_status IS DISTINCT FROM 'previous'`,
      [patientId, String(healthrayId), syncStart.toISOString()],
    )
    .catch((e) =>
      error(
        "syncMedications",
        `stale same-healthrayId demote failed for patient=${patientId} healthrayId=${healthrayId}: ${e.message}`,
      ),
    );
}

// ── Resolve `support_for` hints into real parent_medication_id links ────────
// Called from syncMedications after all parent rows are guaranteed to exist.
// Looks up each support med's parent by canonical pharmacy_match key on the
// same patient, then UPDATEs parent_medication_id + support_condition.
async function linkSupportMedications(patientId, meds) {
  const supportMeds = (meds || []).filter((m) => m?.support_for && m?.name);
  if (supportMeds.length === 0) {
    // Clear any stale links for this patient when no support meds are extracted
    // for this prescription? No — leave existing links untouched, since they may
    // belong to a previous prescription that didn't ship support meds again.
    return;
  }

  // Build a canonical lookup of all active rows for this patient.
  const activeR = await pool
    .query(
      `SELECT id, name, pharmacy_match FROM medications
         WHERE patient_id = $1 AND is_active = true`,
      [patientId],
    )
    .catch(() => ({ rows: [] }));
  const idByCanonical = new Map();
  for (const row of activeR.rows) {
    const key = (
      row.pharmacy_match ||
      normalizeMedName(stripFormPrefix(row.name).name || row.name) ||
      ""
    )
      .toUpperCase()
      .trim();
    if (key && !idByCanonical.has(key)) idByCanonical.set(key, row.id);
  }

  for (const med of supportMeds) {
    const parentHint = stripFormPrefix(med.support_for).name || med.support_for;
    const parentKey = (normalizeMedName(parentHint) || "").toUpperCase().trim();
    const parentId = parentKey ? idByCanonical.get(parentKey) : null;

    const childHint = stripFormPrefix(med.name).name || med.name;
    const childKey = (normalizeMedName(childHint) || "").toUpperCase().trim();
    if (!childKey) continue;

    if (!parentId) {
      error(
        "syncMedications",
        `support link unresolved for patient=${patientId} child="${med.name}" support_for="${med.support_for}"`,
      );
      continue;
    }

    await pool
      .query(
        `UPDATE medications
           SET parent_medication_id = $1,
               support_condition = COALESCE($2, support_condition),
               updated_at = NOW()
         WHERE patient_id = $3
           AND is_active = true
           AND UPPER(COALESCE(pharmacy_match, name)) = $4
           AND id <> $1`,
        [parentId, med.support_condition || null, patientId, childKey],
      )
      .catch((e) =>
        error(
          "syncMedications",
          `support link UPDATE failed for patient=${patientId} child="${med.name}" parent="${med.support_for}": ${e.message}`,
        ),
      );
  }
}

// ── Stop stale HealthRay meds not in the current prescription ───────────────
// After syncing current meds (which sets notes = 'healthray:ID'), deactivate
// any other HealthRay-sourced active meds that weren't updated by this sync.
// This handles meds that were prescribed before but dropped from the current note.
export async function stopStaleHealthrayMeds(patientId, healthrayId, apptDate) {
  if (!patientId || !healthrayId) return;

  // Skip when nothing got tagged with this healthrayId — that means the current
  // prescription was empty. Running the "stale" sweep in that state matches
  // every active HealthRay med for the patient and wipes prior visits' data.
  const { rows: tagged } = await pool.query(
    `SELECT 1 FROM medications
      WHERE patient_id = $1
        AND source = 'healthray'
        AND notes LIKE 'healthray:' || $2 || '%'
      LIMIT 1`,
    [patientId, String(healthrayId)],
  );
  if (tagged.length === 0) {
    log(
      "stopStaleHealthrayMeds",
      `${patientId}/${healthrayId}: skip — current prescription empty, preserving prior meds`,
    );
    return;
  }

  // Two-statement approach so the UPDATE sees the effects of the DELETE:
  //
  // Problem A: a pre-existing inactive row with the same canonical as a stale
  //   active row → flipping the active row to inactive creates a duplicate.
  // Problem B: two active rows share the same canonical (no unique constraint on
  //   active rows) → deactivating both creates two inactive rows that collide.
  //
  // Fix: one DELETE removes both kinds of conflict rows, then the UPDATE runs
  // clean against a de-duped set.
  await pool
    .query(
      `DELETE FROM medications
       WHERE patient_id = $1
         AND (
           -- (A) pre-existing inactive rows whose canonical matches a stale active row
           (is_active = false
            AND UPPER(COALESCE(pharmacy_match, name)) IN (
              SELECT UPPER(COALESCE(pharmacy_match, name))
              FROM medications
              WHERE patient_id = $1
                AND is_active = true
                AND source = 'healthray'
                AND (notes IS NULL OR notes NOT LIKE 'healthray:' || $2 || '%')
            ))
           OR
           -- (B) duplicate active rows per canonical — keep only the lowest id
           (is_active = true
            AND source = 'healthray'
            AND (notes IS NULL OR notes NOT LIKE 'healthray:' || $2 || '%')
            AND id NOT IN (
              SELECT MIN(id)
              FROM medications
              WHERE patient_id = $1
                AND is_active = true
                AND source = 'healthray'
                AND (notes IS NULL OR notes NOT LIKE 'healthray:' || $2 || '%')
              GROUP BY UPPER(COALESCE(pharmacy_match, name))
            ))
         )`,
      [patientId, String(healthrayId)],
    )
    .catch((e) =>
      error(
        "stopStaleHealthrayMeds",
        `pre-deactivation DELETE failed for patient=${patientId}: ${e.message}`,
      ),
    );

  await pool
    .query(
      `UPDATE medications
       SET is_active = false,
           stopped_date = $3,
           stop_reason = $2 || 'stopped',
           updated_at = NOW()
       WHERE patient_id = $1
         AND is_active = true
         AND source = 'healthray'
         AND (notes IS NULL OR notes NOT LIKE 'healthray:' || $2 || '%')`,
      [patientId, String(healthrayId), apptDate],
    )
    .catch((e) =>
      error(
        "stopStaleHealthrayMeds",
        `UPDATE failed for patient=${patientId} healthrayId=${healthrayId}: ${e.message}`,
      ),
    );
}

// ── Sync opdVitals → vitals table ───────────────────────────────────────────
export async function syncVitals(patientId, apptId, apptDate, opdVitals) {
  if (!patientId || !opdVitals) return;
  const w = parseFloat(opdVitals.weight) || null;
  const bpSys = parseFloat(opdVitals.bpSys) || null;
  const pulse = parseFloat(opdVitals.pulse) || null;
  const muscle = parseFloat(opdVitals.muscleMass) || null;
  const waist = parseFloat(opdVitals.waist) || null;
  const bodyFat = parseFloat(opdVitals.bodyFat) || null;
  if (!w && !bpSys && !pulse && !muscle && !waist && !bodyFat) return; // nothing useful to write

  await pool.query(`DELETE FROM vitals WHERE appointment_id = $1`, [apptId]);
  await pool
    .query(
      `INSERT INTO vitals
       (patient_id, appointment_id, recorded_at, bp_sys, bp_dia, pulse, weight, height, bmi, waist, body_fat, muscle_mass, bp_standing_sys, bp_standing_dia, source)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
      [
        patientId,
        apptId,
        apptDate,
        bpSys,
        parseFloat(opdVitals.bpDia) || null,
        pulse,
        w,
        parseFloat(opdVitals.height) || null,
        parseFloat(opdVitals.bmi) || null,
        waist,
        bodyFat,
        muscle,
        parseFloat(opdVitals.bpStandingSys) || null,
        parseFloat(opdVitals.bpStandingDia) || null,
        opdVitals._source || "healthray",
      ],
    )
    .catch((e) =>
      error("syncVitals", `INSERT failed for patient=${patientId} appt=${apptId}: ${e.message}`),
    );
}

// ── Sync vitals from extracted lab report data ────────────────────────────────
// Scans extracted panels for vital-sign values (Weight, Height, BMI, BP) and
// writes them to the vitals table — same pattern as HealthRay's syncVitals().
// Called after lab extraction from any upload path.
export async function syncVitalsFromExtraction(patientId, extractedData, recordedAt) {
  if (!patientId || !extractedData?.panels) return;

  const VITAL_CANONICAL = {
    Weight: "weight",
    "Weight (Kg)": "weight",
    BMI: "bmi",
    "Body Mass Index": "bmi",
    "Systolic BP": "bp_sys",
    "Diastolic BP": "bp_dia",
    Height: "height",
    Waist: "waist",
    "Waist Circumference": "waist",
  };

  const vitals = {};
  for (const panel of extractedData.panels) {
    for (const test of panel.tests || []) {
      const cn = test.test_name?.trim();
      if (!cn) continue;
      // Check direct match or case-insensitive match
      const key =
        VITAL_CANONICAL[cn] ||
        VITAL_CANONICAL[
          Object.keys(VITAL_CANONICAL).find((k) => k.toLowerCase() === cn.toLowerCase())
        ];
      if (key && test.result != null) {
        const val = parseFloat(test.result);
        if (!isNaN(val)) vitals[key] = val;
      }
    }
  }

  // Nothing vital-like found
  if (!vitals.weight && !vitals.bp_sys && !vitals.height && !vitals.bmi) return;

  // Auto-calculate BMI if weight and height present but BMI missing
  if (vitals.weight && vitals.height && !vitals.bmi) {
    const hm = vitals.height / 100;
    if (hm > 0) vitals.bmi = Math.round((vitals.weight / (hm * hm)) * 10) / 10;
  }

  const dateVal =
    recordedAt ||
    extractedData.report_date ||
    extractedData.collection_date ||
    new Date().toISOString().split("T")[0];

  try {
    // Skip if an identical row already exists for this patient + date
    const existing = await pool.query(
      `SELECT id FROM vitals
       WHERE patient_id = $1
         AND recorded_at::date = $2::date
         AND COALESCE(bp_sys, -1) = COALESCE($3::real, -1)
         AND COALESCE(weight, -1) = COALESCE($4::real, -1)
         AND COALESCE(height, -1) = COALESCE($5::real, -1)
       LIMIT 1`,
      [patientId, dateVal, vitals.bp_sys || null, vitals.weight || null, vitals.height || null],
    );
    if (existing.rows.length > 0) return;

    await pool.query(
      `INSERT INTO vitals
       (patient_id, recorded_at, bp_sys, bp_dia, weight, height, bmi, waist)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        patientId,
        dateVal,
        vitals.bp_sys || null,
        vitals.bp_dia || null,
        vitals.weight || null,
        vitals.height || null,
        vitals.bmi || null,
        vitals.waist || null,
      ],
    );
    log(
      "syncVitalsFromExtraction",
      `Patient ${patientId}: wrote vitals from extraction (${Object.keys(vitals).join(", ")})`,
    );
  } catch (e) {
    error("syncVitalsFromExtraction", `Patient ${patientId}: ${e.message}`);
  }
}

// ── Sync appointments.biomarkers from latest lab_results ─────────────────────
// Reads the most recent lab result per canonical for each OPD biomarker field
// and merges into appointments.biomarkers. Only overwrites a key when lab_results
// has a more-recent value than whatever is currently stored.
export async function syncBiomarkersFromLatestLabs(patientId, apptId) {
  if (!patientId || !apptId) return;

  // Map canonical_name → biomarker key (mirrors LAB_KEY_MAP in mappers.js)
  const CANONICAL_TO_BIO = {
    HbA1c: "hba1c",
    FBS: "fg",
    LDL: "ldl",
    Triglycerides: "tg",
    UACR: "uacr",
    "Microalbumin/Creatinine Ratio": "uacr",
    Microalbumin: "uacr",
    "Creatinine, Serum": "creatinine",
    Creatinine: "creatinine",
    eGFR: "egfr",
    TSH: "tsh",
    Hemoglobin: "hb",
    Haemoglobin: "hb",
  };

  try {
    // Get latest result per canonical_name for this patient
    const { rows } = await pool.query(
      `SELECT DISTINCT ON (canonical_name)
         canonical_name, result, test_date
       FROM lab_results
       WHERE patient_id = $1
         AND result IS NOT NULL
       ORDER BY canonical_name, test_date DESC NULLS LAST`,
      [patientId],
    );

    if (rows.length === 0) return;

    // Build update object: bioKey → { value, date }
    const updates = {};
    for (const row of rows) {
      const bioKey = CANONICAL_TO_BIO[row.canonical_name];
      if (!bioKey) continue;
      const val = parseFloat(row.result);
      if (isNaN(val)) continue;
      // Keep whichever date is more recent if multiple canonicals map to same key
      if (!updates[bioKey] || row.test_date > updates[bioKey].date) {
        updates[bioKey] = { val, date: row.test_date };
      }
    }

    if (Object.keys(updates).length === 0) return;

    // Build a JSONB patch of only the new values, but only overwrite a key when
    // the lab_results date is >= the date already stored in biomarkers._dates
    // Use a simple approach: read current biomarkers, compare dates, merge
    const { rows: apptRows } = await pool.query(
      `SELECT biomarkers FROM appointments WHERE id = $1`,
      [apptId],
    );
    const existing = apptRows[0]?.biomarkers || {};
    const existingDates = existing._lab_dates || {};

    const patch = {};
    const newDates = { ...existingDates };

    for (const [bioKey, { val, date }] of Object.entries(updates)) {
      const existingDate = existingDates[bioKey] || "";
      // Only update if newer (or no existing date recorded)
      if (!existingDate || date >= existingDate) {
        patch[bioKey] = val;
        newDates[bioKey] = date;
      }
    }

    if (Object.keys(patch).length === 0) return;

    patch._lab_dates = newDates;

    await pool.query(`UPDATE appointments SET biomarkers = biomarkers || $2::jsonb WHERE id = $1`, [
      apptId,
      JSON.stringify(patch),
    ]);

    log(
      "syncBiomarkers",
      `Patient ${patientId} appt ${apptId}: updated ${Object.keys(patch).length - 1} biomarker keys`,
    );
  } catch (e) {
    error("syncBiomarkers", `Patient ${patientId} appt ${apptId}: ${e.message}`);
  }
}

// ── Sync medical records (documents) ────────────────────────────────────────
export async function syncDocuments(patientId, records, fallbackDate, healthrayApptId) {
  if (!patientId || !records || records.length === 0) return;

  for (const rec of records) {
    const docType = mapRecordType(rec.record_type, rec.file_name);
    const noteParts = [`healthray_record:${rec.id}`];
    if (healthrayApptId) noteParts.unshift(`healthray_appt:${healthrayApptId}`);
    if (rec.medical_record_id) noteParts.push(`healthray_mrid:${rec.medical_record_id}`);
    if (rec.record_type) noteParts.push(`healthray_rtype:${rec.record_type}`);
    const notes = noteParts.join("|");

    const dup = await pool.query(
      `SELECT id, notes FROM documents WHERE patient_id = $1 AND file_name = $2 AND source = 'healthray' LIMIT 1`,
      [patientId, rec.file_name],
    );
    if (dup.rows[0]) {
      // Refresh stored file_url + back-fill notes with appt/mrid info
      const freshUrl = rec.url || rec.file_url || rec.attachment_url || rec.thumbnail || null;
      const existingNotes = dup.rows[0].notes || "";
      const needsNoteUpdate =
        !existingNotes.includes("healthray_mrid:") || !existingNotes.includes("healthray_appt:");
      if (freshUrl || needsNoteUpdate) {
        await pool
          .query(
            `UPDATE documents SET
               file_url = COALESCE($1, file_url),
               notes = $2
             WHERE id = $3`,
            [freshUrl, notes, dup.rows[0].id],
          )
          .catch(() => {});
      }
      // Download actual PDF to Supabase if not stored or only has blurry thumbnail
      const hasStorage = await pool.query(
        `SELECT storage_path, mime_type FROM documents WHERE id=$1`,
        [dup.rows[0].id],
      );
      const needsDownload =
        !hasStorage.rows[0]?.storage_path || hasStorage.rows[0]?.mime_type === "image/jpeg";
      if (needsDownload) {
        downloadAndStore(
          patientId,
          dup.rows[0].id,
          freshUrl,
          rec.file_name,
          rec.id,
          rec.record_type,
          rec.medical_record_id,
        )
          .then((p) => p && log("DB", `Stored file for existing doc ${dup.rows[0].id} → ${p}`))
          .catch(() => {});
      }
      continue;
    }

    const freshUrl = rec.url || rec.file_url || rec.attachment_url || rec.thumbnail || null;
    const insertRes = await pool
      .query(
        `INSERT INTO documents (patient_id, doc_type, title, file_name, file_url, mime_type, doc_date, source, notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'healthray', $8) RETURNING id`,
        [
          patientId,
          docType,
          `${rec.record_type} - ${rec.file_name}`,
          rec.file_name,
          freshUrl,
          rec.file_type || "application/pdf",
          rec.app_date_time ? toISTDate(rec.app_date_time) : fallbackDate,
          notes,
        ],
      )
      .catch((e) => {
        error(
          "syncDocuments",
          `INSERT failed for patient=${patientId} record_id=${rec.id} file_name="${rec.file_name}": ${e.message}`,
        );
        return null;
      });

    // Download file to Supabase for permanent storage (fire-and-forget)
    const newDocId = insertRes?.rows?.[0]?.id;
    if (newDocId && freshUrl) {
      downloadAndStore(
        patientId,
        newDocId,
        freshUrl,
        rec.file_name,
        rec.id,
        rec.record_type,
        rec.medical_record_id,
      )
        .then((p) => p && log("DB", `Stored file for new doc ${newDocId} → ${p}`))
        .catch(() => {});
    }
  }

  log("DB", `${records.length} documents synced`);
}

// ── Auto-mark a HealthRay appointment as "checkedin" ────────────────────────
// Patient appears in HealthRay but no prescription yet — mark as checked in.
export async function markAppointmentAsCheckedIn(appointmentId) {
  try {
    const { rowCount } = await pool.query(
      `UPDATE appointments
         SET status = 'checkedin',
             checked_in_at = COALESCE(checked_in_at, NOW()),
             updated_at = NOW()
       WHERE id = $1 AND status IN ('scheduled', 'in-progress')`,
      [appointmentId],
    );
    if (rowCount > 0) {
      log("DB", `Auto-checked-in appointment ${appointmentId}`);
    }
  } catch (e) {
    error("markAppointmentAsCheckedIn", `Failed for appointment ${appointmentId}: ${e.message}`);
  }
}

// ── Auto-mark a completed HealthRay appointment as "seen" ──────────────────
// Creates a consultation and links all OPD records, mirroring the manual
// "mark as seen" flow in /api/appointments/:id PATCH.
// `finalStatus` lets callers land on 'completed' instead of 'seen' — used
// when HealthRay reports checkout/completed (prescription printed there).
export async function markAppointmentAsSeen(appointmentId, finalStatus = "seen") {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // ── Auto-assign category based on HbA1c (mirrors frontend AI suggestion) ──
    const autoCategory = (bio, visitType) => {
      const hba1c = parseFloat(bio?.hba1c);
      if (!isNaN(hba1c)) {
        if (hba1c > 9) return "complex"; // Uncontrolled
        if (hba1c > 7) return "maint"; // Maintenance
        return "ctrl"; // Continuous Care
      }
      if (visitType === "New Patient") return "new";
      return null;
    };

    const { rows } = await client.query(`SELECT * FROM appointments WHERE id = $1 FOR UPDATE`, [
      appointmentId,
    ]);
    if (!rows[0]) {
      await client.query("ROLLBACK");
      return null;
    }

    // Update status if not already at the target. Never downgrade a
    // 'completed' appointment back to 'seen' — completed is terminal.
    const currentStatus = rows[0].status;
    const shouldUpdate =
      currentStatus !== finalStatus && !(finalStatus === "seen" && currentStatus === "completed");
    if (shouldUpdate) {
      await client.query(`UPDATE appointments SET status = $2, updated_at = NOW() WHERE id = $1`, [
        appointmentId,
        finalStatus,
      ]);
    }

    const appt = rows[0];
    const bio = appt.biomarkers || {};
    const comp = appt.compliance || {};

    // ── Auto-fill prep steps based on available data ──
    const category = appt.category || autoCategory(bio, appt.visit_type);
    const prepSteps = appt.prep_steps || {};
    const newSteps = {};

    // Biomarkers: mark done if any biomarker value exists
    if (!prepSteps.biomarkers && Object.keys(bio).some((k) => bio[k] != null && bio[k] !== "")) {
      newSteps.biomarkers = true;
    }
    // Compliance: mark done if compliance data or medications/diagnoses exist
    if (
      !prepSteps.compliance &&
      (Object.keys(comp).length > 0 ||
        appt.healthray_medications?.length > 0 ||
        appt.healthray_diagnoses?.length > 0)
    ) {
      newSteps.compliance = true;
    }
    // Categorized: mark done if category is set
    if (!prepSteps.categorized && category) {
      newSteps.categorized = true;
    }
    // Assigned: mark done if doctor is assigned
    if (!prepSteps.assigned && appt.doctor_name) {
      newSteps.assigned = true;
    }

    if (Object.keys(newSteps).length > 0 || (category && category !== appt.category)) {
      await client.query(
        `UPDATE appointments
           SET category = COALESCE($1, category),
               prep_steps = COALESCE(prep_steps, '{}'::jsonb) || $2::jsonb
         WHERE id = $3`,
        [category, JSON.stringify(newSteps), appt.id],
      );
      appt.category = category || appt.category;
      Object.assign(prepSteps, newSteps);
    }

    if (!appt.patient_id || appt.consultation_id) {
      await client.query("COMMIT");
      return appt.id;
    }

    const compliance = appt.compliance || {};
    const biomarkers = appt.biomarkers || {};
    const notes = [];
    if (compliance.diet) notes.push(`Diet: ${compliance.diet}`);
    if (compliance.exercise) notes.push(`Exercise: ${compliance.exercise}`);
    if (compliance.stress) notes.push(`Stress: ${compliance.stress}`);
    if (compliance.medPct != null) notes.push(`Med adherence: ${compliance.medPct}%`);
    if (compliance.missed) notes.push(`Missed: ${compliance.missed}`);
    if (compliance.notes) notes.push(`Notes: ${compliance.notes}`);

    // Read current truth from normalized tables
    const liveMedsR = await client.query(
      `SELECT name, dose, frequency, timing, route, is_active FROM medications
       WHERE patient_id = $1 AND is_active = true ORDER BY created_at DESC`,
      [appt.patient_id],
    );
    const liveStoppedR = await client.query(
      `SELECT name, dose, stop_reason FROM medications
       WHERE patient_id = $1 AND is_active = false AND stopped_date >= CURRENT_DATE - INTERVAL '30 days'
       ORDER BY stopped_date DESC`,
      [appt.patient_id],
    );
    const liveDiagsR = await client.query(
      `SELECT diagnosis_id AS id, label, status FROM diagnoses
       WHERE patient_id = $1 AND is_active != false ORDER BY created_at DESC`,
      [appt.patient_id],
    );
    const opdMeds = liveMedsR.rows;
    const opdDiags = liveDiagsR.rows;
    const opdStopped = liveStoppedR.rows;

    // Build con_transcript from OPD prescription documents
    const rxDocs = await client.query(
      `SELECT extracted_data FROM documents
       WHERE patient_id = $1 AND source = 'opd_upload' AND doc_type = 'prescription'
         AND extracted_data IS NOT NULL
       ORDER BY doc_date DESC NULLS LAST, created_at DESC`,
      [appt.patient_id],
    );
    const transcriptParts = [];
    for (const doc of rxDocs.rows) {
      const rx = doc.extracted_data || {};
      const parts = [];
      if (rx.diagnoses?.length)
        parts.push(
          "DIAGNOSIS:\n" +
            rx.diagnoses.map((d) => `${d.label}${d.status ? ` (${d.status})` : ""}`).join("\n"),
        );
      if (rx.medications?.length) {
        parts.push(
          "TREATMENT:\n" +
            rx.medications
              .map((m) =>
                (() => {
                  const wt = (normalizeWhenToTake(m.when_to_take) || []).join(", ");
                  return `-${m.name}${m.dose ? " " + m.dose : ""}${m.frequency ? " " + m.frequency : ""}${wt ? " · " + wt : ""}${m.timing && m.timing !== wt ? " (" + m.timing + ")" : ""}`;
                })(),
              )
              .join("\n"),
        );
      }
      if (rx.stopped_medications?.length)
        parts.push(
          "STOPPED:\n" +
            rx.stopped_medications
              .map((m) => `-${m.name}${m.reason ? " (" + m.reason + ")" : ""}`)
              .join("\n"),
        );
      if (rx.advice?.length) parts.push("ADVICE:\n" + rx.advice.join("\n"));
      if (rx.follow_up) parts.push("FOLLOW UP: " + rx.follow_up);
      if (rx.doctor_name)
        transcriptParts.push(
          `Rx by ${rx.doctor_name}${rx.visit_date ? " on " + rx.visit_date : ""}:`,
        );
      if (parts.length) transcriptParts.push(parts.join("\n\n"));
      transcriptParts.push("");
    }
    // Add biomarker notes
    if (Object.keys(biomarkers).length > 0) {
      const bioLines = [];
      const bioLabels = {
        hba1c: "HbA1c",
        fg: "FPG",
        bpSys: "BP Sys",
        bpDia: "BP Dia",
        ldl: "LDL",
        tg: "TG",
        uacr: "UACR",
        weight: "Weight",
        waist: "Waist",
        creatinine: "Creatinine",
        tsh: "TSH",
        hb: "Hb",
      };
      for (const [k, v] of Object.entries(biomarkers)) {
        if (v != null && v !== "" && bioLabels[k]) bioLines.push(`${bioLabels[k]}: ${v}`);
      }
      if (bioLines.length) transcriptParts.push("BIOMARKERS:\n" + bioLines.join("\n"));
    }
    if (notes.length) transcriptParts.push("COMPLIANCE:\n" + notes.join("\n"));
    const conTranscript = transcriptParts.filter(Boolean).join("\n\n");

    // Upsert by (patient_id, visit_date::date, doctor). Done as explicit
    // SELECT-then-UPDATE-or-INSERT instead of ON CONFLICT because the prod
    // DB has legacy duplicate consultations and we don't want to delete
    // them to add the unique index. If a row already exists for this
    // patient/day/doctor we preserve its richer fields (mo_transcript,
    // plan_edits, exam_data) and only fill missing pieces from HealthRay.
    const moData = JSON.stringify({
      compliance,
      coordinator_notes: appt.coordinator_notes || [],
      category: appt.category,
      diagnoses: opdDiags,
      previous_medications: opdMeds,
      stopped_medications: opdStopped,
      chief_complaints: opdDiags.map((d) => d.label),
    });
    const conData = JSON.stringify({
      biomarkers,
      opd_notes: notes.join("\n"),
      medications_confirmed: opdMeds,
      investigations_to_order: (() => {
        const inv = appt.healthray_investigations || [];
        return inv.map((t) =>
          typeof t === "string"
            ? { name: t, urgency: "routine" }
            : { name: t.name || t.test || String(t), urgency: t.urgency || "routine" },
        );
      })(),
      diet_lifestyle: (() => {
        const c = appt.compliance || {};
        const lines = [];
        if (c.diet) lines.push(c.diet);
        if (c.exercise) lines.push(c.exercise);
        if (c.stress) lines.push(c.stress);
        return lines;
      })(),
      follow_up: appt.healthray_follow_up || null,
    });
    const transcriptArg = conTranscript || null;
    const docName = appt.doctor_name || null;

    // Pick the richest existing row for this patient/day. We don't filter by
    // doctor because the HealthRay insert below leaves both doctor FKs NULL,
    // so the original ON CONFLICT effectively grouped any same-day rows
    // missing doctor FKs together. Picking the richest mirrors the dedup
    // migration's winner-selection score so we update the same row the UI
    // already considers canonical.
    const existingConRes = await client.query(
      `SELECT id FROM consultations
        WHERE patient_id = $1
          AND visit_date::date = ($2::timestamptz)::date
        ORDER BY
          (COALESCE(length(mo_data::text),0) + COALESCE(length(con_data::text),0)
           + COALESCE(length(mo_transcript),0) + COALESCE(length(con_transcript),0)
           + COALESCE(length(quick_transcript),0)) DESC,
          created_at DESC, id DESC
        LIMIT 1`,
      [appt.patient_id, appt.appointment_date],
    );

    let consultationId;
    if (existingConRes.rows[0]) {
      consultationId = existingConRes.rows[0].id;
      await client.query(
        `UPDATE consultations SET
           visit_type     = COALESCE(visit_type, 'OPD'),
           con_name       = COALESCE(con_name, $2),
           mo_data        = COALESCE(mo_data, $3::jsonb),
           con_data       = COALESCE(con_data, $4::jsonb),
           con_transcript = COALESCE(con_transcript, $5),
           updated_at     = NOW()
         WHERE id = $1`,
        [consultationId, docName, moData, conData, transcriptArg],
      );
    } else {
      const insRes = await client.query(
        `INSERT INTO consultations
           (patient_id, visit_date, visit_type, con_name, status, mo_data, con_data, con_transcript)
         VALUES ($1, $2, 'OPD', $3, 'completed', $4, $5, $6)
         RETURNING id`,
        [appt.patient_id, appt.appointment_date, docName, moData, conData, transcriptArg],
      );
      consultationId = insRes.rows[0].id;
    }
    // Link all patient records to this consultation
    await client.query(
      `UPDATE diagnoses SET consultation_id = $1
       WHERE patient_id = $2 AND (consultation_id IS NULL OR consultation_id = $1)`,
      [consultationId, appt.patient_id],
    );
    await client.query(`UPDATE lab_results SET consultation_id = $1 WHERE appointment_id = $2`, [
      consultationId,
      appt.id,
    ]);
    await client.query(`UPDATE vitals SET consultation_id = $1 WHERE appointment_id = $2`, [
      consultationId,
      appt.id,
    ]);
    await client.query(`UPDATE medications SET consultation_id = $1 WHERE appointment_id = $2`, [
      consultationId,
      appt.id,
    ]);
    // Attach only meds belonging to THIS appointment's healthray batch (matched by
    // `notes = healthray:<id>`). The previous broad sweep over all NULL-consultation
    // rows was first-come-first-served: the oldest appointment to be marked-seen would
    // grab every orphaned med across every Rx, so newer prescriptions ended up tied to
    // the oldest visit_date and got nuked by the visit-page reconcile sweep.
    if (appt.healthray_id != null) {
      await client.query(
        `UPDATE medications SET consultation_id = $1
         WHERE patient_id = $2
           AND is_active = true
           AND notes = 'healthray:' || $3::text
           AND (consultation_id IS NULL OR consultation_id <> $1)`,
        [consultationId, appt.patient_id, String(appt.healthray_id)],
      );
    }
    await client.query(
      `UPDATE documents SET consultation_id = $1 WHERE patient_id = $2 AND source = 'opd_upload' AND consultation_id IS NULL`,
      [consultationId, appt.patient_id],
    );
    await client.query(
      `UPDATE documents SET consultation_id = $1
       WHERE patient_id = $2 AND consultation_id IS NULL AND created_at > $3`,
      [consultationId, appt.patient_id, appt.checked_in_at || appt.created_at],
    );

    // Store consultation_id and sync live data back to JSONB
    await client.query(
      `UPDATE appointments SET
         consultation_id = $1,
         opd_medications = $2::jsonb,
         opd_diagnoses = $3::jsonb,
         opd_stopped_medications = $4::jsonb
       WHERE id = $5`,
      [
        consultationId,
        JSON.stringify(opdMeds),
        JSON.stringify(opdDiags),
        JSON.stringify(opdStopped),
        appt.id,
      ],
    );

    await client.query("COMMIT");
    log(
      "DB",
      `Auto-marked appointment ${appointmentId} as ${finalStatus} → consultation ${consultationId}`,
    );

    // Fire-and-log auto Rx save. Idempotency lives inside the helper so
    // repeated calls (e.g. stuck-status recovery, manual PATCH that lands
    // on an already-seen row) do not write duplicate prescriptions.
    autoSavePrescriptionAfterSeen(appt.patient_id, appt.id, consultationId).catch((e) =>
      console.warn("[markAppointmentAsSeen] Rx auto-save failed:", e.message),
    );

    return consultationId;
  } catch (e) {
    await client.query("ROLLBACK");
    error("markAppointmentAsSeen", `Failed for appointment ${appointmentId}: ${e.message}`);
    return null;
  } finally {
    client.release();
  }
}
