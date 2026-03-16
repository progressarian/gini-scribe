// Condition templates with biomarkers, auto-detect rules, and intake questions
export const CONDITIONS = {
  "Type 2 DM": {
    icon: "🩸",
    color: "#dc2626",
    biomarkers: ["HbA1c", "FBS", "PPBS", "C-Peptide", "Fasting Insulin", "HOMA-IR", "Fructosamine"],
    autoDetect: [
      { test: "HbA1c", op: ">", val: 6.5 },
      { test: "FBS", op: ">", val: 126 },
      { test: "PPBS", op: ">", val: 200 },
    ],
    questions: [
      { id: "dx_age", label: "Age at diagnosis", type: "text", placeholder: "e.g. 42" },
      {
        id: "dx_how",
        label: "How diagnosed",
        type: "select",
        options: ["Routine checkup", "Symptoms", "Incidental", "Hospitalization", "Screening"],
      },
      { id: "initial_hba1c", label: "Initial HbA1c", type: "text", placeholder: "e.g. 9.2%" },
      {
        id: "initial_rx",
        label: "Initial treatment",
        type: "text",
        placeholder: "e.g. Metformin 500mg BD",
      },
      {
        id: "insulin",
        label: "Insulin history",
        type: "select",
        options: ["Never used", "Currently on", "Used in past", "Only during hospitalization"],
      },
      {
        id: "hypo",
        label: "Hypoglycemia",
        type: "select",
        options: ["Never", "Rare (1-2/yr)", "Occasional (monthly)", "Frequent (weekly)"],
      },
      {
        id: "complications",
        label: "Complications",
        type: "multi",
        options: [
          "Retinopathy",
          "Nephropathy",
          "Neuropathy",
          "Foot ulcer",
          "Cardiac",
          "ED",
          "None known",
        ],
      },
      {
        id: "control",
        label: "Current control",
        type: "select",
        options: ["Well controlled", "Moderate", "Poorly controlled", "Unknown"],
      },
    ],
  },
  Hypertension: {
    icon: "💓",
    color: "#7c3aed",
    biomarkers: ["BP Systolic", "BP Diastolic", "Creatinine", "eGFR", "K+", "Na+"],
    autoDetect: [
      { test: "BP Systolic", op: ">", val: 140, vitalKey: "bp_sys" },
      { test: "BP Diastolic", op: ">", val: 90, vitalKey: "bp_dia" },
    ],
    questions: [
      { id: "dx_age", label: "Age at diagnosis", type: "text", placeholder: "" },
      { id: "highest_bp", label: "Highest BP", type: "text", placeholder: "e.g. 180/110" },
      {
        id: "target_organ",
        label: "Target organ damage",
        type: "multi",
        options: ["LVH", "Retinopathy", "CKD", "Stroke", "None"],
      },
      {
        id: "compliance",
        label: "Compliance",
        type: "select",
        options: ["Regular", "Sometimes misses", "Often misses", "Self-adjusts"],
      },
    ],
  },
  Hypothyroid: {
    icon: "🦋",
    color: "#6366f1",
    biomarkers: ["TSH", "Free T3", "Free T4", "Anti-TPO"],
    autoDetect: [{ test: "TSH", op: ">", val: 5 }],
    questions: [
      { id: "dx_age", label: "Age at diagnosis", type: "text", placeholder: "" },
      { id: "last_tsh", label: "Last TSH", type: "text", placeholder: "e.g. 5.2" },
      { id: "current_dose", label: "Thyroxine dose", type: "text", placeholder: "e.g. 75 mcg" },
      {
        id: "symptoms",
        label: "Symptoms",
        type: "multi",
        options: [
          "Fatigue",
          "Weight gain",
          "Hair loss",
          "Cold intolerance",
          "Constipation",
          "None",
        ],
      },
    ],
  },
  Hyperthyroid: {
    icon: "🦋",
    color: "#6366f1",
    biomarkers: ["TSH", "Free T3", "Free T4", "Anti-TPO", "TRAb"],
    autoDetect: [{ test: "TSH", op: "<", val: 0.4 }],
    questions: [
      { id: "dx_age", label: "Age at diagnosis", type: "text", placeholder: "" },
      {
        id: "symptoms",
        label: "Symptoms",
        type: "multi",
        options: ["Palpitations", "Weight loss", "Tremor", "Heat intolerance", "Anxiety", "None"],
      },
    ],
  },
  Dyslipidemia: {
    icon: "🫀",
    color: "#f59e0b",
    biomarkers: ["Total Cholesterol", "LDL", "HDL", "Triglycerides", "VLDL", "Non-HDL"],
    autoDetect: [
      { test: "LDL", op: ">", val: 130 },
      { test: "Triglycerides", op: ">", val: 200 },
      { test: "Total Cholesterol", op: ">", val: 240 },
    ],
    questions: [
      {
        id: "type",
        label: "Type",
        type: "select",
        options: ["High LDL", "High TG", "Low HDL", "Mixed", "Familial"],
      },
      {
        id: "on_statin",
        label: "Statin",
        type: "select",
        options: ["Yes", "No — intolerant", "No — not prescribed", "Stopped"],
      },
      {
        id: "statin_se",
        label: "Side effects",
        type: "multi",
        options: ["None", "Muscle pain", "Elevated LFT", "GI symptoms"],
      },
    ],
  },
  Obesity: {
    icon: "⚖️",
    color: "#059669",
    biomarkers: ["BMI", "Waist circumference", "Weight", "Fasting Insulin", "HOMA-IR"],
    autoDetect: [],
    questions: [
      { id: "max_wt", label: "Max weight", type: "text", placeholder: "e.g. 105 kg" },
      {
        id: "onset",
        label: "Onset",
        type: "select",
        options: [
          "Childhood",
          "Adolescence",
          "After marriage",
          "Post-pregnancy",
          "Gradual",
          "Medication",
        ],
      },
      {
        id: "osa",
        label: "Sleep apnea",
        type: "select",
        options: ["No", "Snoring only", "Diagnosed OSA", "On CPAP"],
      },
    ],
  },
  PCOS: {
    icon: "♀️",
    color: "#e11d48",
    biomarkers: ["LH", "FSH", "Testosterone", "DHEAS", "AMH", "Fasting Insulin"],
    autoDetect: [],
    questions: [
      {
        id: "menstrual",
        label: "Menstrual pattern",
        type: "select",
        options: ["Regular", "Irregular", "Oligomenorrhea", "Amenorrhea"],
      },
      {
        id: "fertility",
        label: "Fertility",
        type: "select",
        options: ["Not trying", "No issues", "Difficulty", "IVF history", "Completed"],
      },
      {
        id: "features",
        label: "Features",
        type: "multi",
        options: ["Hirsutism", "Acne", "Hair thinning", "Acanthosis", "Weight gain"],
      },
    ],
  },
  CKD: {
    icon: "🫘",
    color: "#0d9488",
    biomarkers: ["Creatinine", "eGFR", "Urine ACR", "BUN", "K+", "Phosphate", "PTH"],
    autoDetect: [
      { test: "eGFR", op: "<", val: 60 },
      { test: "Creatinine", op: ">", val: 1.5 },
    ],
    questions: [
      {
        id: "stage",
        label: "Stage",
        type: "select",
        options: ["1", "2", "3a", "3b", "4", "5", "Dialysis", "Unknown"],
      },
      {
        id: "cause",
        label: "Cause",
        type: "select",
        options: ["Diabetic", "Hypertensive", "IgA", "PKD", "Unknown", "Other"],
      },
      {
        id: "nephro",
        label: "Nephrologist",
        type: "select",
        options: ["Yes-regular", "Yes-occasional", "No", "Referred"],
      },
    ],
  },
  CAD: {
    icon: "❤️",
    color: "#ef4444",
    biomarkers: ["NT-proBNP", "hs-CRP", "Troponin", "LDL"],
    autoDetect: [],
    questions: [
      {
        id: "type",
        label: "Type",
        type: "select",
        options: ["Stable angina", "ACS/MI", "Post-CABG", "Post-PCI", "Heart failure"],
      },
      { id: "ef", label: "Ejection fraction", type: "text", placeholder: "e.g. 55%" },
    ],
  },
  "Vit D Deficiency": {
    icon: "☀️",
    color: "#ca8a04",
    biomarkers: ["Vitamin D", "Calcium", "Phosphate"],
    autoDetect: [
      { test: "Vitamin D", op: "<", val: 30 },
      { test: "Vit D", op: "<", val: 30 },
    ],
    questions: [],
  },
  "B12 Deficiency": {
    icon: "💉",
    color: "#0ea5e9",
    biomarkers: ["Vitamin B12", "MCV", "Homocysteine"],
    autoDetect: [
      { test: "Vitamin B12", op: "<", val: 200 },
      { test: "Vit B12", op: "<", val: 200 },
    ],
    questions: [],
  },
  Other: {
    icon: "📋",
    color: "#64748b",
    biomarkers: [],
    autoDetect: [],
    questions: [
      { id: "name", label: "Condition", type: "text", placeholder: "e.g. Rheumatoid Arthritis" },
      {
        id: "status",
        label: "Status",
        type: "select",
        options: ["Active", "Remission", "Resolved", "Monitoring"],
      },
    ],
  },
};

export const CONDITION_NAMES = Object.keys(CONDITIONS).filter((k) => k !== "Other");

export const COMMON_SURGERIES = [
  "Appendectomy",
  "Cholecystectomy",
  "CABG",
  "PTCA/Stenting",
  "Hysterectomy",
  "C-Section",
  "Thyroidectomy",
  "Bariatric surgery",
  "Knee/Hip replacement",
  "Hernia repair",
  "Cataract surgery",
];

export const COMMON_ALLERGIES = [
  "Penicillin",
  "Sulfonamides",
  "NSAIDs",
  "Aspirin",
  "Metformin",
  "Contrast dye",
  "Iodine",
  "Latex",
  "None known",
];

export const CONDITIONS_LIST = [
  "Type 2 Diabetes",
  "Type 1 Diabetes",
  "Hypertension",
  "Thyroid",
  "PCOS",
  "Dyslipidemia",
  "CKD",
  "Obesity",
  "Fatty Liver",
  "CAD",
  "Asthma/COPD",
  "Diabetic Neuropathy",
  "Diabetic Nephropathy",
  "General Medicine",
  "Other",
];
