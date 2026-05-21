import { LAB_MAP } from "../../routes/opd.js";
import { getCanonical } from "../../utils/labCanonical.js";
import { sortDiagnoses } from "../../utils/diagnosisSort.js";
import { sortMedications } from "../../utils/medicationSort.js";
import { validatePatientSql, SCHEMA_HINT } from "./sqlGuard.js";

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
            "med_adherence",
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
    name: "run_patient_sql",
    description: `Run a read-only SELECT against the authenticated patient's data when the narrow tools (query_patient_data / get_full_patient_context / get_progress_summary) don't expose what you need. $1 is automatically bound to the patient_id — your query MUST contain \`patient_id = $1\` (with optional table alias) for every patient-scoped table you read. Single statement only. Read-only transaction, 5s statement timeout, max 200 rows returned. Use for: derived metrics (Non-HDL = TC - HDL, TG/HDL ratio, BMI from height+weight, eAG from HbA1c), labs not in the narrow scopes(if not available in db), time-bucketed aggregations, and cross-table joins. DO NOT use as a replacement for the narrow tools on routine reads.\n\n${SCHEMA_HINT}`,
    input_schema: {
      type: "object",
      properties: {
        sql: {
          type: "string",
          description:
            "A single SELECT or WITH ... SELECT statement. Use $1 wherever you need the patient_id. No semicolons, no comments, no DML.",
        },
        reason: {
          type: "string",
          description:
            "One-line note on why narrow tools were insufficient (telemetry only; the user never sees it).",
        },
      },
      required: ["sql"],
    },
  },
  {
    name: "get_full_patient_context",
    description:
      "Return a comprehensive snapshot of EVERYTHING known about the authenticated patient in ONE call: profile (name/age/sex/dob), active medications, active diagnoses, the latest value of every lab on file (HbA1c, LDL, HDL, Total Cholesterol, Triglycerides, TSH, Hb, eGFR, Creatinine, Vitamin D/B12, T3/T4, FBS, PPBS, and any other test ever recorded), recent vitals (BP/sugar/weight, last 90 days), recent symptoms (last 60 days), upcoming + last 5 past appointments, and medication adherence summary (last 30 days). Use this when the patient asks an open-ended question like 'what do you know about me', 'give me my full report', or any derived metric that needs multiple values (e.g. Non-HDL = Total Cholesterol − HDL, TG/HDL ratio, ASCVD risk inputs). Prefer this over chaining many query_patient_data calls.",
    input_schema: {
      type: "object",
      properties: {
        vitals_days: {
          type: "number",
          description: "Window (days) for recent BP/sugar/weight rows. Default 90.",
        },
        symptoms_days: {
          type: "number",
          description: "Window (days) for recent symptoms rows. Default 60.",
        },
      },
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
      "Patient's visit history merged across native consultations + HealthRay appointments (same merge /visit?tab=history uses). scope='past' = completed visits with full details: doctor_name, visit_type, status, diagnoses (JSONB), medications (JSONB — confirmed prescribed list), assessment_summary (text), advice (text from HealthRay), and follow_up. scope='upcoming' = future scheduled appointments (slim — only doctor_name/visit_type/status/follow_up; rich history fields stripped since they don't apply); scope='next' = single nearest future appointment (same slim shape). Each row carries `source` ('consultation'|'appointment'). `follow_up` (JSONB) comes from appointments.healthray_follow_up (HealthRay) or consultations.con_data->'follow_up' (Gini). Use this whenever the patient asks about past visits, what was discussed/prescribed in a prior visit, upcoming appointments, or follow-up dates/instructions.",
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
    name: "get_prescriptions",
    description:
      "Patient's prescription documents (rows from `documents` where doc_type='prescription'). Use when the patient asks to see / view / share / download / open their prescription, or 'meri prescription do/dikha', 'parchi chahiye'. Returns id, title, file_name, doc_date, source, notes, file_url, storage_path, consultation_id — newest first. scope='latest' returns just the most recent row; scope='all' returns up to `limit` rows (default 5). Quote the doc_date verbatim. Always pair with `open_document` so the patient can actually view the PDF in chat.",
    input_schema: {
      type: "object",
      properties: {
        scope: { type: "string", enum: ["latest", "all"] },
        limit: { type: "number" },
      },
      required: ["scope"],
    },
  },
  {
    name: "open_document",
    description:
      "UI tool — open a document (typically a prescription PDF) inline in the chat for the patient to view. Call this AFTER get_prescriptions when the patient wants to see / download / share the file. Pass through the id, file_url, and a short title (e.g. 'Prescription · 12 May 2026'). Always follow with respond_to_patient and a one-line note ('I've opened your latest prescription from 12 May.').",
    input_schema: {
      type: "object",
      properties: {
        document_id: { type: "number", description: "documents.id" },
        file_url: {
          type: "string",
          description: "Signed/public URL from get_prescriptions.file_url",
        },
        title: { type: "string", description: "Short label shown above the inline viewer." },
        doc_type: {
          type: "string",
          enum: ["prescription", "lab_report", "imaging", "discharge", "other"],
        },
        doc_date: { type: "string", description: "YYYY-MM-DD shown next to the title (optional)." },
      },
      required: ["document_id", "file_url", "title"],
    },
  },
  {
    name: "propose_log",
    description:
      "Open the in-app log card pre-filled with values the user just gave you. Always use this when the user says 'log my BP 130/80' / 'sugar 180 fasting' / 'I weigh 82 kg' / 'my Vit D is 28' / 'log uric acid 6.5' / 'sodium 138' — never silently log. Pick the most specific type from the enum. The enum covers the most-asked vitals, common labs, lipid panel, thyroid, KFT, LFT, electrolytes, vitamins, iron studies, and CBC sub-values as first-class types. For ANY test the patient names that ISN'T in the enum (rare biomarkers, hormone panels, tumour markers, niche serologies, etc.), fall back to type='Lab' with test_name + unit + (optional) ref_range + canonical_name. The 'Lab' fallback is the universal escape hatch — there is NO test the patient cannot log here.",
    input_schema: {
      type: "object",
      properties: {
        type: {
          type: "string",
          enum: [
            "BP",
            "Sugar",
            "Weight",
            "Height",
            "Temperature",
            "HeartRate",
            "SpO2",
            "RespiratoryRate",
            "HbA1c",
            "FBS",
            "PPBS",
            "RandomSugar",
            "LDL",
            "HDL",
            "TotalCholesterol",
            "Triglycerides",
            "NonHDL",
            "VLDL",
            "TSH",
            "FreeT3",
            "FreeT4",
            "TotalT3",
            "TotalT4",
            "Haemoglobin",
            "eGFR",
            "Creatinine",
            "UricAcid",
            "Urea",
            "BUN",
            "Sodium",
            "Potassium",
            "Chloride",
            "Calcium",
            "Phosphorus",
            "Magnesium",
            "VitaminD",
            "VitaminB12",
            "Folate",
            "Iron",
            "Ferritin",
            "TIBC",
            "TransferrinSat",
            "ALT",
            "AST",
            "ALP",
            "GGT",
            "Bilirubin",
            "DirectBilirubin",
            "Albumin",
            "Globulin",
            "TotalProtein",
            "WBC",
            "RBC",
            "Platelets",
            "PCV",
            "MCV",
            "MCH",
            "MCHC",
            "RDW",
            "ESR",
            "CRP",
            "Insulin",
            "CPeptide",
            "Lab",
            "Food",
            "Symptom",
          ],
        },
        value1: { type: "string", description: "Primary value (e.g. systolic, sugar mg/dL)." },
        value2: { type: "string", description: "Secondary value (e.g. diastolic)." },
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
        date: {
          type: "string",
          description:
            "Optional ISO date YYYY-MM-DD the reading was taken on. Set this when the patient says things like 'yesterday', 'two days ago', 'on Monday', 'on 12 May'. Default behaviour (omit the field) prefills today. Always resolve relative dates against the system-provided 'today' — never against an older value from the conversation history.",
        },
      },
      required: ["type", "value1"],
    },
  },
  {
    name: "create_health_log",
    description:
      "Directly write a health entry to the database WITHOUT opening a modal. Use ONLY when: (a) the patient explicitly confirms ('yes', 'log it', 'save it', 'haan log karo') after a propose_log called IN THE SAME TURN, OR (b) the patient states a value AND explicitly asks to save directly in a single message. NEVER use to re-log values from memory, prior turns, or checkpoint. NEVER call both propose_log and create_health_log in the same turn. After this call, still call respond_to_patient confirming what was saved.",
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
            "Symptom",
            "Food",
          ],
          description: "Health data type to log.",
        },
        value1: {
          type: "string",
          description:
            "Primary value in the canonical unit — pre-converted per the same rules as propose_log (e.g. kg for Weight, mg/dL for Sugar, % for HbA1c, mmHg for BP systolic).",
        },
        value2: {
          type: "string",
          description: "Secondary value where applicable: diastolic for BP.",
        },
        context: {
          type: "string",
          description:
            "Context label: meal timing for Sugar (Fasting/After breakfast/etc.), meal type for Food (breakfast/lunch/snack/dinner).",
        },
        date: {
          type: "string",
          description:
            "Optional ISO YYYY-MM-DD the reading was taken on. Omit for today. Resolve relative dates against the server-provided today.",
        },
        test_name: {
          type: "string",
          description:
            "For type='Lab' only: human-readable test name (e.g. 'Vitamin D', 'Creatinine'). Required when type='Lab'.",
        },
        unit: {
          type: "string",
          description:
            "For type='Lab' only: standard unit (e.g. 'ng/mL', 'mg/dL'). Required when type='Lab'.",
        },
        ref_range: {
          type: "string",
          description:
            "For type='Lab' only: normal reference range string (e.g. '30-100 ng/mL'). Optional.",
        },
        canonical_name: {
          type: "string",
          description:
            "For type='Lab' only: lowercase canonical key (e.g. 'vitd', 'creatinine', 'b12'). Optional.",
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
            "reception_handoff",
            "schedule_info",
            "refusal",
          ],
          description:
            "Why you replied this way. log_proposed → you also called propose_log. doctor_handoff → you also called open_doctor_chat. reception_handoff → you also called open_reception_chat (admin/scheduling/lab booking). refusal → you declined a diagnosis/dose request and pointed to the doctor.",
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
        disclaimer: {
          type: "string",
          description:
            "Short safety disclaimer rendered as a styled note BELOW the main reply (not part of `message`). Set this WHENEVER the turn touches anything clinical/sensitive: symptom interpretation, lab-value meaning, dose timing or changes, side-effect commentary, medicine interactions, dietary restrictions for a chronic condition, exercise intensity for someone with cardiac/CKD history. Keep to ONE sentence, Hinglish-friendly, ending with 'consult your doctor' / 'doctor se confirm karein'. Examples: 'This is general info — please confirm with your doctor before making any changes.' / 'Yeh general guidance hai — apne doctor se confirm karein before adjusting.' Skip the field entirely (omit, don't pass empty string) for pure greetings, log confirmations, schedule lookups, and admin handoffs.",
        },
        suggested_chips: {
          type: "array",
          description:
            "2-3 short quick-reply chips rendered under your reply for the patient to tap. Tailor them to the CURRENT topic — if you suggested a meal, chips might offer to log it, ask for alternatives, or show macros; if you answered a BP question, chips might offer to log a new reading or show the trend. Plain conversational follow-ups, NOT random tiles. Skip the array entirely for tiny acknowledgments or when no obvious next step exists.",
          maxItems: 4,
          items: {
            type: "object",
            properties: {
              label: {
                type: "string",
                description:
                  "Short chip text (≤ 28 chars). Lead with a single emoji + space when natural, e.g. '📝 Log this meal', '📈 Show my BP trend', '🍵 Snack ideas'.",
              },
              type: {
                type: "string",
                enum: ["ask", "log", "photo", "symptom"],
                description:
                  "How the app should handle a tap. 'ask' = send the label back as a new user message (use for follow-up questions). 'log' = open the Log modal (set logType). 'photo' = open the camera/photo picker. 'symptom' = open the symptom-tracking modal.",
              },
              logType: {
                type: "string",
                enum: ["BP", "Sugar", "Weight", "Food", "Exercise", "Symptom", "Lab"],
                description: "Required when type='log'. Which LogModal to open.",
              },
            },
            required: ["label", "type"],
          },
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
                  "Consultant free-text note (e.g. '30 min before food'). The canonical patient-facing field is `when_to_take` which uses the fixed vocabulary: Fasting, Before breakfast, After breakfast, Before lunch, After lunch, Before dinner, After dinner, At bedtime, SOS only, Any time.",
              },
              when_to_take: {
                type: "string",
                description:
                  "One or more comma-separated values from: Fasting, Before breakfast, After breakfast, Before lunch, After lunch, Before dinner, After dinner, At bedtime, SOS only, Any time.",
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
  {
    name: "propose_med_dose",
    description:
      "Open a confirmation bottom sheet so the patient can record a medicine dose as 'taken' or 'missed'. Use this — NOT propose_log — when the patient says 'I took my Metformin', 'log my Glizid as taken', 'I missed my morning insulin'. Resolve the med name from medications they're actually on (run get_medication_schedule first if you're unsure of the exact name or slot). One call per medicine.",
    input_schema: {
      type: "object",
      properties: {
        medication_name: {
          type: "string",
          description: "Exact medicine name as stored in their schedule (e.g. 'Metformin 500mg').",
        },
        dose: {
          type: "string",
          description: "Dose string the patient confirms, e.g. '500 mg', '10 units'.",
        },
        slot: {
          type: "string",
          enum: [
            "fasting",
            "before_breakfast",
            "after_breakfast",
            "before_lunch",
            "after_lunch",
            "before_dinner",
            "after_dinner",
            "bedtime",
            "anytime",
          ],
          description: "Which scheduled slot this dose belongs to.",
        },
        status: {
          type: "string",
          enum: ["taken", "missed"],
          description: "What the patient says happened — taken (default) or missed.",
        },
        date: {
          type: "string",
          description:
            "ISO YYYY-MM-DD. Omit for 'today/now', set explicitly for 'yesterday', 'on Monday', etc.",
        },
      },
      required: ["medication_name", "status"],
    },
  },
  {
    name: "propose_med_reminder",
    description:
      "Open a bottom sheet to set / update reminder times on a specific medicine. Use when the patient asks 'remind me to take Telvas at 8 pm', 'set reminder for my insulin at 9 and 21', 'mera Glizid 9 baje yaad dilana'. One call per medicine.",
    input_schema: {
      type: "object",
      properties: {
        medication_name: {
          type: "string",
          description: "Exact medicine name as stored in their schedule.",
        },
        times: {
          type: "array",
          description: "Reminder times in 24-hour HH:MM format. Convert '8 pm' → '20:00'.",
          items: { type: "string" },
        },
        enable: {
          type: "boolean",
          description:
            "True to enable the reminders; false only when the patient explicitly asks to turn them off.",
        },
      },
      required: ["medication_name", "times", "enable"],
    },
  },
  {
    name: "propose_refill",
    description:
      "Open the refill-request modal pre-selected with the medicines the patient wants to reorder. Use when patient says 'I'm running low on Metformin', 'order refill for my diabetes meds', 'reorder all my BP medicines'. If they said 'all my X meds', resolve names via query_patient_data scope='meds' filtered by med_group first.",
    input_schema: {
      type: "object",
      properties: {
        items: {
          type: "array",
          description: "Items to pre-select. Each row identifies one medicine.",
          items: {
            type: "object",
            properties: {
              medication_name: { type: "string" },
              dose: { type: "string" },
              quantity: {
                type: "string",
                description: "Quantity / strips / pens the patient asked for. Optional.",
              },
            },
            required: ["medication_name"],
          },
        },
        notes: { type: "string", description: "Optional free-text note for the pharmacy team." },
      },
      required: ["items"],
    },
  },
  {
    name: "propose_pre_visit_symptoms",
    description:
      "Open the pre-visit symptom logger — the same UI the patient sees on the home screen before an upcoming appointment. ONLY use this when the patient has an appointment within the next 7 days (verify with get_appointments scope='next' first). For day-to-day symptom tracking with no upcoming visit, use propose_log with logType='Symptom' instead.",
    input_schema: {
      type: "object",
      properties: {
        appointment_id: {
          type: "integer",
          description:
            "Optional appointment id from get_appointments. The sheet will attach the symptoms to this visit.",
        },
        symptoms: {
          type: "array",
          description: "List of symptom names the patient mentioned (e.g. ['headache','fatigue']).",
          items: { type: "string" },
        },
        note: {
          type: "string",
          description: "Optional free-text note alongside the symptom list.",
        },
      },
      required: ["symptoms"],
    },
  },
  {
    name: "call_clinic",
    description:
      "Surface an inline phone-icon card with the clinic's reception number. Tap dials. Use ONLY when the patient explicitly asks to call the hospital / reception / clinic, or when the situation is too urgent for the asynchronous reception chat. NEVER use for clinical handoff (use open_doctor_chat) or routine admin like booking (use open_reception_chat).",
    input_schema: {
      type: "object",
      properties: {
        reason: { type: "string", description: "Short tag for telemetry — not shown to patient." },
      },
    },
  },
  {
    name: "open_reception_chat",
    description:
      "Surface an inline 'Chat with reception' card in the patient's chat for ADMIN / SCHEDULING / NON-CLINICAL requests the app cannot fulfil directly — e.g. book appointment, reschedule visit, book lab test, home sample pickup, general queries about timings, billing, reports delivery. The card lets the patient tap to open the Gini Advanced Care (reception) chat with the seed pre-filled. Do NOT use this for clinical/medical questions (use open_doctor_chat) or for things you can answer with patient data tools.",
    input_schema: {
      type: "object",
      properties: {
        seed: {
          type: "string",
          description:
            "Pre-filled message the patient can review and send to reception, e.g. 'I'd like to book a lab test with home pickup.'",
        },
        topic: {
          type: "string",
          enum: [
            "book_appointment",
            "reschedule_visit",
            "book_lab_test",
            "home_sample_pickup",
            "billing",
            "reports",
            "general",
          ],
          description: "What the patient is asking reception to help with.",
        },
        reason: { type: "string", description: "Short tag for telemetry — not shown." },
      },
      required: ["seed", "topic"],
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

async function qProfile(pool, patientId) {
  const { rows } = await pool.query(
    `SELECT id, name, age, sex, file_no, dob, phone
       FROM patients WHERE id = $1`,
    [patientId],
  );
  const row = rows[0];
  if (!row) return null;

  if (row.dob) {
    const d = new Date(row.dob);
    if (!isNaN(d.getTime())) {
      const now = new Date();
      let years = now.getUTCFullYear() - d.getUTCFullYear();
      const m = now.getUTCMonth() - d.getUTCMonth();
      if (m < 0 || (m === 0 && now.getUTCDate() < d.getUTCDate())) years -= 1;
      if (years >= 0 && years < 130) row.age = years;
    }
  }
  return row;
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
    "(recorded_at AT TIME ZONE 'Asia/Kolkata')::date AS recorded_date",
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
  sql += ` ORDER BY recorded_date DESC, id DESC LIMIT ${limit}`;

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
          ORDER BY recorded_date DESC, id DESC LIMIT ${limit}`,
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

// Build a {canonical → row[]} history map by merging `lab_results` rows with
// the `appointments.biomarkers` JSONB blobs that HealthRay syncs onto each
// clinical note. Direct port of the merge logic in
// `gini-scribe/server/routes/visit.js:603-764` — needed because some labs
// (e.g. HbA1c read off a clinical note) only exist in the appointment
// biomarkers, never in `lab_results`. Without the merge the agent reports a
// stale value from `lab_results` that disagrees with what /visit shows.
async function fetchMergedLabHistory(pool, patientId) {
  const labHistory = {}; // canonical_name → row[] (newest first)

  // 1. Authoritative lab_results rows.
  const { rows: labRows } = await pool.query(
    `SELECT lr.id, COALESCE(lr.test_date, a.appointment_date) AS test_date,
            lr.test_name, lr.canonical_name, lr.result, lr.result_text, lr.unit,
            lr.flag, lr.ref_range, lr.panel_name, lr.created_at
       FROM lab_results lr
       LEFT JOIN appointments a ON a.id = lr.appointment_id
      WHERE lr.patient_id = $1`,
    [patientId],
  );
  // Track the raw lab draw date per (canonical, day) so the biomarkers pass
  // can decide whether it's already covered. Mirrors visit.js' `latestRaw`
  // tiebreak but simplified to "have we seen this exact day".
  for (const r of labRows) {
    const key = r.canonical_name || getCanonical(r.test_name) || r.test_name;
    if (!key) continue;
    if (!labHistory[key]) labHistory[key] = [];
    labHistory[key].push({
      result: r.result,
      result_text: r.result_text,
      unit: r.unit,
      flag: r.flag,
      date: r.test_date,
      ref_range: r.ref_range,
      panel_name: r.panel_name,
      source: "lab_results",
    });
  }

  // 2. Fold in appointments.biomarkers, applying the same oldest→newest
  // carry-forward dedup /visit uses (HealthRay duplicates the latest value
  // into every subsequent appointment).
  const { rows: bioRows } = await pool.query(
    `SELECT appointment_date, biomarkers FROM appointments
      WHERE patient_id = $1 AND biomarkers IS NOT NULL
        AND appointment_date IS NOT NULL
      ORDER BY appointment_date ASC, created_at ASC`,
    [patientId],
  );
  const dayOf = (d) => (d ? String(d).slice(0, 10) : null);
  const firstSeenCarry = new Map();
  for (const row of bioRows) {
    const bio = row.biomarkers || {};
    const bioLabDates = bio._lab_dates || {};
    for (const [bioKey, meta] of Object.entries(LAB_MAP)) {
      const raw = bio[bioKey];
      if (raw == null) continue;
      const v = parseFloat(raw);
      if (!isFinite(v)) continue;
      const canonical = meta.canonical;
      const labDate = bioLabDates[bioKey];
      let date;
      if (labDate) {
        date = labDate;
      } else {
        const dedupKey = `${canonical}|${v}`;
        if (firstSeenCarry.has(dedupKey)) continue;
        firstSeenCarry.set(dedupKey, true);
        date = row.appointment_date;
      }
      const dayKey = dayOf(date);
      if (!labHistory[canonical]) labHistory[canonical] = [];
      const dup = labHistory[canonical].some((h) => dayOf(h.date) === dayKey);
      if (dup) continue;
      labHistory[canonical].push({
        result: v,
        result_text: null,
        unit: meta.unit || null,
        flag: null,
        date,
        ref_range: null,
        panel_name: meta.panel || null,
        source: "biomarkers",
      });
    }
  }

  for (const arr of Object.values(labHistory)) {
    arr.sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")));
  }
  return labHistory;
}

async function latestLabsMerged(pool, patientId) {
  const hist = await fetchMergedLabHistory(pool, patientId);
  const out = {};
  for (const [canonical, arr] of Object.entries(hist)) {
    if (arr.length > 0) out[canonical] = arr[0];
  }
  return out;
}

async function qLabs(pool, patientId, args) {
  const limit = Math.min(Math.max(args.limit || 50, 1), 500);
  const hist = await fetchMergedLabHistory(pool, patientId);

  // Apply optional date-range filter on the merged set so since_last_visit /
  // range_days still work.
  let sinceDate = null;
  if (args.since_last_visit && args.__lastVisit) {
    sinceDate = String(args.__lastVisit);
  } else if (typeof args.range_days === "number" && args.range_days > 0) {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - Math.floor(args.range_days));
    sinceDate = d.toISOString().slice(0, 10);
  }

  // Optional canonical_name / test_name filter (e.g. "HbA1c").
  const wantName = args.test_name ? String(args.test_name).toLowerCase() : null;

  const flat = [];
  for (const [canonical, arr] of Object.entries(hist)) {
    if (wantName) {
      const meta = Object.values(LAB_MAP).find(
        (m) => m.canonical.toLowerCase() === canonical.toLowerCase(),
      );
      const aliases = [canonical, meta?.test_name]
        .filter(Boolean)
        .map((s) => String(s).toLowerCase());
      // Match LAB_MAP aliases first; otherwise fall back to a substring
      // match against the raw canonical name so tests not in LAB_MAP
      // (HDL, Total Cholesterol, Vitamin D, B12, T3/T4, etc.) still
      // surface when the agent passes their name.
      const aliasHit = aliases.includes(wantName);
      const substrHit =
        !aliasHit &&
        (String(canonical).toLowerCase().includes(wantName) ||
          wantName.includes(String(canonical).toLowerCase()));
      if (!aliasHit && !substrHit) continue;
    }
    for (const r of arr) {
      if (sinceDate && String(r.date || "").slice(0, 10) < sinceDate) continue;
      const meta = Object.values(LAB_MAP).find((m) => m.canonical === canonical);
      flat.push({
        test_date: r.date,
        test_name: meta?.test_name || canonical,
        canonical_name: canonical,
        result: r.result,
        result_text: r.result_text,
        unit: r.unit,
        flag: r.flag,
        ref_range: r.ref_range,
        panel_name: r.panel_name,
        source: r.source,
      });
    }
  }
  flat.sort((a, b) => {
    const d = String(b.test_date || "").localeCompare(String(a.test_date || ""));
    if (d !== 0) return d;
    // Tiebreaker: higher id first so the most-recently-saved row on the
    // same day wins. Falls through to 0 when neither side has an id.
    const ai = a.id ?? a.lab_result_id ?? 0;
    const bi = b.id ?? b.lab_result_id ?? 0;
    return Number(bi) - Number(ai);
  });
  return flat.slice(0, limit);
}

async function qMeds(pool, patientId, args) {
  const limit = Math.min(Math.max(args.limit || 50, 1), 200);
  const { rows } = await pool.query(
    `SELECT id, name, dose, frequency, timing, when_to_take, route, med_group, drug_class,
            is_active, started_date, stopped_date, stop_reason, parent_medication_id,
            days_of_week, sort_order, visit_status
       FROM medications
      WHERE patient_id = $1
        AND is_active = TRUE
        AND (visit_status IS NULL OR visit_status <> 'previous')
      ORDER BY COALESCE(started_date, '0001-01-01'::date) DESC, id DESC
      LIMIT ${limit}`,
    [patientId],
  );
  // Only current-visit active meds — stopped and prior-visit carryovers are
  // excluded so the model doesn't recommend off treatments the doctor dropped.
  return sortMedications(rows);
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

// Medication adherence — which doses were taken, when. Joins to medications
// for the canonical name/dose when patient_med_log carries an id reference.
async function qMedAdherence(pool, patientId, args) {
  const params = [];
  const limit = Math.min(Math.max(args.limit || 100, 1), 500);
  let sql = buildQuery(
    `SELECT id, medication_name, medication_dose, genie_medication_id,
            log_date, dose_time, status, source
       FROM patient_med_log`,
    args,
    "log_date",
    params,
    patientId,
  );
  sql += ` ORDER BY log_date DESC, dose_time DESC NULLS LAST, id DESC LIMIT ${limit}`;
  const { rows } = await pool.query(sql, params);
  return rows;
}

async function qAppointments(pool, patientId, args) {
  // Mirror /visit?tab=history (server/routes/visit.js:288-326): merge native
  // consultations with HealthRay appointments so the agent can answer "what
  // visits have I had" the same way the doctor's UI does. Prefer the
  // consultation row when both exist for the same date.
  //
  // Also surface follow-up info from both sources:
  //   • appointments.healthray_follow_up (JSONB, HealthRay) — from /opd
  //   • consultations.con_data->'follow_up' (JSONB, Gini) — from /visit
  //
  // Tolerate environments where the optional columns aren't present.
  const limit = Math.min(Math.max(args.limit || 20, 1), 100);
  // Mirrors the merged visit-history query at server/routes/visit.js:286–326,
  // so past visits surface the same diagnoses / medications / assessment /
  // advice the /visit history panel renders. Future appointments use the
  // same shape with the rich fields naturally null.
  const buildQuery = ({ withFollowUpWith, withHealthrayFollowUp }) => `
    WITH cons AS (
      SELECT
        id,
        visit_date           AS appointment_date,
        NULL::text           AS time_slot,
        con_name             AS doctor_name,
        visit_type,
        status,
        NULL::text           AS notes,
        NULL::text           AS follow_up_with,
        con_data->'follow_up'           AS follow_up,
        con_data->'diagnoses'           AS diagnoses,
        con_data->'medications_confirmed' AS medications,
        con_data->>'assessment_summary' AS assessment_summary,
        NULL::text                       AS advice,
        'consultation'       AS source
      FROM consultations
      WHERE patient_id = $1
    ),
    appts AS (
      SELECT
        id,
        appointment_date,
        time_slot,
        doctor_name,
        visit_type,
        status,
        notes,
        ${withFollowUpWith ? "follow_up_with" : "NULL::text AS follow_up_with"},
        ${withHealthrayFollowUp ? "healthray_follow_up AS follow_up" : "NULL::jsonb AS follow_up"},
        healthray_diagnoses    AS diagnoses,
        healthray_medications  AS medications,
        NULL::text             AS assessment_summary,
        healthray_advice       AS advice,
        'appointment' AS source
      FROM appointments
      WHERE patient_id = $1
    ),
    merged AS (
      SELECT * FROM cons
      UNION ALL
      SELECT a.* FROM appts a
      WHERE NOT EXISTS (
        SELECT 1 FROM cons c
        WHERE c.appointment_date::date = a.appointment_date::date
      )
    )
    SELECT * FROM merged
    WHERE appointment_date IS NOT NULL
    ORDER BY appointment_date DESC, id DESC
    LIMIT ${limit}
  `;

  // Try widest schema first, then degrade gracefully.
  const variants = [
    { withFollowUpWith: true, withHealthrayFollowUp: true },
    { withFollowUpWith: false, withHealthrayFollowUp: true },
    { withFollowUpWith: true, withHealthrayFollowUp: false },
    { withFollowUpWith: false, withHealthrayFollowUp: false },
  ];
  let lastErr = null;
  for (const v of variants) {
    try {
      const { rows } = await pool.query(buildQuery(v), [patientId]);
      return rows;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("qAppointments failed");
}

async function qDiagnoses(pool, patientId) {
  // Mirror /visit's diagnoses query (visit.js:227-232): DISTINCT ON
  // diagnosis_id, prefer active rows, then most recently updated. Pipe
  // through sortDiagnoses so Primary → Complication → Comorbidity ordering
  // matches what the doctor sees.
  const { rows } = await pool.query(
    `SELECT DISTINCT ON (diagnosis_id) *
       FROM diagnoses WHERE patient_id = $1
      ORDER BY diagnosis_id, is_active DESC, updated_at DESC, id DESC`,
    [patientId],
  );
  return sortDiagnoses(rows);
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
         SELECT (recorded_at AT TIME ZONE 'Asia/Kolkata')::date AS d, bp_sys AS bp_systolic, bp_dia AS bp_diastolic,
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

  // Recent key labs — merged across lab_results + appointments.biomarkers so
  // values that only live on a clinical note (HealthRay sync) still surface.
  // Mirrors /visit's labLatest construction.
  const latestLabs = await latestLabsMerged(pool, patientId);
  const KEY_CANONICAL = [
    "HbA1c",
    "LDL",
    "TSH",
    "FBS",
    "eGFR",
    "Creatinine",
    "Haemoglobin",
    "Triglycerides",
  ];
  const labs = {
    rows: KEY_CANONICAL.filter((c) => latestLabs[c]).map((c) => {
      const r = latestLabs[c];
      const meta = Object.values(LAB_MAP).find((m) => m.canonical === c);
      return {
        canonical_name: c,
        test_name: meta?.test_name || c,
        result: r.result,
        unit: r.unit,
        flag: r.flag,
        test_date: r.date,
      };
    }),
  };

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

async function getFullPatientContext(pool, patientId, args = {}) {
  const vitalsDays = Math.max(1, Math.floor(args.vitals_days || 90));
  const symptomsDays = Math.max(1, Math.floor(args.symptoms_days || 60));

  const today = new Date().toISOString().slice(0, 10);

  const [
    profile,
    diagnoses,
    meds,
    labHistory,
    recentVitals,
    recentSymptoms,
    allAppointments,
    adherenceRow,
  ] = await Promise.all([
    qProfile(pool, patientId),
    qDiagnoses(pool, patientId),
    qMeds(pool, patientId, { limit: 200 }),
    fetchMergedLabHistory(pool, patientId),
    qVitalsAll(pool, patientId, { range_days: vitalsDays, limit: 200 }),
    qSymptoms(pool, patientId, { range_days: symptomsDays, limit: 50 }),
    qAppointments(pool, patientId, { limit: 20 }),
    pool
      .query(
        `WITH active AS (
            SELECT id FROM medications
             WHERE patient_id=$1 AND is_active = TRUE AND parent_medication_id IS NULL
          ),
          taken AS (
            SELECT COUNT(*) AS c FROM patient_med_log
             WHERE patient_id=$1
               AND log_date >= (CURRENT_DATE - INTERVAL '30 days')
               AND status='taken'
          )
          SELECT (SELECT COUNT(*) FROM active) AS active_meds,
                 (SELECT c FROM taken) AS taken_doses`,
        [patientId],
      )
      .then((r) => r.rows[0] || {})
      .catch(() => ({})),
  ]);

  // Latest + full history per lab, with friendly metadata where available.
  const labsLatest = {};
  const labsHistory = {};

  for (const [canonical, arr] of Object.entries(labHistory)) {
    if (!arr || arr.length === 0) continue;
    const meta = Object.values(LAB_MAP).find((m) => m.canonical === canonical);
    const display = meta?.test_name || canonical;
    const latest = arr[0];
    labsLatest[canonical] = {
      test_name: display,
      canonical_name: canonical,
      result: latest.result,
      result_text: latest.result_text,
      unit: latest.unit || meta?.unit || null,
      flag: latest.flag,
      date: latest.date,
      ref_range: latest.ref_range,
      panel_name: latest.panel_name || meta?.panel || null,
      source: latest.source,
    };
    labsHistory[canonical] = arr.slice(0, 10).map((r) => ({
      result: r.result,
      unit: r.unit || meta?.unit || null,
      flag: r.flag,
      date: r.date,
      source: r.source,
    }));
  }

  // Slim the meds payload: keep what the model needs for advice, drop noise.
  const medList = meds.map((m) => ({
    id: m.id,
    name: m.name,
    dose: m.dose,
    frequency: m.frequency,
    timing: m.timing,
    when_to_take: m.when_to_take,
    route: m.route,
    med_group: m.med_group,
    drug_class: m.drug_class,
    is_active: m.is_active,
    visit_status: m.visit_status,
    started_date: m.started_date,
  }));

  const upcomingAppts = allAppointments.filter((a) => String(a.appointment_date) >= today);
  const pastAppts = allAppointments.filter((a) => String(a.appointment_date) < today).slice(0, 5);

  return {
    as_of: today,
    profile,
    diagnoses,
    medications: {
      active: medList,
      adherence_last_30d: {
        active_meds: Number(adherenceRow.active_meds || 0),
        taken_doses: Number(adherenceRow.taken_doses || 0),
      },
    },
    labs: {
      latest: labsLatest,
      history: labsHistory,
      note: "Use latest.<canonical>.result for current values. For derived metrics like Non-HDL = Total Cholesterol − HDL, both come from labs.latest. Units are already canonical.",
    },
    vitals_recent: {
      window_days: vitalsDays,
      rows: recentVitals,
    },
    symptoms_recent: {
      window_days: symptomsDays,
      rows: recentSymptoms,
    },
    appointments: {
      upcoming: upcomingAppts,
      recent_past: pastAppts,
    },
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

  // Pull today's (IST) taken doses so each scheduled med can be flagged
  // taken/missed — the model needs this to know what's still pending and
  // avoid recommending a dose the patient has already taken.
  const { rows: todayLogs } = await pool.query(
    `SELECT medication_name, medication_dose, dose_time, status
       FROM patient_med_log
      WHERE patient_id = $1
        AND log_date = (NOW() AT TIME ZONE 'Asia/Kolkata')::date
        AND status = 'taken'`,
    [patientId],
  );
  const norm = (s) =>
    String(s || "")
      .trim()
      .toLowerCase();
  const takenByName = new Map();
  for (const log of todayLogs) {
    const key = norm(log.medication_name);
    if (!key) continue;
    if (!takenByName.has(key)) takenByName.set(key, []);
    takenByName.get(key).push({ dose_time: log.dose_time, status: log.status });
  }

  const grouped = {};
  for (const m of active) {
    const slot = classifyTimingSlot(m.when_to_take || m.timing);
    if (!grouped[slot]) grouped[slot] = [];
    const takenEntries = takenByName.get(norm(m.name)) || [];
    grouped[slot].push({
      name: m.name,
      dose: m.dose,
      frequency: m.frequency,
      when_to_take: m.when_to_take,
      timing: m.timing,
      taken_today: takenEntries.length > 0,
      taken_doses: takenEntries.map((t) => t.dose_time).filter(Boolean),
    });
  }
  // Slot → approximate clock time (IST). Mirrors the SYSTEM prompt mapping
  // so the agent and tool agree on what counts as past / upcoming.
  const SLOT_HOUR = {
    fasting: 7,
    before_breakfast: 7,
    after_breakfast: 9,
    before_lunch: 12.5,
    after_lunch: 14,
    before_dinner: 19,
    after_dinner: 21,
    bedtime: 22.5,
    anytime: -1,
  };
  const istNow = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  const istHourFloat = istNow.getHours() + istNow.getMinutes() / 60;
  const istStr = `${String(istNow.getHours()).padStart(2, "0")}:${String(
    istNow.getMinutes(),
  ).padStart(2, "0")}`;

  const slotsOut = Object.entries(grouped).map(([slot, items]) => {
    const slotHour = SLOT_HOUR[slot] ?? -1;
    const isPast = slotHour > 0 && istHourFloat > slotHour + 0.5; // 30-min grace
    const isUpcoming = slotHour > 0 && !isPast;
    return {
      slot,
      label: TIME_SLOT_LABELS[slot] || slot,
      slot_clock:
        slotHour > 0
          ? `${String(Math.floor(slotHour)).padStart(2, "0")}:${String(
              Math.round((slotHour % 1) * 60),
            ).padStart(2, "0")}`
          : "any time",
      is_past: isPast,
      is_upcoming: isUpcoming,
      meds: items.map((m) => ({
        ...m,
        status: m.taken_today ? "taken" : isPast ? "overdue" : isUpcoming ? "due" : "scheduled",
      })),
    };
  });

  return {
    now_ist: istStr,
    note:
      "STRICT: only meds with status='taken' have a real adherence row for today. " +
      "status='overdue' = slot time already passed today with no log. " +
      "status='due' = upcoming slot today. " +
      "Never claim a med was taken unless its status is 'taken'. " +
      "When answering 'kab dawai leni hai?', list ALL slots that are still due or overdue today — do not skip evening/night doses.",
    slots: slotsOut,
  };
}

const MAX_SQL_ROWS = 200;
const MAX_SQL_JSON_BYTES = 60_000;

async function runPatientSql(pool, patientId, sql) {
  const check = validatePatientSql(sql);
  if (!check.ok)
    return { error: check.error, hint: "Fix the query and call run_patient_sql again." };

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL TRANSACTION READ ONLY");
    // await client.query("SET LOCAL statement_timeout = '5s'");
    await client.query("SET LOCAL lock_timeout = '2s'");
    const result = await client.query({ text: sql, values: [patientId] });
    await client.query("ROLLBACK");

    const rows = Array.isArray(result.rows) ? result.rows : [];
    const truncated = rows.length > MAX_SQL_ROWS;
    let payloadRows = truncated ? rows.slice(0, MAX_SQL_ROWS) : rows;

    // Hard byte cap so a wide-column row set can't blow the tool_result
    // budget. Drop rows from the tail until we fit.
    let json = JSON.stringify(payloadRows);
    let byteTruncated = false;
    while (json.length > MAX_SQL_JSON_BYTES && payloadRows.length > 1) {
      payloadRows = payloadRows.slice(0, Math.max(1, Math.floor(payloadRows.length / 2)));
      json = JSON.stringify(payloadRows);
      byteTruncated = true;
    }

    return {
      ok: true,
      row_count: rows.length,
      returned: payloadRows.length,
      truncated: truncated || byteTruncated,
      rows: payloadRows,
    };
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch (_) {}
    return {
      error: String(err?.message || err).slice(0, 500),
      hint: "Check column names against the schema in the tool description, then retry.",
    };
  } finally {
    client.release();
  }
}

// ── create_health_log executor ──────────────────────────────────────────
// Direct DB write used when the patient explicitly confirms a save (or
// phrases the request as a direct "log X now"). Returns { ok, saved } or
// { ok: false, error } which the model reads as the tool_result to phrase
// a confirmation message in respond_to_patient.
async function executeCreateHealthLog(pool, patientId, input) {
  const today = new Date().toISOString().slice(0, 10);
  const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  const logDate =
    typeof input.date === "string" && ISO_DATE_RE.test(input.date) ? input.date : today;

  const type = String(input.type || "").trim();
  const v1 = String(input.value1 ?? "").trim();
  const v2 = String(input.value2 ?? "").trim();
  const context = String(input.context ?? "").trim();

  // ── Vitals ──────────────────────────────────────────────────────────
  if (type === "BP") {
    const systolic = Number(v1);
    const diastolic = Number(v2);
    if (!Number.isFinite(systolic) || systolic <= 0)
      return { ok: false, error: "value1 (systolic mmHg) must be a positive number." };
    if (!Number.isFinite(diastolic) || diastolic <= 0)
      return { ok: false, error: "value2 (diastolic mmHg) must be a positive number." };
    await pool.query(
      `INSERT INTO patient_vitals_log (patient_id, recorded_date, bp_systolic, bp_diastolic)
       VALUES ($1, $2, $3, $4)`,
      [patientId, logDate, systolic, diastolic],
    );
    return { ok: true, saved: { type, systolic, diastolic, date: logDate } };
  }

  if (type === "Sugar") {
    const rbs = Number(v1);
    if (!Number.isFinite(rbs) || rbs <= 0)
      return { ok: false, error: "value1 (sugar mg/dL) must be a positive number." };
    const mealType = (context || "Random").slice(0, 50);
    await pool.query(
      `INSERT INTO patient_vitals_log (patient_id, recorded_date, rbs, meal_type)
       VALUES ($1, $2, $3, $4)`,
      [patientId, logDate, rbs, mealType],
    );
    return { ok: true, saved: { type, rbs, meal_type: mealType, date: logDate } };
  }

  if (type === "Weight") {
    const weightKg = Number(v1);
    if (!Number.isFinite(weightKg) || weightKg <= 0)
      return { ok: false, error: "value1 (weight kg) must be a positive number." };
    await pool.query(
      `INSERT INTO patient_vitals_log (patient_id, recorded_date, weight_kg)
       VALUES ($1, $2, $3)`,
      [patientId, logDate, weightKg],
    );
    return { ok: true, saved: { type, weight_kg: weightKg, date: logDate } };
  }

  // ── Named lab types ──────────────────────────────────────────────────
  const NAMED_LAB_META = {
    HbA1c: { testName: "HbA1c", canonicalName: "hba1c", unit: "%" },
    LDL: { testName: "LDL Cholesterol", canonicalName: "ldl", unit: "mg/dL" },
    TSH: { testName: "TSH", canonicalName: "tsh", unit: "µIU/mL" },
    Haemoglobin: { testName: "Haemoglobin", canonicalName: "haemoglobin", unit: "g/dL" },
    eGFR: { testName: "eGFR", canonicalName: "egfr", unit: "mL/min" },
  };
  if (NAMED_LAB_META[type]) {
    const meta = NAMED_LAB_META[type];
    const numeric = Number(v1);
    if (!Number.isFinite(numeric) || numeric <= 0)
      return { ok: false, error: `value1 must be a positive number for ${type}.` };
    await pool.query(
      `INSERT INTO lab_results
         (patient_id, test_date, test_name, canonical_name, result, result_text, unit, source)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'agent')`,
      [patientId, logDate, meta.testName, meta.canonicalName, numeric, v1, meta.unit],
    );
    return {
      ok: true,
      saved: { type, test_name: meta.testName, result: numeric, unit: meta.unit, date: logDate },
    };
  }

  // ── Generic Lab (Vitamin D, B12, T3, T4, Creatinine, HDL, FBS, etc.) ──
  if (type === "Lab") {
    const testName = String(input.test_name || "").trim();
    if (!testName) return { ok: false, error: "test_name is required for type='Lab'." };
    const numeric = Number(v1);
    if (!Number.isFinite(numeric) || numeric <= 0)
      return { ok: false, error: "value1 must be a positive number." };
    const unit = String(input.unit || "").trim();
    const refRange = String(input.ref_range || "").trim();
    const canonicalName = String(input.canonical_name || testName)
      .toLowerCase()
      .replace(/\s+/g, "_")
      .slice(0, 100);
    await pool.query(
      `INSERT INTO lab_results
         (patient_id, test_date, test_name, canonical_name, result, result_text, unit, ref_range, source)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'agent')`,
      [
        patientId,
        logDate,
        testName.slice(0, 200),
        canonicalName,
        numeric,
        v1,
        unit.slice(0, 50) || null,
        refRange.slice(0, 100) || null,
      ],
    );
    return {
      ok: true,
      saved: { type: "Lab", test_name: testName, result: numeric, unit, date: logDate },
    };
  }

  // ── Symptom ─────────────────────────────────────────────────────────
  if (type === "Symptom") {
    if (!v1) return { ok: false, error: "value1 (symptom name) is required." };
    const severity = v2 && Number.isFinite(Number(v2)) ? Number(v2) : null;
    const bodyArea = (context || "General").slice(0, 100);
    await pool.query(
      `INSERT INTO patient_symptom_log
         (patient_id, log_date, symptom, severity, body_area, context, source)
       VALUES ($1, $2, $3, $4, $5, $6, 'agent')`,
      [patientId, logDate, v1.slice(0, 200), severity, bodyArea, "Tracked via Genie"],
    );
    return { ok: true, saved: { type, symptom: v1, severity, date: logDate } };
  }

  // ── Food ─────────────────────────────────────────────────────────────
  if (type === "Food") {
    if (!v1) return { ok: false, error: "value1 (food description) is required." };
    const mealType = (context || "snack").toLowerCase().slice(0, 30);
    await pool.query(
      `INSERT INTO patient_meal_log
         (patient_id, meal_type, description, log_date)
       VALUES ($1, $2, $3, $4)`,
      [patientId, mealType, v1.slice(0, 200), logDate],
    );
    return { ok: true, saved: { type, description: v1, meal_type: mealType, date: logDate } };
  }

  return { ok: false, error: `Unknown type: ${type}` };
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
        case "med_adherence":
          return qMedAdherence(pool, scribePatientId, args);
        default:
          return { error: `Unknown scope: ${args.scope}` };
      }
    }
    case "get_progress_summary":
      return summariseProgress(pool, scribePatientId, args);
    case "get_full_patient_context":
      return getFullPatientContext(pool, scribePatientId, args);
    case "get_medication_schedule":
      return getMedSchedule(pool, scribePatientId);
    case "get_prescriptions": {
      const limit = Math.min(Math.max(args.limit || (args.scope === "latest" ? 1 : 5), 1), 20);
      const { rows } = await pool.query(
        `SELECT id, doc_type, title, file_name, doc_date, source, notes,
                storage_path, file_url, consultation_id, created_at
           FROM documents
          WHERE patient_id = $1 AND doc_type = 'prescription'
          ORDER BY doc_date DESC NULLS LAST, created_at DESC, id DESC
          LIMIT ${limit}`,
        [scribePatientId],
      );
      if (args.scope === "latest") return rows[0] || null;
      return rows;
    }
    case "get_appointments": {
      const raw = await qAppointments(pool, scribePatientId, { limit: args.limit || 20 });
      // Filter out no-show appointments — the patient never attended, so
      // they shouldn't surface in history or upcoming lists.
      const all = raw.filter((a) => String(a.status || "").toLowerCase() !== "no_show");
      const today = new Date().toISOString().slice(0, 10);

      // Mirror /visit's post-SQL dedupe (visit.js:593–600) — drop rows that
      // share visit_date+status with one already kept. Without this the
      // panel's "6 Visits" count and the tool's row count diverge.
      const dedupeByDateStatus = (rows) => {
        const seen = new Set();
        return rows.filter((r) => {
          const key = `${String(r.appointment_date || "").slice(0, 10)}|${r.status || ""}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
      };

      const pastRows = dedupeByDateStatus(all.filter((a) => String(a.appointment_date) < today));
      const futureRows = all
        .filter((a) => String(a.appointment_date) >= today)
        .sort((a, b) => String(a.appointment_date).localeCompare(String(b.appointment_date)));

      // For future scheduled rows the rich history fields don't apply; strip
      // them, but enrich with the follow-up plan from the most recent past
      // consultation (matches VisitPlan.jsx's "Next Visit Scheduled" source).
      const latestPastFollowUp =
        pastRows.find((r) => r.follow_up && (r.follow_up.date || r.follow_up.when))?.follow_up ||
        null;
      const stripFuture = (a) => {
        const { diagnoses, medications, assessment_summary, advice, ...rest } = a;
        const follow_up = rest.follow_up || latestPastFollowUp;
        return {
          ...rest,
          follow_up,
          follow_up_date: follow_up?.date || follow_up?.when || null,
        };
      };

      if (args.scope === "upcoming") return futureRows.map(stripFuture);
      if (args.scope === "past") return pastRows;
      if (args.scope === "next") return futureRows[0] ? stripFuture(futureRows[0]) : null;
      return all;
    }
    case "create_health_log":
      return executeCreateHealthLog(pool, scribePatientId, input);
    case "run_patient_sql":
      return runPatientSql(pool, scribePatientId, input?.sql);
    default:
      return { error: `Unknown tool: ${name}` };
  }
}

// ── Client-action mapping for UI tools ─────────────────────────────────
// Returns { clientAction, ack } where ack is the JSON the model sees as the
// tool_result so it can phrase a closing sentence to the patient.
//
// Native modal types the RN client knows how to render directly. Anything
// else gets routed through the generic 'Lab' modal with test_name/unit
// auto-derived from the LAB_TYPE_MAP below, so the model can pick any of
// the extended enum values without us shipping a new RN build first.
const NATIVE_LOG_TYPES = new Set([
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
]);

// type → {test_name, unit, canonical_name, ref_range?} for every extended
// lab/vital the propose_log enum now accepts. Used to flatten unknown enum
// values into the universal Lab modal.
const LAB_TYPE_MAP = {
  Height: { test_name: "Height", unit: "cm", canonical_name: "height" },
  Temperature: { test_name: "Temperature", unit: "°F", canonical_name: "temperature" },
  HeartRate: { test_name: "Heart Rate", unit: "bpm", canonical_name: "heart_rate" },
  SpO2: { test_name: "SpO2", unit: "%", canonical_name: "spo2" },
  RespiratoryRate: {
    test_name: "Respiratory Rate",
    unit: "breaths/min",
    canonical_name: "respiratory_rate",
  },
  FBS: { test_name: "Fasting Blood Sugar", unit: "mg/dL", canonical_name: "fbs" },
  PPBS: { test_name: "Postprandial Blood Sugar", unit: "mg/dL", canonical_name: "ppbs" },
  RandomSugar: { test_name: "Random Blood Sugar", unit: "mg/dL", canonical_name: "rbs" },
  HDL: { test_name: "HDL", unit: "mg/dL", canonical_name: "hdl" },
  TotalCholesterol: {
    test_name: "Total Cholesterol",
    unit: "mg/dL",
    canonical_name: "total_cholesterol",
  },
  Triglycerides: { test_name: "Triglycerides", unit: "mg/dL", canonical_name: "triglycerides" },
  NonHDL: { test_name: "Non-HDL Cholesterol", unit: "mg/dL", canonical_name: "non_hdl" },
  VLDL: { test_name: "VLDL", unit: "mg/dL", canonical_name: "vldl" },
  FreeT3: { test_name: "Free T3", unit: "pg/mL", canonical_name: "ft3" },
  FreeT4: { test_name: "Free T4", unit: "ng/dL", canonical_name: "ft4" },
  TotalT3: { test_name: "Total T3", unit: "ng/dL", canonical_name: "t3" },
  TotalT4: { test_name: "Total T4", unit: "µg/dL", canonical_name: "t4" },
  Creatinine: { test_name: "Creatinine", unit: "mg/dL", canonical_name: "creatinine" },
  UricAcid: { test_name: "Uric Acid", unit: "mg/dL", canonical_name: "uric_acid" },
  Urea: { test_name: "Urea", unit: "mg/dL", canonical_name: "urea" },
  BUN: { test_name: "Blood Urea Nitrogen", unit: "mg/dL", canonical_name: "bun" },
  Sodium: { test_name: "Sodium", unit: "mmol/L", canonical_name: "sodium" },
  Potassium: { test_name: "Potassium", unit: "mmol/L", canonical_name: "potassium" },
  Chloride: { test_name: "Chloride", unit: "mmol/L", canonical_name: "chloride" },
  Calcium: { test_name: "Calcium", unit: "mg/dL", canonical_name: "calcium" },
  Phosphorus: { test_name: "Phosphorus", unit: "mg/dL", canonical_name: "phosphorus" },
  Magnesium: { test_name: "Magnesium", unit: "mg/dL", canonical_name: "magnesium" },
  VitaminD: { test_name: "Vitamin D", unit: "ng/mL", canonical_name: "vitd" },
  VitaminB12: { test_name: "Vitamin B12", unit: "pg/mL", canonical_name: "b12" },
  Folate: { test_name: "Folate", unit: "ng/mL", canonical_name: "folate" },
  Iron: { test_name: "Iron", unit: "µg/dL", canonical_name: "iron" },
  Ferritin: { test_name: "Ferritin", unit: "ng/mL", canonical_name: "ferritin" },
  TIBC: { test_name: "TIBC", unit: "µg/dL", canonical_name: "tibc" },
  TransferrinSat: {
    test_name: "Transferrin Saturation",
    unit: "%",
    canonical_name: "transferrin_sat",
  },
  ALT: { test_name: "ALT (SGPT)", unit: "U/L", canonical_name: "alt" },
  AST: { test_name: "AST (SGOT)", unit: "U/L", canonical_name: "ast" },
  ALP: { test_name: "Alkaline Phosphatase", unit: "U/L", canonical_name: "alp" },
  GGT: { test_name: "GGT", unit: "U/L", canonical_name: "ggt" },
  Bilirubin: { test_name: "Total Bilirubin", unit: "mg/dL", canonical_name: "bilirubin_total" },
  DirectBilirubin: {
    test_name: "Direct Bilirubin",
    unit: "mg/dL",
    canonical_name: "bilirubin_direct",
  },
  Albumin: { test_name: "Albumin", unit: "g/dL", canonical_name: "albumin" },
  Globulin: { test_name: "Globulin", unit: "g/dL", canonical_name: "globulin" },
  TotalProtein: { test_name: "Total Protein", unit: "g/dL", canonical_name: "total_protein" },
  WBC: { test_name: "WBC Count", unit: "10³/µL", canonical_name: "wbc" },
  RBC: { test_name: "RBC Count", unit: "10⁶/µL", canonical_name: "rbc" },
  Platelets: { test_name: "Platelet Count", unit: "10³/µL", canonical_name: "platelets" },
  PCV: { test_name: "PCV / Hematocrit", unit: "%", canonical_name: "pcv" },
  MCV: { test_name: "MCV", unit: "fL", canonical_name: "mcv" },
  MCH: { test_name: "MCH", unit: "pg", canonical_name: "mch" },
  MCHC: { test_name: "MCHC", unit: "g/dL", canonical_name: "mchc" },
  RDW: { test_name: "RDW", unit: "%", canonical_name: "rdw" },
  ESR: { test_name: "ESR", unit: "mm/hr", canonical_name: "esr" },
  CRP: { test_name: "CRP", unit: "mg/L", canonical_name: "crp" },
  Insulin: { test_name: "Fasting Insulin", unit: "µIU/mL", canonical_name: "insulin" },
  CPeptide: { test_name: "C-Peptide", unit: "ng/mL", canonical_name: "c_peptide" },
};

export function buildClientAction(name, input) {
  if (name === "propose_log") {
    // Flatten any extended enum value the RN client doesn't render natively
    // into the generic Lab modal, pre-filling test_name/unit/canonical_name
    // from LAB_TYPE_MAP so it still opens with the right label.
    let effectiveType = input.type;
    const extra = {};
    if (!NATIVE_LOG_TYPES.has(effectiveType) && LAB_TYPE_MAP[effectiveType]) {
      const m = LAB_TYPE_MAP[effectiveType];
      effectiveType = "Lab";
      extra.test_name = input.test_name || m.test_name;
      extra.unit = input.unit || m.unit;
      if (input.ref_range) extra.ref_range = input.ref_range;
      extra.canonical_name = input.canonical_name || m.canonical_name;
    }
    const ca = {
      type: "open_log_modal",
      logType: effectiveType,
      v1: input.value1 ?? "",
      v2: input.value2 ?? "",
      context: input.context ?? "",
    };
    // Optional ISO date forwarded to the modal so the patient can backdate
    // a log (e.g. "log yesterday's BP 140/90"). Only accept YYYY-MM-DD; the
    // modal will fall back to today when missing or malformed.
    if (typeof input.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(input.date)) {
      ca.date = input.date;
    }
    // Generic-lab card: forward AI-supplied metadata so the app can render
    // the right label, unit, and (optional) ref-range for tests that aren't
    // in the dedicated enum (Vit D, B12, T3, T4, Creatinine, …). Metadata
    // can come from the model (when type='Lab') or from LAB_TYPE_MAP (when
    // we flattened an extended enum value above).
    if (effectiveType === "Lab") {
      const test_name = extra.test_name ?? input.test_name;
      const unit = extra.unit ?? input.unit;
      const ref_range = extra.ref_range ?? input.ref_range;
      const canonical_name = extra.canonical_name ?? input.canonical_name;
      if (test_name) ca.test_name = String(test_name);
      if (unit) ca.unit = String(unit);
      if (ref_range) ca.ref_range = String(ref_range);
      if (canonical_name) ca.canonical_name = String(canonical_name);
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
  if (name === "open_document") {
    const ca = {
      type: "open_document",
      document_id: input.document_id,
      file_url: input.file_url,
      title: input.title,
      doc_type: input.doc_type || "prescription",
      doc_date: input.doc_date || null,
    };
    return {
      clientAction: ca,
      ack: {
        status: "queued_for_client",
        note: "The document viewer will open in chat with this file.",
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
  if (name === "open_reception_chat") {
    const ca = {
      type: "open_reception_chat",
      seed: input.seed ?? "",
      topic: input.topic ?? "general",
    };
    return {
      clientAction: ca,
      ack: {
        status: "queued_for_client",
        note: "Reception chat card will appear inline in the patient's chat.",
      },
    };
  }
  if (name === "propose_med_dose") {
    const ca = {
      type: "open_med_log_sheet",
      medication_name: String(input.medication_name || "").trim(),
      dose: input.dose ?? null,
      slot: input.slot ?? null,
      status: input.status === "missed" ? "missed" : "taken",
      date: input.date ?? null,
    };
    return {
      clientAction: ca,
      ack: { status: "queued_for_client", note: "Med-log confirmation sheet will open." },
    };
  }
  if (name === "propose_med_reminder") {
    const ca = {
      type: "open_med_reminder_sheet",
      medication_name: String(input.medication_name || "").trim(),
      times: Array.isArray(input.times) ? input.times.filter((t) => typeof t === "string") : [],
      enable: input.enable !== false,
    };
    return {
      clientAction: ca,
      ack: { status: "queued_for_client", note: "Reminder editor will open for this medicine." },
    };
  }
  if (name === "propose_refill") {
    const ca = {
      type: "open_refill_sheet",
      items: Array.isArray(input.items)
        ? input.items
            .filter((it) => it && typeof it.medication_name === "string")
            .map((it) => ({
              medication_name: it.medication_name.trim(),
              dose: it.dose ?? null,
              quantity: it.quantity ?? null,
            }))
        : [],
      notes: input.notes ?? null,
    };
    return {
      clientAction: ca,
      ack: { status: "queued_for_client", note: "Refill request modal will open pre-selected." },
    };
  }
  if (name === "propose_pre_visit_symptoms") {
    const ca = {
      type: "open_pre_symptom_sheet",
      appointment_id: input.appointment_id ?? null,
      symptoms: Array.isArray(input.symptoms)
        ? input.symptoms.filter((s) => typeof s === "string" && s.trim()).map((s) => s.trim())
        : [],
      note: input.note ?? null,
    };
    return {
      clientAction: ca,
      ack: { status: "queued_for_client", note: "Pre-visit symptom sheet will open." },
    };
  }
  if (name === "call_clinic") {
    // Server-resolved phone + name so the model can't fabricate digits.
    const phone = (process.env.HOSPITAL_PHONE || "").trim();
    const label = (process.env.HOSPITAL_NAME || "Gini Health").trim();
    const ca = {
      type: "call_clinic",
      phone,
      label,
    };
    return {
      clientAction: ca,
      ack: phone
        ? { status: "queued_for_client", note: "Inline call card will appear." }
        : {
            status: "missing_config",
            note: "HOSPITAL_PHONE is not configured on the server. The chip will not be rendered.",
          },
    };
  }
  return null;
}

export const UI_TOOL_NAMES = new Set([
  "propose_log",
  "open_doctor_chat",
  "open_reception_chat",
  "open_document",
  "classify_and_extract_attachment",
  "propose_med_dose",
  "propose_med_reminder",
  "propose_refill",
  "propose_pre_visit_symptoms",
  "call_clinic",
]);
export const FINAL_TOOL_NAME = "respond_to_patient";
