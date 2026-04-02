// Canonical name mapping for lab results — ensures consistent names across all routes
// so outcomes page, visit page, and OPD page all show the same data.
const CANONICAL_MAP = {
  "hba1c": "HbA1c", "glycated hemoglobin": "HbA1c", "a1c": "HbA1c", "glycated haemoglobin": "HbA1c",
  "fbs": "FBS", "fasting glucose": "FBS", "fasting blood sugar": "FBS", "fpg": "FBS", "fasting plasma glucose": "FBS",
  "ldl": "LDL", "ldl cholesterol": "LDL", "ldl-c": "LDL", "ldl cholesterol-direct": "LDL",
  "hdl": "HDL", "hdl cholesterol": "HDL",
  "triglycerides": "Triglycerides", "tg": "Triglycerides",
  "creatinine": "Creatinine", "s.creatinine": "Creatinine", "serum creatinine": "Creatinine",
  "egfr": "eGFR", "gfr": "eGFR", "estimated gfr": "eGFR",
  "tsh": "TSH", "thyroid stimulating hormone": "TSH",
  "haemoglobin": "Haemoglobin", "hemoglobin": "Haemoglobin", "hb": "Haemoglobin",
  "uacr": "UACR", "urine acr": "UACR", "microalbumin": "UACR",
  "vitamin d": "Vitamin D", "25-oh vitamin d": "Vitamin D", "vit d": "Vitamin D",
  "vitamin b12": "Vitamin B12", "b12": "Vitamin B12",
  "sgpt (alt)": "SGPT (ALT)", "alt": "SGPT (ALT)", "sgpt": "SGPT (ALT)",
  "sgot (ast)": "SGOT (AST)", "ast": "SGOT (AST)", "sgot": "SGOT (AST)",
  "ppbs": "PPBS", "post prandial": "PPBS",
  "ferritin": "Ferritin", "crp": "CRP", "alp": "ALP",
  "non-hdl": "Non-HDL", "non hdl": "Non-HDL",
  "t3": "T3", "total t3": "T3", "t4": "T4", "total t4": "T4", "free t4": "T4",
};

export const getCanonical = (name) =>
  CANONICAL_MAP[(name || "").toLowerCase().trim()] || null;
