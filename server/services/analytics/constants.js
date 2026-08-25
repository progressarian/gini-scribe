export const ENGINE_VERSION = "1.0.0";

export const CONTINUITY_DAYS = 180;

export const RECENCY_BANDS = [
  { key: "0_3m", label: "Seen within 3 months", maxDays: 90 },
  { key: "3_6m", label: "3 to 6 months", maxDays: 180 },
  { key: "6_12m", label: "6 to 12 months", maxDays: 365 },
  { key: "gt_12m", label: "Over 12 months", maxDays: null },
];

export const VISIT_STATUSES_COUNTED = ["seen", "completed", "checkedin"];

export const HISTORY_START_DATE = "2023-01-01";

export const MARKERS = {
  hba1c: {
    label: "HbA1c",
    unit: "%",
    canonical: ["HbA1c"],
    min: 3,
    max: 20,
    decimals: 1,
    tier: 1,
  },
  fg: {
    label: "Fasting blood sugar",
    unit: "mg/dL",
    canonical: ["FBS"],
    min: 40,
    max: 600,
    decimals: 0,
    tier: 2,
  },
  ppbs: {
    label: "Post-prandial blood sugar",
    unit: "mg/dL",
    canonical: ["PPBS"],
    min: 40,
    max: 800,
    decimals: 0,
    tier: 2,
  },
  sbp: {
    label: "Systolic BP",
    unit: "mmHg",
    canonical: ["BP (mmHg)", "Systolic BP"],
    vitalsColumn: "bp_sys",
    min: 70,
    max: 260,
    decimals: 0,
    tier: 1,
  },
  dbp: {
    label: "Diastolic BP",
    unit: "mmHg",
    canonical: ["Diastolic BP"],
    vitalsColumn: "bp_dia",
    min: 40,
    max: 160,
    decimals: 0,
    tier: 3,
  },
  ldl: {
    label: "LDL cholesterol",
    unit: "mg/dL",
    canonical: ["LDL"],
    min: 10,
    max: 400,
    decimals: 0,
    tier: 2,
  },
  hdl: {
    label: "HDL cholesterol",
    unit: "mg/dL",
    canonical: ["HDL"],
    min: 10,
    max: 150,
    decimals: 0,
    tier: 2,
  },
  tg: {
    label: "Triglycerides",
    unit: "mg/dL",
    canonical: ["Triglycerides"],
    min: 20,
    max: 2000,
    decimals: 0,
    tier: 2,
  },
  nonhdl: {
    label: "Non-HDL cholesterol",
    unit: "mg/dL",
    canonical: ["Non-HDL"],
    min: 20,
    max: 500,
    decimals: 0,
    tier: 3,
  },
  tc: {
    label: "Total cholesterol",
    unit: "mg/dL",
    canonical: ["Total Cholesterol"],
    min: 50,
    max: 600,
    decimals: 0,
    tier: 3,
  },
  egfr: {
    label: "eGFR",
    unit: "mL/min/1.73m2",
    canonical: ["eGFR"],
    min: 1,
    max: 200,
    decimals: 0,
    tier: 2,
  },
  uacr: {
    label: "Urine albumin/creatinine ratio",
    unit: "mg/g",
    canonical: ["UACR"],
    min: 0,
    max: 5000,
    decimals: 1,
    tier: 2,
  },
  creatinine: {
    label: "Serum creatinine",
    unit: "mg/dL",
    canonical: ["Creatinine"],
    min: 0.1,
    max: 20,
    decimals: 2,
    tier: 3,
  },
  tsh: {
    label: "TSH",
    unit: "mIU/L",
    canonical: ["TSH"],
    min: 0.005,
    max: 150,
    decimals: 2,
    tier: 1,
  },
  weight: {
    label: "Weight",
    unit: "kg",
    canonical: ["Weight"],
    vitalsColumn: "weight",
    min: 25,
    max: 300,
    decimals: 1,
    tier: 3,
  },
  bmi: {
    label: "BMI",
    unit: "kg/m2",
    canonical: ["BMI"],
    vitalsColumn: "bmi",
    min: 10,
    max: 80,
    decimals: 1,
    tier: 3,
  },
  waist: {
    label: "Waist circumference",
    unit: "cm",
    canonical: ["Waist"],
    vitalsColumn: "waist",
    min: 40,
    max: 200,
    decimals: 1,
    tier: 3,
  },
  bodyfat: {
    label: "Body fat",
    unit: "%",
    canonical: ["Body Fat (%)"],
    vitalsColumn: "body_fat",
    min: 3,
    max: 70,
    decimals: 1,
    tier: 3,
  },
  homair: {
    label: "HOMA-IR",
    unit: "",
    canonical: ["HOMA-IR"],
    min: 0.1,
    max: 50,
    decimals: 2,
    tier: 3,
  },
  hb: {
    label: "Haemoglobin",
    unit: "g/dL",
    canonical: ["Haemoglobin", "Hemoglobin"],
    min: 3,
    max: 25,
    decimals: 1,
    tier: 3,
  },
  vitd: {
    label: "Vitamin D",
    unit: "ng/mL",
    canonical: ["Vitamin D"],
    min: 1,
    max: 200,
    decimals: 1,
    tier: 3,
  },
};

export const MARKER_KEYS = Object.keys(MARKERS);

export const CONDITION_GROUPS = [
  {
    key: "diabetes",
    label: "Diabetes (Type 1 & Type 2)",
    pattern: /^(type_?[12]_?(diabetes(_mellitus)?|dm)|dm[12]|t[12]dm|diabetes(_mellitus)?|lada)$/,
    headlineMarker: "hba1c",
    isComplication: false,
  },
  {
    key: "prediabetes",
    label: "Prediabetes",
    pattern: /(prediabetes|pre_diabetes|impaired_glucose|impaired_fasting)/,
    headlineMarker: "hba1c",
  },
  {
    key: "hypertension",
    label: "Hypertension",
    pattern: /(hypertension|^htn$)/,
    headlineMarker: "sbp",
  },
  {
    key: "masld",
    label: "Fatty liver disease (MASLD/MASH)",
    pattern: /(masld|^mash$|nafld|nash|fatty_liver|steatotic|steatohepatitis)/,
    headlineMarker: "bmi",
  },
  {
    key: "adiposity",
    label: "Obesity & adiposity",
    pattern: /(obesity|obese|adiposity|overweight)/,
    headlineMarker: "weight",
  },
  {
    key: "thyroid",
    label: "Thyroid disorder",
    pattern: /(hypothyroid|hyperthyroid|hashimoto|graves|thyroiditis|thyroid_associated)/,
    headlineMarker: "tsh",
  },
  {
    key: "dyslipidemia",
    label: "Dyslipidaemia",
    pattern: /(dyslipid|hyperlipid|hypercholester|hypertriglycer)/,
    headlineMarker: "ldl",
  },
  {
    key: "metabolic_syndrome",
    label: "Metabolic syndrome",
    pattern: /metabolic_syndrome/,
    headlineMarker: "bmi",
  },
  {
    key: "pcos",
    label: "PCOS / PCOD",
    pattern: /(pcos|pcod|polycystic)/,
    headlineMarker: "bmi",
  },
  {
    key: "cad",
    label: "Coronary artery disease",
    pattern: /(coronary|^cad$|^ihd$|myocardial_infarction|angina)/,
    headlineMarker: "ldl",
    isComplication: true,
  },
  {
    key: "ckd",
    label: "Chronic kidney disease / nephropathy",
    pattern: /(^ckd$|chronic_kidney|nephropathy|renal_failure|esrd|albuminuria)/,
    headlineMarker: "egfr",
    isComplication: true,
  },
  {
    key: "neuropathy",
    label: "Neuropathy",
    pattern: /neuropathy/,
    headlineMarker: "hba1c",
    isComplication: true,
  },
  {
    key: "retinopathy",
    label: "Retinopathy",
    pattern: /retinopathy/,
    headlineMarker: "hba1c",
    isComplication: true,
  },
  {
    key: "osa",
    label: "Obstructive sleep apnoea",
    pattern: /(obstructive_sleep|sleep_apn|^osas?$)/,
    headlineMarker: "bmi",
  },
  {
    key: "pvd",
    label: "Peripheral vascular disease",
    pattern: /(peripheral_vascular|^pvd$)/,
    headlineMarker: "ldl",
    isComplication: true,
  },
  {
    key: "cva",
    label: "Stroke / CVA",
    pattern: /(^cva$|stroke|cerebrovascular)/,
    headlineMarker: "sbp",
    isComplication: true,
  },
  {
    key: "gmi",
    label: "Genital mycotic infection",
    pattern: /(^gmi$|_gmi$|genital_mycotic)/,
    headlineMarker: "hba1c",
  },
  {
    key: "anaemia",
    label: "Anaemia",
    pattern: /(anemia|anaemia)/,
    headlineMarker: "hb",
  },
  {
    key: "bph",
    label: "Benign prostatic hyperplasia",
    pattern: /(^bph$|benign_prostatic)/,
    headlineMarker: null,
  },
  {
    key: "uti",
    label: "Urinary tract infection",
    pattern: /(^uti$|urinary_tract_infection|recurrent_uti)/,
    headlineMarker: null,
  },
];

export const COMPLICATION_KEYS = CONDITION_GROUPS.filter((g) => g.isComplication).map((g) => g.key);

export const AGE_BANDS = [
  { key: "0_17", label: "Under 18", min: 0, max: 17 },
  { key: "18_29", label: "18-29", min: 18, max: 29 },
  { key: "30_39", label: "30-39", min: 30, max: 39 },
  { key: "40_49", label: "40-49", min: 40, max: 49 },
  { key: "50_59", label: "50-59", min: 50, max: 59 },
  { key: "60_69", label: "60-69", min: 60, max: 69 },
  { key: "70_plus", label: "70 and over", min: 70, max: 130 },
];

export const OUTCOME_WINDOWS = [
  { key: "m3", label: "3 months", minDays: 60, maxDays: 150, targetDays: 90 },
  { key: "m6", label: "6 months", minDays: 150, maxDays: 270, targetDays: 180 },
  { key: "m12", label: "12 months", minDays: 270, maxDays: 450, targetDays: 365 },
];

export const BASELINE_WINDOW = { beforeDays: 180, afterDays: 14 };

export const OUTCOME_MARKERS = [
  "hba1c",
  "weight",
  "bmi",
  "waist",
  "ldl",
  "tg",
  "uacr",
  "egfr",
  "sbp",
  "fg",
];

export const WEIGHT_RESPONSE_THRESHOLDS = [5, 10, 15];

export const AUTOMATED_STOP_REASON =
  /(not in latest prescription|healthray:|report_extract:|dedup|superseded)/i;

export const GOAL_ATTAINMENT_MIN_VISITS = 3;

export const GOAL_ATTAINMENT_MARKERS = ["hba1c", "ldl", "sbp", "dbp"];
