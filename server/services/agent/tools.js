// Patient-facing AI agent tools. Used by POST /api/ai/agent (routes/ai.js).
//
// Two kinds of tools:
//   • DB tools — executed server-side, return JSON for the model to read.
//   • UI tools — recorded as `client_actions` for the RN app to act on
//     (open log modal, open doctor chat). Server returns a tiny
//     acknowledgement so the model can phrase a closing sentence.

// ── Tool schemas (Anthropic Messages API `tools` parameter) ─────────────
export const AGENT_TOOLS = [
  {
    name: "query_patient_data",
    description:
      "Read the authenticated patient's data from the DB. Use this when you need specific numbers or rows. Prefer get_progress_summary for broad 'how am I doing' questions.",
    input_schema: {
      type: "object",
      properties: {
        scope: {
          type: "string",
          enum: [
            "profile",
            "vitals",
            "sugar",
            "bp",
            "weight",
            "labs",
            "meds",
            "meals",
            "symptoms",
            "appointments",
            "diagnoses",
          ],
          description: "Which slice of patient data to read.",
        },
        range_days: {
          type: "number",
          description: "Limit rows to the last N days. Omit for all-time.",
        },
        since_last_visit: {
          type: "boolean",
          description: "If true, return rows from the most recent past appointment_date onwards.",
        },
        limit: { type: "number", description: "Max rows (default 50)." },
        test_name: {
          type: "string",
          description:
            "For scope='labs', filter by a single canonical test name (HbA1c, LDL, TSH, FBS, eGFR, Hb).",
        },
      },
      required: ["scope"],
    },
  },
  {
    name: "get_progress_summary",
    description:
      "One-shot summary of trends and adherence for the patient. Prefer this over multiple query_patient_data calls when the user asks 'how am I doing'.",
    input_schema: {
      type: "object",
      properties: {
        window: { type: "string", enum: ["days", "since_last_visit"] },
        days: {
          type: "number",
          description: "If window='days', the number of past days (default 30).",
        },
      },
      required: ["window"],
    },
  },
  {
    name: "get_medication_schedule",
    description:
      "Active medications grouped by time-of-day slot (fasting / before_breakfast / after_breakfast / ... / bedtime). Use for 'what meds do I take today/now?'.",
    input_schema: {
      type: "object",
      properties: {
        when: { type: "string", enum: ["today", "now"] },
      },
      required: ["when"],
    },
  },
  {
    name: "get_appointments",
    description:
      "Upcoming, past, or the single next appointment for the patient. Includes follow_up_with prep instructions when present.",
    input_schema: {
      type: "object",
      properties: {
        scope: { type: "string", enum: ["upcoming", "past", "next"] },
        limit: { type: "number" },
      },
      required: ["scope"],
    },
  },
  {
    name: "propose_log",
    description:
      "Open the in-app log card pre-filled with values the user just gave you. Always use this when the user says 'log my BP 130/80' / 'sugar 180 fasting' / 'I weigh 82 kg' / 'my Vit D is 28' — never silently log. Pick the most specific type from the enum. Use 'Lab' (with test_name+unit) for any lab not in the dedicated enum (Vitamin D, B12, T3, T4, Creatinine, Triglycerides, HDL, FBS, PPBS, …).",
    input_schema: {
      type: "object",
      properties: {
        type: {
          type: "string",
          enum: [
            "BP",
            "Sugar",
            "Weight",
            "HbA1c",
            "LDL",
            "TSH",
            "Haemoglobin",
            "eGFR",
            "Lab",
            "Food",
            "Exercise",
            "Sleep",
            "Mood",
            "Symptom",
          ],
        },
        value1: { type: "string", description: "Primary value (e.g. systolic, sugar mg/dL)." },
        value2: { type: "string", description: "Secondary value (e.g. diastolic, duration)." },
        context: {
          type: "string",
          description:
            "Context label, e.g. 'Fasting', 'After breakfast' for Sugar; 'Morning (after meds)' for BP.",
        },
        test_name: {
          type: "string",
          description:
            "For type='Lab' only: the human-readable test name (e.g. 'Vitamin D', 'Vitamin B12', 'Free T3', 'Creatinine', 'Triglycerides', 'HDL', 'FBS', 'PPBS'). Required when type='Lab'.",
        },
        unit: {
          type: "string",
          description:
            "For type='Lab' only: the standard unit for the test (e.g. 'ng/mL' for Vit D, 'pg/mL' for B12, 'mg/dL' for lipids, 'mg/dL' for creatinine, 'pg/mL' for T3, 'ng/dL' for T4). Required when type='Lab'.",
        },
        ref_range: {
          type: "string",
          description:
            "For type='Lab' only: the normal reference range as a plain string (e.g. '30-100 ng/mL' for Vit D). Optional but helpful for display.",
        },
        canonical_name: {
          type: "string",
          description:
            "For type='Lab' only: a lowercase canonical key (e.g. 'vitd', 'b12', 't3', 't4', 'creatinine', 'triglycerides', 'hdl', 'fbs', 'ppbs'). Optional.",
        },
      },
      required: ["type", "value1"],
    },
  },
  {
    name: "respond_to_patient",
    description:
      "Your FINAL output for this turn. You MUST call this exactly once, and it must be the last tool you call. The `message` is shown verbatim in the chat — keep it short, friendly, no markdown headers. Put every concrete number you cite in `numbers` so the app can render badges/charts deterministically. Pick `intent` based on what this turn is doing.",
    input_schema: {
      type: "object",
      properties: {
        message: {
          type: "string",
          description:
            "Plain conversational text shown to the patient (2-4 sentences for most replies; longer only when the patient explicitly asked for detail).",
        },
        intent: {
          type: "string",
          enum: [
            "chat",
            "log_proposed",
            "data_summary",
            "doctor_handoff",
            "schedule_info",
            "refusal",
          ],
          description:
            "Why you replied this way. log_proposed → you also called propose_log. doctor_handoff → you also called open_doctor_chat. refusal → you declined a diagnosis/dose request and pointed to the doctor.",
        },
        numbers: {
          type: "array",
          description:
            "Every numeric fact mentioned in `message`. Empty array if you cited none. Always include the unit and (for time-series facts) the date.",
          items: {
            type: "object",
            properties: {
              label: {
                type: "string",
                description: "Short metric name, e.g. 'HbA1c', 'Avg fasting sugar', 'BP'.",
              },
              value: { type: "number", description: "Numeric value." },
              value2: {
                type: "number",
                description: "Secondary numeric (e.g. diastolic when label='BP'); omit otherwise.",
              },
              unit: { type: "string", description: "e.g. '%', 'mg/dL', 'mmHg', 'kg'." },
              date: {
                type: "string",
                description:
                  "ISO date YYYY-MM-DD the value was measured/observed. Omit for derived averages where a window is the right anchor.",
              },
              window: {
                type: "string",
                description:
                  "Plain-text window for derived averages, e.g. 'last 30 days', 'since 2026-04-12'.",
              },
              trend: {
                type: "string",
                enum: ["up", "down", "flat", "unknown"],
                description: "Direction vs the prior reading/window, if you can tell.",
              },
            },
            required: ["label", "value"],
          },
        },
        log_proposal: {
          type: "object",
          description:
            "Mirror of the propose_log inputs when intent='log_proposed'. Lets the client cross-check the modal prefill against the assistant's intent. Omit otherwise.",
          properties: {
            type: { type: "string" },
            value1: { type: "string" },
            value2: { type: "string" },
            context: { type: "string" },
          },
        },
        safety_flag: {
          type: "string",
          enum: ["none", "urgent_symptom", "out_of_range_lab", "medication_concern"],
          description:
            "Set when the patient mentioned something that warrants doctor attention. 'urgent_symptom' for chest pain / breathlessness / severe headache / loss of consciousness.",
        },
      },
      required: ["message", "intent"],
    },
  },
  {
    name: "classify_and_extract_attachment",
    description:
      "Call ONLY when the patient sent a photo or PDF this turn and wants it logged (food photo, lab report, or prescription). You can SEE the attachment in this turn's content — classify it and extract every distinct item you see. The app will open a bulk-log sheet pre-filled with these rows for the patient to confirm. Then still call respond_to_patient with a short summary.",
    input_schema: {
      type: "object",
      properties: {
        kind: {
          type: "string",
          enum: ["food", "lab_report", "prescription"],
          description: "Which kind of attachment this is.",
        },
        food_items: {
          type: "array",
          description:
            "When kind='food': one row per distinct dish on the plate. Estimate per-serving macros.",
          items: {
            type: "object",
            properties: {
              name: { type: "string", description: "Short dish name, e.g. 'Roti', 'Dal'." },
              kcal: { type: "number" },
              protein_g: { type: "number" },
              carbs_g: { type: "number" },
              fat_g: { type: "number" },
              fiber_g: { type: "number" },
              sugar_g: { type: "number" },
              sodium_mg: { type: "number" },
            },
            required: ["name"],
          },
        },
        lab_items: {
          type: "array",
          description:
            "When kind='lab_report': one row per test result. Use canonical names where possible (HbA1c, FBS, PPBS, LDL, HDL, TG, TSH, T3, T4, Hb, eGFR, Creatinine, VitD, B12).",
          items: {
            type: "object",
            properties: {
              test_name: { type: "string", description: "Exact name as printed on the report." },
              canonical_name: {
                type: "string",
                description: "Canonical lowercase key (hba1c, ldl, tsh, fbs, ppbs, egfr, hb, …).",
              },
              result: { type: "string", description: "Numeric or string result as printed." },
              unit: { type: "string" },
              ref_range: { type: "string" },
              flag: {
                type: "string",
                enum: ["H", "L", "N", "Critical", ""],
                description: "Optional flag if printed.",
              },
              panel_name: { type: "string" },
              test_date: {
                type: "string",
                description: "ISO YYYY-MM-DD if printed on the report.",
              },
            },
            required: ["test_name", "result"],
          },
        },
        rx_items: {
          type: "array",
          description: "When kind='prescription': one row per medication on the slip.",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              dose: { type: "string", description: "e.g. '500 mg'." },
              frequency: { type: "string", description: "OD / BD / TDS / SOS." },
              timing: {
                type: "string",
                description:
                  "Consultant free-text note (e.g. '30 min before food'). The canonical patient-facing field is `when_to_take` which uses the fixed vocabulary: Fasting, Before breakfast, After breakfast, Before lunch, After lunch, Before dinner, After dinner, At bedtime, With milk, SOS only, Any time.",
              },
              when_to_take: {
                type: "string",
                description:
                  "One or more comma-separated values from: Fasting, Before breakfast, After breakfast, Before lunch, After lunch, Before dinner, After dinner, At bedtime, With milk, SOS only, Any time.",
              },
              route: { type: "string" },
              for_diagnosis: { type: "string" },
            },
            required: ["name"],
          },
        },
        summary: {
          type: "string",
          description:
            "One-line plain summary you'll repeat to the patient (e.g. 'I see 5 labs — HbA1c 7.2, LDL 142, …').",
        },
      },
      required: ["kind"],
    },
  },
  {
    name: "open_doctor_chat",
    description:
      "Open the in-app Care → Team chat so the patient can message their doctor / Gini clinic. Use when the patient asks to talk to the doctor or raises anything that needs medical judgement (dose changes, new chest pain, side effects, etc).",
    input_schema: {
      type: "object",
      properties: {
        seed: {
          type: "string",
          description: "Pre-filled message for the patient to review and send.",
        },
        reason: { type: "string", description: "Short tag for telemetry — not shown." },
      },
    },
  },
];

// ── SQL helpers ────────────────────────────────────────────────────────
async function findLastVisitDate(pool, patientId) {
  const { rows } = await pool.query(
    `SELECT MAX(appointment_date)::date AS d FROM appointments
      WHERE patient_id = $1 AND appointment_date::date <= CURRENT_DATE`,
    [patientId],
  );
  return rows[0]?.d || null;
}

function rangeClause(args, dateCol) {
  if (args.since_last_visit && args.__lastVisit) {
    return { sql: ` AND ${dateCol} >= $__since`, val: args.__lastVisit };
  }
  if (typeof args.range_days === "number" && args.range_days > 0) {
    return {
      sql: ` AND ${dateCol} >= (CURRENT_DATE - INTERVAL '${Math.floor(args.range_days)} days')`,
      val: null,
    };
  }
  return { sql: "", val: null };
}

async function withSinceContext(pool, patientId, args) {
  if (args.since_last_visit) {
    args.__lastVisit = await findLastVisitDate(pool, patientId);
  }
  return args;
}

function pushIfVal(params, value) {
  if (value === null || value === undefined) return null;
  params.push(value);
  return params.length;
}

function buildQuery(baseSql, args, dateCol, params, patientId) {
  let sql = baseSql + ` WHERE patient_id = $${params.push(patientId)}`;
  const r = rangeClause(args, dateCol);
  if (r.sql) {
    if (r.val !== null) {
      const idx = params.push(r.val);
      sql += r.sql.replace("$__since", "$" + idx);
    } else {
      sql += r.sql;
    }
  }
  return sql;
}

// ── Scope handlers ─────────────────────────────────────────────────────
async function qProfile(pool, patientId) {
  const { rows } = await pool.query(
    `SELECT id, name, age, sex, file_no, dob, phone
       FROM patients WHERE id = $1`,
    [patientId],
  );
  return rows[0] || null;
}

// Patient vitals live in TWO tables in the scribe DB:
//   • `vitals`               — written by the doctor on /visit (per-consultation row)
//   • `patient_vitals_log`   — written by the companion app (patient self-logs)
// Both must be merged when answering "what's my weight / BP / sugar" or the
// patient sees "no records" even when their doctor recorded values during
// the visit. Column names differ between the two tables; this helper
// normalises them to a common shape: { source_table, recorded_date,
// bp_systolic, bp_diastolic, pulse, rbs, meal_type, weight_kg, bmi, waist,
// body_fat, spo2 }.
async function qVitalsMerged(pool, patientId, args, fields /* Set */) {
  const limit = Math.min(Math.max(args.limit || 50, 1), 500);
  const wantBp = fields.has("bp");
  const wantSugar = fields.has("sugar");
  const wantWeight = fields.has("weight");
  const wantVitalsAll = fields.has("all");

  // Date range params for each subquery.
  const sinceVal = args.since_last_visit && args.__lastVisit ? args.__lastVisit : null;
  const days =
    typeof args.range_days === "number" && args.range_days > 0 ? Math.floor(args.range_days) : null;

  // patient_vitals_log uses `recorded_date`; vitals uses `recorded_at`
  // (timestamp). Normalise both to a date in the output.
  const params = [];
  const pvlParts = [];
  const vitParts = [];

  const pvlSelectCols = [
    "'patient_vitals_log' AS source_table",
    "recorded_date::date AS recorded_date",
    wantBp || wantVitalsAll ? "bp_systolic" : "NULL::int AS bp_systolic",
    wantBp || wantVitalsAll ? "bp_diastolic" : "NULL::int AS bp_diastolic",
    wantBp || wantVitalsAll ? "pulse" : "NULL::int AS pulse",
    wantSugar || wantVitalsAll ? "rbs" : "NULL::numeric AS rbs",
    wantSugar || wantVitalsAll ? "meal_type" : "NULL::text AS meal_type",
    wantWeight || wantVitalsAll ? "weight_kg" : "NULL::numeric AS weight_kg",
    wantWeight || wantVitalsAll ? "bmi" : "NULL::numeric AS bmi",
    wantWeight ? "waist" : "NULL::numeric AS waist",
    wantWeight ? "body_fat" : "NULL::numeric AS body_fat",
    wantVitalsAll ? "spo2" : "NULL::numeric AS spo2",
  ];
  const vitSelectCols = [
    "'vitals' AS source_table",
    "recorded_at::date AS recorded_date",
    wantBp || wantVitalsAll ? "bp_sys AS bp_systolic" : "NULL::int AS bp_systolic",
    wantBp || wantVitalsAll ? "bp_dia AS bp_diastolic" : "NULL::int AS bp_diastolic",
    wantBp || wantVitalsAll ? "pulse" : "NULL::int AS pulse",
    wantSugar || wantVitalsAll ? "rbs" : "NULL::numeric AS rbs",
    wantSugar || wantVitalsAll ? "meal_type" : "NULL::text AS meal_type",
    wantWeight || wantVitalsAll ? "weight" : "NULL::numeric AS weight_kg",
    wantWeight || wantVitalsAll ? "bmi" : "NULL::numeric AS bmi",
    wantWeight ? "waist" : "NULL::numeric AS waist",
    wantWeight ? "body_fat" : "NULL::numeric AS body_fat",
    wantVitalsAll ? "spo2" : "NULL::numeric AS spo2",
  ];

  const pidIdx = params.push(patientId);
  pvlParts.push(
    `SELECT ${pvlSelectCols.join(", ")} FROM patient_vitals_log WHERE patient_id = $${pidIdx}`,
  );
  vitParts.push(`SELECT ${vitSelectCols.join(", ")} FROM vitals WHERE patient_id = $${pidIdx}`);

  if (sinceVal) {
    const idx = params.push(sinceVal);
    pvlParts.push(`AND recorded_date >= $${idx}`);
    vitParts.push(`AND recorded_at >= $${idx}`);
  } else if (days) {
    pvlParts.push(`AND recorded_date >= (CURRENT_DATE - INTERVAL '${days} days')`);
    vitParts.push(`AND recorded_at >= (CURRENT_DATE - INTERVAL '${days} days')`);
  }

  // Only include a "match" filter per requested field so the merged result
  // doesn't drag in empty rows from the wrong table.
  const matchClauses = [];
  if (wantBp) matchClauses.push("bp_systolic IS NOT NULL");
  if (wantSugar) matchClauses.push("rbs IS NOT NULL");
  if (wantWeight) matchClauses.push("weight_kg IS NOT NULL");
  // No filter when wantVitalsAll — caller wants the broad picture.

  const pvlSql = pvlParts.join(" ");
  const vitSql = vitParts.join(" ");

  let sql = `WITH merged AS ( ${pvlSql} UNION ALL ${vitSql} ) SELECT * FROM merged`;
  if (matchClauses.length > 0) {
    sql += ` WHERE (${matchClauses.join(" OR ")})`;
  }
  sql += ` ORDER BY recorded_date DESC LIMIT ${limit}`;

  try {
    const { rows } = await pool.query(sql, params);
    return rows;
  } catch (e) {
    // Fall back to patient_vitals_log only if the `vitals` table is
    // missing on this env (legacy/test deploys).
    if (
      String(e?.message || "")
        .toLowerCase()
        .includes('relation "vitals"')
    ) {
      const fallback = await pool.query(
        `SELECT 'patient_vitals_log' AS source_table, recorded_date,
                bp_systolic, bp_diastolic, pulse, rbs, meal_type,
                weight_kg, bmi, NULL::numeric AS waist, NULL::numeric AS body_fat, spo2
           FROM patient_vitals_log WHERE patient_id = $1
          ORDER BY recorded_date DESC LIMIT ${limit}`,
        [patientId],
      );
      return fallback.rows;
    }
    throw e;
  }
}

async function qSugar(pool, patientId, args) {
  return qVitalsMerged(pool, patientId, args, new Set(["sugar"]));
}
async function qBP(pool, patientId, args) {
  return qVitalsMerged(pool, patientId, args, new Set(["bp"]));
}
async function qWeight(pool, patientId, args) {
  return qVitalsMerged(pool, patientId, args, new Set(["weight"]));
}
async function qVitalsAll(pool, patientId, args) {
  return qVitalsMerged(pool, patientId, args, new Set(["all"]));
}

async function qLabs(pool, patientId, args) {
  const params = [];
  const limit = Math.min(Math.max(args.limit || 50, 1), 500);
  let sql = `SELECT id, test_date, test_name, canonical_name, result, result_text, unit, flag, ref_range, panel_name
               FROM lab_results WHERE patient_id = $${params.push(patientId)}`;
  if (args.test_name) {
    sql += ` AND (LOWER(canonical_name) = LOWER($${params.push(args.test_name)})
                  OR LOWER(test_name) = LOWER($${params.length}))`;
  }
  const r = rangeClause(args, "test_date");
  if (r.sql) {
    if (r.val !== null) {
      const idx = params.push(r.val);
      sql += r.sql.replace("$__since", "$" + idx);
    } else sql += r.sql;
  }
  sql += ` ORDER BY test_date DESC, id DESC LIMIT ${limit}`;
  const { rows } = await pool.query(sql, params);
  return rows;
}

async function qMeds(pool, patientId, args) {
  const limit = Math.min(Math.max(args.limit || 50, 1), 200);
  const { rows } = await pool.query(
    `SELECT id, name, dose, frequency, timing, when_to_take, route, med_group, drug_class,
            is_active, started_date, stopped_date, stop_reason, parent_medication_id,
            days_of_week
       FROM medications WHERE patient_id = $1
      ORDER BY is_active DESC, sort_order, name
      LIMIT ${limit}`,
    [patientId],
  );
  return rows;
}

async function qMeals(pool, patientId, args) {
  const params = [];
  const limit = Math.min(Math.max(args.limit || 50, 1), 200);
  let sql = buildQuery(
    `SELECT id, log_date, meal_type, description, calories, protein_g, carbs_g, fat_g
       FROM patient_meal_log`,
    args,
    "log_date",
    params,
    patientId,
  );
  sql += ` ORDER BY log_date DESC, id DESC LIMIT ${limit}`;
  const { rows } = await pool.query(sql, params);
  return rows;
}

async function qSymptoms(pool, patientId, args) {
  const params = [];
  const limit = Math.min(Math.max(args.limit || 50, 1), 200);
  let sql = buildQuery(
    `SELECT id, log_date, log_time, symptom, severity, body_area, context, notes, follow_up_needed
       FROM patient_symptom_log`,
    args,
    "log_date",
    params,
    patientId,
  );
  sql += ` ORDER BY log_date DESC, id DESC LIMIT ${limit}`;
  const { rows } = await pool.query(sql, params);
  return rows;
}

async function qAppointments(pool, patientId, args) {
  // Tolerate missing `follow_up_with` column on environments without the
  // 2026-05-14 migration applied.
  const limit = Math.min(Math.max(args.limit || 20, 1), 100);
  try {
    const { rows } = await pool.query(
      `SELECT id, appointment_date, time_slot, doctor_name, visit_type, status,
              notes, follow_up_with
         FROM appointments WHERE patient_id = $1
        ORDER BY appointment_date DESC, id DESC
        LIMIT ${limit}`,
      [patientId],
    );
    return rows;
  } catch (_) {
    const { rows } = await pool.query(
      `SELECT id, appointment_date, time_slot, doctor_name, visit_type, status, notes
         FROM appointments WHERE patient_id = $1
        ORDER BY appointment_date DESC, id DESC
        LIMIT ${limit}`,
      [patientId],
    );
    return rows;
  }
}

async function qDiagnoses(pool, patientId) {
  const { rows } = await pool.query(
    `SELECT id, diagnosis_id, label, status, is_active, since_date
       FROM diagnoses WHERE patient_id = $1
      ORDER BY is_active DESC, id`,
    [patientId],
  );
  return rows;
}

// ── Progress summary ───────────────────────────────────────────────────
async function summariseProgress(pool, patientId, window) {
  let sinceDate = null;
  let label = "all-time";
  if (window?.window === "since_last_visit") {
    sinceDate = await findLastVisitDate(pool, patientId);
    label = sinceDate ? `since ${sinceDate}` : "since first visit (no past appt found)";
  } else {
    const days = Math.max(1, Math.floor(window?.days || 30));
    label = `last ${days} days`;
  }

  const dateExpr = sinceDate
    ? `>= '${sinceDate}'::date`
    : `>= (CURRENT_DATE - INTERVAL '${Math.max(1, Math.floor(window?.days || 30))} days')`;

  // BP / sugar / weight averages — merged across patient_vitals_log (companion
  // self-logs) and vitals (doctor entries on /visit). Without the union,
  // "how am I doing?" silently misses any doctor-recorded readings.
  let vit;
  try {
    vit = await pool.query(
      `WITH merged AS (
         SELECT recorded_date::date AS d, bp_systolic, bp_diastolic, rbs, meal_type, weight_kg
           FROM patient_vitals_log WHERE patient_id=$1
         UNION ALL
         SELECT recorded_at::date AS d, bp_sys AS bp_systolic, bp_dia AS bp_diastolic,
                rbs, meal_type, weight AS weight_kg
           FROM vitals WHERE patient_id=$1
       )
       SELECT
          AVG(bp_systolic)::numeric(6,1) AS bp_sys_avg,
          AVG(bp_diastolic)::numeric(6,1) AS bp_dia_avg,
          COUNT(*) FILTER (WHERE bp_systolic IS NOT NULL) AS bp_count,
          AVG(rbs)::numeric(6,1) AS sugar_avg,
          AVG(rbs) FILTER (WHERE meal_type ILIKE 'fasting')::numeric(6,1) AS sugar_fbg_avg,
          COUNT(*) FILTER (WHERE rbs IS NOT NULL) AS sugar_count,
          MIN(weight_kg) AS weight_min, MAX(weight_kg) AS weight_max,
          (SELECT weight_kg FROM (
              SELECT weight_kg, d FROM merged WHERE weight_kg IS NOT NULL
           ) w ORDER BY d DESC LIMIT 1) AS weight_latest
         FROM merged
        WHERE d ${dateExpr}`,
      [patientId],
    );
  } catch (e) {
    // Fallback if `vitals` table missing on this env.
    vit = await pool.query(
      `SELECT
          AVG(bp_systolic)::numeric(6,1) AS bp_sys_avg,
          AVG(bp_diastolic)::numeric(6,1) AS bp_dia_avg,
          COUNT(*) FILTER (WHERE bp_systolic IS NOT NULL) AS bp_count,
          AVG(rbs)::numeric(6,1) AS sugar_avg,
          AVG(rbs) FILTER (WHERE meal_type ILIKE 'fasting')::numeric(6,1) AS sugar_fbg_avg,
          COUNT(*) FILTER (WHERE rbs IS NOT NULL) AS sugar_count,
          MIN(weight_kg) AS weight_min, MAX(weight_kg) AS weight_max,
          (SELECT weight_kg FROM patient_vitals_log
            WHERE patient_id=$1 AND weight_kg IS NOT NULL
            ORDER BY recorded_date DESC, id DESC LIMIT 1) AS weight_latest
         FROM patient_vitals_log
        WHERE patient_id=$1 AND recorded_date ${dateExpr}`,
      [patientId],
    );
  }

  // Recent key labs
  const labs = await pool.query(
    `SELECT DISTINCT ON (canonical_name) canonical_name, test_name, result, unit, flag, test_date
       FROM lab_results
      WHERE patient_id=$1
        AND canonical_name IN ('hba1c','ldl','tsh','fbs','egfr','creatinine','hb','triglycerides')
      ORDER BY canonical_name, test_date DESC, id DESC`,
    [patientId],
  );

  // Med adherence — taken_logs / expected_doses approximation over window
  const adherence = await pool.query(
    `WITH active AS (
        SELECT id FROM medications
         WHERE patient_id=$1 AND is_active = TRUE AND parent_medication_id IS NULL
      ),
      taken AS (
        SELECT COUNT(*) AS c FROM patient_med_log
         WHERE patient_id=$1 AND log_date ${dateExpr} AND status='taken'
      )
      SELECT (SELECT COUNT(*) FROM active) AS active_meds,
             (SELECT c FROM taken) AS taken_doses`,
    [patientId],
  );

  // Recent symptoms (top 5)
  const sym = await pool.query(
    `SELECT symptom, MAX(log_date) AS last_date, COUNT(*) AS n, MAX(severity) AS worst_severity
       FROM patient_symptom_log
      WHERE patient_id=$1 AND log_date ${dateExpr}
      GROUP BY symptom ORDER BY n DESC, last_date DESC LIMIT 5`,
    [patientId],
  );

  return {
    window: label,
    since_date: sinceDate,
    bp:
      vit.rows[0]?.bp_count > 0
        ? {
            systolic_avg: Number(vit.rows[0].bp_sys_avg),
            diastolic_avg: Number(vit.rows[0].bp_dia_avg),
            readings: Number(vit.rows[0].bp_count),
          }
        : null,
    sugar:
      vit.rows[0]?.sugar_count > 0
        ? {
            all_avg_mgdl: Number(vit.rows[0].sugar_avg),
            fasting_avg_mgdl: vit.rows[0].sugar_fbg_avg ? Number(vit.rows[0].sugar_fbg_avg) : null,
            readings: Number(vit.rows[0].sugar_count),
          }
        : null,
    weight: vit.rows[0]?.weight_latest
      ? {
          latest_kg: Number(vit.rows[0].weight_latest),
          min_kg: vit.rows[0].weight_min ? Number(vit.rows[0].weight_min) : null,
          max_kg: vit.rows[0].weight_max ? Number(vit.rows[0].weight_max) : null,
        }
      : null,
    labs_latest: labs.rows.map((r) => ({
      test: r.test_name,
      canonical: r.canonical_name,
      value: r.result,
      unit: r.unit,
      flag: r.flag,
      date: r.test_date,
    })),
    medication_adherence: {
      active_meds: Number(adherence.rows[0]?.active_meds || 0),
      taken_doses_in_window: Number(adherence.rows[0]?.taken_doses || 0),
    },
    top_symptoms: sym.rows.map((r) => ({
      symptom: r.symptom,
      occurrences: Number(r.n),
      worst_severity: r.worst_severity ? Number(r.worst_severity) : null,
      last_date: r.last_date,
    })),
  };
}

// ── Medication schedule ────────────────────────────────────────────────
const TIME_SLOT_LABELS = {
  fasting: "Fasting / first thing",
  before_breakfast: "Before breakfast",
  after_breakfast: "After breakfast",
  before_lunch: "Before lunch",
  after_lunch: "After lunch",
  before_dinner: "Before dinner",
  after_dinner: "After dinner",
  bedtime: "Bedtime",
  anytime: "Anytime",
};

function classifyTimingSlot(timing) {
  // Accept the canonical text[] enum value, a comma-separated string, or null.
  const t = Array.isArray(timing)
    ? timing.join(",").toLowerCase()
    : String(timing || "").toLowerCase();
  if (!t) return "anytime";
  if (t.includes("fasting")) return "fasting";
  if (t.includes("bedtime") || t.includes("night")) return "bedtime";
  if (t.includes("before breakfast") || t.includes("empty stomach")) return "before_breakfast";
  if (t.includes("after breakfast") || t.includes("breakfast")) return "after_breakfast";
  if (t.includes("before lunch")) return "before_lunch";
  if (t.includes("after lunch") || t.includes("lunch")) return "after_lunch";
  if (t.includes("before dinner")) return "before_dinner";
  if (t.includes("after dinner") || t.includes("dinner")) return "after_dinner";
  return "anytime";
}

async function getMedSchedule(pool, patientId) {
  const meds = await qMeds(pool, patientId, { limit: 200 });
  const active = meds.filter((m) => m.is_active && !m.parent_medication_id);
  const grouped = {};
  for (const m of active) {
    const slot = classifyTimingSlot(m.when_to_take || m.timing);
    if (!grouped[slot]) grouped[slot] = [];
    grouped[slot].push({
      name: m.name,
      dose: m.dose,
      frequency: m.frequency,
      when_to_take: m.when_to_take,
      timing: m.timing,
    });
  }
  return Object.entries(grouped).map(([slot, items]) => ({
    slot,
    label: TIME_SLOT_LABELS[slot] || slot,
    meds: items,
  }));
}

// ── Dispatcher ─────────────────────────────────────────────────────────
export async function executeTool(name, input, ctx) {
  const { pool, scribePatientId } = ctx;
  const args = await withSinceContext(pool, scribePatientId, input || {});

  switch (name) {
    case "query_patient_data": {
      switch (args.scope) {
        case "profile":
          return qProfile(pool, scribePatientId);
        case "vitals":
          return qVitalsAll(pool, scribePatientId, args);
        case "sugar":
          return qSugar(pool, scribePatientId, args);
        case "bp":
          return qBP(pool, scribePatientId, args);
        case "weight":
          return qWeight(pool, scribePatientId, args);
        case "labs":
          return qLabs(pool, scribePatientId, args);
        case "meds":
          return qMeds(pool, scribePatientId, args);
        case "meals":
          return qMeals(pool, scribePatientId, args);
        case "symptoms":
          return qSymptoms(pool, scribePatientId, args);
        case "appointments":
          return qAppointments(pool, scribePatientId, args);
        case "diagnoses":
          return qDiagnoses(pool, scribePatientId);
        default:
          return { error: `Unknown scope: ${args.scope}` };
      }
    }
    case "get_progress_summary":
      return summariseProgress(pool, scribePatientId, args);
    case "get_medication_schedule":
      return getMedSchedule(pool, scribePatientId);
    case "get_appointments": {
      const all = await qAppointments(pool, scribePatientId, { limit: args.limit || 20 });
      const today = new Date().toISOString().slice(0, 10);
      if (args.scope === "upcoming") return all.filter((a) => String(a.appointment_date) >= today);
      if (args.scope === "past") return all.filter((a) => String(a.appointment_date) < today);
      if (args.scope === "next") {
        const up = all
          .filter((a) => String(a.appointment_date) >= today)
          .sort((a, b) => String(a.appointment_date).localeCompare(String(b.appointment_date)));
        return up[0] || null;
      }
      return all;
    }
    default:
      return { error: `Unknown tool: ${name}` };
  }
}

// ── Client-action mapping for UI tools ─────────────────────────────────
// Returns { clientAction, ack } where ack is the JSON the model sees as the
// tool_result so it can phrase a closing sentence to the patient.
export function buildClientAction(name, input) {
  if (name === "propose_log") {
    const ca = {
      type: "open_log_modal",
      logType: input.type,
      v1: input.value1 ?? "",
      v2: input.value2 ?? "",
      context: input.context ?? "",
    };
    // Generic-lab card: forward AI-supplied metadata so the app can render
    // the right label, unit, and (optional) ref-range for tests that aren't
    // in the dedicated enum (Vit D, B12, T3, T4, Creatinine, …).
    if (input.type === "Lab") {
      if (input.test_name) ca.test_name = String(input.test_name);
      if (input.unit) ca.unit = String(input.unit);
      if (input.ref_range) ca.ref_range = String(input.ref_range);
      if (input.canonical_name) ca.canonical_name = String(input.canonical_name);
    }
    return {
      clientAction: ca,
      ack: {
        status: "queued_for_client",
        note: "The log card will open in the patient app pre-filled with these values. The patient will tap Save or Cancel.",
      },
    };
  }
  if (name === "classify_and_extract_attachment") {
    const kind = input.kind;
    let items = [];
    if (kind === "food") items = input.food_items || [];
    else if (kind === "lab_report") items = input.lab_items || [];
    else if (kind === "prescription") items = input.rx_items || [];
    const ca = {
      type: "open_multi_log_sheet",
      kind,
      items,
      summary: input.summary || "",
    };
    return {
      clientAction: ca,
      ack: {
        status: "queued_for_client",
        note: `Bulk-log sheet will open with ${items.length} ${kind} item(s). The patient will pick which rows to save.`,
      },
    };
  }
  if (name === "open_doctor_chat") {
    const ca = {
      type: "open_doctor_chat",
      seed: input.seed ?? "",
    };
    return {
      clientAction: ca,
      ack: { status: "queued_for_client", note: "Care → Team chat will open." },
    };
  }
  return null;
}

export const UI_TOOL_NAMES = new Set([
  "propose_log",
  "open_doctor_chat",
  "classify_and_extract_attachment",
]);
export const FINAL_TOOL_NAME = "respond_to_patient";
