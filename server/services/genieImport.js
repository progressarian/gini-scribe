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
function getGenieDb() {
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
  return Array.from(new Set([phone, digits, `+${digits}`, last10].filter(Boolean)));
}

export async function lookupGeniePatientByPhone(phone) {
  const db = getGenieDb();
  if (!db) return null;
  const variants = normalisePhone(phone);
  if (variants.length === 0) return null;
  const { data, error } = await db.from("patients").select("*").in("phone", variants).limit(1);
  if (error || !data || data.length === 0) return null;
  return data[0];
}

// ---- per-table inverse mappers (genie row → scribe insert payload) ----

function mapVitalToScribe(v, scribePatientId) {
  return {
    patient_id: scribePatientId,
    bp_sys: v.bp_systolic ?? null,
    bp_dia: v.bp_diastolic ?? null,
    pulse: v.pulse ?? null,
    weight: v.weight_kg ?? null,
    rbs: v.rbs ?? null,
    bmi: v.bmi ?? null,
    recorded_at: v.reading_time ?? (v.recorded_date ? `${v.recorded_date}T00:00:00Z` : null),
    notes: v.meal_type ? `meal_type=${v.meal_type}` : null,
  };
}

function mapLabToScribe(l, scribePatientId) {
  return {
    patient_id: scribePatientId,
    test_name: l.test_name,
    result: typeof l.value === "number" ? l.value : null,
    unit: l.unit ?? null,
    flag: l.status ?? null,
    panel_name: l.lab_name ?? null,
    test_date: l.test_date,
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
  // Drop entries whose name has no alphabetic chars — these are stray numeric
  // tokens (years, IDs, lab values) the AI occasionally emits as conditions.
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

function mapMealLogToScribe(ml, scribePatientId) {
  return {
    patient_id: scribePatientId,
    meal_type: ml.meal_type ?? null,
    description: ml.description ?? null,
    logged_at: ml.logged_at ?? ml.created_at ?? new Date().toISOString(),
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

async function bulkInsert(table, rows, columns) {
  if (rows.length === 0) return 0;
  const placeholders = [];
  const values = [];
  let idx = 1;
  for (const row of rows) {
    const ph = columns.map(() => `$${idx++}`).join(",");
    placeholders.push(`(${ph})`);
    for (const col of columns) values.push(row[col]);
  }
  const sql = `INSERT INTO ${table} (${columns.join(",")}) VALUES ${placeholders.join(",")} ON CONFLICT DO NOTHING`;
  const result = await pool.query(sql, values);
  return result.rowCount || 0;
}

/**
 * Convert a Genie patient into scribe by phone match.
 *
 * Idempotent on the patient-row creation: if a scribe patient with the same
 * phone or file_no already exists we use that; otherwise we insert. History
 * tables are inserted blind (no dedup on source_id since scribe schema lacks
 * those columns) — caller should only run this once per patient.
 */
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

  // Pull each history table.
  const [vitals, labs, meds, conditions, mealLogs] = await Promise.all([
    db
      .from("vitals")
      .select("*")
      .eq("patient_id", geniePatient.id)
      .then((r) => r.data ?? []),
    db
      .from("lab_results")
      .select("*")
      .eq("patient_id", geniePatient.id)
      .then((r) => r.data ?? []),
    db
      .from("medications")
      .select("*")
      .eq("patient_id", geniePatient.id)
      .then((r) => r.data ?? []),
    db
      .from("conditions")
      .select("*")
      .eq("patient_id", geniePatient.id)
      .then((r) => r.data ?? []),
    db
      .from("meal_logs")
      .select("*")
      .eq("patient_id", geniePatient.id)
      .then((r) => r.data ?? []),
  ]);

  const counts = { vitals: 0, lab_results: 0, medications: 0, diagnoses: 0, meal_logs: 0 };

  if (vitals.length > 0) {
    counts.vitals = await bulkInsert(
      "vitals",
      vitals.map((v) => mapVitalToScribe(v, scribePatientId)),
      ["patient_id", "bp_sys", "bp_dia", "pulse", "weight", "rbs", "bmi", "recorded_at", "notes"],
    );
  }

  if (labs.length > 0) {
    counts.lab_results = await bulkInsert(
      "lab_results",
      labs.map((l) => mapLabToScribe(l, scribePatientId)),
      ["patient_id", "test_name", "result", "unit", "flag", "panel_name", "test_date"],
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
