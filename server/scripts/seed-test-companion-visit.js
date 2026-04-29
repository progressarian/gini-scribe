/**
 * Seed comprehensive dummy clinical data for the TEST_COMPANION_USER patient
 * so the /visit page renders every section with realistic content.
 *
 * Idempotent: deletes existing clinical rows for this patient (by file_no)
 * before re-inserting. The patient row itself is preserved (created by
 * create-test-patient.js if absent).
 *
 * Run:
 *   node server/scripts/seed-test-companion-visit.js
 */
import { fileURLToPath } from "url";
import { dirname, join } from "path";
const __dirname = dirname(fileURLToPath(import.meta.url));

const dotenv = await import("dotenv");
dotenv.config({ path: join(__dirname, "..", ".env") });

const { default: pool } = await import("../config/db.js");

const FILE_NO = "TEST_COMPANION_USER";

const TEST = {
  name: "Test Patient (Companion)",
  phone: "+919999999001",
  file_no: FILE_NO,
  dob: "1985-06-15",
  age: 40,
  sex: "Male",
  email: "test-companion@example.com",
  blood_group: "O+",
  address: "Test Address — safe to delete",
  notes: "DUMMY PATIENT — created by scripts/create-test-patient.js",
};

const today = new Date();
const iso = (d) => d.toISOString().split("T")[0];
const daysAgo = (n) => {
  const d = new Date(today);
  d.setDate(d.getDate() - n);
  return iso(d);
};

async function ensurePatient(client) {
  const existing = await client.query("SELECT id FROM patients WHERE file_no=$1", [FILE_NO]);
  if (existing.rows[0]) return existing.rows[0].id;
  const r = await client.query(
    `INSERT INTO patients (name, phone, file_no, dob, age, sex, email, blood_group, address, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
    [
      TEST.name,
      TEST.phone,
      TEST.file_no,
      TEST.dob,
      TEST.age,
      TEST.sex,
      TEST.email,
      TEST.blood_group,
      TEST.address,
      TEST.notes,
    ],
  );
  return r.rows[0].id;
}

async function wipeClinical(client, pid) {
  const tables = [
    "patient_meal_log",
    "patient_med_log",
    "patient_symptom_log",
    "patient_activity_log",
    "patient_vitals_log",
    "patient_medications_genie",
    "patient_conditions_genie",
    "visit_symptoms",
    "referrals",
    "goals",
    "complications",
    "documents",
    "lab_results",
    "vitals",
    "medications",
    "diagnoses",
    "appointments",
    "consultations",
  ];
  for (const t of tables) {
    try {
      await client.query(`DELETE FROM ${t} WHERE patient_id=$1`, [pid]);
    } catch (e) {
      // table may not exist on older deployments — ignore
    }
  }
}

async function seedConsultation(client, pid) {
  const r = await client.query(
    `INSERT INTO consultations (patient_id, visit_date, visit_type, mo_name, con_name, status, mo_data, con_data)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb) RETURNING id`,
    [
      pid,
      daysAgo(90),
      "Follow-up",
      "Dr. Simranpreet K.",
      "Dr. Bhansali",
      "completed",
      JSON.stringify({ chief_complaint: "Routine diabetes follow-up", hpi: "Patient reports stable glucose readings, occasional fatigue post-lunch" }),
      JSON.stringify({ assessment: "T2DM controlled, mild dyslipidemia", plan: "Continue current regimen, repeat HbA1c in 3 months" }),
    ],
  );
  return r.rows[0].id;
}

async function seedVitals(client, pid, conId) {
  const points = [
    { d: 0, bp_sys: 130, bp_dia: 84, pulse: 76, temp: 98.4, spo2: 98, weight: 72.5, height: 172, rbs: 142 },
    { d: 30, bp_sys: 134, bp_dia: 86, pulse: 78, temp: 98.6, spo2: 98, weight: 72.8, height: 172, rbs: 156 },
    { d: 60, bp_sys: 136, bp_dia: 88, pulse: 80, temp: 98.2, spo2: 97, weight: 73.2, height: 172, rbs: 168 },
    { d: 90, bp_sys: 138, bp_dia: 90, pulse: 82, temp: 98.5, spo2: 97, weight: 73.5, height: 172, rbs: 175 },
    { d: 180, bp_sys: 142, bp_dia: 92, pulse: 84, temp: 98.6, spo2: 97, weight: 74.0, height: 172, rbs: 188 },
  ];
  for (const v of points) {
    const bmi = +(v.weight / Math.pow(v.height / 100, 2)).toFixed(1);
    await client.query(
      `INSERT INTO vitals (patient_id, consultation_id, recorded_at, bp_sys, bp_dia, pulse, temp, spo2, weight, height, bmi, rbs)
       VALUES ($1,$2,NOW() - ($3 || ' days')::interval, $4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [pid, v.d === 90 ? conId : null, v.d, v.bp_sys, v.bp_dia, v.pulse, v.temp, v.spo2, v.weight, v.height, bmi, v.rbs],
    );
  }
}

async function seedDiagnoses(client, pid, conId) {
  const dx = [
    { id: "dm2", label: "Type 2 Diabetes Mellitus (Since 2018)", status: "Uncontrolled", category: "primary", since: 2018, key: "HbA1c 8.2%", trend: "7.4 → 7.8 → 8.2" },
    { id: "htn", label: "Hypertension (Since 2020)", status: "Controlled", category: "comorbidity", since: 2020, key: "BP 130/84", trend: "138/90 → 134/86 → 130/84" },
    { id: "dyslipidemia", label: "Dyslipidemia", status: "Controlled", category: "comorbidity", since: 2020, key: "LDL 92", trend: "118 → 104 → 92" },
    { id: "ckd", label: "CKD Stage 2 — Diabetic Nephropathy", status: "Active", category: "complication", complication_type: "nephropathy", since: 2023, key: "eGFR 78, UACR 62" },
    { id: "neuropathy", label: "Peripheral Neuropathy — Mild", status: "Active", category: "complication", complication_type: "neuropathy", since: 2024, key: "Monofilament 8/10" },
    { id: "retinopathy_mon", label: "Retinopathy Screening", status: "New", category: "monitoring", since: 2026, key: "Fundus due Q2 2026" },
    { id: "hypothyroid_ext", label: "Hypothyroidism (under Dr. Mehra)", status: "Controlled", category: "external", external_doctor: "Dr. Mehra (Endocrine)", since: 2022, key: "TSH 2.4" },
  ];
  for (const [i, d] of dx.entries()) {
    await client.query(
      `INSERT INTO diagnoses (patient_id, consultation_id, diagnosis_id, label, status, category, complication_type, external_doctor, key_value, trend, since_year, sort_order, is_active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,true)`,
      [pid, conId, d.id, d.label, d.status, d.category, d.complication_type || null, d.external_doctor || null, d.key, d.trend || null, d.since, i],
    );
  }
}

async function seedMedications(client, pid, conId) {
  const active = [
    { name: "Glycomet GP 1", composition: "Metformin 500 + Glimepiride 1", dose: "1 tab", frequency: "BD", timing: "Before meals", med_group: "diabetes", drug_class: "metformin", for_dx: ["dm2"], started: daysAgo(800) },
    { name: "Jardiance", composition: "Empagliflozin 10mg", dose: "1 tab", frequency: "OD", timing: "Morning", med_group: "diabetes", drug_class: "sglt2", for_dx: ["dm2", "ckd"], clinical_note: "Renal & cardiac protection", started: daysAgo(180), is_new: false },
    { name: "Telma 40", composition: "Telmisartan 40mg", dose: "1 tab", frequency: "OD", timing: "Morning", med_group: "bp", drug_class: "arb", for_dx: ["htn", "ckd"], started: daysAgo(900) },
    { name: "Rosuvas 10", composition: "Rosuvastatin 10mg", dose: "1 tab", frequency: "OD", timing: "At bedtime", med_group: "lipids", drug_class: "statin", for_dx: ["dyslipidemia"], started: daysAgo(700) },
    { name: "Pregabid 75", composition: "Pregabalin 75mg", dose: "1 cap", frequency: "OD", timing: "At bedtime", med_group: "neuropathy", drug_class: "gabapentinoid", for_dx: ["neuropathy"], clinical_note: "For burning feet at night", started: daysAgo(60), is_new: true },
    { name: "Eltroxin 50", composition: "Levothyroxine 50mcg", dose: "1 tab", frequency: "OD", timing: "Empty stomach", med_group: "external", drug_class: "thyroid", for_dx: ["hypothyroid_ext"], external_doctor: "Dr. Mehra", started: daysAgo(1400) },
    { name: "Shelcal 500", composition: "Calcium + Vit D3", dose: "1 tab", frequency: "OD", timing: "After lunch", med_group: "supplement", drug_class: "supplement", for_dx: [], started: daysAgo(120) },
  ];
  for (const [i, m] of active.entries()) {
    await client.query(
      `INSERT INTO medications (patient_id, consultation_id, name, pharmacy_match, composition, dose, frequency, timing, route, for_diagnosis, med_group, drug_class, external_doctor, clinical_note, sort_order, is_new, is_active, started_date, last_prescribed_date)
       VALUES ($1,$2,$3,$3,$4,$5,$6,$7,'Oral',$8,$9,$10,$11,$12,$13,$14,true,$15,$16)`,
      [pid, conId, m.name, m.composition, m.dose, m.frequency, m.timing, m.for_dx, m.med_group, m.drug_class, m.external_doctor || null, m.clinical_note || null, i, !!m.is_new, m.started, daysAgo(90)],
    );
  }

  const stopped = [
    { name: "Glimisave M2", composition: "Glimepiride 2 + Metformin 500", dose: "1 tab", frequency: "BD", med_group: "diabetes", started: daysAgo(900), stopped: daysAgo(180), reason: "Replaced — switched to SGLT2i for renal benefit" },
    { name: "Amlong 5", composition: "Amlodipine 5mg", dose: "1 tab", frequency: "OD", med_group: "bp", started: daysAgo(800), stopped: daysAgo(700), reason: "Side effect — pedal edema" },
  ];
  for (const m of stopped) {
    await client.query(
      `INSERT INTO medications (patient_id, name, pharmacy_match, composition, dose, frequency, route, med_group, is_active, started_date, stopped_date, stop_reason)
       VALUES ($1,$2,$2,$3,$4,$5,'Oral',$6,false,$7,$8,$9)`,
      [pid, m.name, m.composition, m.dose, m.frequency, m.med_group, m.started, m.stopped, m.reason],
    );
  }
}

async function seedLabs(client, pid) {
  const dates = [daysAgo(365), daysAgo(180), daysAgo(90), daysAgo(7)];
  const series = [
    { name: "HbA1c", canonical: "HbA1c", panel: "Diabetes", unit: "%", ref: "<5.7", values: [7.4, 7.8, 8.0, 8.2], flagFn: (v) => (v >= 6.5 ? "HIGH" : null) },
    { name: "Fasting Blood Sugar", canonical: "FBS", panel: "Diabetes", unit: "mg/dL", ref: "70-100", values: [142, 156, 168, 152], flagFn: (v) => (v > 100 ? "HIGH" : null) },
    { name: "Post Prandial Glucose", canonical: "PPBS", panel: "Diabetes", unit: "mg/dL", ref: "<140", values: [198, 212, 224, 208], flagFn: (v) => (v > 140 ? "HIGH" : null) },
    { name: "Serum Creatinine", canonical: "Creatinine", panel: "RFT", unit: "mg/dL", ref: "0.7-1.3", values: [1.0, 1.1, 1.2, 1.2], flagFn: () => null },
    { name: "eGFR", canonical: "eGFR", panel: "RFT", unit: "mL/min", ref: ">90", values: [88, 82, 80, 78], flagFn: (v) => (v < 90 ? "LOW" : null) },
    { name: "Urine ACR", canonical: "UACR", panel: "RFT", unit: "mg/g", ref: "<30", values: [42, 54, 58, 62], flagFn: (v) => (v >= 30 ? "HIGH" : null) },
    { name: "LDL Cholesterol", canonical: "LDL", panel: "Lipid Profile", unit: "mg/dL", ref: "<100", values: [118, 104, 96, 92], flagFn: (v) => (v >= 100 ? "HIGH" : null) },
    { name: "HDL Cholesterol", canonical: "HDL", panel: "Lipid Profile", unit: "mg/dL", ref: ">40", values: [38, 40, 42, 44], flagFn: (v) => (v < 40 ? "LOW" : null) },
    { name: "Triglycerides", canonical: "Triglycerides", panel: "Lipid Profile", unit: "mg/dL", ref: "<150", values: [188, 172, 165, 158], flagFn: (v) => (v >= 150 ? "HIGH" : null) },
    { name: "Total Cholesterol", canonical: "Total Cholesterol", panel: "Lipid Profile", unit: "mg/dL", ref: "<200", values: [212, 198, 188, 184], flagFn: (v) => (v >= 200 ? "HIGH" : null) },
    { name: "TSH", canonical: "TSH", panel: "Thyroid", unit: "mIU/L", ref: "0.4-4.0", values: [3.1, 2.8, 2.6, 2.4], flagFn: () => null },
    { name: "Hemoglobin", canonical: "Hemoglobin", panel: "CBC", unit: "g/dL", ref: "13-17", values: [14.2, 14.0, 13.8, 13.6], flagFn: () => null },
    { name: "Vitamin D", canonical: "Vitamin D", panel: "Vitamins", unit: "ng/mL", ref: "30-100", values: [22, 26, 28, 32], flagFn: (v) => (v < 30 ? "LOW" : null) },
    { name: "Vitamin B12", canonical: "Vitamin B12", panel: "Vitamins", unit: "pg/mL", ref: "200-900", values: [180, 240, 320, 380], flagFn: (v) => (v < 200 ? "LOW" : null) },
  ];
  for (const s of series) {
    for (let i = 0; i < dates.length; i++) {
      const v = s.values[i];
      await client.query(
        `INSERT INTO lab_results (patient_id, test_date, panel_name, test_name, canonical_name, result, unit, ref_range, flag, source)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'lab')`,
        [pid, dates[i], s.panel, s.name, s.canonical, v, s.unit, s.ref, s.flagFn(v)],
      );
    }
  }
}

async function seedDocuments(client, pid, conId) {
  const docs = [
    { type: "lab_report", title: "Comprehensive Panel — Apr 2026", file: "lab_apr2026.pdf", date: daysAgo(7) },
    { type: "lab_report", title: "Comprehensive Panel — Jan 2026", file: "lab_jan2026.pdf", date: daysAgo(90) },
    { type: "prescription", title: "Prescription — Last Visit", file: "rx_lastvisit.pdf", date: daysAgo(90) },
    { type: "imaging", title: "USG Abdomen — Normal", file: "usg_abdomen.pdf", date: daysAgo(200) },
    { type: "discharge", title: "Discharge Summary — DKA Episode 2018", file: "discharge_2018.pdf", date: daysAgo(2700) },
    { type: "other", title: "ECG — Sinus Rhythm", file: "ecg_2026.pdf", date: daysAgo(30) },
  ];
  for (const d of docs) {
    await client.query(
      `INSERT INTO documents (patient_id, consultation_id, doc_type, title, file_name, mime_type, doc_date, source)
       VALUES ($1,$2,$3,$4,$5,'application/pdf',$6,'upload')`,
      [pid, conId, d.type, d.title, d.file, d.date],
    );
  }
}

async function seedGoals(client, pid, conId) {
  const goals = [
    { marker: "HbA1c", current: "8.2%", target: "<7.0%", timeline: "3 months", priority: "critical", status: "active" },
    { marker: "BP", current: "130/84", target: "<130/80", timeline: "6 weeks", priority: "high", status: "active" },
    { marker: "LDL", current: "92 mg/dL", target: "<70 mg/dL", timeline: "3 months", priority: "high", status: "active" },
    { marker: "Weight", current: "72.5 kg", target: "68 kg", timeline: "6 months", priority: "medium", status: "active" },
    { marker: "UACR", current: "62 mg/g", target: "<30 mg/g", timeline: "6 months", priority: "high", status: "active" },
  ];
  for (const g of goals) {
    await client.query(
      `INSERT INTO goals (patient_id, consultation_id, marker, current_value, target_value, timeline, priority, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [pid, conId, g.marker, g.current, g.target, g.timeline, g.priority, g.status],
    );
  }
}

async function seedComplications(client, pid, conId) {
  const c = [
    { name: "Nephropathy", status: "+", detail: "UACR 62 mg/g, eGFR 78", severity: "low" },
    { name: "Neuropathy", status: "+", detail: "Mild peripheral, monofilament 8/10", severity: "low" },
    { name: "Retinopathy", status: "screening", detail: "Last fundus 2025-Q3 — normal; due Q2 2026" },
    { name: "Foot", status: "-", detail: "No ulcers, pulses intact" },
    { name: "Cardiovascular", status: "-", detail: "ECG normal sinus, no IHD" },
  ];
  for (const x of c) {
    await client.query(
      `INSERT INTO complications (patient_id, consultation_id, name, status, detail, severity, is_active)
       VALUES ($1,$2,$3,$4,$5,$6,true)`,
      [pid, conId, x.name, x.status, x.detail, x.severity || null],
    );
  }
}

async function seedAppointment(client, pid) {
  const apptDate = iso(today);
  const r = await client.query(
    `INSERT INTO appointments (
       patient_id, patient_name, file_no, phone, age, sex,
       appointment_date, time_slot, visit_type, status, category,
       doctor_name, visit_count, last_visit_date,
       biomarkers, prep_steps, compliance,
       healthray_investigations, healthray_follow_up, healthray_clinical_notes
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16::jsonb,$17::jsonb,$18::jsonb,$19::jsonb,$20)
     RETURNING id`,
    [
      pid,
      TEST.name,
      TEST.file_no,
      TEST.phone,
      TEST.age,
      TEST.sex,
      apptDate,
      "10:30",
      "Follow-Up",
      "checkedin",
      "maint",
      "Dr. Bhansali",
      5,
      daysAgo(90),
      JSON.stringify({ hba1c: 8.2, fg: 152, bpSys: 130, bpDia: 84, ldl: 92, tg: 158, bp: "130/84" }),
      JSON.stringify({ biomarkers: true, compliance: true, categorized: true, assigned: true }),
      JSON.stringify({ adherence: "Good (95%)", missed_doses: 2, last_30_days: "Stable" }),
      JSON.stringify([
        { name: "HbA1c", priority: "high" },
        { name: "Lipid Profile", priority: "medium" },
        { name: "UACR", priority: "high" },
        { name: "eGFR", priority: "high" },
      ]),
      JSON.stringify({ next_visit: daysAgo(-90), notes: "3 month follow-up; recheck HbA1c, UACR" }),
      "Patient reports good adherence. Mild peripheral burning at night — started Pregabalin. To continue Jardiance for renal protection. Increased Rosuvastatin to 10mg. F/U 3 months with repeat HbA1c, UACR, lipids.",
    ],
  );
  return r.rows[0].id;
}

async function seedReferrals(client, pid, apptId) {
  const refs = [
    { doctor: "Dr. Mehra", speciality: "Endocrinology", reason: "Thyroid co-management — annual review" },
    { doctor: "Dr. Kapoor", speciality: "Ophthalmology", reason: "Annual fundus exam — diabetic retinopathy screening" },
    { doctor: "Dr. Sharma", speciality: "Nephrology", reason: "CKD stage 2 — UACR rising trend" },
  ];
  for (const r of refs) {
    await client.query(
      `INSERT INTO referrals (patient_id, appointment_id, doctor_name, speciality, reason, status)
       VALUES ($1,$2,$3,$4,$5,'pending')`,
      [pid, apptId, r.doctor, r.speciality, r.reason],
    );
  }
}

async function seedVisitSymptoms(client, pid, apptId) {
  const sx = [
    { id: "fatigue", label: "Post-lunch fatigue", severity: "Mild", since: daysAgo(45), related: "dm2", status: "Active" },
    { id: "burning_feet", label: "Burning sensation in feet at night", severity: "Mild", since: daysAgo(60), related: "neuropathy", status: "Improving" },
    { id: "polyuria", label: "Increased urination", severity: "Mild", since: daysAgo(20), related: "dm2", status: "Active" },
    { id: "headache", label: "Occasional morning headache", severity: "Mild", since: daysAgo(15), related: "htn", status: "Resolving" },
  ];
  for (const s of sx) {
    await client.query(
      `INSERT INTO visit_symptoms (patient_id, appointment_id, symptom_id, label, since_date, severity, related_to, status, is_active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,true)`,
      [pid, apptId, s.id, s.label, s.since, s.severity, s.related, s.status],
    );
  }
}

async function seedLoggedData(client, pid) {
  for (let i = 0; i < 14; i++) {
    const d = daysAgo(i);
    await client.query(
      `INSERT INTO patient_vitals_log (patient_id, recorded_date, reading_time, bp_systolic, bp_diastolic, rbs, meal_type, weight_kg, pulse, spo2, source, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'genie',NOW())`,
      [pid, d, "Morning", 128 + (i % 5), 82 + (i % 3), 110 + (i * 2 % 30), "Fasting", 72.5 + (i % 3) * 0.1, 74 + (i % 4), 98],
    );
  }

  const activities = [
    { type: "Exercise", value: "Brisk walking", duration: 30 },
    { type: "Exercise", value: "Yoga", duration: 20 },
    { type: "Sleep", value: "7h 20m", duration: 440 },
    { type: "Sleep", value: "6h 50m", duration: 410 },
    { type: "Mood", value: "Good", mood: 4 },
    { type: "Mood", value: "Tired", mood: 3 },
    { type: "Body", value: "Steps", value2: "8420" },
    { type: "Body", value: "Steps", value2: "9120" },
  ];
  for (let i = 0; i < activities.length; i++) {
    const a = activities[i];
    await client.query(
      `INSERT INTO patient_activity_log (patient_id, activity_type, value, value2, duration_minutes, mood_score, log_date, log_time, source, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'genie',NOW())`,
      [pid, a.type, a.value, a.value2 || null, a.duration || null, a.mood || null, daysAgo(i), "07:30"],
    );
  }

  const sxLog = [
    { s: "Fatigue after lunch", sev: 4, area: "general", d: 1 },
    { s: "Burning feet", sev: 3, area: "feet", d: 2 },
    { s: "Mild headache", sev: 2, area: "head", d: 4 },
    { s: "Dizziness on standing", sev: 3, area: "head", d: 6 },
  ];
  for (const s of sxLog) {
    await client.query(
      `INSERT INTO patient_symptom_log (patient_id, symptom, severity, body_area, log_date, log_time, source, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,'genie',NOW())`,
      [pid, s.s, s.sev, s.area, daysAgo(s.d), "20:00"],
    );
  }

  const meds = [
    { name: "Glycomet GP 1", dose: "1 tab", time: "07:30" },
    { name: "Telma 40", dose: "1 tab", time: "08:00" },
    { name: "Glycomet GP 1", dose: "1 tab", time: "19:30" },
    { name: "Rosuvas 10", dose: "1 tab", time: "22:00" },
  ];
  for (let d = 0; d < 7; d++) {
    for (const m of meds) {
      await client.query(
        `INSERT INTO patient_med_log (patient_id, medication_name, medication_dose, log_date, dose_time, status, source, created_at)
         VALUES ($1,$2,$3,$4,$5,'taken','genie',NOW())`,
        [pid, m.name, m.dose, daysAgo(d), m.time],
      );
    }
  }

  const meals = [
    { type: "breakfast", desc: "Oats with banana, almonds, milk", cal: 320, p: 12, c: 48, f: 9 },
    { type: "lunch", desc: "Roti (2), dal, sabzi, salad, curd", cal: 480, p: 18, c: 65, f: 14 },
    { type: "snack", desc: "Apple + handful of nuts", cal: 180, p: 4, c: 22, f: 9 },
    { type: "dinner", desc: "Roti (2), grilled paneer, sabzi", cal: 520, p: 24, c: 52, f: 18 },
  ];
  for (let d = 0; d < 7; d++) {
    for (const m of meals) {
      await client.query(
        `INSERT INTO patient_meal_log (patient_id, meal_type, description, calories, protein_g, carbs_g, fat_g, log_date, source, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'genie',NOW())`,
        [pid, m.type, m.desc, m.cal, m.p, m.c, m.f, daysAgo(d)],
      );
    }
  }
}

async function seedGenieMirror(client, pid) {
  const meds = [
    { id: "g_med_1", name: "Glycomet GP 1", dose: "500/1mg", frequency: "BD", timing: "Before meals", conds: ["Diabetes"] },
    { id: "g_med_2", name: "Jardiance", dose: "10mg", frequency: "OD", timing: "Morning", conds: ["Diabetes", "CKD"] },
    { id: "g_med_3", name: "Telma 40", dose: "40mg", frequency: "OD", timing: "Morning", conds: ["Hypertension"] },
    { id: "g_med_4", name: "Rosuvas 10", dose: "10mg", frequency: "OD", timing: "Bedtime", conds: ["Dyslipidemia"] },
  ];
  for (const m of meds) {
    await client.query(
      `INSERT INTO patient_medications_genie (patient_id, genie_id, name, dose, frequency, timing, is_active, for_conditions, source, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,true,$7,'genie',NOW())
       ON CONFLICT (genie_id) DO NOTHING`,
      [pid, m.id, m.name, m.dose, m.frequency, m.timing, m.conds],
    );
  }
  const conds = [
    { id: "g_cond_1", name: "Type 2 Diabetes", status: "active", date: "2018-04-10" },
    { id: "g_cond_2", name: "Hypertension", status: "active", date: "2020-08-22" },
    { id: "g_cond_3", name: "Hypothyroidism", status: "active", date: "2022-02-15" },
  ];
  for (const c of conds) {
    await client.query(
      `INSERT INTO patient_conditions_genie (patient_id, genie_id, name, status, diagnosed_date, created_at)
       VALUES ($1,$2,$3,$4,$5,NOW())
       ON CONFLICT (genie_id) DO NOTHING`,
      [pid, c.id, c.name, c.status, c.date],
    );
  }
}

async function run() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const pid = await ensurePatient(client);
    console.log(`Patient id=${pid} (file_no=${FILE_NO})`);

    console.log("Wiping existing clinical data...");
    await wipeClinical(client, pid);

    console.log("Seeding consultation, vitals, dx, meds, labs, docs, goals, complications...");
    const conId = await seedConsultation(client, pid);
    await seedVitals(client, pid, conId);
    await seedDiagnoses(client, pid, conId);
    await seedMedications(client, pid, conId);
    await seedLabs(client, pid);
    await seedDocuments(client, pid, conId);
    await seedGoals(client, pid, conId);
    await seedComplications(client, pid, conId);

    console.log("Seeding today's appointment, referrals, visit symptoms...");
    const apptId = await seedAppointment(client, pid);
    await seedReferrals(client, pid, apptId);
    await seedVisitSymptoms(client, pid, apptId);

    console.log("Seeding patient-app logged data + Genie mirror...");
    await seedLoggedData(client, pid);
    await seedGenieMirror(client, pid);

    await client.query("COMMIT");
    console.log("\nSeed complete.");
    console.log(`   Visit URL:  /visit/${pid}`);
    console.log(`   OPD today:  / (look for "${TEST.name}")`);
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("Seed failed:", e);
    process.exitCode = 1;
  } finally {
    client.release();
  }
}

try {
  await run();
} finally {
  await pool.end();
}
