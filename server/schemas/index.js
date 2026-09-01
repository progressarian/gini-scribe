import { z } from "zod";
import { CATEGORIES, TRIAGE_FILTERS } from "../../shared/giniflowStatus.js";

// Canonical patient-facing "when to take" vocabulary. Must stay in sync
// with src/config/medicationTimings.js and the Postgres when_to_take_pill
// ENUM. The Zod transform below accepts arrays, comma-separated strings
// (legacy AI output), or null and normalises everything to a string array
// of validated pill labels.
const WHEN_TO_TAKE_PILLS = [
  "Fasting",
  "Before breakfast",
  "After breakfast",
  "Before lunch",
  "After lunch",
  "Before dinner",
  "After dinner",
  "At bedtime",
  "SOS only",
  "Any time",
];
const PILL_BY_LOWER = new Map(WHEN_TO_TAKE_PILLS.map((p) => [p.toLowerCase(), p]));

// Normalise whatever an insert path receives (AI raw string, legacy
// comma-separated string, JS array, or null) into a deduped array of valid
// pill labels — or null when nothing recognisable is left. Returning null
// for empty input lets COALESCE in upserts keep any existing value.
export function normalizeWhenToTake(v) {
  if (v == null) return null;
  const tokens = Array.isArray(v) ? v : String(v).split(",");
  const out = [];
  const seen = new Set();
  for (const raw of tokens) {
    const canonical = PILL_BY_LOWER.get(
      String(raw || "")
        .trim()
        .toLowerCase(),
    );
    if (canonical && !seen.has(canonical)) {
      seen.add(canonical);
      out.push(canonical);
    }
  }
  return out.length ? out : null;
}

const whenToTakeArr = z
  .union([z.array(z.string()), z.string()])
  .optional()
  .nullable()
  .transform((v) => {
    if (v == null) return null;
    const tokens = Array.isArray(v) ? v : String(v).split(",");
    const out = [];
    const seen = new Set();
    for (const raw of tokens) {
      const canonical = PILL_BY_LOWER.get(
        String(raw || "")
          .trim()
          .toLowerCase(),
      );
      if (canonical && !seen.has(canonical)) {
        seen.add(canonical);
        out.push(canonical);
      }
    }
    return out.length ? out : null;
  });

// ---- Reusable primitives ----
const optStr = z.string().optional().nullable();
const optNum = z
  .union([z.number(), z.string().transform(Number)])
  .optional()
  .nullable();
const optInt = z
  .union([z.number().int(), z.string().transform((v) => parseInt(v))])
  .optional()
  .nullable();
const optDate = z.string().optional().nullable(); // ISO date strings
const optBool = z.boolean().optional().nullable();

// ---- Auth ----
export const loginSchema = z.object({
  doctor_id: z.number({ required_error: "doctor_id is required" }),
  pin: z.string({ required_error: "PIN is required" }).min(1, "PIN is required"),
});

// ---- Patients ----
// A phone with letters in it is not a number anyone can ring — it is a typo or
// a paste of something else. Kept to that one rule rather than the strict
// 10-digit mobile the forms enforce, because the same schema guards edits to
// legacy records whose stored numbers are landlines or partial (26 today).
const phoneField = optStr.refine((v) => !v || !/[A-Za-z]/.test(v), {
  message: "Phone number cannot contain letters",
});

export const patientCreateSchema = z
  .object({
    name: optStr,
    phone: phoneField,
    dob: optDate,
    age: optInt,
    sex: z.enum(["Male", "Female", "Other"]).optional().nullable(),
    file_no: optStr,
    abha_id: optStr,
    health_id: optStr,
    aadhaar: optStr,
    govt_id: optStr,
    govt_id_type: optStr,
    email: optStr,
    address: optStr,
  })
  .passthrough();

// ---- Labs ----
export const labCreateSchema = z.object({
  test_name: z.string({ required_error: "test_name is required" }).min(1),
  result: z.union([z.string(), z.number()]),
  unit: optStr,
  flag: optStr,
  ref_range: optStr,
  test_date: optDate,
  consultation_id: optInt,
});

// ---- Consultations ----
const patientField = z
  .object({
    name: optStr,
    phone: optStr,
    fileNo: optStr,
    age: z.union([z.number(), z.string(), z.null()]).optional(),
    sex: optStr,
    abhaId: optStr,
    healthId: optStr,
    aadhaar: optStr,
    govtId: optStr,
    govtIdType: optStr,
    dob: optDate,
    address: optStr,
  })
  .passthrough();

const vitalsField = z
  .object({
    bp_sys: optNum,
    bp_dia: optNum,
    pulse: optNum,
    temp: optNum,
    spo2: optNum,
    weight: optNum,
    height: optNum,
    bmi: optNum,
    waist: optNum,
    body_fat: optNum,
    muscle_mass: optNum,
  })
  .passthrough()
  .optional()
  .nullable();

export const consultationCreateSchema = z
  .object({
    patient: patientField,
    vitals: vitalsField,
    moData: z.any().optional().nullable(),
    conData: z.any().optional().nullable(),
    moTranscript: optStr,
    conTranscript: optStr,
    quickTranscript: optStr,
    moName: optStr,
    conName: optStr,
    planEdits: z.any().optional().nullable(),
    moDoctorId: optInt,
    conDoctorId: optInt,
    visitDate: optDate,
  })
  .passthrough();

// ---- History import ----
export const historyCreateSchema = z
  .object({
    visit_date: z.string({ required_error: "visit_date is required" }),
    visit_type: optStr,
    doctor_name: optStr,
    specialty: optStr,
    vitals: vitalsField,
    diagnoses: z
      .array(
        z
          .object({
            id: optStr,
            label: optStr,
            status: optStr,
          })
          .passthrough(),
      )
      .optional()
      .nullable(),
    medications: z
      .array(
        z
          .object({
            name: z.string(),
            composition: optStr,
            dose: optStr,
            frequency: optStr,
            timing: optStr,
            when_to_take: whenToTakeArr,
            is_active: optBool,
            started_date: optDate,
          })
          .passthrough(),
      )
      .optional()
      .nullable(),
    labs: z
      .array(
        z
          .object({
            test_name: z.string(),
            result: z.union([z.string(), z.number()]).optional().nullable(),
            unit: optStr,
            flag: optStr,
            ref_range: optStr,
          })
          .passthrough(),
      )
      .optional()
      .nullable(),
  })
  .passthrough();

// ---- Documents ----
export const documentCreateSchema = z.object({
  doc_type: optStr,
  title: optStr,
  file_name: optStr,
  file_url: optStr,
  extracted_text: optStr,
  extracted_data: z.any().optional().nullable(),
  doc_date: optDate,
  source: optStr,
  uploaded_by_patient: z.boolean().optional(),
  notes: optStr,
  consultation_id: optInt,
});

export const fileUploadSchema = z.object({
  base64: z.string({ required_error: "base64 data is required" }).min(1),
  mediaType: z.string().optional(),
  fileName: z.string({ required_error: "fileName is required" }).min(1),
});

// ---- Appointments ----
export const appointmentCreateSchema = z.object({
  patient_id: optInt,
  patient_name: z.string({ required_error: "patient_name is required" }).min(1),
  file_no: optStr,
  phone: optStr,
  doctor_name: optStr,
  appointment_date: z
    .string({ required_error: "appointment_date is required" })
    .min(1, "Date is required"),
  time_slot: optStr,
  visit_type: z.enum(["OPD", "IPD", "Telehealth", "Follow-up", "Lab"]).optional().default("OPD"),
  notes: optStr,
  category: optStr,
  is_walkin: optBool,
  // Admin override for availability enforcement (else validate() strips it).
  force: optBool,
});

export const appointmentUpdateSchema = z.object({
  doctor_name: optStr,
  appointment_date: optDate,
  time_slot: optStr,
  visit_type: optStr,
  status: z
    .enum(["scheduled", "in-progress", "completed", "cancelled", "no_show"])
    .optional()
    .nullable(),
  notes: optStr,
  // Admin override for availability enforcement (else validate() strips it).
  force: optBool,
});

// ---- Messages ----
export const messageCreateSchema = z.object({
  message: z.string({ required_error: "message is required" }).min(1),
  sender_name: optStr,
  sender_role: optStr,
});

// Conversation-centric (2026-04-23)
// As of 2026-04-25, lab/reception messages may carry an attachment in place
// of (or alongside) text. message and attachment_path are individually
// optional, but at least one must be present.
export const CHAT_ATTACHMENT_MIMES = [
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/heic",
  "image/heif",
  "image/webp",
  "application/pdf",
];

export const conversationMessageSchema = z
  .object({
    message: z.string().max(4000).optional().nullable(),
    attachment_path: optStr,
    attachment_mime: z.enum(CHAT_ATTACHMENT_MIMES).optional().nullable(),
    attachment_name: optStr,
  })
  .refine(
    (v) =>
      (typeof v.message === "string" && v.message.trim().length > 0) ||
      (typeof v.attachment_path === "string" && v.attachment_path.length > 0),
    { message: "message or attachment_path is required" },
  )
  .refine(
    (v) =>
      !v.attachment_path || (typeof v.attachment_mime === "string" && v.attachment_mime.length > 0),
    { message: "attachment_mime is required when attachment_path is set" },
  );

export const conversationAttachmentSchema = z.object({
  base64: z.string({ required_error: "base64 data is required" }).min(1),
  mediaType: z.enum(CHAT_ATTACHMENT_MIMES, {
    required_error: "mediaType is required",
  }),
  fileName: z.string({ required_error: "fileName is required" }).min(1),
});

export const ensureConversationSchema = z.object({
  kind: z.enum(["doctor", "lab", "reception"]),
  doctor_id: optStr,
  doctor_name: optStr,
});

// ---- Clinical Reasoning ----
export const reasoningCreateSchema = z.object({
  patient_id: optInt,
  doctor_id: optInt,
  doctor_name: z.string({ required_error: "doctor_name is required" }).min(1),
  reasoning_text: z.string({ required_error: "reasoning_text is required" }).min(1),
  primary_condition: optStr,
  secondary_conditions: z.array(z.string()).optional().nullable(),
  reasoning_tags: z.array(z.string()).optional().nullable(),
  capture_method: z.enum(["text", "audio", "both"]).optional().default("text"),
  patient_context: optStr,
});

export const reasoningUpdateSchema = z.object({
  reasoning_text: optStr,
  primary_condition: optStr,
  secondary_conditions: z.array(z.string()).optional().nullable(),
  reasoning_tags: z.array(z.string()).optional().nullable(),
  capture_method: z.enum(["text", "audio", "both"]).optional().nullable(),
  audio_transcript: optStr,
  transcription_status: optStr,
});

export const audioUploadSchema = z.object({
  base64: z.string({ required_error: "base64 data is required" }).min(1),
  duration: optNum,
});

// ---- Rx Review Feedback ----
export const rxFeedbackCreateSchema = z.object({
  patient_id: z.number({ required_error: "patient_id is required" }),
  doctor_id: optInt,
  doctor_name: z.string({ required_error: "doctor_name is required" }).min(1),
  ai_rx_analysis: optStr,
  ai_model: optStr,
  agreement_level: z.string({ required_error: "agreement_level is required" }),
  feedback_text: optStr,
  correct_approach: optStr,
  reason_for_difference: optStr,
  disagreement_tags: z.array(z.string()).optional().nullable(),
  primary_condition: optStr,
  medications_involved: z.array(z.string()).optional().nullable(),
  severity: optStr,
});

export const rxAudioUploadSchema = z.object({
  base64: z.string({ required_error: "base64 data is required" }).min(1),
});

// ---- Medicine collection (pharmacy fulfillment) ----
const COLLECTION_STATUS = ["given", "not_given", "partial"];
const reasonRequired = (status, reason) =>
  status === "given" || !!(reason && String(reason).trim());

export const collectionMarkSchema = z
  .object({
    status: z.enum(COLLECTION_STATUS),
    reason: optStr, // out_of_stock | patient_declined | buying_outside | not_available | other
    qty_note: optStr,
    date: optDate,
    appointment_id: optInt,
  })
  .refine((v) => reasonRequired(v.status, v.reason), {
    message: "reason is required when not given / partial",
    path: ["reason"],
  });

export const collectionBulkSchema = z.object({
  date: optDate,
  items: z
    .array(
      z
        .object({
          medication_id: z.number({ required_error: "medication_id is required" }).int(),
          status: z.enum(COLLECTION_STATUS),
          reason: optStr,
          qty_note: optStr,
        })
        .refine((i) => reasonRequired(i.status, i.reason), {
          message: "reason is required for not-given / partial items",
          path: ["reason"],
        }),
    )
    .min(1, "at least one item is required"),
});

// ---- Doctor Management & Availability ----
// See docs/doctor-management/03-api-endpoints.md §9.

// Doctor working profile (available-by-default model). All fields optional.
//   off_weekdays  : weekdays NOT worked (0=Sun..6=Sat); default {Sunday}
//   work_start/end: clock-time working hours ("HH:MM"); null = all day
//   lunch_start/end: recurring daily lunch break ("HH:MM"); null = none
const optTime = z
  .string()
  .regex(/^\d{2}:\d{2}(:\d{2})?$/, "time must be HH:MM")
  .optional()
  .nullable();
// Overnight-aware: working hours may wrap past midnight (e.g. 17:00–01:00).
const _toMin = (t) => {
  if (!t) return null;
  const [h, m] = String(t).split(":").map(Number);
  return h * 60 + m;
};
const _within = (ws, we, t) => {
  if (ws == null || we == null || t == null) return true;
  let s = ws,
    e = we,
    x = t;
  if (e <= s) e += 1440; // overnight window
  if (x < s) x += 1440;
  return x >= s && x <= e; // inclusive (lunch bounds)
};
export const profileUpdateSchema = z
  .object({
    off_weekdays: z.array(z.number().int().min(0).max(6)).optional().default([]),
    work_start: optTime,
    work_end: optTime,
    lunch_start: optTime,
    lunch_end: optTime,
  })
  // Lunch must sit inside the working hours (when both are set) — wrap-aware.
  .refine(
    (v) => {
      const ws = _toMin(v.work_start);
      const we = _toMin(v.work_end);
      const ls = _toMin(v.lunch_start);
      const le = _toMin(v.lunch_end);
      if (ls == null || le == null || ws == null || we == null) return true;
      return _within(ws, we, ls) && _within(ws, we, le);
    },
    { message: "Lunch break must be within working hours", path: ["lunch_start"] },
  );

// Reject windows that start before today (no leave/emergency in the past).
const notPastStart = (v) => v.start_date >= new Date().toISOString().slice(0, 10);
const notPastStartOpts = { message: "Cannot select a past date", path: ["start_date"] };

export const unavailabilityCreateSchema = z
  .object({
    type: z.enum(["leave", "holiday"]).optional().default("leave"),
    start_date: z.string({ required_error: "start_date is required" }).min(1),
    end_date: z.string({ required_error: "end_date is required" }).min(1),
    slot_labels: z.array(z.string()).optional().nullable(),
    reason: optStr,
  })
  .refine((v) => v.end_date >= v.start_date, {
    message: "end_date must be >= start_date",
    path: ["end_date"],
  })
  .refine(notPastStart, notPastStartOpts);

// A break is a slot-scoped unavailability — slots are required.
export const breakCreateSchema = z
  .object({
    start_date: z.string({ required_error: "start_date is required" }).min(1),
    end_date: z.string({ required_error: "end_date is required" }).min(1),
    slot_labels: z.array(z.string().min(1)).min(1, "pick at least one slot"),
    reason: optStr,
  })
  .refine((v) => v.end_date >= v.start_date, {
    message: "end_date must be >= start_date",
    path: ["end_date"],
  })
  .refine(notPastStart, notPastStartOpts);

export const unavailabilityUpdateSchema = z.object({
  start_date: optDate,
  end_date: optDate,
  slot_labels: z.array(z.string()).optional().nullable(),
  reason: optStr,
  status: z.enum(["active", "cancelled"]).optional(),
});

export const emergencyLeaveSchema = z
  .object({
    start_date: z.string({ required_error: "start_date is required" }).min(1),
    end_date: z.string({ required_error: "end_date is required" }).min(1),
    slot_labels: z.array(z.string()).optional().nullable(),
    from_now: optBool,
    reason: optStr,
  })
  .refine((v) => v.end_date >= v.start_date, {
    message: "end_date must be >= start_date",
    path: ["end_date"],
  })
  .refine(notPastStart, notPastStartOpts);

export const reassignBulkSchema = z.object({
  trigger: optStr,
  unavailability_id: optInt,
  reason: optStr,
  moves: z
    .array(
      z.object({
        appointment_id: z.number({ required_error: "appointment_id is required" }).int(),
        to_doctor_id: z.number({ required_error: "to_doctor_id is required" }).int(),
        to_doctor_name: z.string({ required_error: "to_doctor_name is required" }).min(1),
      }),
    )
    .min(1, "at least one move is required"),
});

export const reassignSingleSchema = z.object({
  to_doctor_id: z.number({ required_error: "to_doctor_id is required" }).int(),
  to_doctor_name: z.string({ required_error: "to_doctor_name is required" }).min(1),
  reason: optStr,
  trigger: optStr,
});

// ── Gini Flow (docs/gini-flow/) ─────────────────────────────────────────────
// The board's date is optional and defaults to the IST today. It is validated
// rather than pattern-matched in the route so a malformed value returns 400
// instead of silently showing today's board under yesterday's heading.
export const giniflowDateQuerySchema = z.object({
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD")
    .refine((d) => !Number.isNaN(Date.parse(d)), "date is not a real date")
    .optional(),
});

export const giniflowSearchQuerySchema = z.object({
  q: z.string().trim().min(2, "search needs at least 2 characters").max(60),
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD")
    .optional(),
});

// Vitals are clinical numbers: reject anything outside a physiologically
// plausible range rather than storing a typo that a doctor may later act on.
export const giniflowVitalsSchema = z.object({
  weight: z.number().min(1).max(400).nullish(),
  height: z.number().min(30).max(260).nullish(),
  bpSys: z.number().int().min(50).max(300).nullish(),
  bpDia: z.number().int().min(20).max(200).nullish(),
  pulse: z.number().int().min(20).max(250).nullish(),
  spo2: z.number().int().min(50).max(100).nullish(),
  temp: z.number().min(90).max(115).nullish(),
  source: z.enum(["manual", "voice"]).default("manual"),
});

export const giniflowPaymentSchema = z.object({
  method: z.enum(["paid", "insurance_claim", "claim_approved"]).default("paid"),
});

// Reception's arrivals tab: the same day + optional search shape the board's
// own search uses, so a receptionist's query behaves identically on both screens.
export const giniflowArrivalsQuerySchema = giniflowDateQuerySchema.extend({
  q: z.string().trim().max(60).optional(),
});

// Cancelling is visible to every other station, so it has to say why — the same
// rule blocking a visit has.
export const giniflowCancelSchema = z.object({
  reason: z.string().trim().min(2, "a cancellation needs a reason").max(200),
});

export const giniflowWalkInSchema = z.object({
  patientId: z.coerce.number().int().positive(),
  appointmentId: z.coerce.number().int().positive().nullish(),
  force: z.boolean().optional(),
});

export const giniflowSampleSchema = z.object({
  to: z.enum(["paid", "sample_collected", "processing", "results_ready", "uploaded"]),
  reportUrl: z.string().url().max(2000).nullish(),
});

export const giniflowReportSchema = z.object({
  base64: z.string().min(1),
  fileName: z.string().max(200).optional(),
  mediaType: z.string().max(120).optional(),
});

export const giniflowPlanSchema = z.object({
  plan: z.string().max(20000),
  source: z.enum(["typed", "voice"]).default("typed"),
});

export const giniflowProposalSchema = z.object({
  medicineName: z.string().min(1).max(200),
  fromDose: z.string().max(100).nullish(),
  toDose: z.string().max(100).nullish(),
  reason: z.string().max(500).nullish(),
  changeType: z.enum(["continued", "changed", "new", "stopped", "paused"]).default("changed"),
});

// The MO queue also searches, and the search runs in Postgres — see QUEUE_SQL.
export const giniflowMoQueueQuerySchema = giniflowDateQuerySchema.extend({
  q: z.string().trim().max(60).optional(),
});

export const giniflowOrderTestsSchema = z.object({
  urgency: z.enum(["today", "tomorrow", "next_visit"]),
  tests: z.array(z.string().min(1).max(120)).min(1).max(40),
});

export const giniflowSlaUpdateSchema = z.object({
  budgets: z
    .array(
      z.object({
        station: z.string().min(1),
        budgetMinutes: z.number().int().positive().max(600),
      }),
    )
    .min(1),
});

// The reason is optional, unlike a block's (GF-18): an urgent patient is often
// self-evident at the desk, and a required sentence would only produce empty
// ones. It is dropped when the priority returns to normal.
export const giniflowPrioritySchema = z.object({
  priority: z.enum(["urgent", "high", "normal"]),
  reason: z.string().trim().max(200).nullish(),
});

// The column's full order, top to bottom. A cap keeps a malformed client from
// sending an unbounded array into the UNNEST — no real column holds 200 people.
export const giniflowReorderSchema = z.object({
  visitIds: z.array(z.string().uuid()).min(1).max(200),
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD")
    .optional(),
});

// The lab track is not a point in the chain, so it is not a drop target. The
// service checks column adjacency on top of this: the enum says which columns
// exist, not which of them this patient may be moved to.
export const giniflowMoveSchema = z.object({
  column: z.enum(["checked_in", "vitals", "sd", "wait_doctor", "doctor", "pharmacy", "done"]),
});

// ── Gini Flow · consultant station (docs/gini-flow/13-CONSULTANT-STATION-PLAN.md)
export const giniflowDoctorQueueQuerySchema = z.object({
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD")
    .optional(),
  // "mine" is the signed-in consultant's own patients; "all" is every
  // consultant's, for the day one clinician covers another's list.
  scope: z.enum(["mine", "all"]).optional(),
  q: z.string().trim().max(60).optional(),
});

// Goals are structured rather than prose: they are what the NEXT visit's
// in-control / worse classifier measures against, so they must be readable by a
// machine as well as by the patient.
export const giniflowCarePlanSchema = z.object({
  treatment: z.string().max(4000).nullish(),
  lifestyle: z.string().max(4000).nullish(),
  internalNote: z.string().max(4000).nullish(),
  nextVisitDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD")
    .nullish(),
  nextVisitInterval: z.string().max(40).nullish(),
  goals: z
    .array(
      z.object({
        test: z.string().min(1).max(60),
        target: z.string().min(1).max(40),
        unit: z.string().max(20).optional(),
      }),
    )
    .max(12)
    .optional(),
  source: z.enum(["typed", "voice"]).optional(),
});

// A rejection needs a reason for the same reason a block does (GF-18): the MO
// who proposed the change has to be able to see why it was turned down.
export const giniflowProposalDecisionSchema = z
  .object({
    status: z.enum(["approved", "adjusted", "rejected"]),
    adjustedDose: z.string().max(80).nullish(),
    note: z.string().max(300).nullish(),
  })
  .refine((v) => v.status !== "rejected" || (v.note && v.note.trim()), {
    message: "Rejecting a proposal needs a reason",
    path: ["note"],
  })
  .refine((v) => v.status !== "adjusted" || (v.adjustedDose && v.adjustedDose.trim()), {
    message: "Adjusting a proposal needs the dose you want instead",
    path: ["adjustedDose"],
  });

// ── Gini Flow · consultant prescription (14-CONSULTANT-PRESCRIPTION-PLAN.md) ──
const TIMING_CATEGORY = z.enum([
  "before_breakfast",
  "with_breakfast",
  "after_breakfast",
  "before_lunch",
  "with_lunch",
  "after_lunch",
  "evening",
  "before_dinner",
  "with_dinner",
  "after_dinner",
  "bedtime",
  "with_meals",
  "sos",
  "weekly",
  "fortnightly",
]);

const CLOCK_TIME = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "time must be HH:MM");

export const giniflowRxItemSchema = z.object({
  medicineName: z.string().trim().min(1).max(200),
  sourceMedicationId: z.number().int().positive().nullish(),
  pharmacyMatch: z.string().max(200).nullish(),
  composition: z.string().max(300).nullish(),
  dose: z.string().max(100).nullish(),
  previousDose: z.string().max(100).nullish(),
  frequency: z.string().max(60).nullish(),
  timing: z.string().max(100).nullish(),
  timingCategory: TIMING_CATEGORY.nullish(),
  timeOfDay: CLOCK_TIME.nullish(),
  route: z.string().max(40).nullish(),
  form: z.string().max(60).nullish(),
  duration: z.string().max(60).nullish(),
  reason: z.string().max(300).nullish(),
  patientInstruction: z.string().max(400).nullish(),
  drugClass: z.string().max(100).nullish(),
  changeType: z.enum(["continued", "changed", "new", "stopped", "paused"]).optional(),
});

export const giniflowRxItemPatchSchema = giniflowRxItemSchema.partial();

export const giniflowRxPauseSchema = z.object({
  weeks: z.number().int().min(1).max(52),
});

// Stopping a medicine is a clinical decision the pharmacy and the patient both
// see; it carries its reason for the same reason a block does (GF-18).
export const giniflowRxStopSchema = z.object({
  reason: z.string().trim().min(1, "Stopping a medicine needs a reason").max(300),
});

export const giniflowMedSearchQuerySchema = z.object({
  q: z.string().trim().min(2, "search needs at least 2 characters").max(80),
});

// The prescriber is required: an external medicine with no doctor behind it
// cannot be interaction-checked by a human later, and "someone prescribed this"
// is not a record.
export const giniflowExternalMedSchema = z.object({
  medicineName: z.string().trim().min(1).max(200),
  composition: z.string().max(300).nullish(),
  dose: z.string().max(100).nullish(),
  frequency: z.string().max(60).nullish(),
  timing: z.string().max(100).nullish(),
  timingCategory: TIMING_CATEGORY.nullish(),
  timeOfDay: CLOCK_TIME.nullish(),
  prescriberName: z.string().trim().min(1).max(120),
  prescriberSpecialty: z.string().max(120).nullish(),
  prescriberHospital: z.string().max(160).nullish(),
  sinceDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD")
    .nullish(),
  interactionFlag: z.string().max(300).nullish(),
});

// ── Pharmacy station (docs/gini-flow/16-PHARMACY-STATION-PLAN.md §8) ────────
// `not_given` carries the reason the not-collected report is built on, so it is
// required here rather than checked only at the counter.
export const giniflowDispenseSchema = z
  .object({
    status: z.enum(["given", "not_given", "partial"]).default("given"),
    reason: z.string().trim().max(300).nullish(),
    qtyNote: z.string().trim().max(120).nullish(),
  })
  .refine((v) => v.status !== "not_given" || !!v.reason, {
    message: "Say why the medicine was not given",
    path: ["reason"],
  });

// Ending a visit is irreversible under append-only rules, so the screen has to
// say so out loud — the same shape the board's Done drop uses (BQ-03).
export const giniflowDispenseAllSchema = z
  .object({ confirm: z.boolean() })
  .refine((v) => v.confirm === true, {
    message: "Confirm before ending the visit",
    path: ["confirm"],
  });

// Finalize is irreversible under append-only rules, so it is never a bare POST.
export const giniflowFinalizeSchema = z.object({
  confirm: z.literal(true, { errorMap: () => ({ message: "Finalize must be confirmed" }) }),
});

// ── Gini Flow · triage board (docs/gini-flow/18-TRIAGE-BOARD-PLAN.md §9) ─────
// The pipeline step names are the filter values: the bar's counts and the rows
// a step opens come from one registry, so a step's number and its list cannot
// drift apart.
export const giniflowTriageQuerySchema = z.object({
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD")
    .optional(),
  filter: z.enum(TRIAGE_FILTERS).optional(),
  // A display filter for one doctor's morning list — it never changes an
  // assignment.
  doctorId: z.coerce.number().int().positive().optional(),
  q: z.string().trim().max(60).optional(),
});

// Both writes in one body, because the coordinator makes both in one gesture.
// `category: null` is meaningful rather than absent: it hands the row back to
// the auto engine, which is the only way to undo an override.
export const giniflowTriagePatchSchema = z
  .object({
    category: z.enum(CATEGORIES).nullable().optional(),
    assignedSdId: z.coerce.number().int().positive().nullable().optional(),
    assignedDoctorId: z.coerce.number().int().positive().nullable().optional(),
  })
  .refine(
    (v) => "category" in v || "assignedSdId" in v || "assignedDoctorId" in v,
    "Nothing to change",
  );
