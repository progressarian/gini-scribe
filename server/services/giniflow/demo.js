import pool from "../../config/db.js";
import { syncAppointmentsToFlow } from "./appointmentSync.js";
import { autoCategoriseDay } from "./triage.js";

// Reproduces the floor in docs/gini-flow-manager.html: 18 booked, 14 in the
// building, 8 done, a hot "Waiting — doctor" column, 2 blocked, 3 on the lab track.
//
// Gini Flow has no check-in of its own yet and deliberately does not read the
// older flow_* module, so until the station screens land this seeder IS the
// board's data. Events are written with explicit backdated occurred_at values so
// every timer, average and bottleneck the board computes is real arithmetic over
// a real log rather than a mocked number.

const MINUTE = 60_000;

// [status, minutes before now that it was entered]
const JOURNEYS = [
  {
    key: "blocked",
    category: "no_reports",
    blocked: "Blocked — reports not uploaded",
    steps: [
      ["checked_in", 34],
      ["blocked_reports", 33],
    ],
  },
  { key: "arrived", category: "worse_in_range", steps: [["checked_in", 4]] },
  {
    key: "at_vitals",
    category: "in_control",
    steps: [
      ["checked_in", 18],
      ["vitals_pending", 15],
      ["with_vitals", 3],
    ],
  },
  {
    key: "with_sd_a",
    category: "worse_in_range",
    sd: true,
    steps: [
      ["checked_in", 33],
      ["vitals_pending", 29],
      ["with_vitals", 25],
      ["vitals_done", 22],
      ["sd_pending", 21],
      ["with_sd", 9],
    ],
  },
  {
    key: "with_sd_b",
    category: "worse_in_range",
    sd: true,
    steps: [
      ["checked_in", 41],
      ["vitals_pending", 37],
      ["with_vitals", 33],
      ["vitals_done", 30],
      ["sd_pending", 28],
      ["with_sd", 13],
    ],
  },
  {
    key: "wait_doc_long",
    category: "worse_in_range",
    sd: true,
    results: "ready",
    steps: [
      ["checked_in", 78],
      ["vitals_pending", 71],
      ["with_vitals", 67],
      ["vitals_done", 63],
      ["sd_pending", 59],
      ["with_sd", 47],
      ["ready_for_doctor", 41],
    ],
  },
  {
    key: "wait_doc_green",
    category: "in_control",
    sd: true,
    results: "ready",
    steps: [
      ["checked_in", 52],
      ["vitals_pending", 47],
      ["with_vitals", 43],
      ["vitals_done", 40],
      ["sd_pending", 36],
      ["with_sd", 24],
      ["ready_for_doctor", 14],
    ],
  },
  {
    key: "wait_doc_red",
    category: "worse_out_of_range",
    sd: true,
    steps: [
      ["checked_in", 47],
      ["vitals_pending", 43],
      ["with_vitals", 39],
      ["vitals_done", 36],
      ["sd_pending", 33],
      ["with_sd", 21],
      ["ready_for_doctor", 12],
    ],
  },
  {
    key: "wait_doc_ok",
    category: "worse_in_range",
    sd: true,
    results: "ready",
    steps: [
      ["checked_in", 39],
      ["vitals_pending", 35],
      ["with_vitals", 31],
      ["vitals_done", 28],
      ["sd_pending", 25],
      ["with_sd", 13],
      ["ready_for_doctor", 6],
    ],
  },
  {
    key: "with_doc_a",
    category: "worse_in_range",
    sd: true,
    doctor: true,
    results: "ready",
    steps: [
      ["checked_in", 64],
      ["vitals_pending", 59],
      ["with_vitals", 55],
      ["vitals_done", 52],
      ["sd_pending", 49],
      ["with_sd", 37],
      ["ready_for_doctor", 27],
      ["with_doctor", 18],
    ],
  },
  {
    key: "with_doc_b",
    category: "worse_out_of_range",
    sd: true,
    doctor: true,
    results: "ready",
    steps: [
      ["checked_in", 51],
      ["vitals_pending", 46],
      ["with_vitals", 42],
      ["vitals_done", 39],
      ["sd_pending", 36],
      ["with_sd", 24],
      ["ready_for_doctor", 16],
      ["with_doctor", 8],
    ],
  },
  {
    key: "pharmacy_a",
    category: "in_control",
    sd: true,
    doctor: true,
    results: "ready",
    steps: [
      ["checked_in", 58],
      ["vitals_pending", 53],
      ["with_vitals", 49],
      ["vitals_done", 46],
      ["sd_pending", 43],
      ["with_sd", 31],
      ["ready_for_doctor", 22],
      ["with_doctor", 14],
      ["doctor_done", 5],
      ["pharmacy_pending", 4],
    ],
  },
  {
    key: "pharmacy_b",
    category: "worse_in_range",
    sd: true,
    doctor: true,
    results: "ready",
    steps: [
      ["checked_in", 83],
      ["vitals_pending", 78],
      ["with_vitals", 74],
      ["vitals_done", 71],
      ["sd_pending", 68],
      ["with_sd", 55],
      ["ready_for_doctor", 44],
      ["with_doctor", 30],
      ["doctor_done", 11],
      ["pharmacy_pending", 9],
    ],
  },
  {
    key: "blocked_2",
    category: "no_reports",
    blocked: "Blocked — awaiting outside reports",
    steps: [
      ["checked_in", 21],
      ["blocked_reports", 20],
    ],
  },
  // Blocked, then unblocked — the recovery path the coordinator sees most often,
  // and the one that exercises resume_status.
  {
    key: "recovered",
    category: "getting_better",
    steps: [
      ["checked_in", 29],
      ["blocked_reports", 27],
      ["vitals_pending", 9],
      ["with_vitals", 4],
    ],
  },
];

const doneJourney = (offsetMin, totalMin) => ({
  key: `done_${offsetMin}`,
  category: "in_control",
  sd: true,
  doctor: true,
  results: "ready",
  steps: [
    ["checked_in", offsetMin],
    ["vitals_pending", offsetMin - 6],
    ["with_vitals", offsetMin - 9],
    ["vitals_done", offsetMin - 12],
    ["sd_pending", offsetMin - 14],
    ["with_sd", offsetMin - 22],
    ["ready_for_doctor", offsetMin - 31],
    ["with_doctor", offsetMin - 39],
    ["doctor_done", offsetMin - 47],
    ["pharmacy_pending", offsetMin - 52],
    ["dispensed", offsetMin - totalMin + 2],
    ["exited", offsetMin - totalMin],
  ],
});

// `events` are [track, status, minutesAgo] — the log the lab and reception
// screens will write for real. Without them the lab_total and reception_payment
// footer budgets have nothing to measure (GF-07, GF-12).
const LAB_ORDERS = [
  {
    journey: "pharmacy_a",
    sampleStatus: "uploaded",
    paymentStatus: "paid",
    minutes: 46,
    uploadedMinutesAgo: 8,
    events: [
      ["payment", "pending", 46],
      ["payment", "paid", 38],
      ["sample", "sample_collected", 36],
      ["sample", "processing", 30],
      ["sample", "results_ready", 12],
      ["sample", "uploaded", 8],
    ],
    tests: [
      ["HbA1c", 600],
      ["Lipid profile", 800],
    ],
  },
  {
    journey: "with_doc_a",
    sampleStatus: "payment_pending",
    paymentStatus: "pending",
    minutes: 12,
    tests: [
      ["Lipid profile", 800],
      ["HbA1c", 600],
      ["CBC", 400],
      ["KFT", 700],
      ["LFT", 700],
      ["TSH", 500],
    ],
  },
  {
    journey: "wait_doc_long",
    sampleStatus: "processing",
    paymentStatus: "paid",
    minutes: 24,
    tests: [
      ["HbA1c", 600],
      ["Lipid profile", 800],
      ["Urine R/M", 300],
      ["Creatinine", 350],
      ["Vitamin D", 1200],
    ],
  },
  {
    journey: "with_sd_a",
    sampleStatus: "results_ready",
    paymentStatus: "paid",
    minutes: 18,
    tests: [
      ["CBC", 400],
      ["HbA1c", 600],
      ["KFT", 700],
      ["TSH", 500],
    ],
  },
];

const ACTOR_FOR = {
  checked_in: "reception",
  vitals_pending: "reception",
  blocked_reports: "reception",
  with_vitals: "vitals",
  vitals_done: "vitals",
  sd_pending: "vitals",
  with_sd: "mo_sd",
  ready_for_doctor: "mo_sd",
  with_doctor: "doctor",
  doctor_done: "doctor",
  pharmacy_pending: "doctor",
  dispensed: "pharmacy",
  exited: "pharmacy",
};

// ── Tomorrow, for the triage board ─────────────────────────────────────────
// The floor journeys above are TODAY: they build the board and every station
// queue. The triage board works the day BEFORE the day, off `appointments` —
// biomarkers, the confirmation call, the patient's own pre-visit note — and the
// seeder wrote none of those, so that one screen was the only station with
// nothing to show.
//
// One profile per column the engine can produce, plus the two the coordinator
// most needs to see: a patient with no numbers at all (the call list) and one
// whose diagnosis triggers a routing suggestion.
//
// [key, current HbA1c, previous HbA1c, extra markers, call status, extras]
const TRIAGE_PROFILES = [
  [
    "t_crisis",
    11.4,
    9.1,
    { fg: 196, ldl: 158, tg: 227, uacr: 42, egfr: 84 },
    "called",
    {
      symptoms: ["numbness in feet", "blurred vision 1 week"],
      note: "Doctor se poochna tha — kya insulin lena padega?",
      compliance: 44,
    },
  ],
  ["t_jump", 8.4, 6.6, { fg: 168, ldl: 121 }, "pending", { compliance: 58 }],
  [
    "t_rising",
    7.9,
    7.2,
    { fg: 141, ldl: 96, tg: 165, uacr: 18, egfr: 92 },
    "not_picked",
    {
      lifestyle: true,
      compliance: 71,
    },
  ],
  ["t_resched", 7.6, 7.1, { fg: 138, tg: 172 }, "rescheduled", {}],
  [
    "t_better",
    8.1,
    9.4,
    { fg: 129, ldl: 88, tg: 140, uacr: 12, egfr: 97 },
    "called",
    {
      compliance: 86,
    },
  ],
  ["t_better2", 7.4, 8.2, { fg: 124, ldl: 91 }, "no_call_needed", { compliance: 92 }],
  [
    "t_green",
    6.4,
    6.5,
    { fg: 98, ldl: 82, tg: 118, uacr: 8, egfr: 103 },
    "called",
    {
      compliance: 95,
    },
  ],
  [
    "t_green2",
    6.1,
    6.3,
    { fg: 94, ldl: 79, tg: 110, uacr: 6, egfr: 108 },
    "called",
    {
      compliance: 88,
    },
  ],
  ["t_none", null, 7.8, {}, "wrong_number", {}],
  ["t_none2", null, null, {}, "pending", { symptoms: ["swelling in feet"] }],
];

// The diagnosis that makes the routing suggestion appear on one card. Written
// against a demo patient only — never a real one.
const TRIAGE_DIAGNOSIS = { profile: "t_crisis", label: "Diabetic foot ulcer (right great toe)" };

const adherenceFor = (pct) =>
  pct >= 90 ? "always" : pct >= 70 ? "mostly" : pct >= 50 ? "sometimes" : "missed";

// A visit's worth of appointment rows for the triage day: the previous visit
// that "rising" and "improving" are measured against, and the booking itself.
async function seedTriageDay(client, patientIds, triageDate) {
  const { rows: prev } = await client.query(
    `SELECT ($1::date - INTERVAL '3 months')::date::text AS d`,
    [triageDate],
  );
  const previousDate = prev[0].d;
  const lifestyleFileNos = [];
  let created = 0;

  for (const [i, [key, cur, before, extra, callStatus, opts]] of TRIAGE_PROFILES.entries()) {
    const patientId = patientIds[i];
    if (!patientId) continue;
    const { rows: who } = await client.query(`SELECT name, file_no FROM patients WHERE id = $1`, [
      patientId,
    ]);
    const { name, file_no: fileNo } = who[0];

    // The previous visit the engine measures "rising" and "improving" against.
    if (before !== null) {
      await client.query(
        `INSERT INTO appointments (patient_id, patient_name, file_no, appointment_date, status,
                                   visit_type, biomarkers)
         VALUES ($1, $2, $3, $4::date, 'completed', 'OPD', $5::jsonb)`,
        [patientId, name, fileNo, previousDate, JSON.stringify({ hba1c: before })],
      );
    }

    // The booking itself. `appointments` has no is_demo column, so these rows
    // are scoped the way every other demo write is — to the ZZDEMO_ patients,
    // which is what cleanDemoDay deletes by.
    // Both shapes the column actually holds, alternating — the patient app's
    // ARRAY of per-medicine adherence, and the summary OBJECT carrying a pct.
    // A demo that only ever wrote one of them would leave the other reader
    // untested on screen.
    const compliance = opts.compliance ?? null;
    const items = [
      {
        medication: "Metformin 1000mg",
        schedule: "twice daily",
        adherence: adherenceFor(compliance ?? 0),
      },
      {
        medication: "Glimepiride 2mg",
        schedule: "once daily",
        adherence: adherenceFor(compliance ?? 0),
      },
    ];
    const preVisitCompliance =
      compliance === null ? null : JSON.stringify(i % 2 ? items : { pct: compliance, items });

    await client.query(
      `INSERT INTO appointments (patient_id, patient_name, file_no, appointment_date, status,
                                 visit_type, time_slot, call_status, call_date, biomarkers,
                                 pre_visit_symptoms, pre_visit_notes, pre_visit_compliance,
                                 pre_visit_compliance_at)
       VALUES ($1, $2, $3, $4::date, 'scheduled', 'OPD', $5, $6, $7::date, $8::jsonb,
               $9::text[], $10, $11::jsonb, $12::timestamptz)`,
      [
        patientId,
        name,
        fileNo,
        triageDate,
        `${9 + Math.floor(i / 2)}:${i % 2 ? "30" : "00"} AM`,
        callStatus,
        callStatus === "pending" ? null : previousDate,
        JSON.stringify(cur === null ? extra : { hba1c: cur, ...extra }),
        opts.symptoms || null,
        opts.note || null,
        preVisitCompliance,
        preVisitCompliance === null ? null : new Date().toISOString(),
      ],
    );
    created++;
    if (opts.lifestyle) lifestyleFileNos.push(fileNo);

    if (TRIAGE_DIAGNOSIS.profile === key) {
      await client.query(
        `INSERT INTO diagnoses (patient_id, diagnosis_id, label, category, is_active)
         VALUES ($1, 'diabetic_foot_ulcer', $2, 'secondary', TRUE)
         ON CONFLICT DO NOTHING`,
        [patientId, TRIAGE_DIAGNOSIS.label],
      );
    }
  }
  return { created, triageDate, previousDate, lifestyleFileNos };
}

// ── The consultation, for the consultant station ───────────────────────────
// The floor journeys give every station a QUEUE. The consult screen behind that
// queue reads the patient's CHART — biomarkers on the appointment, the lab
// table, diagnoses, medications, the MO's plan and their proposals — and the
// seeder wrote none of it, so opening a demo patient gave a screen of "nothing
// recorded" boxes: no key numbers, no labs, an empty prescription, no diagnoses.
//
// Each profile is keyed on the journey's own category, so what the consultant
// reads agrees with the colour the board gave the card. A `no_reports` patient
// deliberately gets nothing — that is what the category means, and inventing
// numbers for them would make the one honest empty state impossible to see.
const CONSULT_PROFILES = {
  worse_out_of_range: {
    current: {
      hba1c: 10.9,
      fg: 196,
      ppbs: 284,
      ldl: 158,
      hdl: 34,
      tg: 227,
      tc: 212,
      uacr: 42,
      egfr: 84,
      creatinine: 1.12,
      tsh: 3.2,
      vitd: 18,
      hb: 12.4,
    },
    trail: [
      { months: 4, b: { hba1c: 9.4, fg: 172, ldl: 141, tg: 198, uacr: 31, egfr: 88 } },
      { months: 8, b: { hba1c: 8.8, fg: 158, ldl: 132, tg: 176, uacr: 22, egfr: 91 } },
      { months: 12, b: { hba1c: 8.1, fg: 149, ldl: 128, tg: 165, uacr: 14, egfr: 94 } },
    ],
    vitals: { weight: 88.4, height: 168, bmi: 31.3, bp_sys: 148, bp_dia: 92, pulse: 84, spo2: 97 },
    compliance: 44,
    symptoms: ["numbness in both feet", "blurred vision 1 week", "getting up twice at night"],
    note: "Doctor se poochna tha — kya insulin lena padega?",
    diagnoses: [
      ["dm2", "Type 2 DM", "Uncontrolled", "primary", "HbA1c 10.9%", "8.1→9.4→10.9", 2011],
      ["htn", "Hypertension", "Uncontrolled", "comorbidity", "BP 148/92", "138→144→148", 2015],
      [
        "ckd",
        "Diabetic nephropathy (early)",
        "New",
        "complication",
        "UACR 42 mg/g",
        "14→31→42",
        2026,
      ],
      [
        "dyslipidemia",
        "Dyslipidaemia",
        "Uncontrolled",
        "comorbidity",
        "LDL 158",
        "128→141→158",
        2016,
      ],
    ],
    meds: [
      [
        "Glycomet GP2",
        "Metformin 1000mg + Glimepiride 2mg",
        "1-0-1",
        "BD",
        "diabetes",
        "Before meals",
      ],
      ["Jardiance 10", "Empagliflozin 10mg", "1-0-0", "OD", "diabetes", "Before breakfast"],
      ["Telma 40", "Telmisartan 40mg", "0-0-1", "OD", "bp", "At bedtime"],
      ["Atchol 20", "Atorvastatin 20mg", "0-0-1", "OD", "lipids", "At bedtime"],
    ],
    external: ["Pregabalin 75", "Pregabalin 75mg", "0-0-1", "Dr. Sethi (Neuro)"],
    plan:
      "HbA1c 10.9 on maximal orals — up from 9.4 in June. Reports compliance ~44%, missing the evening dose most days. " +
      "UACR now 42 (was 14 a year ago) with eGFR still 84 — early nephropathy. BP 148/92 at the chair, second reading same. " +
      "Suggest basal insulin discussion and pushing the statin; foot exam done, sensation reduced bilaterally.",
    proposals: [
      ["Atchol 20", "20mg", "40mg", "LDL 158, well above target on 20mg", "changed"],
      ["Lantus", null, "10 units at bedtime", "HbA1c 10.9 on maximal orals", "new"],
    ],
  },
  worse_in_range: {
    current: {
      hba1c: 7.9,
      fg: 141,
      ppbs: 198,
      ldl: 96,
      hdl: 42,
      tg: 165,
      tc: 171,
      uacr: 18,
      egfr: 92,
      creatinine: 0.94,
      tsh: 2.4,
      vitd: 24,
      hb: 13.1,
    },
    trail: [
      { months: 3, b: { hba1c: 7.2, fg: 128, ldl: 92, tg: 148, uacr: 12, egfr: 94 } },
      { months: 7, b: { hba1c: 7.0, fg: 124, ldl: 88, tg: 140, uacr: 9, egfr: 96 } },
    ],
    vitals: { weight: 74.2, height: 163, bmi: 27.9, bp_sys: 132, bp_dia: 84, pulse: 78, spo2: 98 },
    compliance: 71,
    symptoms: ["tired by evening"],
    note: "Weight badh raha hai — diet chart mil sakta hai?",
    diagnoses: [
      ["dm2", "Type 2 DM", "Uncontrolled", "primary", "HbA1c 7.9%", "7.0→7.2→7.9", 2018],
      ["obesity", "Overweight", "Uncontrolled", "comorbidity", "BMI 27.9", "26.4→27.1→27.9", 2020],
    ],
    meds: [
      ["Glycomet 1000", "Metformin 1000mg", "1-0-1", "BD", "diabetes", "After meals"],
      [
        "Istamet 50/500",
        "Sitagliptin 50mg + Metformin 500mg",
        "1-0-0",
        "OD",
        "diabetes",
        "After breakfast",
      ],
    ],
    external: null,
    plan:
      "HbA1c drifted 7.2 → 7.9 over three months. Compliance reported ~71% — skipping the evening metformin. " +
      "Weight up 2.4kg since the last visit; says the walking stopped after Diwali. Numbers otherwise in range, " +
      "renal and lipids fine. Suggest reinforcing the evening dose before adding anything.",
    proposals: [
      [
        "Glycomet 1000",
        "1000mg BD",
        "1000mg BD + evening reminder",
        "compliance, not dose",
        "continued",
      ],
    ],
  },
  getting_better: {
    current: {
      hba1c: 8.1,
      fg: 129,
      ppbs: 176,
      ldl: 88,
      hdl: 46,
      tg: 140,
      tc: 162,
      uacr: 12,
      egfr: 97,
      creatinine: 0.88,
      tsh: 2.1,
      vitd: 31,
      hb: 13.4,
    },
    trail: [
      { months: 3, b: { hba1c: 9.4, fg: 168, ldl: 118, tg: 186, uacr: 19, egfr: 95 } },
      { months: 7, b: { hba1c: 10.2, fg: 184, ldl: 134, tg: 210, uacr: 24, egfr: 93 } },
    ],
    vitals: { weight: 68.9, height: 160, bmi: 26.9, bp_sys: 126, bp_dia: 80, pulse: 74, spo2: 99 },
    compliance: 86,
    symptoms: [],
    note: "Sugar ab theek lag raha hai — dawai kam ho sakti hai?",
    diagnoses: [
      ["dm2", "Type 2 DM", "Controlled", "primary", "HbA1c 8.1%", "10.2→9.4→8.1", 2019],
      ["dyslipidemia", "Dyslipidaemia", "Controlled", "comorbidity", "LDL 88", "134→118→88", 2019],
    ],
    meds: [
      [
        "Glycomet GP1",
        "Metformin 500mg + Glimepiride 1mg",
        "1-0-1",
        "BD",
        "diabetes",
        "Before meals",
      ],
      ["Atchol 10", "Atorvastatin 10mg", "0-0-1", "OD", "lipids", "At bedtime"],
    ],
    external: null,
    plan:
      "Good trajectory — 10.2 → 9.4 → 8.1 across three visits, compliance 86% and walking daily. " +
      "LDL down to 88 on 10mg. Still above the 7.0 target so not for de-escalation yet; asked about reducing " +
      "medicines, explained why we hold for one more cycle.",
    proposals: [],
  },
  in_control: {
    current: {
      hba1c: 6.4,
      fg: 98,
      ppbs: 132,
      ldl: 82,
      hdl: 51,
      tg: 118,
      tc: 156,
      uacr: 8,
      egfr: 103,
      creatinine: 0.79,
      tsh: 1.8,
      vitd: 36,
      hb: 13.9,
    },
    trail: [
      { months: 4, b: { hba1c: 6.5, fg: 101, ldl: 86, tg: 124, uacr: 7, egfr: 102 } },
      { months: 8, b: { hba1c: 6.6, fg: 104, ldl: 90, tg: 130, uacr: 9, egfr: 101 } },
    ],
    vitals: { weight: 64.1, height: 165, bmi: 23.5, bp_sys: 118, bp_dia: 76, pulse: 70, spo2: 99 },
    compliance: 95,
    symptoms: [],
    note: null,
    diagnoses: [["dm2", "Type 2 DM", "Controlled", "primary", "HbA1c 6.4%", "6.6→6.5→6.4", 2021]],
    meds: [["Glycomet 500", "Metformin 500mg", "1-0-1", "BD", "diabetes", "After meals"]],
    external: null,
    plan:
      "Everything at target and steady for a year — HbA1c 6.6 → 6.5 → 6.4, renal and lipids clean, " +
      "compliance 95%. Green category: no change proposed, six-month recall.",
    proposals: [],
  },
};

// The lab table the Labs & graphs tabs read. Panel names match the groups the
// screen sorts into, so every tab has rows rather than four empty ones.
const LAB_ROWS = [
  ["hba1c", "HbA1c", "%", "4.0-5.6", "Diabetes"],
  ["fg", "FBS", "mg/dL", "70-100", "Diabetes"],
  ["ppbs", "PPBS", "mg/dL", "<140", "Diabetes"],
  ["tc", "Total Cholesterol", "mg/dL", "<200", "Lipid Profile"],
  ["ldl", "LDL", "mg/dL", "<100", "Lipid Profile"],
  ["hdl", "HDL", "mg/dL", ">40", "Lipid Profile"],
  ["tg", "Triglycerides", "mg/dL", "<150", "Lipid Profile"],
  ["creatinine", "Creatinine", "mg/dL", "0.6-1.2", "KFT"],
  ["egfr", "eGFR", "mL/min", ">60", "KFT"],
  ["uacr", "UACR", "mg/g", "<30", "KFT"],
  ["tsh", "TSH", "µIU/mL", "0.4-4.0", "Thyroid"],
  ["vitd", "Vitamin D", "ng/mL", "30-100", "Vitamins"],
  ["hb", "Hemoglobin", "g/dL", "12-16", "CBC"],
];

const flagFor = (key, value) => {
  const t = {
    hba1c: 5.6,
    fg: 100,
    ppbs: 140,
    tc: 200,
    ldl: 100,
    tg: 150,
    creatinine: 1.2,
    uacr: 30,
  };
  const low = { hdl: 40, egfr: 60, vitd: 30, hb: 12 };
  if (t[key] !== undefined) return value > t[key] ? "H" : null;
  if (low[key] !== undefined) return value < low[key] ? "L" : null;
  return null;
};

// Everything the consult screen reads, for one demo visit.
async function seedConsultFor(
  client,
  { visitId, patientId, patientName, fileNo, category, sdId, chiefId, visitDate },
) {
  const profile = CONSULT_PROFILES[category];
  if (!profile) return 0;

  const dateAt = async (monthsAgo) =>
    (
      await client.query(`SELECT ($1::date - ($2 || ' months')::interval)::date::text AS d`, [
        visitDate,
        monthsAgo,
      ])
    ).rows[0].d;

  // The history the deltas and the trend graphs are drawn from.
  for (const step of profile.trail) {
    await client.query(
      `INSERT INTO appointments (patient_id, patient_name, file_no, appointment_date, status,
                                 visit_type, biomarkers)
       VALUES ($1, $2, $3, $4::date, 'completed', 'OPD', $5::jsonb)`,
      [patientId, patientName, fileNo, await dateAt(step.months), JSON.stringify(step.b)],
    );
  }

  // Today's appointment — where the consult screen reads "today's numbers" and
  // the compliance percentage from. The visit is pointed at it, which is the
  // join `getConsult` makes.
  const { rows: appt } = await client.query(
    `INSERT INTO appointments (patient_id, patient_name, file_no, appointment_date, status,
                               visit_type, biomarkers, pre_visit_compliance, pre_visit_compliance_at,
                               pre_visit_symptoms, pre_visit_notes)
     VALUES ($1, $2, $3, $4::date, 'checkedin', 'OPD', $5::jsonb, $6::jsonb, NOW(), $7::text[], $8)
     RETURNING id`,
    [
      patientId,
      patientName,
      fileNo,
      visitDate,
      JSON.stringify(profile.current),
      JSON.stringify({ pct: profile.compliance }),
      profile.symptoms?.length ? profile.symptoms : null,
      profile.note,
    ],
  );
  await client.query(`UPDATE giniflow_visits SET appointment_id = $2 WHERE id = $1`, [
    visitId,
    appt[0].id,
  ]);

  // The chart's lab table, on two dates so a graph has a line rather than a dot.
  const previous = profile.trail[0]?.b || {};
  for (const [when, blob] of [
    [visitDate, profile.current],
    [await dateAt(profile.trail[0]?.months ?? 4), previous],
  ]) {
    for (const [key, testName, unit, ref, panel] of LAB_ROWS) {
      const value = blob[key];
      if (value === undefined) continue;
      await client.query(
        `INSERT INTO lab_results (patient_id, test_date, panel_name, test_name, canonical_name,
                                  result, unit, ref_range, flag, source)
         VALUES ($1, $2::date, $3, $4, $5, $6, $7, $8, $9, 'report_extract')
         ON CONFLICT DO NOTHING`,
        [patientId, when, panel, testName, testName, value, unit, ref, flagFor(key, value)],
      );
    }
    await client.query(
      `INSERT INTO documents (patient_id, doc_type, title, doc_date, source)
       VALUES ($1, 'lab_report', $2, $3::date, 'upload_demo')`,
      [patientId, `Lab report — ${when}`, when],
    );
  }

  for (const [i, [id, label, status, cat, keyValue, trend, since]] of profile.diagnoses.entries()) {
    await client.query(
      `INSERT INTO diagnoses (patient_id, diagnosis_id, label, status, category, key_value, trend,
                              since_year, sort_order, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, TRUE)`,
      [patientId, id, label, status, cat, keyValue, trend, since, i],
    );
  }

  for (const [i, [name, composition, dose, frequency, group, timing]] of profile.meds.entries()) {
    await client.query(
      `INSERT INTO medications (patient_id, name, composition, dose, frequency, timing, med_group,
                                route, form, sort_order, is_active, started_date)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'Oral', 'Tablet', $8, TRUE, $9::date)`,
      [patientId, name, composition, dose, frequency, timing, group, i, await dateAt(6)],
    );
  }
  if (profile.external) {
    const [name, composition, dose, doctor] = profile.external;
    await client.query(
      `INSERT INTO medications (patient_id, name, composition, dose, frequency, med_group,
                                external_doctor, route, form, is_active, started_date)
       VALUES ($1, $2, $3, $4, 'OD', 'external', $5, 'Oral', 'Tablet', TRUE, $6::date)`,
      [patientId, name, composition, dose, doctor, await dateAt(3)],
    );
  }

  // Vitals taken at the chair an hour ago — what the consult header's BP and
  // weight come from, and what tops up today's numbers.
  await client.query(
    `INSERT INTO giniflow_vitals (visit_id, patient_id, weight, height, bmi, bp_sys, bp_dia,
                                  pulse, spo2, source, recorded_by, recorded_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'manual', $10, NOW() - INTERVAL '55 minutes')`,
    [
      visitId,
      patientId,
      profile.vitals.weight,
      profile.vitals.height,
      profile.vitals.bmi,
      profile.vitals.bp_sys,
      profile.vitals.bp_dia,
      profile.vitals.pulse,
      profile.vitals.spo2,
      sdId,
    ],
  );

  // The MO's workup note and their proposals — the first section the consultant
  // reads, and the one the screen opens on.
  await client.query(
    `INSERT INTO giniflow_sd_notes (visit_id, plan, source, authored_by)
     VALUES ($1, $2, 'typed', $3)
     ON CONFLICT (visit_id) DO UPDATE SET plan = EXCLUDED.plan, updated_at = NOW()`,
    [visitId, profile.plan, sdId],
  );

  for (const [name, from, to, reason, changeType] of profile.proposals) {
    await client.query(
      `INSERT INTO giniflow_rx_proposals (visit_id, medicine_name, from_dose, to_dose, reason,
                                          change_type, proposed_by, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'proposed')`,
      [visitId, name, from, to, reason, changeType, sdId],
    );
  }

  return 1;
}

const DEMO_MARKER = "giniflow-demo";

// GF-03: the seeder used to pick real patients (`SELECT id FROM patients ORDER BY
// id LIMIT n`) and write fabricated categories, vitals and blocked reasons against
// them. Those are clinical attributes about identifiable people, in a DPDP-covered
// production database. It creates its own patients instead, marked unmistakably in
// both the name and the file number, and deletes them again on clean.
const DEMO_FILE_PREFIX = "ZZDEMO_";

const DEMO_NAMES = [
  "Demo Nishant Puri",
  "Demo Harpreet Kaur",
  "Demo Rakesh Sharma",
  "Demo Anil Dhamija",
  "Demo Sunita Devi",
  "Demo Isha Gambhir",
  "Demo Deepak Khanna",
  "Demo Promila Puri",
  "Demo Mohan Lal",
  "Demo Sandeep Kumar",
  "Demo Gurmail Singh",
  "Demo Kamla Devi",
  "Demo Baljit Singh",
  "Demo Ravinder Grewal",
  "Demo Jasbir Kaur",
  "Demo Satpal Singh",
  "Demo Neelam Rani",
  "Demo Ashok Verma",
  "Demo Manjit Kaur",
  "Demo Rajesh Bansal",
  "Demo Kiran Bala",
  "Demo Surinder Pal",
  // Tomorrow's triage list is a different set of people from today's floor, so
  // the roster has to be long enough for both — a wrapped name would put the
  // same person on two days with two different clinical stories.
  "Demo Paramjit Singh",
  "Demo Veena Sharma",
  "Demo Karan Malhotra",
  "Demo Simran Kaur",
  "Demo Vikram Chopra",
  "Demo Anita Mehra",
  "Demo Harbans Lal",
  "Demo Pooja Aggarwal",
  "Demo Tarun Sethi",
  "Demo Meena Kumari",
  "Demo Jagdish Rai",
];

// Sex follows the NAME, not the row's parity — which is what it used to do, so
// every other demo card read "Demo Sunita Devi · 52M". On a screen built to be
// shown to clinicians that is the first thing anyone notices.
const FEMALE_MARKERS = [
  "kaur",
  "devi",
  "rani",
  "bala",
  "kumari",
  "promila",
  "isha",
  "veena",
  "anita",
  "pooja",
  "simran",
  "meena",
  "manjit",
  "jasbir",
  "kamla",
  "neelam",
  "sunita",
  "harpreet",
  "kiran",
];

const sexForName = (name) =>
  FEMALE_MARKERS.some((m) => name.toLowerCase().includes(m)) ? "Female" : "Male";

async function ensureDemoPatients(client, count) {
  const ids = [];
  for (let i = 0; i < count; i++) {
    const fileNo = `${DEMO_FILE_PREFIX}${String(i + 1).padStart(3, "0")}`;
    const { rows } = await client.query(
      `INSERT INTO patients (name, file_no, age, sex, phone)
       VALUES ($1, $2, $3, $4, NULL)
       ON CONFLICT (file_no) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`,
      [
        DEMO_NAMES[i % DEMO_NAMES.length],
        fileNo,
        40 + ((i * 3) % 35),
        sexForName(DEMO_NAMES[i % DEMO_NAMES.length]),
      ],
    );
    ids.push(rows[0].id);
  }
  return ids;
}

async function pickDoctors(client) {
  const { rows } = await client.query(
    `SELECT id FROM doctors WHERE COALESCE(is_active, TRUE) ORDER BY is_chief DESC NULLS LAST, id LIMIT 2`,
  );
  return { chief: rows[0]?.id ?? null, sd: rows[1]?.id ?? rows[0]?.id ?? null };
}

// GF-P0: a destructive/fabricating routine needs more than a role check on the
// live host. Both entry points refuse unless GINIFLOW_ALLOW_DEMO is set.
export const demoAllowed = () => process.env.GINIFLOW_ALLOW_DEMO === "1";

const assertDemoAllowed = () => {
  if (!demoAllowed()) {
    throw Object.assign(
      new Error("Demo seeding is disabled. Set GINIFLOW_ALLOW_DEMO=1 to enable it."),
      { status: 403 },
    );
  }
};

// `date` exists so the smoke suite can seed a day of its own. Once the HealthRay
// sync runs, today belongs to real patients — a test that seeds into it collides
// with them and asserts against a mixture of both.
export async function seedDemoDay({ db = pool, date = null } = {}) {
  assertDemoAllowed();
  const client = await db.connect();
  try {
    await client.query("BEGIN");

    const journeys = [
      ...JOURNEYS,
      doneJourney(140, 64),
      doneJourney(133, 69),
      doneJourney(126, 71),
      doneJourney(119, 66),
      doneJourney(112, 74),
      doneJourney(105, 68),
      doneJourney(98, 77),
      doneJourney(91, 70),
    ];

    // Today's floor and tomorrow's triage list are DIFFERENT people, as they are
    // on a real day. Sharing them meant one patient carried two clinical stories
    // — the consult trail said HbA1c 7.2 → 7.9 while the triage row said 8.2 for
    // the same week — and whichever appointment sorted latest silently became
    // the "previous reading" the consult screen measured today against.
    const patientIds = await ensureDemoPatients(client, journeys.length + TRIAGE_PROFILES.length);
    const floorPatientIds = patientIds.slice(0, journeys.length);
    const triagePatientIds = patientIds.slice(journeys.length);
    const doctors = await pickDoctors(client);
    const now = Date.now();
    const at = (minsAgo) => new Date(now - minsAgo * MINUTE).toISOString();

    // Bulk inserts, not a loop of round trips: the seeder runs against a remote
    // pooler and ~200 sequential statements inside one transaction is long
    // enough for the connection to be dropped mid-way.
    const visitRows = journeys.map((journey, i) => ({
      journey,
      patientId: floorPatientIds[i],
      finalStatus: journey.steps[journey.steps.length - 1][0],
      appointmentTime: `${String(8 + (i % 4)).padStart(2, "0")}:${String((i * 7) % 60).padStart(2, "0")}`,
    }));

    const inserted = await client.query(
      `INSERT INTO giniflow_visits
         (patient_id, visit_date, current_status, results_status, category, blocked_reason,
          assigned_sd_id, assigned_doctor_id, appointment_time, is_demo)
       SELECT t.patient_id, COALESCE($9::date, (NOW() AT TIME ZONE 'Asia/Kolkata')::date), t.current_status,
              t.results_status, t.category, t.blocked_reason, t.sd_id, t.doctor_id, t.appt_time, TRUE
         FROM UNNEST($1::int[], $2::text[], $3::text[], $4::text[], $5::text[],
                     $6::int[], $7::int[], $8::time[])
           AS t(patient_id, current_status, results_status, category, blocked_reason,
                sd_id, doctor_id, appt_time)
       ON CONFLICT (patient_id, visit_date) DO NOTHING
       RETURNING id, patient_id`,
      [
        visitRows.map((v) => v.patientId),
        visitRows.map((v) => v.finalStatus),
        visitRows.map((v) => v.journey.results || "none"),
        visitRows.map((v) => v.journey.category),
        visitRows.map((v) => v.journey.blocked || null),
        visitRows.map((v) => (v.journey.sd ? doctors.sd : null)),
        visitRows.map((v) => (v.journey.doctor ? doctors.chief : null)),
        visitRows.map((v) => v.appointmentTime),
        date,
      ],
    );

    const idByPatient = new Map(inserted.rows.map((r) => [r.patient_id, r.id]));
    const byKey = {};
    const events = [];
    for (const row of visitRows) {
      const visitId = idByPatient.get(row.patientId);
      if (!visitId) continue;
      byKey[row.journey.key] = visitId;
      for (const [status, minsAgo] of row.journey.steps) {
        events.push({
          visitId,
          status,
          actorRole: ACTOR_FOR[status] || "system",
          occurredAt: at(minsAgo),
          meta:
            status === "with_vitals"
              ? { vitals: { bp: "143/90", weight: 116.8 } }
              : { [DEMO_MARKER]: true },
        });
      }
    }

    await client.query(
      `INSERT INTO giniflow_visit_events (visit_id, status, actor_role, occurred_at, meta)
       SELECT * FROM UNNEST($1::uuid[], $2::text[], $3::text[], $4::timestamptz[], $5::jsonb[])`,
      [
        events.map((e) => e.visitId),
        events.map((e) => e.status),
        events.map((e) => e.actorRole),
        events.map((e) => e.occurredAt),
        events.map((e) => JSON.stringify(e.meta)),
      ],
    );

    // The chart behind each card: biomarkers on the appointment, the lab table,
    // diagnoses, medications, vitals, the MO's note and their proposals. Without
    // it every consult screen opened on a wall of "nothing recorded" boxes.
    const { rows: floorDay } = await client.query(
      `SELECT COALESCE($1::date, (NOW() AT TIME ZONE 'Asia/Kolkata')::date)::text AS d`,
      [date],
    );
    const floorDate = floorDay[0].d;

    let consults = 0;
    for (const row of visitRows) {
      const visitId = idByPatient.get(row.patientId);
      if (!visitId) continue;
      const { rows: who } = await client.query(`SELECT name, file_no FROM patients WHERE id = $1`, [
        row.patientId,
      ]);
      consults += await seedConsultFor(client, {
        visitId,
        patientId: row.patientId,
        patientName: who[0].name,
        fileNo: who[0].file_no,
        category: row.journey.category,
        sdId: doctors.sd,
        chiefId: doctors.chief,
        visitDate: floorDate,
      });
    }

    let labOrders = 0;
    for (const order of LAB_ORDERS) {
      const visitId = byKey[order.journey];
      if (!visitId) continue;
      const created = await client.query(
        `INSERT INTO giniflow_lab_orders
           (visit_id, ordered_by, urgency, payment_status, amount_total, sample_status,
          created_at, updated_at, uploaded_at)
         VALUES ($1, $2, 'today', $3, $4, $5, $6, $6, $7) RETURNING id`,
        [
          visitId,
          doctors.chief,
          order.paymentStatus,
          order.tests.reduce((sum, [, price]) => sum + price, 0),
          order.sampleStatus,
          at(order.minutes),
          order.uploadedMinutesAgo ? at(order.uploadedMinutesAgo) : null,
        ],
      );
      if (order.events?.length) {
        await client.query(
          `INSERT INTO giniflow_lab_order_events (lab_order_id, track, status, actor_role, occurred_at)
           SELECT $1, * FROM UNNEST($2::text[], $3::text[], $4::text[], $5::timestamptz[])`,
          [
            created.rows[0].id,
            order.events.map((e) => e[0]),
            order.events.map((e) => e[1]),
            order.events.map((e) => (e[0] === "payment" ? "reception" : "lab")),
            order.events.map((e) => at(e[2])),
          ],
        );
      }
      await client.query(
        `INSERT INTO giniflow_lab_order_tests (lab_order_id, test_name, price)
         SELECT $1, * FROM UNNEST($2::text[], $3::numeric[])`,
        [created.rows[0].id, order.tests.map((t) => t[0]), order.tests.map((t) => t[1])],
      );
      labOrders++;
    }

    // Tomorrow, for the triage board. Written inside the same transaction as the
    // floor, so a demo day is all-or-nothing.
    const { rows: nextDay } = await client.query(
      `SELECT (COALESCE($1::date, (NOW() AT TIME ZONE 'Asia/Kolkata')::date) + 1)::date::text AS d`,
      [date],
    );
    const triage = await seedTriageDay(client, triagePatientIds, nextDay[0].d);

    await client.query("COMMIT");

    // The triage day's VISIT rows are built the same way the board builds them
    // on open — through the appointment sync, not by hand — so the seeder can
    // never produce a shape the real path would not (18-TRIAGE-BOARD-PLAN §3.2b).
    await syncAppointmentsToFlow({ date: triage.triageDate, db });
    const categorised = await autoCategoriseDay(triage.triageDate, { db });

    // `lifestyle_flagged` lives on the visit, which only exists once the sync
    // above has run — so it is stamped here rather than with the appointment.
    if (triage.lifestyleFileNos.length) {
      await db.query(
        `UPDATE giniflow_visits v SET lifestyle_flagged = TRUE
           FROM patients p
          WHERE p.id = v.patient_id AND v.visit_date = $1::date AND p.file_no = ANY($2::text[])`,
        [triage.triageDate, triage.lifestyleFileNos],
      );
    }

    const skipped = visitRows
      .filter((r) => !idByPatient.get(r.patientId))
      .map((r) => r.journey.key);
    return {
      visits: Object.keys(byKey).length,
      events: events.length,
      labOrders,
      consults,
      triage: {
        date: triage.triageDate,
        appointments: triage.created,
        categorised: categorised.updated,
      },
      skipped,
      ...(skipped.length
        ? {
            note: `${skipped.length} journey(s) skipped — a visit already exists for that patient today`,
          }
        : {}),
    };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

// Removes only rows this seeder created. Never date-wide: once check-in ships,
// a date-wide delete here would wipe the live floor (GF-01).
export async function cleanDemoDay(db = pool) {
  assertDemoAllowed();
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    // Scoped by the demo file-number prefix, so a real patient can never be
    // caught by any of the deletes below.
    const demoPatients = await client.query(
      `SELECT id FROM patients WHERE file_no LIKE $1 || '%'`,
      [DEMO_FILE_PREFIX],
    );
    const demoIds = demoPatients.rows.map((r) => r.id);

    // `is_demo` alone is no longer enough: reception's walk-in check-in creates
    // an ordinary visit, so a smoke run leaves one behind that is not flagged —
    // and the patient delete below then fails on its foreign key, which leaves
    // demo people sitting in production.
    const { rowCount } = await client.query(
      `DELETE FROM giniflow_visits WHERE is_demo OR patient_id = ANY($1::int[])`,
      [demoIds],
    );

    // A finalized demo consult writes into the CHART — `consultations` and
    // `medications` — because that is the point: the consultant station has one
    // prescription history and does not keep a demo copy of it. Those rows
    // reference the demo patient, so deleting the patient fails on the foreign
    // key, and a failed clean leaves demo people sitting in production.
    //
    if (demoIds.length) {
      // The pharmacy station marks a collection row per medicine, and those
      // reference both the patient and the medication — so they have to go
      // first, or the medications delete below fails on the foreign key and the
      // clean leaves demo people sitting in production.
      await client.query(`DELETE FROM medicine_collections WHERE patient_id = ANY($1::int[])`, [
        demoIds,
      ]);
      await client.query(`DELETE FROM medications WHERE patient_id = ANY($1::int[])`, [demoIds]);
      await client.query(`DELETE FROM vitals WHERE patient_id = ANY($1::int[])`, [demoIds]);
      await client.query(`DELETE FROM diagnoses WHERE patient_id = ANY($1::int[])`, [demoIds]);
      await client.query(`DELETE FROM lab_results WHERE patient_id = ANY($1::int[])`, [demoIds]);
      // The consult seed writes a report document per lab date, and documents
      // reference the patient — so they go with them or the patient delete
      // fails on the foreign key and demo people stay in production.
      await client.query(`DELETE FROM documents WHERE patient_id = ANY($1::int[])`, [demoIds]);
      await client.query(`DELETE FROM consultations WHERE patient_id = ANY($1::int[])`, [demoIds]);
    }

    // The triage day's appointments. They carry no is_demo flag — the column
    // does not exist — so they are scoped to the demo patients, and they have to
    // go AFTER the visits above, which reference them.
    if (demoIds.length) {
      await client.query(`DELETE FROM appointments WHERE patient_id = ANY($1::int[])`, [demoIds]);
    }

    // Reception's walk-in check-in writes the hospital's own booking record, so
    // a smoke run leaves one behind unless it is cleaned with the patient.
    await client.query(`DELETE FROM walkin_bookings WHERE file_no LIKE $1 || '%'`, [
      DEMO_FILE_PREFIX,
    ]);

    const patients = await client.query(`DELETE FROM patients WHERE file_no LIKE $1 || '%'`, [
      DEMO_FILE_PREFIX,
    ]);
    await client.query("COMMIT");
    return { deleted: rowCount, demoPatientsRemoved: patients.rowCount };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}
