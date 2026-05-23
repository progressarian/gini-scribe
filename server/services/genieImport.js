// ============================================================================
// genieImport — read a patient + their history out of the Genie DB
// (purzqfmfycfowyxfaumc) and copy it into this scribe Postgres.
//
// Replaces the bidirectional gini_sync_* RPC pipeline. Used in two flows:
//
//   1. POST /api/patients/convert-from-genie — reception in scribe is
//      onboarding a walk-in whose phone already exists in the patient app.
//      We pull every row keyed off the genie patient and insert into scribe,
//      then mark the genie row migrated_to_gini=true so the patient app stops
//      writing to it.
//
//   2. GET /api/patients/genie-lookup?phone= — IntakePage lookup. Read-only.
//
// IMPORTANT: this module only READS from the Genie DB (and flips ONE flag at
// the very end). It does not push scribe data to Genie. The whole point of
// the dual-DB routing is to stop syncing.
// ============================================================================

import { createRequire } from "module";
import pool from "../config/db.js";
import { encryptAadhaar } from "../utils/aadhaarCrypt.js";

const require = createRequire(import.meta.url);
const { createClient } = require("@supabase/supabase-js");

let genieDb = null;
export function getGenieDb() {
  if (genieDb) return genieDb;
  const url = process.env.GENIE_SUPABASE_URL;
  const key = process.env.GENIE_SUPABASE_SERVICE_KEY;
  if (!url || !key) return null;
  genieDb = createClient(url, key);
  return genieDb;
}

function normalisePhone(phone) {
  if (!phone) return [];
  const digits = String(phone).replace(/[^\d]/g, "");
  const last10 = digits.slice(-10);
  // patientAuth stores 10-digit Indian numbers as +91XXXXXXXXXX — always include that variant
  const withCountry = last10.length === 10 ? `+91${last10}` : null;
  return Array.from(new Set([phone, digits, `+${digits}`, last10, withCountry].filter(Boolean)));
}

/**
 * Look up app-DB patient rows by phone. Returns an array — a phone may legitimately
 * be shared by multiple family members who self-onboarded on the app.
 * By default, rows already migrated to hospital are filtered out.
 */
export async function lookupGeniePatientsByPhone(phone, { includeMigrated = false } = {}) {
  const db = getGenieDb();
  if (!db) return [];
  const variants = normalisePhone(phone);
  if (variants.length === 0) return [];
  let q = db.from("patients").select("*").in("phone", variants);
  // New patients have migrated_to_gini = null (not set on insert) — treat null as not migrated
  if (!includeMigrated) q = q.or("migrated_to_gini.eq.false,migrated_to_gini.is.null");
  const { data, error } = await q;
  if (error || !data) return [];
  return data;
}

// Backwards-compat singular accessor — returns the first non-migrated match.
export async function lookupGeniePatientByPhone(phone) {
  const rows = await lookupGeniePatientsByPhone(phone, { includeMigrated: true });
  return rows[0] || null;
}

async function getGeniePatientById(genieId) {
  const db = getGenieDb();
  if (!db) return null;
  const { data, error } = await db
    .from("patients")
    .select("*")
    .eq("id", genieId)
    .limit(1)
    .maybeSingle();
  if (error) return null;
  return data;
}

// ---- per-table inverse mappers (genie row → scribe insert payload) ----
//
// Every mapper sets `genie_id` (or source_id for tables that use that name)
// to the app row's UUID. Combined with the unique indexes from migration
// 2026-05-20_patient_log_genie_id_unique.sql, ON CONFLICT prevents re-imports
// from duplicating rows.

// Genie `vitals` → scribe `patient_vitals_log` (NOT scribe `vitals` — that's
// for OPD in-clinic measurements; patient self-measurements live in the log).
function mapVitalToScribeLog(v, scribePatientId) {
  return {
    patient_id: scribePatientId,
    genie_id: v.id ?? null,
    recorded_date: v.recorded_date ?? null,
    reading_time: v.reading_time ?? null,
    bp_systolic: v.bp_systolic ?? null,
    bp_diastolic: v.bp_diastolic ?? null,
    rbs: v.rbs ?? null,
    meal_type: v.meal_type ?? null,
    weight_kg: v.weight_kg ?? null,
    pulse: v.pulse ?? null,
    spo2: v.spo2 ?? null,
    body_fat: v.body_fat ?? null,
    muscle_mass: v.muscle_mass ?? null,
    bmi: v.bmi ?? null,
    waist: v.waist ?? null,
    source: "genie",
  };
}

function mapLabToScribe(l, scribePatientId) {
  return {
    patient_id: scribePatientId,
    genie_id: l.id ?? null,
    test_name: l.test_name,
    result: typeof l.value === "number" ? l.value : null,
    result_text: typeof l.value === "string" ? l.value : null,
    unit: l.unit ?? null,
    flag: l.status ?? null,
    panel_name: l.lab_name ?? null,
    test_date: l.test_date,
    source: "genie",
  };
}

function mapMedicationToScribe(m, scribePatientId) {
  return {
    patient_id: scribePatientId,
    name: m.name,
    dose: m.dose ?? null,
    frequency: m.timing ?? null,
    timing: m.scheduled_time ?? null,
    is_active: m.is_active ?? true,
    med_group: m.type ?? null,
    pharmacy_match: m.brand ?? null,
    for_diagnosis: Array.isArray(m.for_conditions) ? m.for_conditions : null,
    started_date: m.start_date ?? null,
    patient_notes: m.notes ?? null,
  };
}

function mapConditionToDiagnosis(c, scribePatientId) {
  if (!c?.name || !/[a-zA-Z]/.test(c.name)) return null;
  return {
    patient_id: scribePatientId,
    diagnosis_id: (c.name || "unknown").toLowerCase().replace(/\s+/g, "_").slice(0, 64),
    label: c.label ?? c.name ?? "Unknown",
    status: c.status || "New",
    since_year: c.diagnosed_year ? Number(c.diagnosed_year) || null : null,
    notes: c.notes ?? null,
    is_active: c.status !== "resolved",
  };
}

// Genie `meal_logs` lands in scribe's `meal_logs` (rich shape; idempotency
// via `(patient_id, source_id)`) AND in scribe's `patient_meal_log` (the
// thinner log table). Two destinations, one source. The app DB uses
// `log_date` + `log_time` columns; combine them into a single timestamp for
// scribe's `meal_logs.logged_at`.
function geniMealTimestamp(ml) {
  if (ml.logged_at) return ml.logged_at;
  if (ml.log_date) {
    const t = ml.log_time && /^\d{2}:\d{2}/.test(ml.log_time) ? ml.log_time : "00:00";
    return `${ml.log_date}T${t.length === 5 ? t + ":00" : t}Z`;
  }
  return ml.created_at ?? new Date().toISOString();
}

function mapMealLogToScribe(ml, scribePatientId) {
  return {
    patient_id: scribePatientId,
    meal_type: ml.meal_type ?? null,
    description: ml.description ?? null,
    logged_at: geniMealTimestamp(ml),
    calories: ml.calories ?? null,
    protein_g: ml.protein_g ?? null,
    carbs_g: ml.carbs_g ?? null,
    fat_g: ml.fat_g ?? null,
    fiber_g: ml.fiber_g ?? null,
    sugar_g: ml.sugar_g ?? null,
    sodium_mg: ml.sodium_mg ?? null,
    source: "genie_import",
    source_id: String(ml.id),
    notes: ml.notes ?? null,
  };
}

function mapMealLogToPatientLog(ml, scribePatientId) {
  return {
    patient_id: scribePatientId,
    genie_id: ml.id ?? null,
    meal_type: ml.meal_type ?? null,
    description: ml.description ?? null,
    calories: ml.calories ?? null,
    protein_g: ml.protein_g ?? null,
    carbs_g: ml.carbs_g ?? null,
    fat_g: ml.fat_g ?? null,
    log_date: ml.log_date ?? (ml.logged_at ? String(ml.logged_at).slice(0, 10) : null),
    source: "genie",
  };
}

function mapActivityToScribe(a, scribePatientId) {
  return {
    patient_id: scribePatientId,
    genie_id: a.id ?? null,
    activity_type: a.activity_type ?? "Exercise",
    value: a.value != null ? String(a.value) : null,
    value2: a.value2 != null ? String(a.value2) : null,
    context: a.context ?? null,
    duration_minutes: a.duration_minutes ?? null,
    mood_score: a.mood_score ?? null,
    log_date: a.log_date,
    log_time: a.log_time ?? null,
    source: "genie",
  };
}

function mapSymptomToScribe(s, scribePatientId) {
  return {
    patient_id: scribePatientId,
    genie_id: s.id ?? null,
    symptom: s.symptom,
    severity: s.severity ?? null,
    body_area: s.body_area ?? null,
    context: s.context ?? null,
    notes: s.notes ?? null,
    follow_up_needed: !!s.follow_up_needed,
    log_date: s.log_date,
    log_time: s.log_time ?? null,
    source: "genie",
  };
}

function mapMedLogToScribe(ml, scribePatientId) {
  return {
    patient_id: scribePatientId,
    genie_id: ml.id ?? null,
    medication_name: ml.medication_name ?? null,
    medication_dose: ml.medication_dose ?? null,
    genie_medication_id: ml.medication_id ? String(ml.medication_id) : null,
    log_date: ml.log_date,
    dose_time: ml.dose_time ?? null,
    status: ml.status ?? "taken",
    source: "genie",
  };
}

function mapSideEffectToScribe(s, scribePatientId) {
  return {
    patient_id: scribePatientId,
    medication_id: s.medication_id != null ? String(s.medication_id) : null,
    medication_name: s.medication_name ?? null,
    name: s.name,
    description: s.description ?? null,
    severity: ["common", "uncommon", "warn"].includes(s.severity) ? s.severity : "common",
    status: s.status === "resolved" ? "resolved" : "active",
    source: s.source === "curated" ? "curated" : "custom",
    patient_note: s.patient_note ?? null,
    reported_at: s.reported_at ?? new Date().toISOString(),
  };
}

function mapDocumentToScribe(d, scribePatientId) {
  return {
    patient_id: scribePatientId,
    doc_type: d.doc_type || "other",
    title: d.title ?? null,
    file_name: d.file_name ?? null,
    file_url: d.file_url ?? null,
    mime_type: d.mime_type ?? null,
    doc_date: d.doc_date ?? null,
    source: "patient_upload",
    uploaded_by_patient: true,
    notes: d.id ? `genie_id:${d.id}` : null,
  };
}

// Bulk insert with optional ON CONFLICT clause. Pass the conflict target
// (e.g. "(patient_id, genie_id)") if the table has a matching unique index.
async function bulkInsert(table, rows, columns, conflictTarget = null) {
  if (rows.length === 0) return 0;
  const placeholders = [];
  const values = [];
  let idx = 1;
  for (const row of rows) {
    const ph = columns.map(() => `$${idx++}`).join(",");
    placeholders.push(`(${ph})`);
    for (const col of columns) values.push(row[col]);
  }
  const conflictClause = conflictTarget
    ? `ON CONFLICT ${conflictTarget} DO NOTHING`
    : `ON CONFLICT DO NOTHING`;
  const sql = `INSERT INTO ${table} (${columns.join(",")}) VALUES ${placeholders.join(",")} ${conflictClause}`;
  const result = await pool.query(sql, values);
  return result.rowCount || 0;
}

/**
 * Convert a specific Genie patient row into scribe by its app-DB id (UUID).
 * Preferred over `convertGeniePatientByPhone` when multiple app patients
 * share the same phone — the doctor must pick which one to import.
 */
export async function convertGeniePatientById(genieId) {
  const db = getGenieDb();
  if (!db) return { ok: false, reason: "genie_db_not_configured" };
  const geniePatient = await getGeniePatientById(genieId);
  if (!geniePatient) return { ok: false, reason: "no_genie_patient_for_id" };
  if (geniePatient.migrated_to_gini) {
    return { ok: false, reason: "already_migrated", geniePatient };
  }
  return doConvert(db, geniePatient);
}

export async function convertGeniePatientByPhone(phone) {
  const db = getGenieDb();
  if (!db) {
    return { ok: false, reason: "genie_db_not_configured" };
  }

  const geniePatient = await lookupGeniePatientByPhone(phone);
  if (!geniePatient) {
    return { ok: false, reason: "no_genie_patient_for_phone" };
  }
  if (geniePatient.migrated_to_gini) {
    return { ok: false, reason: "already_migrated", geniePatient };
  }
  return doConvert(db, geniePatient);
}

async function doConvert(db, geniePatient) {
  // Find or create scribe patient.
  const existing = (
    await pool.query("SELECT id FROM patients WHERE phone = $1 LIMIT 1", [geniePatient.phone])
  ).rows[0];

  let scribePatientId = existing?.id;
  if (!scribePatientId) {
    const seq = await pool.query(
      `SELECT COALESCE(MAX(CAST(SUBSTRING(file_no FROM 'GNI-([0-9]+)') AS INTEGER)), 0) + 1 AS next
       FROM patients WHERE file_no ~ '^GNI-[0-9]+$'`,
    );
    const fileNo = `GNI-${String(seq.rows[0].next).padStart(5, "0")}`;
    const ins = await pool.query(
      `INSERT INTO patients (name, phone, dob, sex, blood_group, file_no, email, health_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [
        geniePatient.name,
        geniePatient.phone,
        geniePatient.dob,
        geniePatient.sex,
        geniePatient.blood_group,
        fileNo,
        geniePatient.email,
        geniePatient.id, // store genie uuid as health_id for traceability
      ],
    );
    scribePatientId = ins.rows[0].id;
  }

  // Pull every per-patient history table from the genie DB in parallel.
  // Anything not enumerated here will be silently dropped on import.
  const fetchAll = (table) =>
    db
      .from(table)
      .select("*")
      .eq("patient_id", geniePatient.id)
      .then((r) => r.data ?? [])
      .catch(() => []);

  // `patient_reported_side_effects` doesn't exist in the app DB schema today —
  // the app writes side effects directly to the scribe hospital DB. Same for
  // `patient_documents`. We still fetch (defensively returns [] on missing
  // table) so the import is forward-compatible if those tables show up later.
  const [
    vitals,
    labs,
    meds,
    conditions,
    mealLogs,
    activityLogs,
    symptomLogs,
    medicationLogs,
    sideEffects,
    documents,
  ] = await Promise.all([
    fetchAll("vitals"),
    fetchAll("lab_results"),
    fetchAll("medications"),
    fetchAll("conditions"),
    fetchAll("meal_logs"),
    fetchAll("activity_logs"),
    fetchAll("symptom_logs"),
    fetchAll("medication_logs"),
    fetchAll("patient_reported_side_effects"),
    fetchAll("patient_documents"),
  ]);

  const counts = {
    patient_vitals_log: 0,
    lab_results: 0,
    medications: 0,
    diagnoses: 0,
    meal_logs: 0,
    patient_meal_log: 0,
    patient_activity_log: 0,
    patient_symptom_log: 0,
    patient_med_log: 0,
    patient_reported_side_effects: 0,
    documents: 0,
  };

  if (vitals.length > 0) {
    counts.patient_vitals_log = await bulkInsert(
      "patient_vitals_log",
      vitals.map((v) => mapVitalToScribeLog(v, scribePatientId)),
      [
        "patient_id",
        "genie_id",
        "recorded_date",
        "reading_time",
        "bp_systolic",
        "bp_diastolic",
        "rbs",
        "meal_type",
        "weight_kg",
        "pulse",
        "spo2",
        "body_fat",
        "muscle_mass",
        "bmi",
        "waist",
        "source",
      ],
      "(patient_id, genie_id)",
    );
  }

  if (labs.length > 0) {
    counts.lab_results = await bulkInsert(
      "lab_results",
      labs.map((l) => mapLabToScribe(l, scribePatientId)),
      [
        "patient_id",
        "genie_id",
        "test_name",
        "result",
        "result_text",
        "unit",
        "flag",
        "panel_name",
        "test_date",
        "source",
      ],
      "(genie_id)",
    );
  }

  if (meds.length > 0) {
    counts.medications = await bulkInsert(
      "medications",
      meds.map((m) => mapMedicationToScribe(m, scribePatientId)),
      [
        "patient_id",
        "name",
        "dose",
        "frequency",
        "timing",
        "is_active",
        "med_group",
        "pharmacy_match",
        "for_diagnosis",
        "started_date",
        "notes",
      ],
    );
  }

  if (conditions.length > 0) {
    counts.diagnoses = await bulkInsert(
      "diagnoses",
      conditions.map((c) => mapConditionToDiagnosis(c, scribePatientId)).filter(Boolean),
      ["patient_id", "diagnosis_id", "label", "status", "since_year", "notes", "is_active"],
    );
  }

  if (mealLogs.length > 0) {
    counts.meal_logs = await bulkInsert(
      "meal_logs",
      mealLogs.map((ml) => mapMealLogToScribe(ml, scribePatientId)),
      [
        "patient_id",
        "meal_type",
        "description",
        "logged_at",
        "calories",
        "protein_g",
        "carbs_g",
        "fat_g",
        "fiber_g",
        "sugar_g",
        "sodium_mg",
        "source",
        "source_id",
        "notes",
      ],
      "(patient_id, source_id)",
    );
    counts.patient_meal_log = await bulkInsert(
      "patient_meal_log",
      mealLogs.map((ml) => mapMealLogToPatientLog(ml, scribePatientId)),
      [
        "patient_id",
        "genie_id",
        "meal_type",
        "description",
        "calories",
        "protein_g",
        "carbs_g",
        "fat_g",
        "log_date",
        "source",
      ],
      "(patient_id, genie_id)",
    );
  }

  if (activityLogs.length > 0) {
    counts.patient_activity_log = await bulkInsert(
      "patient_activity_log",
      activityLogs.map((a) => mapActivityToScribe(a, scribePatientId)),
      [
        "patient_id",
        "genie_id",
        "activity_type",
        "value",
        "value2",
        "context",
        "duration_minutes",
        "mood_score",
        "log_date",
        "log_time",
        "source",
      ],
      "(patient_id, genie_id)",
    );
  }

  if (symptomLogs.length > 0) {
    counts.patient_symptom_log = await bulkInsert(
      "patient_symptom_log",
      symptomLogs.map((s) => mapSymptomToScribe(s, scribePatientId)),
      [
        "patient_id",
        "genie_id",
        "symptom",
        "severity",
        "body_area",
        "context",
        "notes",
        "follow_up_needed",
        "log_date",
        "log_time",
        "source",
      ],
      "(patient_id, genie_id)",
    );
  }

  if (medicationLogs.length > 0) {
    counts.patient_med_log = await bulkInsert(
      "patient_med_log",
      medicationLogs.map((m) => mapMedLogToScribe(m, scribePatientId)),
      [
        "patient_id",
        "genie_id",
        "medication_name",
        "medication_dose",
        "genie_medication_id",
        "log_date",
        "dose_time",
        "status",
        "source",
      ],
      "(patient_id, genie_id)",
    );
  }

  if (sideEffects.length > 0) {
    counts.patient_reported_side_effects = await bulkInsert(
      "patient_reported_side_effects",
      sideEffects.map((s) => mapSideEffectToScribe(s, scribePatientId)),
      [
        "patient_id",
        "medication_id",
        "medication_name",
        "name",
        "description",
        "severity",
        "status",
        "source",
        "patient_note",
        "reported_at",
      ],
      "(patient_id, name, reported_at)",
    );
  }

  if (documents.length > 0) {
    counts.documents = await bulkInsert(
      "documents",
      documents.map((d) => mapDocumentToScribe(d, scribePatientId)),
      [
        "patient_id",
        "doc_type",
        "title",
        "file_name",
        "file_url",
        "mime_type",
        "doc_date",
        "source",
        "uploaded_by_patient",
        "notes",
      ],
    );
  }

  // Flip the migrated flag last so a partial import can be retried safely.
  await db
    .from("patients")
    .update({
      migrated_to_gini: true,
      migrated_to_gini_at: new Date().toISOString(),
      gini_patient_id: String(scribePatientId),
      program_type: "gini_patient",
    })
    .eq("id", geniePatient.id);

  return {
    ok: true,
    scribePatientId,
    geniePatientId: geniePatient.id,
    imported: counts,
  };
}
