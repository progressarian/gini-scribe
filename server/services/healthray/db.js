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
      ADD COLUMN IF NOT EXISTS healthray_labs JSONB DEFAULT '[]'::jsonb;
    ALTER TABLE appointments
      ADD COLUMN IF NOT EXISTS healthray_advice TEXT;
    ALTER TABLE doctors
      ADD COLUMN IF NOT EXISTS healthray_id INTEGER;
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
    `SELECT id, patient_id, healthray_clinical_notes, compliance, source FROM appointments WHERE healthray_id = $1`,
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
        healthray_advice = $8, status = COALESCE($9, status), updated_at = NOW()
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
        healthray_labs, healthray_advice)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16::jsonb,$17::jsonb,$18,$19::jsonb,$20::jsonb,$21::jsonb,$22)
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
    ],
  );
  return rows[0].id;
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
    await pool
      .query(
        `INSERT INTO lab_results
         (patient_id, appointment_id, test_date, test_name, canonical_name, result, unit, source)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'healthray')`,
        [
          patientId,
          apptId,
          apptDate,
          lab.test,
          (lab.test || "").toLowerCase().replace(/\s+/g, "_"),
          val,
          lab.unit || null,
        ],
      )
      .catch(() => {});
  }
}

// ── Sync parsed medications → medications table ─────────────────────────────
export async function syncMedications(patientId, healthrayId, apptDate, meds) {
  if (!patientId || meds.length === 0) return;

  const existing = await pool.query(
    `SELECT id FROM medications WHERE patient_id = $1 AND notes = $2 LIMIT 1`,
    [patientId, `healthray:${healthrayId}`],
  );
  if (existing.rows[0]) return;

  for (const med of meds) {
    await pool
      .query(
        `INSERT INTO medications
         (patient_id, name, dose, frequency, timing, route, is_active, started_date, notes)
         VALUES ($1, $2, $3, $4, $5, $6, true, $7, $8)`,
        [
          patientId,
          med.name,
          med.dose || null,
          med.frequency || null,
          med.timing || null,
          med.route || "Oral",
          apptDate,
          `healthray:${healthrayId}`,
        ],
      )
      .catch(() => {});
  }
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
          rec.thumbnail || null,
          rec.file_type || "application/pdf",
          rec.app_date_time ? toISTDate(rec.app_date_time) : fallbackDate,
          `healthray_record:${rec.id}`,
        ],
      )
      .catch(() => {});
  }

  log("DB", `${records.length} documents synced`);
}
