// ── HealthRay Sync DB operations ────────────────────────────────────────────

import pool from "../../config/db.js";
import { mapRecordType, toISTDate } from "./mappers.js";
import { createLogger } from "../logger.js";
const { log } = createLogger("HealthRay Sync");

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
    CREATE UNIQUE INDEX IF NOT EXISTS idx_appt_healthray
      ON appointments(healthray_id) WHERE healthray_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_doc_healthray
      ON doctors(healthray_id) WHERE healthray_id IS NOT NULL;
  `);
  columnsReady = true;
}

// ── Find previous appointment with clinical notes for same patient ──────────
export async function findAppointmentWithNotes(fileNo, phone, excludeHealthrayId) {
  return pool.query(
    `SELECT healthray_id FROM appointments
     WHERE healthray_clinical_notes IS NOT NULL AND LENGTH(healthray_clinical_notes) > 20
       AND healthray_id != $3
       AND (($1::text IS NOT NULL AND file_no = $1) OR ($2::text IS NOT NULL AND phone = $2))
     ORDER BY appointment_date DESC LIMIT 1`,
    [fileNo || null, phone || null, excludeHealthrayId],
  );
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
  const existing = await pool.query(
    `SELECT id, file_no FROM patients
     WHERE ($1::text IS NOT NULL AND file_no = $1)
        OR ($2::text IS NOT NULL AND phone = $2)
     ORDER BY (file_no = $1::text) DESC NULLS LAST
     LIMIT 1`,
    [fileNo, phone],
  );

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
      const dup = await pool.query(
        `SELECT id FROM patients WHERE phone = $1 OR file_no = $2 LIMIT 1`,
        [phone, fileNo],
      );
      return dup.rows[0]?.id || null;
    }
    throw e;
  }
}

// ── Sync doctors ────────────────────────────────────────────────────────────
export async function syncDoctors(rayDoctors) {
  const mapping = new Map();

  for (const rd of rayDoctors) {
    if (rd.is_deactivated) continue;

    const hrid = rd.id;
    const rayName = rd.doctor_name;
    const specialty = rd.specialty_name || null;
    const phone = rd.mobile_no || null;

    let local = await pool.query(`SELECT id, name FROM doctors WHERE healthray_id = $1`, [hrid]);

    if (!local.rows[0] && phone) {
      local = await pool.query(`SELECT id, name FROM doctors WHERE phone = $1`, [phone]);
    }

    if (!local.rows[0]) {
      const stripped = rayName
        .replace(/^Dr\.?\s*/i, "")
        .trim()
        .toLowerCase();
      local = await pool.query(
        `SELECT id, name FROM doctors
         WHERE LOWER(REPLACE(name, 'Dr. ', '')) ILIKE $1
            OR LOWER(short_name) ILIKE $1
         LIMIT 1`,
        [`%${stripped}%`],
      );
    }

    if (local.rows[0]) {
      await pool.query(
        `UPDATE doctors SET healthray_id = $2, specialty = COALESCE(specialty, $3) WHERE id = $1`,
        [local.rows[0].id, hrid, specialty],
      );
      mapping.set(hrid, local.rows[0].name);
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
  if (!name) return name;

  const n = name.toLowerCase().trim();

  // FBS
  if (n.includes("fasting") || n.includes("fbs") || n.includes("fbg")) {
    return "FBS";
  }

  // PPBS
  if (n.includes("post") || n.includes("ppbs") || n.includes("postprandial")) {
    return "PPBS";
  }

  // RBS
  if (n.includes("random") || n.includes("rbs")) {
    return "RBS";
  }

  // HbA1c
  if (n.includes("hba1c") || n.includes("glycated")) {
    return "HbA1c";
  }

  // Weight
  if (n.includes("weight")) {
    return "Weight";
  }

  return name;
}

// ── Sync parsed labs → lab_results table ────────────────────────────────────
export async function syncLabResults(patientId, apptId, apptDate, labs) {
  if (!patientId || labs.length === 0) return;

  await pool.query(`DELETE FROM lab_results WHERE appointment_id = $1 AND source = 'healthray'`, [
    apptId,
  ]);

  for (const lab of labs) {
    const val = parseFloat(lab.value);
    if (isNaN(val)) continue;
    const canonicalName = normalizeCanonicalName(lab.test);
    // Use lab's own date if the AI extracted a specific date (e.g. "FOLLOW UP TODAY: 31/1/26" labs)
    // otherwise fall back to appointment date
    const labDate = lab.date || apptDate;

    // Skip if a better-or-equal source already exists for same patient + test + date
    const existing = await pool.query(
      `SELECT source FROM lab_results
       WHERE patient_id = $1 AND canonical_name = $2 AND test_date::date = $3::date
       ORDER BY CASE source
         WHEN 'opd' THEN 1 WHEN 'report_extract' THEN 2 WHEN 'lab_healthray' THEN 3
         WHEN 'vitals_sheet' THEN 4 WHEN 'prescription_parsed' THEN 5 WHEN 'healthray' THEN 6 ELSE 7
       END ASC LIMIT 1`,
      [patientId, canonicalName, labDate],
    );
    if (existing.rows[0]) {
      const existingPriority = SOURCE_PRIORITY[existing.rows[0].source] ?? 99;
      if (existingPriority <= SOURCE_PRIORITY.healthray) continue;
    }

    await pool
      .query(
        `INSERT INTO lab_results
         (patient_id, appointment_id, test_date, test_name, canonical_name, result, unit, source)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'healthray')`,
        [patientId, apptId, labDate, lab.test, canonicalName, val, lab.unit || null],
      )
      .catch(() => {});
  }
}

// ── Sync parsed medications → medications table ─────────────────────────────
// ── Normalize diagnosis name → canonical ID to prevent duplicates ───────────
function normalizeDiagnosisId(name) {
  // Strip parenthetical qualifiers before matching — "(Since 1998)", "(Seronegative)", etc.
  const n = name
    .toLowerCase()
    .trim()
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
  if (/hypothyroid/.test(n)) return "hypothyroidism";
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
  if (/coronary artery disease|cad\b/.test(n)) return "coronary_artery_disease";
  if (/atrial fibrillation|af\b|afib/.test(n)) return "atrial_fibrillation";
  if (/myocardial infarction|\bmi\b.*heart|heart.*\bmi\b/.test(n)) return "myocardial_infarction";
  if (/cerebrovascular accident|cva\b|stroke/.test(n)) return "cerebrovascular_accident";
  if (/peripheral vascular disease|pvd\b/.test(n)) return "peripheral_vascular_disease";

  // Sleep & respiratory
  if (/obstructive sleep apnea|osas\b|osa\b/.test(n)) return "obstructive_sleep_apnea";

  // Thyroid eye disease
  if (/thyroid.*(orbitopathy|ophthalmopathy|eye disease)|tao\b|ted\b/.test(n))
    return "thyroid_associated_orbitopathy";

  // Retinopathy
  if (/retinopathy/.test(n)) return "diabetic_retinopathy";

  // Dyslipidemia
  if (/dyslipidemia|hyperlipidemia|hypercholesterol/.test(n)) return "dyslipidemia";

  // Obesity / adiposity
  if (/^obesity$/.test(n)) return "obesity";
  if (/dual adiposity|visceral adiposity|adiposity/.test(n)) return "dual_adiposity";

  // MASLD / fatty liver
  if (
    /masld|mafld|nafld|non.alcoholic fatty liver|metabolic.*steatotic liver|metabolic.*fatty liver/.test(
      n,
    )
  )
    return "masld";

  // Default: slugify (using stripped name without parentheticals)
  return n
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 100);
}

// ── Sync diagnoses from HealthRay clinical notes ────────────────────────────
// Detect negative/absent findings that should not be stored as diagnoses
function isAbsentFinding(dx) {
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

export async function syncDiagnoses(patientId, healthrayId, diagnoses) {
  if (!patientId || !diagnoses || diagnoses.length === 0) return;

  for (const dx of diagnoses) {
    if (!dx.name) continue;
    if (isAbsentFinding(dx)) continue;
    // Strip "+" suffix the AI may leave on condition names (e.g. "NEUROPATHY+" → "NEUROPATHY")
    const cleanName = stripPlusSuffix(dx.name);
    if (!cleanName) continue;
    const diagId = normalizeDiagnosisId(dx.id || cleanName);

    await pool
      .query(
        `INSERT INTO diagnoses (patient_id, diagnosis_id, label, status, notes)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (patient_id, diagnosis_id) DO UPDATE SET
           label = EXCLUDED.label,
           status = COALESCE(EXCLUDED.status, diagnoses.status),
           notes = COALESCE(EXCLUDED.notes, diagnoses.notes),
           updated_at = NOW()`,
        [
          patientId,
          diagId,
          cleanName,
          dx.status || "Active",
          `healthray:${healthrayId}${dx.details ? " — " + dx.details : ""}`,
        ],
      )
      .catch(() => {});
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
    await pool
      .query(
        `INSERT INTO visit_symptoms (patient_id, symptom_id, label, appointment_id)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (patient_id, symptom_id) DO UPDATE SET
           label = EXCLUDED.label,
           appointment_id = EXCLUDED.appointment_id,
           updated_at = NOW()`,
        [patientId, symptomId, sy.name, apptId],
      )
      .catch(() => {});
  }
}

// ── Sync stopped/previous medications from HealthRay ──────────────────────────
export async function syncStoppedMedications(patientId, healthrayId, stoppedMeds) {
  if (!patientId || !stoppedMeds || stoppedMeds.length === 0) return;

  for (const med of stoppedMeds) {
    if (!med.name) continue;

    const reason = `healthray:${healthrayId}${med.reason ? " — " + med.reason : med.status || ""}`;

    // Try to mark existing active med as stopped (by name + dose)
    const updateRes = await pool
      .query(
        `UPDATE medications
         SET is_active = false,
             stopped_date = CURRENT_DATE,
             stop_reason = $2,
             updated_at = NOW()
         WHERE patient_id = $1
           AND UPPER(COALESCE(pharmacy_match, name)) = UPPER($3)
           AND (($4::text IS NULL AND dose IS NULL) OR dose = $4)
           AND is_active = true`,
        [patientId, reason, med.name, med.dose || null],
      )
      .catch(() => ({ rowCount: 0 }));

    // If no existing active medicine found, insert as a new stopped entry (for dose changes)
    // Only insert if this dose+name combo doesn't already exist
    if (updateRes.rowCount === 0) {
      const checkExists = await pool
        .query(
          `SELECT id FROM medications
           WHERE patient_id = $1
             AND UPPER(name) = UPPER($2)
             AND dose = $3`,
          [patientId, med.name, med.dose || null],
        )
        .catch(() => ({ rows: [] }));

      if (checkExists.rows.length === 0) {
        await pool
          .query(
            `INSERT INTO medications (patient_id, name, dose, frequency, is_active, stopped_date, stop_reason, notes)
             VALUES ($1, $2, $3, $4, false, CURRENT_DATE, $5, $6)`,
            [
              patientId,
              med.name,
              med.dose || null,
              med.frequency || null,
              reason,
              `Previous dose (stopped)`,
            ],
          )
          .catch(() => {});
      }
    }
  }
}

export async function syncMedications(patientId, healthrayId, apptDate, meds) {
  if (!patientId || meds.length === 0) return;

  for (const med of meds) {
    if (!med.name) continue;
    const params = [
      patientId,
      med.name,
      med.dose || null,
      med.frequency || null,
      med.timing || null,
      med.route || "Oral",
      apptDate,
      `healthray:${healthrayId}`,
    ];

    // Step 1: reactivate any existing inactive row with the same name first.
    // Without this, syncMedications creates a duplicate active row (because the
    // ON CONFLICT below can't match the partial inactive index), and the next
    // reconcile then fails with a unique constraint violation when it tries to
    // stop both rows.
    // Also clear consultation_id/document_id so HealthRay takes ownership —
    // otherwise old consultation-linked rows stay filtered out by latest_cons.
    await pool
      .query(
        `UPDATE medications
         SET is_active = true,
             dose = COALESCE($3, dose),
             frequency = COALESCE($4, frequency),
             timing = COALESCE($5, timing),
             route = COALESCE($6, route),
             started_date = COALESCE($7, started_date),
             notes = $8,
             consultation_id = NULL,
             document_id = NULL,
             updated_at = NOW()
         WHERE patient_id = $1
           AND UPPER(COALESCE(pharmacy_match, name)) = UPPER($2)
           AND is_active = false`,
        params,
      )
      .catch(() => {});

    // Step 2: insert or upsert the active row.
    await pool
      .query(
        `INSERT INTO medications
         (patient_id, name, dose, frequency, timing, route, is_active, started_date, notes, source)
         VALUES ($1, $2, $3, $4, $5, $6, true, $7, $8, 'healthray')
         ON CONFLICT (patient_id, UPPER(COALESCE(pharmacy_match, name))) WHERE is_active = true
         DO UPDATE SET
           dose = COALESCE(EXCLUDED.dose, medications.dose),
           frequency = COALESCE(EXCLUDED.frequency, medications.frequency),
           timing = COALESCE(EXCLUDED.timing, medications.timing),
           route = COALESCE(EXCLUDED.route, medications.route),
           started_date = COALESCE(EXCLUDED.started_date, medications.started_date),
           notes = EXCLUDED.notes,
           source = 'healthray',
           consultation_id = NULL,
           document_id = NULL,
           updated_at = NOW()`,
        params,
      )
      .catch(() => {});
  }
}

// ── Stop stale HealthRay meds not in the current prescription ───────────────
// After syncing current meds (which sets notes = 'healthray:ID'), deactivate
// any other HealthRay-sourced active meds that weren't updated by this sync.
// This handles meds that were prescribed before but dropped from the current note.
export async function stopStaleHealthrayMeds(patientId, healthrayId, apptDate) {
  if (!patientId || !healthrayId) return;
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
    .catch(() => {});
}

// ── Sync opdVitals → vitals table ───────────────────────────────────────────
export async function syncVitals(patientId, apptId, apptDate, opdVitals) {
  if (!patientId || !opdVitals) return;
  const w = parseFloat(opdVitals.weight) || null;
  const bpSys = parseFloat(opdVitals.bpSys) || null;
  if (!w && !bpSys) return; // nothing useful to write

  await pool.query(`DELETE FROM vitals WHERE appointment_id = $1`, [apptId]);
  await pool
    .query(
      `INSERT INTO vitals
       (patient_id, appointment_id, recorded_at, bp_sys, bp_dia, weight, height, bmi, waist, body_fat)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        patientId,
        apptId,
        apptDate,
        bpSys,
        parseFloat(opdVitals.bpDia) || null,
        w,
        parseFloat(opdVitals.height) || null,
        parseFloat(opdVitals.bmi) || null,
        parseFloat(opdVitals.waist) || null,
        parseFloat(opdVitals.bodyFat) || null,
      ],
    )
    .catch(() => {});
}

// ── Sync medical records (documents) ────────────────────────────────────────
export async function syncDocuments(patientId, records, fallbackDate) {
  if (!patientId || !records || records.length === 0) return;

  for (const rec of records) {
    const docType = mapRecordType(rec.record_type, rec.file_name);
    const dup = await pool.query(
      `SELECT id FROM documents WHERE patient_id = $1 AND file_name = $2 AND source = 'healthray' LIMIT 1`,
      [patientId, rec.file_name],
    );
    if (dup.rows[0]) continue;

    await pool
      .query(
        `INSERT INTO documents (patient_id, doc_type, title, file_name, file_url, mime_type, doc_date, source, notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'healthray', $8)`,
        [
          patientId,
          docType,
          `${rec.record_type} - ${rec.file_name}`,
          rec.file_name,
          rec.url || rec.file_url || rec.attachment_url || rec.thumbnail || null,
          rec.file_type || "application/pdf",
          rec.app_date_time ? toISTDate(rec.app_date_time) : fallbackDate,
          `healthray_record:${rec.id}`,
        ],
      )
      .catch(() => {});
  }

  log("DB", `${records.length} documents synced`);
}
