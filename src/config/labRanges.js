// Fallback reference ranges shown on the Visit → Labs tab when the source lab
// report didn't include a range. Keys are canonical lab names from
// server/utils/labCanonical.js. Ranges are stated in the units the app
// already displays for each analyte (VisitLabsPanel renders them verbatim).
//
// Values are adult general-population reference ranges sourced from standard
// lab reporting conventions (Mayo, Quest, common Indian pathology labs). They
// are intended as a display hint only — clinical decisions should use the
// lab-provided range when available.

export const FALLBACK_RANGES = {
  // Diabetes & glycaemic
  HbA1c: "4.0 - 5.6 %",
  FBS: "70 - 100 mg/dL",
  PPBS: "< 140 mg/dL",
  RBS: "< 140 mg/dL",
  "C-Peptide": "0.9 - 7.1 ng/mL",
  "HOMA-IR": "< 2.0",

  // Lipids
  "Total Cholesterol": "< 200 mg/dL",
  LDL: "< 100 mg/dL",
  HDL: "> 40 mg/dL",
  Triglycerides: "< 150 mg/dL",
  "Non-HDL": "< 130 mg/dL",

  // Kidney / renal
  Creatinine: "0.6 - 1.2 mg/dL",
  eGFR: "> 60 mL/min/1.73m²",
  UACR: "< 30 mg/g",
  BUN: "7 - 20 mg/dL",
  Urea: "15 - 45 mg/dL",
  "Uric Acid": "3.5 - 7.2 mg/dL",
  Sodium: "135 - 145 mEq/L",
  Potassium: "3.5 - 5.0 mEq/L",

  // Liver
  "SGPT (ALT)": "< 40 U/L",
  "SGOT (AST)": "< 40 U/L",
  ALP: "44 - 147 U/L",
  Albumin: "3.5 - 5.0 g/dL",
  "Total Protein": "6.0 - 8.3 g/dL",

  // Thyroid
  TSH: "0.4 - 4.0 mIU/L",
  T3: "80 - 200 ng/dL",
  T4: "4.5 - 12.0 µg/dL",

  // Cardiac / inflammation
  CRP: "< 5 mg/L",
  "hs-CRP": "< 1 mg/L",
  "Pro-BNP": "< 125 pg/mL",

  // CBC
  Haemoglobin: "12 - 16 g/dL",
  WBC: "4000 - 11000 /µL",
  RBC: "4.0 - 5.5 million/µL",
  Platelets: "150000 - 400000 /µL",

  // Vitamins & minerals / iron studies
  "Vitamin D": "30 - 100 ng/mL",
  "Vitamin B12": "200 - 900 pg/mL",
  Iron: "60 - 170 µg/dL",
  TIBC: "240 - 450 µg/dL",
  "Transferrin Saturation": "20 - 50 %",
  Ferritin: "20 - 200 ng/mL",
  Calcium: "8.5 - 10.5 mg/dL",

  // Anthropometrics / vitals
  BMI: "18.5 - 24.9",
  "Systolic BP": "< 120 mmHg",
  "Diastolic BP": "< 80 mmHg",
  Waist: "< 90 cm",
};

// Try canonical name first, then fall back to a case-insensitive match on the
// raw test name so variants like "S. Ferritin" / "Serum Ferritin" still pick
// up the Ferritin fallback range.
export function getFallbackRange(canonical, testName) {
  if (canonical && FALLBACK_RANGES[canonical]) return FALLBACK_RANGES[canonical];
  if (!testName) return null;
  const tn = String(testName).trim().toLowerCase();
  for (const key of Object.keys(FALLBACK_RANGES)) {
    if (key.toLowerCase() === tn) return FALLBACK_RANGES[key];
  }
  return null;
}
