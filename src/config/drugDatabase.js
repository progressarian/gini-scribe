// ── Drug Database for Gini Scribe ───────────────────────────────────────────
// Defines medications with clinical grouping, drug class, brand names, and defaults

// Medication groups
export const MED_GROUPS = [
  { id: "diabetes", label: "Diabetes", icon: "💉" },
  { id: "kidney", label: "Kidney Protection", icon: "🫘" },
  { id: "bp", label: "Blood Pressure", icon: "💓" },
  { id: "lipids", label: "Lipids", icon: "🫀" },
  { id: "thyroid", label: "Thyroid", icon: "🦋" },
  { id: "supplement", label: "Supplements", icon: "💊" },
  { id: "external", label: "External Doctor", icon: "👨‍⚕️" },
];

// Diabetes drug classes
export const DIABETES_CLASSES = [
  { id: "insulin", label: "Insulin" },
  { id: "metformin", label: "Metformin" },
  { id: "sglt2", label: "SGLT2 Inhibitor" },
  { id: "glp1", label: "GLP-1 / GIP Agonist" },
  { id: "dpp4", label: "DPP-4 Inhibitor" },
  { id: "su", label: "Sulphonylurea" },
  { id: "other", label: "Other" },
];

// Timing options
export const TIMING_OPTIONS = [
  {
    value: "Empty stomach — 30 min before breakfast",
    label: "Empty stomach (30 min before breakfast)",
  },
  { value: "Before breakfast", label: "Before breakfast" },
  { value: "With breakfast", label: "With breakfast" },
  { value: "After breakfast", label: "After breakfast" },
  { value: "After lunch", label: "After lunch" },
  { value: "After dinner", label: "After dinner" },
  { value: "At night (after dinner)", label: "At night (after dinner)" },
  { value: "At bedtime", label: "At bedtime" },
  { value: "Once weekly (Sunday)", label: "Once weekly (Sunday)" },
];

// Drug database with defaults
export const DRUG_DATABASE = {
  // ── DIABETES MEDICATIONS ──────────────────────────────────────────────────
  metformin: {
    name: "Metformin",
    group: "diabetes",
    drugClass: "metformin",
    brands: ["Glycomet", "Glucophage", "Diamet", "Obimet", "Metafor"],
    defaultDose: "500mg",
    defaultFrequency: "BD",
    defaultTiming: "After meals",
    composition: "Metformin",
    warnings: ["Check eGFR — reduce dose if eGFR < 45, stop if < 30"],
  },
  "metformin-xr": {
    name: "Metformin XR",
    group: "diabetes",
    drugClass: "metformin",
    brands: ["Glycomet GP", "Diamet XR", "Gluconorm XR"],
    defaultDose: "500mg",
    defaultFrequency: "OD",
    defaultTiming: "After dinner",
    composition: "Metformin (Extended Release)",
    warnings: ["Check eGFR — reduce dose if eGFR < 45, stop if < 30"],
  },
  empagliflozin: {
    name: "Empagliflozin",
    group: "diabetes",
    drugClass: "sglt2",
    brands: ["Jardiance", "Synjardy"],
    defaultDose: "10mg",
    defaultFrequency: "OD",
    defaultTiming: "With breakfast",
    composition: "Empagliflozin",
    warnings: ["SGLT2 inhibitors not effective below eGFR 30"],
  },
  dapagliflozin: {
    name: "Dapagliflozin",
    group: "diabetes",
    drugClass: "sglt2",
    brands: ["Forxiga", "Daplo M", "Xigduo"],
    defaultDose: "10mg",
    defaultFrequency: "OD",
    defaultTiming: "With breakfast",
    composition: "Dapagliflozin",
    warnings: ["SGLT2 inhibitors not effective below eGFR 30"],
  },
  sitagliptin: {
    name: "Sitagliptin",
    group: "diabetes",
    drugClass: "dpp4",
    brands: ["Januvia", "Istavel"],
    defaultDose: "100mg",
    defaultFrequency: "OD",
    defaultTiming: "With breakfast",
    composition: "Sitagliptin",
  },
  vildagliptin: {
    name: "Vildagliptin",
    group: "diabetes",
    drugClass: "dpp4",
    brands: ["Galvus", "Zomelis"],
    defaultDose: "50mg",
    defaultFrequency: "BD",
    defaultTiming: "With meals",
    composition: "Vildagliptin",
  },
  glimepiride: {
    name: "Glimepiride",
    group: "diabetes",
    drugClass: "su",
    brands: ["Amaryl", "Glimpid", "Glycinorm"],
    defaultDose: "1mg",
    defaultFrequency: "OD",
    defaultTiming: "Before breakfast",
    composition: "Glimepiride",
    warnings: [
      "High hypoglycaemia risk in elderly (>70y). Consider lower dose or switch to DPP-4.",
    ],
  },
  glipizide: {
    name: "Glipizide",
    group: "diabetes",
    drugClass: "su",
    brands: ["Glucotrol", "Glynase"],
    defaultDose: "5mg",
    defaultFrequency: "OD",
    defaultTiming: "Before breakfast",
    composition: "Glipizide",
    warnings: ["High hypoglycaemia risk in elderly (>70y)."],
  },
  gliclazide: {
    name: "Gliclazide",
    group: "diabetes",
    drugClass: "su",
    brands: ["Diamicron", "Gliclazide MR"],
    defaultDose: "80mg",
    defaultFrequency: "OD",
    defaultTiming: "Before breakfast",
    composition: "Gliclazide",
    warnings: ["High hypoglycaemia risk in elderly (>70y)."],
  },
  insulin_glargine: {
    name: "Insulin Glargine",
    group: "diabetes",
    drugClass: "insulin",
    brands: ["Lantus", "Toujeo", "Basaglar"],
    defaultDose: "10u",
    defaultFrequency: "OD",
    defaultTiming: "At bedtime",
    composition: "Insulin Glargine",
    warnings: ["Counsel patient on hypoglycaemia management and emergency kit."],
  },
  insulin_degludec: {
    name: "Insulin Degludec",
    group: "diabetes",
    drugClass: "insulin",
    brands: ["Tresiba"],
    defaultDose: "10u",
    defaultFrequency: "OD",
    defaultTiming: "At bedtime",
    composition: "Insulin Degludec",
    warnings: ["Counsel patient on hypoglycaemia management and emergency kit."],
  },
  insulin_aspart: {
    name: "Insulin Aspart",
    group: "diabetes",
    drugClass: "insulin",
    brands: ["NovoRapid", "Fiasp"],
    defaultDose: "As prescribed",
    defaultFrequency: "BD/TDS",
    defaultTiming: "Before meals",
    composition: "Insulin Aspart",
    warnings: ["Counsel patient on hypoglycaemia management and emergency kit."],
  },
  tirzepatide: {
    name: "Tirzepatide",
    group: "diabetes",
    drugClass: "glp1",
    brands: ["Mounjaro"],
    defaultDose: "2.5mg",
    defaultFrequency: "Once weekly",
    defaultTiming: "Once weekly",
    composition: "Tirzepatide",
  },
  semaglutide: {
    name: "Semaglutide",
    group: "diabetes",
    drugClass: "glp1",
    brands: ["Ozempic", "Rybelsus", "Wegovy"],
    defaultDose: "0.5mg",
    defaultFrequency: "Once weekly",
    defaultTiming: "Once weekly",
    composition: "Semaglutide",
  },

  // ── KIDNEY PROTECTION ──────────────────────────────────────────────────────
  ramipril: {
    name: "Ramipril",
    group: "kidney",
    drugClass: "ace",
    brands: ["Cardace", "Hopace", "Ramipril"],
    defaultDose: "2.5mg",
    defaultFrequency: "OD",
    defaultTiming: "After breakfast",
    composition: "Ramipril",
    clinicalNoteTemplate: "Renal protection — UACR {value}",
  },
  telmisartan: {
    name: "Telmisartan",
    group: "kidney",
    drugClass: "arb",
    brands: ["Telma", "Telmikind", "Telma-AM"],
    defaultDose: "40mg",
    defaultFrequency: "OD",
    defaultTiming: "After breakfast",
    composition: "Telmisartan",
    clinicalNoteTemplate: "Renal protection — UACR {value}",
  },

  // ── BLOOD PRESSURE ────────────────────────────────────────────────────────
  amlodipine: {
    name: "Amlodipine",
    group: "bp",
    drugClass: "ccb",
    brands: ["Norvasc", "Amlokind", "Amlopres", "Amlopress"],
    defaultDose: "5mg",
    defaultFrequency: "OD",
    defaultTiming: "After dinner",
    composition: "Amlodipine",
  },
  metoprolol: {
    name: "Metoprolol",
    group: "bp",
    drugClass: "beta-blocker",
    brands: ["Betaloc", "Metolar", "Lopressor"],
    defaultDose: "25mg",
    defaultFrequency: "BD",
    defaultTiming: "After meals",
    composition: "Metoprolol Succinate",
  },
  bisoprolol: {
    name: "Bisoprolol",
    group: "bp",
    drugClass: "beta-blocker",
    brands: ["Concor", "Bisoprolol"],
    defaultDose: "2.5mg",
    defaultFrequency: "OD",
    defaultTiming: "After breakfast",
    composition: "Bisoprolol",
  },
  aspirin: {
    name: "Aspirin 75mg",
    group: "bp",
    drugClass: "antiplatelet",
    brands: ["Ecosprin", "Aspirin"],
    defaultDose: "75mg",
    defaultFrequency: "OD",
    defaultTiming: "After breakfast",
    composition: "Aspirin",
  },
  clopidogrel: {
    name: "Clopidogrel",
    group: "bp",
    drugClass: "antiplatelet",
    brands: ["Plavix", "Clopitab"],
    defaultDose: "75mg",
    defaultFrequency: "OD",
    defaultTiming: "After breakfast",
    composition: "Clopidogrel",
  },

  // ── LIPIDS ────────────────────────────────────────────────────────────────
  rosuvastatin: {
    name: "Rosuvastatin",
    group: "lipids",
    drugClass: "statin",
    brands: ["Crestor", "Rozavel", "Rosuvas"],
    defaultDose: "10mg",
    defaultFrequency: "OD",
    defaultTiming: "At night (after dinner)",
    composition: "Rosuvastatin",
    warnings: ["Document LDL target based on cardiovascular risk category."],
  },
  atorvastatin: {
    name: "Atorvastatin",
    group: "lipids",
    drugClass: "statin",
    brands: ["Lipitor", "Storvas", "Atorva"],
    defaultDose: "20mg",
    defaultFrequency: "OD",
    defaultTiming: "At night (after dinner)",
    composition: "Atorvastatin",
    warnings: ["Document LDL target based on cardiovascular risk category."],
  },
  fenofibrate: {
    name: "Fenofibrate",
    group: "lipids",
    drugClass: "fibrate",
    brands: ["Fenolip", "Tricor", "Lipicard"],
    defaultDose: "145mg",
    defaultFrequency: "OD",
    defaultTiming: "After dinner",
    composition: "Fenofibrate",
  },
  ezetimibe: {
    name: "Ezetimibe",
    group: "lipids",
    drugClass: "absorption",
    brands: ["Ezetrol", "Ezentia"],
    defaultDose: "10mg",
    defaultFrequency: "OD",
    defaultTiming: "At night",
    composition: "Ezetimibe",
  },

  // ── THYROID ───────────────────────────────────────────────────────────────
  levothyroxine: {
    name: "Levothyroxine",
    group: "thyroid",
    drugClass: "thyroid",
    brands: ["Thyronorm", "Eltroxin", "Thyrox", "Lethroxin"],
    defaultDose: "50mcg",
    defaultFrequency: "OD",
    defaultTiming: "Empty stomach — 30 min before breakfast",
    composition: "Levothyroxine",
    criticalNote:
      "Always on empty stomach, 30 minutes before breakfast. Food, calcium, iron block absorption.",
  },

  // ── SUPPLEMENTS ───────────────────────────────────────────────────────────
  "vitamin-d3": {
    name: "Vitamin D3 60,000 IU",
    group: "supplement",
    drugClass: "vitamin",
    brands: ["D-Rise", "Calshine", "Uprise-D3"],
    defaultDose: "1 sachet",
    defaultFrequency: "Once weekly",
    defaultTiming: "Once weekly (Sunday)",
    composition: "Cholecalciferol 60,000 IU",
  },
  "calcium-d3": {
    name: "Calcium + Vit D3",
    group: "supplement",
    drugClass: "mineral",
    brands: ["Shelcal", "Caltrate", "Calcimax"],
    defaultDose: "1 tablet",
    defaultFrequency: "OD",
    defaultTiming: "After lunch",
    composition: "Calcium + Vitamin D3",
  },
  "vitamin-b12": {
    name: "Vitamin B12",
    group: "supplement",
    drugClass: "vitamin",
    brands: ["Methylcobal", "Cobadex", "Neurobion"],
    defaultDose: "500mcg",
    defaultFrequency: "OD",
    defaultTiming: "After breakfast",
    composition: "Methylcobalamin",
    warning: "Check B12 — Metformin depletes B12 with long-term use (>3 years).",
  },
  "omega-3": {
    name: "Omega-3",
    group: "supplement",
    drugClass: "supplement",
    brands: ["Maxepa", "Omacor"],
    defaultDose: "1g",
    defaultFrequency: "OD-BD",
    defaultTiming: "After dinner",
    composition: "Omega-3 Fatty Acids",
  },
};

// Find drug by name or brand
export function findDrug(searchTerm) {
  const term = (searchTerm || "").toLowerCase().trim();

  // Try exact match on key
  if (DRUG_DATABASE[term]) {
    return DRUG_DATABASE[term];
  }

  // Try matching on name
  for (const [key, drug] of Object.entries(DRUG_DATABASE)) {
    if (drug.name.toLowerCase() === term) {
      return drug;
    }
  }

  // Try matching on brand names
  for (const [key, drug] of Object.entries(DRUG_DATABASE)) {
    if (drug.brands?.some((b) => b.toLowerCase().includes(term))) {
      return drug;
    }
  }

  // Try partial match on composition
  for (const [key, drug] of Object.entries(DRUG_DATABASE)) {
    if (drug.composition?.toLowerCase().includes(term)) {
      return drug;
    }
  }

  return null;
}

// Auto-detect group from medication name
export function detectGroupFromName(name) {
  const drug = findDrug(name);
  return drug?.group || "supplement";
}

// Auto-detect drug class from medication name
export function detectClassFromName(name) {
  const drug = findDrug(name);
  return drug?.drugClass || "other";
}

// Get default timing for a medication
export function getDefaultTiming(name) {
  const drug = findDrug(name);
  return drug?.defaultTiming || "After meals";
}

// Get default dose for a medication
export function getDefaultDose(name) {
  const drug = findDrug(name);
  return drug?.defaultDose || "";
}

// Get warnings for a medication
export function getWarnings(name) {
  const drug = findDrug(name);
  return drug?.warnings || [];
}

export default {
  MED_GROUPS,
  DIABETES_CLASSES,
  TIMING_OPTIONS,
  DRUG_DATABASE,
  findDrug,
  detectGroupFromName,
  detectClassFromName,
  getDefaultTiming,
  getDefaultDose,
  getWarnings,
};
