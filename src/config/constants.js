// Gini Pharmacy brand names for exact matching
export const GINI_BRANDS =
  "Thyronorm,Euthrox,Euthyrox,Telma,Telma AM,Telma H,Telma CT,Telma Beta,Concor,Concor AM,Concor T,Ecosprin AV,Ecosprin Gold,Atchol,Atchol F,Dytor,Dytor Plus,Amlong,Cetanil,Cetanil M,Ciplar LA,Glimy,Rosuvas CV,Dolo,Mixtard,Huminsulin,Lantus,Tresiba,Novorapid,Humalog,Clopitab,Dianorm,Glycomet,Amaryl,Jalra,Galvus,Forxiga,Jardiance,Pan D,Razo D,Shelcal,Calnex,Uprise D3,Stamlo,Cardivas,Atorva,Rozavel,Arkamin,Prazopress,Minipress,Lasix,Aldactone,Eltroxin,Thyrox,Cilacar,Amlokind,Telmikind,Metapure,Obimet,Gluconorm";

// Drug class -> biomarker relevance mapping for intelligent filtering
export const DRUG_BIOMARKER_MAP = {
  // Antidiabetics -> HbA1c, Fasting Glucose
  diabetes: {
    patterns:
      /glycomet|metformin|glizid|gliclazide|glimepiride|glimy|amaryl|galvus|vildagliptin|jalra|sitagliptin|forxiga|dapagliflozin|jardiance|empagliflozin|dianorm|gluconorm|cetanil|mixtard|huminsulin|lantus|tresiba|novorapid|humalog|insulin|ozempic|rybelsus|semaglutide|liraglutide|reclimet|istavel/i,
    biomarkers: ["hba1c", "fpg"],
  },
  // Weight-affecting drugs -> Weight (SGLT2i, GLP-1, Metformin)
  weight: {
    patterns:
      /forxiga|dapagliflozin|jardiance|empagliflozin|ozempic|rybelsus|semaglutide|liraglutide|trulicity|dulaglutide|victoza|saxenda|mounjaro|tirzepatide|metformin|glycomet|reclimet/i,
    biomarkers: ["weight"],
  },
  // Antihypertensives -> BP
  bp: {
    patterns:
      /telma|telmisartan|amlong|amlodipine|concor|bisoprolol|stamlo|cilacar|cilnidipine|arkamin|clonidine|prazopress|minipress|dytor|torsemide|lasix|furosemide|aldactone|metoprolol|atenolol|ramipril|enalapril|losartan|cardivas|carvedilol|ciplar|propranolol|metosartan/i,
    biomarkers: ["bp"],
  },
  // Statins/Lipid -> LDL, Triglycerides, HDL
  lipid: {
    patterns:
      /atchol|atorva|atorvastatin|rosuvas|rosuvastatin|rozavel|ecosprin|clopitab|fenofibrate|torglip/i,
    biomarkers: ["ldl", "triglycerides", "hdl"],
  },
  // Thyroid -> TSH
  thyroid: { patterns: /thyronorm|eltroxin|thyrox|euthrox|levothyroxine/i, biomarkers: ["tsh"] },
  // Nephroprotective -> eGFR, Creatinine, UACR
  kidney: {
    patterns:
      /forxiga|dapagliflozin|jardiance|empagliflozin|telma|telmisartan|ramipril|enalapril|losartan/i,
    biomarkers: ["egfr", "creatinine", "uacr"],
  },
};

export function getMedsForBiomarker(biomarkerKey, meds) {
  const relevant = [];
  for (const [cls, info] of Object.entries(DRUG_BIOMARKER_MAP)) {
    if (info.biomarkers.includes(biomarkerKey)) {
      meds.forEach((m) => {
        const name = (m.pharmacy_match || m.name || m || "").toString();
        if (info.patterns.test(name)) relevant.push(name);
      });
    }
  }
  return [...new Set(relevant)];
}

// Diagnosis colors and friendly labels
export const DC = {
  dm2: "#dc2626",
  htn: "#ea580c",
  cad: "#d97706",
  ckd: "#7c3aed",
  hypo: "#2563eb",
  obesity: "#92400e",
  dyslipidemia: "#0891b2",
};
export const FRIENDLY = {
  dm2: "Type 2 Diabetes (DM)",
  dm1: "Type 1 Diabetes (DM)",
  htn: "High Blood Pressure (Hypertension)",
  cad: "Heart Disease (CAD)",
  ckd: "Kidney Disease (CKD)",
  hypo: "Thyroid \u2014 Low (Hypothyroidism)",
  obesity: "Weight Management (Obesity)",
  dyslipidemia: "High Cholesterol (Dyslipidemia)",
  liver: "Fatty Liver (MASLD/NAFLD)",
  asthma: "Asthma",
  copd: "COPD",
  pcos: "PCOS",
  "overactive-bladder": "Overactive Bladder",
  "diabetic-neuropathy": "Diabetic Neuropathy",
  "diabetic-nephropathy": "Diabetic Nephropathy",
  "diabetic-retinopathy": "Diabetic Retinopathy",
  osas: "Sleep Apnea (OSAS)",
  gerd: "Acid Reflux (GERD)",
  ibs: "IBS",
  depression: "Depression",
  anxiety: "Anxiety",
  "subclinical-hypothyroidism": "Subclinical Hypothyroidism",
  hashimotos: "Hashimoto's Thyroiditis",
};

// Safe array accessor
export const sa = (obj, key) => (obj && Array.isArray(obj[key]) ? obj[key] : []);
// Safe to-string for test items
export const ts = (item) =>
  typeof item === "string"
    ? item
    : item?.test || item?.name || item?.marker || JSON.stringify(item);
