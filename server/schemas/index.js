import { z } from "zod";

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
export const patientCreateSchema = z
  .object({
    name: optStr,
    phone: optStr,
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
  doctor_name: z.string({ required_error: "doctor_name is required" }).min(1),
  appointment_date: z
    .string({ required_error: "appointment_date is required" })
    .min(1, "Date is required")
    .refine((v) => v >= new Date().toISOString().split("T")[0], "Cannot book for a past date"),
  time_slot: optStr,
  visit_type: z.enum(["OPD", "IPD", "Telehealth", "Follow-up", "Lab"]).optional().default("OPD"),
  notes: optStr,
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
});

// ---- Messages ----
export const messageCreateSchema = z.object({
  message: z.string({ required_error: "message is required" }).min(1),
  sender_name: optStr,
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
