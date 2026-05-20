// Static validator for SQL produced by the patient-facing AI agent.
// Every SELECT it returns is run by `runPatientSql` in tools.js with $1
// bound to the authenticated scribePatientId. The guard's job is to make
// sure nothing other than a read of THIS patient's rows can slip through.
//
// Defense in depth — the runtime ALSO wraps the query in a read-only
// transaction with a short statement timeout. This file is the first line.

// ── Whitelist ──────────────────────────────────────────────────────────
// Patient-scoped tables. Every query that references one of these MUST
// also contain `patient_id = $1` (alias-tolerant).
export const PATIENT_SCOPED_TABLES = new Set([
  "consultations",
  "vitals",
  "diagnoses",
  "medications",
  "lab_results",
  "documents",
  "goals",
  "complications",
  "patient_vitals_log",
  "patient_symptom_log",
  "patient_med_log",
  "patient_meal_log",
  "patient_reported_side_effects",
  "medication_dose_change_requests",
  "medication_refill_requests",
  "appointments",
  // /visit's ?tab=labs panel reads from this table for both the
  // investigation-summary grouping (visit.js Q18) and the pending /
  // recent / partial / uploaded badge counts (Q26). Whitelisting it lets
  // the agent answer "are any of my lab reports still pending?".
  "lab_cases",
]);

// Lookup / join tables that have no `patient_id` of their own. Allowed,
// but the patient-scoped predicate requirement does not apply to them
// (they must reach the patient through a joined patient-scoped table).
export const LOOKUP_TABLES = new Set(["medication_refill_request_items", "doctors"]);

export const ALLOWED_TABLES = new Set([...PATIENT_SCOPED_TABLES, ...LOOKUP_TABLES]);

// Column names that must never appear in the agent's SQL — auth secrets,
// PII outside the patient's normal record, raw consultation transcripts,
// blobs.
export const FORBIDDEN_COLUMNS = [
  "password_hash",
  "otp_code",
  "aadhaar",
  "govt_id",
  // Raw recorded-audio transcripts. Stay blocked — they're verbose,
  // sometimes contain unrelated speech from the room, and the doctor UI
  // never shows them as a primary surface either.
  "quick_transcript",
  "mo_transcript",
  "con_transcript",
  "file_data",
  "pin",
  "bcrypt",
  // NOTE: `con_data`, `mo_data`, `exam_data` are intentionally NOT
  // forbidden. /visit's History tab renders these structured JSONB
  // fields (assessment_summary, diagnoses[], medications_confirmed[],
  // exam findings, MO pre-consultation) — the agent needs them to give
  // the same answers the patient sees on screen.
];

// Hard list of DML / DDL / session-mutating keywords. SELECT and WITH are
// the only acceptable leading verbs; this catches anything else even if
// the model tries to embed it mid-query.
const FORBIDDEN_KEYWORDS = [
  "insert",
  "update",
  "delete",
  "merge",
  "truncate",
  "drop",
  "alter",
  "create",
  "grant",
  "revoke",
  "copy",
  "vacuum",
  "analyze",
  "call",
  "do",
  "set",
  "reset",
  "show",
  "listen",
  "notify",
  "lock",
  "refresh",
  "cluster",
  "reindex",
  // FOR UPDATE / FOR SHARE — read locks that we don't want in a patient
  // chat context. TRANSACTION READ ONLY would already reject these, but
  // catch them early for a clearer error.
  "for\\s+update",
  "for\\s+share",
];

const MAX_SQL_LEN = 4000;

// Strip leading/trailing whitespace and any leading -- or /* */ comments.
function stripLeading(sql) {
  let s = sql.trim();
  // Repeatedly strip leading line comments and block comments.
  // (We reject comments below — this is only for the "starts with SELECT"
  // check so a malformed comment doesn't false-positive.)
  // We don't actually allow comments; this is purely defensive.
  return s;
}

function bareWord(re) {
  return new RegExp(`(?:^|[^a-z0-9_])${re}(?:$|[^a-z0-9_])`, "i");
}

// Pull every identifier that appears immediately after FROM or JOIN. The
// scribe DB doesn't use schema-qualified names, so we look for a single
// identifier optionally followed by an alias. CTE names defined via
// `WITH x AS (...)` are removed from the set so they aren't checked
// against the table whitelist.
function extractCteNames(sql) {
  const ctes = new Set();
  // Only meaningful if the query starts with WITH.
  if (!/^\s*with\b/i.test(sql)) return ctes;
  // Match `WITH name AS (` and `, name AS (` after the leading WITH.
  // Optional RECURSIVE keyword between WITH and the first name.
  const re = /(?:^\s*with\s+(?:recursive\s+)?|,\s*)([a-zA-Z_][a-zA-Z0-9_]*)\s+as\s*\(/gi;
  let m;
  while ((m = re.exec(sql)) !== null) {
    ctes.add(m[1].toLowerCase());
  }
  return ctes;
}

function extractReferencedTables(sql) {
  const refs = new Set();
  const re = /\b(?:from|join)\s+([a-zA-Z_][a-zA-Z0-9_]*)/gi;
  let m;
  while ((m = re.exec(sql)) !== null) {
    refs.add(m[1].toLowerCase());
  }
  // Drop CTE-defined names — they aren't real tables.
  for (const c of extractCteNames(sql)) refs.delete(c);
  return refs;
}

// Does the query contain `patient_id = $1` for (any alias of) this table?
// We accept any alias (or none) because that's how the agent will actually
// write joins (e.g. `lr.patient_id = $1`). The important invariant is that
// SOMEWHERE in the WHERE/ON clauses, patient_id is constrained to $1.
function hasPatientIdEqualsParam(sql) {
  // Match: patient_id = $1, lr.patient_id = $1, "patient_id"=$1, etc.
  return /(?:[a-zA-Z_][a-zA-Z0-9_]*\s*\.\s*)?patient_id\s*=\s*\$1\b/i.test(sql);
}

// ── Public API ─────────────────────────────────────────────────────────
export function validatePatientSql(rawSql) {
  if (typeof rawSql !== "string" || rawSql.trim().length === 0) {
    return { ok: false, error: "sql must be a non-empty string." };
  }
  if (rawSql.length > MAX_SQL_LEN) {
    return { ok: false, error: `sql exceeds ${MAX_SQL_LEN} character limit.` };
  }

  const sql = stripLeading(rawSql);

  // 1. Must start with SELECT or WITH.
  if (!/^\s*(select|with)\b/i.test(sql)) {
    return { ok: false, error: "Query must start with SELECT or WITH." };
  }

  // 2. No statement chaining (a trailing single ; is also disallowed —
  //    pg accepts a single statement per query.text and chaining is the
  //    only reason to include one).
  if (sql.includes(";")) {
    return { ok: false, error: "Semicolons are not allowed." };
  }

  // 3. No SQL comments. Easy to abuse to hide forbidden keywords.
  if (sql.includes("--") || sql.includes("/*") || sql.includes("*/")) {
    return { ok: false, error: "SQL comments (-- or /* */) are not allowed." };
  }

  // 4. Reject system schema references.
  if (/\b(pg_[a-z_]+|information_schema|pg_catalog)\b/i.test(sql)) {
    return { ok: false, error: "Access to system schemas is not allowed." };
  }

  // 5. Reject DML / DDL / session-mutating keywords appearing anywhere.
  for (const kw of FORBIDDEN_KEYWORDS) {
    if (bareWord(kw).test(sql)) {
      return { ok: false, error: `Disallowed keyword: ${kw.replace("\\s+", " ")}` };
    }
  }

  // 6. Forbidden columns (auth secrets, raw transcripts, blobs).
  for (const col of FORBIDDEN_COLUMNS) {
    if (bareWord(col).test(sql)) {
      return { ok: false, error: `Forbidden column reference: ${col}` };
    }
  }

  // 7. Every FROM/JOIN target must be in the whitelist.
  const referenced = extractReferencedTables(sql);
  if (referenced.size === 0) {
    return { ok: false, error: "Query must reference at least one whitelisted table." };
  }
  for (const t of referenced) {
    if (!ALLOWED_TABLES.has(t)) {
      return { ok: false, error: `Table not allowed: ${t}` };
    }
  }

  // 8. If ANY patient-scoped table is referenced, the query must constrain
  //    patient_id to $1. Lookup tables on their own would also fail this
  //    requirement, but step 9 below forces at least one patient-scoped
  //    anchor anyway.
  const refsPatientScoped = [...referenced].some((t) => PATIENT_SCOPED_TABLES.has(t));
  if (refsPatientScoped && !hasPatientIdEqualsParam(sql)) {
    return {
      ok: false,
      error: "Patient-scoped tables require `patient_id = $1` somewhere in the query.",
    };
  }

  // 9. Disallow lookup-only queries — without a patient_id anchor there
  //    is no scoping at all.
  if (!refsPatientScoped) {
    return {
      ok: false,
      error:
        "Query must reference at least one patient-scoped table (with patient_id = $1). Lookup tables alone are not allowed.",
    };
  }

  // 10. The only positional param the agent may use is $1. $2+ would be
  //     unbound (we only ever pass [scribePatientId]) and Postgres would
  //     error — surface that earlier with a clearer message.
  if (/\$(?!1\b)\d+/.test(sql)) {
    return { ok: false, error: "Only $1 is available — it is bound to your patient_id." };
  }

  return { ok: true };
}

// Short human-readable schema string the agent sees in the tool
// description so it knows what columns exist on each table. Keep this
// concise — it goes into every system+tools payload sent to Anthropic.
// Columns listed mirror what the doctor-facing /visit page reads
// (gini-scribe/server/routes/visit.js) so the agent can compose queries
// whose answers match the UI value-for-value.
export const SCHEMA_HINT = `
Whitelisted tables (use $1 for patient_id wherever a table below has patient_id):
 - consultations(id, patient_id, visit_date, visit_type, mo_name, con_name, status, created_at, con_data jsonb {assessment_summary, diagnoses[], medications_confirmed[]}, exam_data jsonb, mo_data jsonb)
 - vitals(id, patient_id, recorded_at, bp_sys, bp_dia, pulse, temp, spo2, weight, height, bmi, rbs, meal_type, notes)
 - diagnoses(id, patient_id, diagnosis_id, label, status, category, key_value, trend, since_year, notes, is_active, updated_at)
 - medications(id, patient_id, consultation_id, name, dose, frequency, timing, when_to_take, route, composition, for_diagnosis, med_group, drug_class, is_active, started_date, stopped_date, stop_reason, common_side_effects, parent_medication_id, pharmacy_match, last_prescribed_date)
 - lab_results(id, patient_id, appointment_id, test_date, test_name, canonical_name, result, result_text, unit, flag, is_critical, ref_range, panel_name, source, created_at)
     · source dedup priority (highest → lowest): lab_healthray > opd > report_extract > healthray > prescription_parsed
 - lab_cases(id, patient_id, case_no, patient_case_no, case_date, results_synced, reported_on, retry_abandoned, investigation_summary jsonb {reports[], tests[]})
 - documents(id, patient_id, doc_type, title, doc_date, source, extracted_text, notes, created_at)
 - goals(id, patient_id, marker, current_value, target_value, timeline, status, achieved_date)
 - complications(id, patient_id, name, status, detail, severity)
 - patient_vitals_log(id, patient_id, recorded_date, bp_systolic, bp_diastolic, pulse, rbs, meal_type, weight_kg, bmi, waist, body_fat, spo2)
 - patient_symptom_log(id, patient_id, log_date, log_time, symptom, severity, body_area, context, notes, follow_up_needed, source)
 - patient_med_log(id, patient_id, medication_name, medication_dose, genie_medication_id, log_date, dose_time, status, source)
 - patient_meal_log(id, patient_id, log_date, meal_type, description, calories, protein_g, carbs_g, fat_g)
 - patient_reported_side_effects(id, patient_id, medication_id, name, severity, status, patient_note, reported_at)
 - medication_dose_change_requests(id, patient_id, medication_id, requested_dose, status, doctor_note, created_at)
 - medication_refill_requests(id, patient_id, status, created_at)
 - appointments(id, patient_id, appointment_date, time_slot, doctor_name, visit_type, status, notes, follow_up_with, pre_visit_symptoms, pre_visit_compliance, ai_summary, biomarkers jsonb, healthray_id, healthray_diagnoses jsonb, healthray_medications jsonb, healthray_advice text, healthray_investigations jsonb, healthray_follow_up jsonb)
Join-only lookup tables (no patient_id; reach via a join from a patient-scoped table):
 - medication_refill_request_items(id, refill_request_id, medication_name, quantity, status)
 - doctors(id, name, short_name, specialty)
Forbidden columns anywhere in the query: password_hash, otp_code, aadhaar, govt_id, quick_transcript, mo_transcript, con_transcript, file_data, pin, bcrypt.

Query recipes (clone these shapes so your answers match /visit value-for-value):
 - Visit history merged (default /visit and ?tab=history):
     WITH cons AS (
       SELECT id, visit_date, visit_type, mo_name, con_name, status, created_at, con_data, exam_data,
              NULL::jsonb AS healthray_diagnoses, NULL::jsonb AS healthray_medications, NULL::text AS healthray_advice,
              'consultation' AS source_type
       FROM consultations WHERE patient_id = $1
     ),
     appts AS (
       SELECT id, appointment_date AS visit_date, visit_type, NULL AS mo_name, doctor_name AS con_name, status, created_at,
              NULL::jsonb AS con_data, NULL::jsonb AS exam_data,
              healthray_diagnoses, healthray_medications, healthray_advice,
              'appointment' AS source_type
       FROM appointments
       WHERE patient_id = $1 AND healthray_id IS NOT NULL AND appointment_date IS NOT NULL
     )
     SELECT * FROM cons
     UNION ALL
     SELECT a.* FROM appts a
       WHERE NOT EXISTS (SELECT 1 FROM cons c WHERE c.visit_date::date = a.visit_date::date)
     ORDER BY visit_date DESC, created_at DESC, id DESC LIMIT 200;
 - Last visit assessment summary:
     SELECT visit_date, con_name, con_data->>'assessment_summary' AS summary
     FROM consultations WHERE patient_id = $1 ORDER BY visit_date DESC, id DESC LIMIT 1;
 - Latest HealthRay diagnoses / advice (the doctor's most recent diagnosis list shown on /visit):
     SELECT healthray_diagnoses, healthray_advice, appointment_date FROM appointments
     WHERE patient_id = $1 AND healthray_diagnoses IS NOT NULL AND jsonb_array_length(healthray_diagnoses) > 0
     ORDER BY appointment_date DESC, id DESC LIMIT 1;
 - Pending lab cases (?tab=labs "Gini Lab Processing" badge):
     SELECT case_no, patient_case_no, case_date FROM lab_cases
     WHERE patient_id = $1 AND results_synced = FALSE AND retry_abandoned = FALSE
     ORDER BY case_date DESC, id DESC;
 - Investigation summary per lab case (?tab=labs section grouping):
     SELECT case_no, case_date, investigation_summary FROM lab_cases
     WHERE patient_id = $1 AND results_synced = TRUE AND investigation_summary IS NOT NULL
     ORDER BY case_date DESC, id DESC LIMIT 20;
 - Latest value per lab (mirrors visit.js labLatest):
     SELECT DISTINCT ON (canonical_name) canonical_name, test_name, result, unit, flag, test_date
     FROM lab_results WHERE patient_id = $1 AND test_date IS NOT NULL
     ORDER BY canonical_name, test_date DESC, created_at DESC, id DESC;
 - Merged FBS history (lab FBS + patient_vitals_log fasting RBS, mirrors getMergedFbsHist):
     SELECT test_date AS d, result AS fbs FROM lab_results
       WHERE patient_id = $1 AND canonical_name = 'FBS' AND result IS NOT NULL
     UNION ALL
     SELECT recorded_date::date AS d, rbs AS fbs FROM patient_vitals_log
       WHERE patient_id = $1 AND meal_type ILIKE 'Fasting' AND rbs IS NOT NULL
     ORDER BY d DESC;
 - Active meds with prescriber (mirrors visit.js Q4):
     SELECT m.name, m.dose, m.frequency, m.timing, m.when_to_take, m.for_diagnosis,
            c.con_name AS prescriber, COALESCE(c.visit_date, m.started_date) AS prescribed_date
     FROM medications m LEFT JOIN consultations c ON c.id = m.consultation_id
     WHERE m.patient_id = $1 AND m.is_active = true
     ORDER BY prescribed_date DESC NULLS LAST, m.created_at DESC, m.id DESC;
 - GENERAL ORDERING RULE (apply to any custom run_patient_sql you write): primary sort by the most relevant time column DESC (created_at / recorded_date / test_date / appointment_date / log_date / visit_date / doc_date), with \`id DESC\` as the final tiebreaker so same-timestamp rows are deterministic and the newest insert wins.
 - HOMA-IR fallback (when not stored as a lab row): (fasting_insulin × fbs) / 405. Pull both from lab_results.
 - eGFR fallback (CKD-EPI) requires creatinine + age + sex — for accuracy prefer get_full_patient_context (it carries the canonical eGFR via fetchMergedLabHistory).

Notes:
 - The carry-forward dedup on appointments.biomarkers (HealthRay duplicates a value across later visits) is non-trivial in SQL — for canonical lab history with that dedup applied, call get_full_patient_context instead and read labs.latest / labs.history.
 - Care phase + biomarker priority (computeCarePhase / deriveBiomarkerPriorityStatus) are not exposed to SQL; refer the patient to the /visit page for that view, or read the inputs (HbA1c trend + BP + visit count) yourself.
`.trim();
