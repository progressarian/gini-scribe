// ── HealthRay Sync DB operations ────────────────────────────────────────────

import pool from "../../config/db.js";
import { SUPABASE_URL, SUPABASE_SERVICE_KEY, STORAGE_BUCKET } from "../../config/storage.js";
import { mapRecordType, toISTDate } from "./mappers.js";
import { createLogger } from "../logger.js";
import { normalizeTestName } from "../../utils/labNormalization.js";
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
  return normalizeTestName(name);
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

    // Skip if this lab has no specific date (fell back to apptDate) AND the same
    // test+value already exists for this patient within the last 365 days —
    // this prevents carry-forward values from being re-inserted each visit.
    if (!lab.date) {
      const carryForward = await pool.query(
        `SELECT id FROM lab_results
         WHERE patient_id = $1 AND canonical_name = $2
           AND result::numeric = $3::numeric
           AND test_date >= NOW() - INTERVAL '365 days'
         LIMIT 1`,
        [patientId, canonicalName, val],
      );
      if (carryForward.rows[0]) continue;
    }

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

export async function syncDiagnoses(patientId, healthrayId, diagnoses) {
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

  for (const dx of diagnoses) {
    if (!dx.name) continue;
    if (isAbsentFinding(dx)) continue;
    // Strip "+" suffix the AI may leave on condition names (e.g. "NEUROPATHY+" → "NEUROPATHY")
    const cleanName = stripPlusSuffix(dx.name);
    if (!cleanName) continue;
    const diagId = normalizeDiagnosisId(dx.id || cleanName);
    if (!diagId) continue; // null = non-medical descriptor, skip

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
      .catch((e) => {
        error(
          "syncStoppedMedications",
          `stop UPDATE failed for patient=${patientId} med="${med.name}" dose="${med.dose || ""}": ${e.message}`,
        );
        return { rowCount: 0 };
      });

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
        .catch((e) => {
          error(
            "syncStoppedMedications",
            `existence-check SELECT failed for patient=${patientId} med="${med.name}": ${e.message}`,
          );
          return { rows: [] };
        });

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
          .catch((e) =>
            error(
              "syncStoppedMedications",
              `historical INSERT failed for patient=${patientId} med="${med.name}" dose="${med.dose || ""}": ${e.message}`,
            ),
          );
      }
    }
  }
}

// Strip common dosage-form prefixes so "Tab Wegovy", "INJ Wegovy", "WEGOVY"
// all resolve to the same canonical key ("WEGOVY") for the ON CONFLICT check.
function normalizeMedName(name) {
  return name
    .replace(
      /^(tab\.?\s+|tablet\s+|inj\.?\s+|injection\s+|cap\.?\s+|capsule\s+|syp\.?\s+|syrup\s+|drops?\s+|oint\.?\s+|ointment\s+|gel\s+|cream\s+|spray\s+|sachet\s+|pwd\.?\s+|powder\s+)/i,
      "",
    )
    .replace(/\s*\([\d\s+.\/mg%KkUuIL]+\)\s*$/i, "") // strip trailing dose in parens e.g. "(5+25+1000 mg)", "(60K units)"
    .trim()
    .toUpperCase();
}

export async function syncMedications(patientId, healthrayId, apptDate, meds) {
  if (!patientId || meds.length === 0) return;

  for (const med of meds) {
    if (!med.name) continue;
    const pharmacyMatch = normalizeMedName(med.name);
    const params = [
      patientId,
      med.name,
      pharmacyMatch,
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
    // Step 1: reactivate any existing inactive row with the same canonical name.
    await pool
      .query(
        `UPDATE medications
         SET is_active = true,
             pharmacy_match = $3,
             dose = COALESCE($4, dose),
             frequency = COALESCE($5, frequency),
             timing = COALESCE($6, timing),
             route = COALESCE($7, route),
             started_date = COALESCE($8, started_date),
             notes = $9,
             consultation_id = NULL,
             document_id = NULL,
             updated_at = NOW()
         WHERE patient_id = $1
           AND UPPER(COALESCE(pharmacy_match, name)) = $3
           AND is_active = false`,
        params,
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
         (patient_id, name, pharmacy_match, dose, frequency, timing, route, is_active, started_date, notes, source)
         VALUES ($1, $2, $3, $4, $5, $6, $7, true, $8, $9, 'healthray')
         ON CONFLICT (patient_id, UPPER(COALESCE(pharmacy_match, name))) WHERE is_active = true
         DO UPDATE SET
           dose = COALESCE(EXCLUDED.dose, medications.dose),
           frequency = COALESCE(EXCLUDED.frequency, medications.frequency),
           timing = COALESCE(EXCLUDED.timing, medications.timing),
           route = COALESCE(EXCLUDED.route, medications.route),
           started_date = COALESCE(EXCLUDED.started_date, medications.started_date),
           notes = EXCLUDED.notes,
           pharmacy_match = EXCLUDED.pharmacy_match,
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
    .catch((e) =>
      error("syncVitals", `INSERT failed for patient=${patientId} appt=${apptId}: ${e.message}`),
    );
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
    "Microalbumin/Creatinine Ratio": "uacr",
    Microalbumin: "uacr",
    "Creatinine, Serum": "creatinine",
    Creatinine: "creatinine",
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
