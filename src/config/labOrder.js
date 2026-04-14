// ── Canonical Lab / Report Order ─────────────────────────────────────────────
// Single source of truth for how lab panels and biomarkers are ordered across
// the entire app. The order mirrors the medication/diagnosis grouping used in
// `server/utils/medicationSort.js` and `server/utils/diagnosisSort.js` so that
// labs, diagnoses and meds for the same body system sit visually adjacent on
// the patient record (Diabetes labs ↔ Diabetes meds, Kidney labs ↔ ACE/ARB,
// Lipid labs ↔ Statins, etc.).
//
// If you add a new lab test or panel anywhere in the app, update THIS file
// and `labOrder.md` at the project root together — every consumer (Visit page
// panels, Outcomes charts, Sidebar, Assess page chips, dashboard tiles) reads
// from here.

// ── LAB_PANELS ──────────────────────────────────────────────────────────────
// Used by VisitLabsPanel.jsx to group lab_results into named sections.
// `keys` are lowercase substring matchers tested against canonical_name OR
// test_name. Order of panels = display order on screen.
export const LAB_PANELS = [
  {
    id: "diabetes_glycaemic",
    name: "Diabetes & Glycaemic Control",
    keys: [
      "hb_a1c",
      "hba1c",
      "glycated_hb",
      "glycated hemoglobin",
      "mean_blood_glucose",
      "mean blood glucose",
      "fasting_blood_sugar",
      "fasting blood sugar",
      "fbg",
      "fbs",
      "post_prandial",
      "post prandial",
      "ppbs",
      "ppbg",
      "ppg",
      "fasting_insulin",
      "fasting insulin",
      "insulin",
      "c_peptide",
      "c-peptide",
      "c peptide",
      "homa_ir",
      "homa-ir",
      "homa ir",
    ],
  },
  {
    id: "kidney_renal",
    name: "Renal Function Test (RFT)",
    keys: [
      "creatinine,_serum",
      "creatinine, serum",
      "creatinine_serum",
      "creatinine_(serum",
      "glomerular_filtration",
      "glomerular filtration",
      "egfr",
      "e-gfr",
      "urea",
      "bun",
      "uric_acid",
      "uric acid",
      "sodium",
      "potassium",
      "chloride",
      "bicarbonate",
    ],
  },
  {
    id: "kidney_uacr",
    name: "Microalbumin / Creatinine Ratio",
    keys: [
      "microalbumin/creatinine",
      "microalbumin_/",
      "microalbumin",
      "uacr",
      "urine_acr",
      "urine acr",
      "creatinine_(urine",
      "creatinine (urine",
    ],
  },
  {
    id: "lipid_profile",
    name: "Lipid Profile",
    keys: [
      "total_cholesterol",
      "total cholesterol",
      "triglyceride",
      "hdl_cholesterol",
      "hdl cholesterol",
      "ldl_cholesterol",
      "ldl cholesterol",
      "vldl_cholesterol",
      "vldl cholesterol",
      "non_hdl",
      "non hdl",
      "non-hdl",
      "ldl_/_hdl",
      "ldl / hdl",
      "total_/_hdl",
      "total / hdl",
    ],
  },
  {
    id: "liver_lft",
    name: "Liver Function Test (LFT)",
    keys: [
      "sgpt",
      "alt",
      "sgot",
      "ast",
      "alkaline_phosphatase",
      "alkaline phosphatase",
      "alp",
      "gamma_gt",
      "gamma gt",
      "ggt",
      "bilirubin",
      "albumin",
      "total_protein",
      "total protein",
    ],
  },
  {
    id: "thyroid",
    name: "Thyroid",
    keys: [
      "tsh",
      "free_t3",
      "free t3",
      "free_t4",
      "free t4",
      "ft3",
      "ft4",
      "t3",
      "t4",
      "anti_tpo",
      "anti-tpo",
      "anti_thyro",
      "anti-thyro",
    ],
  },
  {
    id: "cardiac_inflam",
    name: "Cardiac / Inflammation",
    keys: ["hs_crp", "hs-crp", "hscrp", "crp", "nt_probnp", "nt-probnp", "ntprobnp", "bnp"],
  },
  {
    id: "cbc",
    name: "Complete Blood Count (CBC)",
    keys: [
      "haemoglobin",
      "hemoglobin",
      "hematocrit",
      "rbc",
      "mcv",
      "mch",
      "mchc",
      "wbc",
      "neutrophil",
      "lymphocyte",
      "eosinophil",
      "basophil",
      "monocyte",
      "platelet",
    ],
  },
  {
    id: "vitamins_minerals",
    name: "Vitamins & Minerals",
    keys: [
      "vitamin_d",
      "vitamin d",
      "vit_d",
      "25-oh",
      "vitamin_b12",
      "vitamin b12",
      "vit_b12",
      "folate",
      "iron",
      "ferritin",
      "tibc",
      "transferrin",
      "calcium",
      "phosphate",
      "phosphorus",
      "pth",
      "magnesium",
    ],
  },
  {
    id: "urine_other",
    name: "Urine / Other",
    keys: ["urine_r", "urine r/m", "urine routine", "hb_electrophoresis", "hb electrophoresis"],
  },
];

// ── LAB_ORDER_CHIPS ─────────────────────────────────────────────────────────
// Flat ordered list of test names shown as quick-pick chips on the Assess page
// "Order Labs" UI. Order = canonical lab order so chips group naturally by
// body system as you scan left-to-right.
export const LAB_ORDER_CHIPS = [
  // Diabetes & Glycaemic Control
  "HbA1c",
  "FBS",
  "PPBS",
  "Fasting Insulin",
  "C-Peptide",
  "HOMA-IR",
  // Kidney / Renal
  "RFT",
  "UACR",
  "K+",
  "Na+",
  // Lipids
  "Lipid Panel",
  // Liver
  "LFT",
  // Thyroid
  "TSH",
  "FT3/FT4",
  // Cardiac / Inflammation
  "hs-CRP",
  "NT-proBNP",
  // CBC
  "CBC",
  // Vitamins & Minerals
  "Vit D",
  "Vit B12",
  "Iron Studies",
  "Ca+",
  "Phosphate",
  "PTH",
  // Urine / Other
  "Urine R/M",
  "HbElectrophoresis",
  // Endocrine / Hormonal
  "Cortisol",
  "Testosterone",
  "AMH",
  "LH/FSH",
  "PSA",
  // Imaging & Screening
  "Fundus",
  "ABI",
  "VPT",
  "ECG",
  "Echo",
  "USG Abdomen",
  "Doppler",
  "DEXA",
  "NCS/EMG",
];

// ── KEY_BIOMARKERS ──────────────────────────────────────────────────────────
// Short list of "headline" biomarkers shown in the Visit sidebar and dashboard
// tiles. Order = canonical lab order. VisitSidebar attaches its own units +
// flag thresholds — see src/components/visit/VisitSidebar.jsx.
export const KEY_BIOMARKERS = ["HbA1c", "FBS", "Creatinine", "eGFR", "LDL", "TSH", "Haemoglobin"];

// ── LAB_PACKAGES ────────────────────────────────────────────────────────────
// Pre-defined investigation packages (Assess page "📦" buttons). Tests within
// each package follow canonical order.
export const LAB_PACKAGES = [
  {
    label: "📦 DM Panel",
    tests: ["HbA1c", "FBS", "PPBS", "Fasting Insulin", "C-Peptide", "RFT", "UACR", "Lipid Panel"],
  },
  {
    label: "📦 Renal",
    tests: ["Creatinine", "eGFR", "BUN", "Electrolytes", "Urine ACR"],
  },
  {
    label: "📦 Lipid",
    tests: ["Total Cholesterol", "LDL", "HDL", "Triglycerides", "VLDL"],
  },
  {
    label: "📦 Thyroid",
    tests: ["TSH", "Free T3", "Free T4", "Anti-TPO"],
  },
  {
    label: "📦 Annual",
    tests: [
      "HbA1c",
      "FBS",
      "RFT",
      "Urine R/M",
      "Lipid Panel",
      "LFT",
      "TSH",
      "CBC",
      "Vit D",
      "Vit B12",
    ],
  },
];
