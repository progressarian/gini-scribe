/**
 * Lab test name normalization — shared canonical mapping.
 * Maps hundreds of test name variants to a single canonical name.
 *
 * Usage:
 *   import { normalizeTestName } from '../utils/labNormalization.js';
 *   const canonical = normalizeTestName("Glycated Hemoglobin"); // → "HbA1c"
 */

const map = {};
const add = (canonical, ...aliases) => {
  map[canonical.toLowerCase().trim()] = canonical; // canonical maps to itself
  aliases.forEach((a) => {
    map[a.toLowerCase().trim()] = canonical;
  });
};

// ── Diabetes ─────────────────────────────────────────────────────────────────
add(
  "HbA1c",
  "glycated hemoglobin",
  "glycated haemoglobin",
  "hba1c",
  "glycosylated hemoglobin",
  "a1c",
  "hemoglobin a1c",
  "haemoglobin a1c",
  "glycated hb",
  "hba1c (glycated haemoglobin)",
  "hba1c (glycosylated hemoglobin)",
  "hba1c (%)",
  "hba1c (previous)",
  "hb a1c",
  "hb a1c - glycated hb(glycated hemoglobin )",
  "hb a1c - glycated hb (glycated hemoglobin)",
  "hb a1c-glycated hb(glycated hemoglobin)",
);
add(
  "FBS",
  "fasting blood sugar",
  "fasting glucose",
  "fasting plasma glucose",
  "fpg",
  "fbs",
  "fbg",
  "fasting blood glucose",
  "blood sugar fasting",
  "glucose fasting",
  "blood glucose fasting",
  "fasting plasma glucose (fpg)",
  "fpg (mg/dl)",
  "fasting blood sugar .",
);
add(
  "PPBS",
  "post prandial blood sugar",
  "pp glucose",
  "ppg",
  "ppbs",
  "pp",
  "ppbg",
  "post prandial glucose",
  "pp blood sugar",
  "blood sugar pp",
  "glucose pp",
  "2hr pp glucose",
  "pp2bs",
  "post-prandial glucose",
  "post-prandial blood glucose",
  "post-prandial blood sugar",
  "post prandial blood glucose",
  "postprandial blood glucose",
  "postprandial blood sugar",
  "postprandial glucose",
  "1hr post meal blood sugar",
  "2hr post meal blood sugar",
  "post prandial glucose (ppg)",
  "pp (postprandial)",
);
add(
  "RBS",
  "random blood sugar",
  "rbs",
  "rbg",
  "random blood glucose",
  "spot blood sugar",
  "spot glucose",
  "spot",
  "spot bg",
  "spot blood glucose",
  "rbg (4:10pm)",
  "spot glucose (4:10pm)",
);

// ── Insulin / C-Peptide / HOMA ───────────────────────────────────────────────
add(
  "Fasting Insulin",
  "fasting insulin",
  "insulin fasting",
  "serum insulin",
  "insulin",
  "fpi",
  "fasting plasma insulin",
  "fasting plasma insulin (uiu/ml)",
  "plasma insulin",
  "insulin f",
  "insulin fasting (uiu/ml)",
);
add(
  "C-Peptide",
  "c-peptide",
  "c peptide",
  "c-peptide fasting",
  "c-peptide (fasting)",
  "fasting c-peptide",
  "fcp",
  "random c-peptide",
  "fasting c peptide (ng/ml)",
);
add("HOMA-IR", "homa-ir", "homa ir", "homair", "homa - ir (nmol/l)", "homa - ir");
add("HOMA-Beta", "homa-beta", "homa beta", "homa-b", "homa b", "homa - b (nmol/l)");

// ── Lipids ───────────────────────────────────────────────────────────────────
add(
  "Total Cholesterol",
  "total cholesterol",
  "cholesterol total",
  "cholesterol, total",
  "serum cholesterol",
  "t.cholesterol",
  "cholesterol",
);
add(
  "LDL",
  "ldl cholesterol",
  "ldl-c",
  "ldl-cholesterol",
  "ldl cholesterol (direct)",
  "ldl direct",
  "low density lipoprotein",
  "ldl cholesterol, calculated",
  "ldl - c (mg/dl)",
);
add(
  "HDL",
  "hdl cholesterol",
  "hdl-c",
  "hdl-cholesterol",
  "hdl cholesterol (direct)",
  "high density lipoprotein",
);
add(
  "Triglycerides",
  "triglycerides",
  "triglyceride",
  "tg",
  "trigs",
  "serum triglycerides",
  "triglycerides (mg/dl)",
  "triglycerides (tg)",
  "triglycerides(tg)",
);
add(
  "VLDL",
  "vldl cholesterol",
  "vldl-c",
  "vldl",
  "very low density lipoprotein",
  "vldl cholesterol,calculated",
);
add(
  "Non-HDL",
  "non-hdl cholesterol",
  "non hdl cholesterol",
  "nonhdl",
  "non-hdl",
  "non hdl",
  "nhdl",
  "non-hdl (mg/dl)",
  "non hdl cholestrol",
  "non hdl cholesterol",
);

// ── Renal ────────────────────────────────────────────────────────────────────
add(
  "Creatinine",
  "creatinine",
  "serum creatinine",
  "creatinine, serum",
  "s. creatinine",
  "s creatinine",
  "creatinine (serum)",
  "creatinine (mg/dl)",
  "creatinine (crt)",
  "creatinine(crt)",
);
add(
  "BUN",
  "blood urea nitrogen",
  "bun",
  "urea",
  "blood urea",
  "serum urea",
  "blood urea nitrogen (bun)",
  "urea, blood",
  "blood urea (bu)",
);
add("Uric Acid", "uric acid", "serum uric acid", "uric acid, serum", "s. uric acid");
add(
  "eGFR",
  "egfr",
  "estimated gfr",
  "gfr",
  "glomerular filtration rate",
  "egfr (ml/ minute)",
  "egfr (ml/minute/1.73msq.)",
  "egfr (gfr)",
  "egfr(gfr)",
);
add(
  "UACR",
  "uacr",
  "urine albumin creatinine ratio",
  "microalbumin",
  "urine microalbumin",
  "albumin creatinine ratio",
  "microalbumin/creatinine ratio",
  "urine acr",
  "urine a:c ratio (mg/l)",
);

// ── Electrolytes ─────────────────────────────────────────────────────────────
add("Sodium", "sodium", "na", "na+", "serum sodium", "s sodium", "s. sodium", "sodium, serum");
add(
  "Potassium",
  "potassium",
  "k",
  "k+",
  "serum potassium",
  "s. potassium",
  "s.potassium",
  "potassium, serum",
);
add("Calcium", "calcium", "ca", "serum calcium", "calcium, total", "c calcium", "c.calcium");
add(
  "Phosphorus",
  "phosphorus",
  "phosphate",
  "serum phosphorus",
  "inorganic phosphorus",
  "phosphorous",
);
add("Magnesium", "magnesium", "serum magnesium", "mg");
add("Chloride", "chloride", "serum chloride", "serum chlorides");
add("Bicarbonate", "bicarbonate", "bicarb", "hco3");

// ── Thyroid ──────────────────────────────────────────────────────────────────
add(
  "TSH",
  "tsh",
  "thyroid stimulating hormone",
  "serum tsh",
  "tsh ultrasensitive",
  "tsh (ultrasensitive)",
  "tsh ( iiird generation )",
);
add("T3", "t3", "total t3", "triiodothyronine", "triiodothyronine, total (t3)");
add("T4", "t4", "total t4", "thyroxine", "thyroxine, total (t4)");
add("Free T3", "free t3", "ft3");
add("Free T4", "free t4", "ft4", "free thyroxine");
add(
  "Anti-TPO",
  "anti-tpo",
  "anti tpo",
  "tpo",
  "tpo antibody",
  "anti-tpo ab",
  "anti-tpo antibody",
  "anti tpo antibodies",
  "anti thyroid peroxidase antibodies",
);
add(
  "Anti-TG",
  "anti-tg",
  "anti tg",
  "anti-tg ab",
  "anti-tg antibody",
  "anti-tga",
  "atg",
  "tg antibody",
  "thyroglobulin antibody",
  "anti thyroglobulin",
  "anti-thyroglobulin",
  "anti thyroglobulin antibodies",
  "anti thyroglobulin antibody",
  "anti-thyroglobulin antibody",
  "anti thyroid globulin",
  "anti-thyroglobulin (anti-tg)",
  "anti thyroglobulin (anti-tg)",
);
add(
  "TSH Receptor Ab",
  "tsh receptor ab",
  "tsh receptor antibodies",
  "tsh receptor antibody",
  "anti-tshr",
  "anti tshr",
  "anti-tsh receptor",
  "anti-tsh receptor antibody",
  "anti tsh receptor antibodies",
  "anti tsh",
  "anti tsh r",
  "trab",
  "tshr",
);
add("Thyroglobulin", "thyroglobulin");

// ── Liver ────────────────────────────────────────────────────────────────────
add(
  "SGPT (ALT)",
  "sgpt",
  "alt",
  "sgpt (alt)",
  "alanine aminotransferase",
  "sgpt(alt)",
  "alt (sgpt)",
  "alanine transaminase",
  "sgpt (alt), serum",
  "sgpt (alanine amino transferase - alt)",
  "pt/sgpt",
  "sgpt/alt",
);
add(
  "SGOT (AST)",
  "sgot",
  "ast",
  "sgot (ast)",
  "aspartate aminotransferase",
  "sgot(ast)",
  "ast (sgot)",
  "aspartate transaminase",
  "sgot (ast), serum",
  "sgot (aspartate amino transferase - ast)",
  "ot",
  "ot/sgot",
  "sgot/ast",
);
add(
  "ALP",
  "alp",
  "alkaline phosphatase",
  "alkaline phosphatase (alp)",
  "alk phosphatase",
  "alkaline phosphatase (alp), serum",
);
add("GGT", "ggt", "gamma gt", "gamma glutamyl transferase", "gamma-glutamyl transferase");
add(
  "Total Bilirubin",
  "total bilirubin",
  "bilirubin total",
  "bilirubin, total",
  "s. bilirubin",
  "serum bilirubin",
  "bilirubin",
);
add(
  "Direct Bilirubin",
  "direct bilirubin",
  "bilirubin direct",
  "bilirubin, direct",
  "conjugated bilirubin",
);
add("Indirect Bilirubin", "indirect bilirubin", "bilirubin, indirect", "unconjugated bilirubin");
add("Albumin", "albumin", "serum albumin", "s. albumin");
add(
  "Total Protein",
  "total protein",
  "protein total",
  "serum total protein",
  "s. protein",
  "protein, total",
  "total proteins",
);
add("Globulin", "globulin");

// ── Hematology ───────────────────────────────────────────────────────────────
add("Hemoglobin", "hemoglobin", "haemoglobin", "hb", "hgb", "haemoglobin (hb)");
add(
  "WBC",
  "wbc",
  "white blood cells",
  "total wbc",
  "total leucocyte count",
  "tlc",
  "leucocyte count",
  "total leucocyte count",
  "tlc (total leucocyte count)",
);
add("RBC", "rbc", "red blood cells", "total rbc", "erythrocyte count", "rbc count", "r.b.c.");
add("Platelets", "platelets", "platelet count", "plt", "pl");
add("ESR", "esr", "erythrocyte sedimentation rate", "sed rate");
add("CRP", "crp", "c-reactive protein", "hs-crp", "c reactive protein");
add("MCV", "mcv", "mean corpuscular volume");
add("MCH", "mch", "mean corpuscular hemoglobin");
add("MCHC", "mchc", "mean corpuscular hemoglobin concentration");
add("Hematocrit", "hematocrit", "pcv", "packed cell volume", "pcv / haematocrit value");
add("INR", "inr", "international normalized ratio");

// ── Micronutrients ───────────────────────────────────────────────────────────
add(
  "Vitamin D",
  "vitamin d",
  "25-hydroxy vitamin d",
  "25-oh vitamin d",
  "vit d",
  "25 hydroxy vitamin d",
  "vitamin d3",
  "vitamin d total",
  "vitamin d 25 hydroxy",
  "25(oh) vitamin d",
  "25(oh)d3",
  "25-hydroxy cholecalciferol (25-oh) vitamin d3",
  "vitamin d 25 ( oh )",
  "serum vitamin d total, 25-hydroxy",
);
add(
  "Vitamin B12",
  "vitamin b12",
  "vit b12",
  "b12",
  "cyanocobalamin",
  "cobalamin",
  "vitamin b12 level",
);
add("Ferritin", "ferritin", "serum ferritin", "s. ferritin");
add("Iron", "iron", "serum iron", "s. iron", "iron, serum", "fe");
add("TIBC", "tibc", "total iron binding capacity", "iron binding capacity");
add("Folate", "folate", "folic acid");
add("Transferrin Saturation", "transferrin saturation");

// ── Hormones ─────────────────────────────────────────────────────────────────
add(
  "Cortisol",
  "cortisol",
  "serum cortisol",
  "cortisol morning",
  "cortisol am",
  "cortisol 8am",
  "8 am cortisol",
  "8am cortisol",
  "morning cortisol",
  "cortisol [morning]",
  "cortisol m",
  "fasting cortisol",
);
add("ACTH", "acth", "adrenocorticotropic hormone");
add("Prolactin", "prolactin", "prl", "serum prolactin", "macroprolactin");
add("Testosterone", "testosterone", "total testosterone", "testosterone total");
add("Free Testosterone", "free testosterone");
add("DHEAS", "dheas", "dehydroepiandrosterone sulfate");
add("AMH", "amh", "anti-mullerian hormone", "anti mullerian hormone", "anti mullerian hormones");
add("FSH", "fsh", "follicle stimulating hormone");
add("LH", "lh", "luteinizing hormone", "leutinizing hormone");
add("Estradiol", "estradiol", "e2");
add("Progesterone", "progesterone");
add("PTH", "pth", "ipth", "parathyroid hormone");
add("IGF-1", "igf-1", "igf1", "igf", "insulin like growth factor");
add(
  "PSA",
  "psa",
  "prostate specific antigen",
  "total psa",
  "psa total",
  "prostate specific antigen (total) psa",
  "s. psa",
);
add("Beta HCG", "beta hcg", "hcg");
add("Growth Hormone", "growth hormone", "gh");

// ── Cardiac ──────────────────────────────────────────────────────────────────
add("Troponin T", "troponin t", "trop t");
add("Troponin I", "troponin i");
add("Pro-BNP", "pro-bnp", "pro bnp", "bnp");
add("CK-MB", "ck-mb", "creatine kinase mb");
add("Homocysteine", "homocysteine");
add("Lipoprotein(a)", "lipoprotein(a)", "lp(a)");

// ── Autoimmune ───────────────────────────────────────────────────────────────
add("RA Factor", "ra factor", "ra", "rheumatoid factor");
add("ANA", "ana", "antinuclear antibody");
add("Anti-CCP", "anti-ccp", "anti ccp");
add("Anti DS DNA", "anti ds dna", "anti dsdna");
add(
  "tTG IgA",
  "ttg",
  "ttg-iga",
  "ttg iga",
  "ttg ab",
  "ttga",
  "ttgiga",
  "anti-ttg",
  "anti ttg",
  "iga-ttg",
  "iga ttg",
  "anti-ttgiga",
  "ttgiga",
);

// ── Diabetes Antibodies ──────────────────────────────────────────────────────
add(
  "GAD-65",
  "gad-65",
  "gad 65",
  "gad65",
  "gad",
  "gad-65 antibody",
  "gad 65 antibody",
  "gad65 antibody",
  "gad 65 ab",
);
add(
  "IA-2",
  "ia-2",
  "ia2",
  "ia-2 antibody",
  "ia2 antibodies",
  "ia2 ab",
  "anti-ia2",
  "anti ia-2",
  "anti ia2",
);
add(
  "IAA",
  "iaa",
  "anti insulin",
  "anti-insulin antibody",
  "anti insulin ab",
  "anti insulin antibody",
);
add("ZnT8", "znt8", "zinc transporter 8");

// ── Bone Markers ─────────────────────────────────────────────────────────────
add("P1NP", "p1np", "total p1np", "pinp");
add(
  "Beta-CrossLaps",
  "beta-crosslaps",
  "beta-crosslap",
  "beta crosslaps",
  "beta crosslap",
  "beta cross laps",
  "beta cross lap",
  "betacrosslaps",
  "betacross laps",
);
add("Calcitonin", "calcitonin");

// ── Urine Tests ──────────────────────────────────────────────────────────────
add("Urine Creatinine", "urine creatinine", "creatinine (urine spot test)");
add("Urine Protein", "urine protein", "24 hr urine protein");
add(
  "Estimated Average Glucose",
  "estimated average glucose",
  "estimated average glucose (eag)",
  "eag",
);

// ── Vitals stored in lab_results ─────────────────────────────────────────────
// These are vital signs but HealthRay sometimes sends them as lab rows.
add("Weight", "weight", "body weight", "weight (kg)", "wt", "wt.");
add("Height", "height", "height (cm)", "ht", "ht.");
add("BMI", "bmi", "body mass index", "bmi (kg/m2)", "bmi (kg/m²)");
add("Waist", "waist", "waist circumference", "waist (cm)", "waist circumference (cm)");
add("Body Fat", "body fat", "body fat %", "body fat percentage", "% body fat");
add("Systolic BP", "systolic bp", "sbp", "systolic blood pressure", "bp systolic");
add("Diastolic BP", "diastolic bp", "dbp", "diastolic blood pressure", "bp diastolic");

// ── Vitals-sheet names (with units in parentheses) ───────────────────────────
// These are NOT added as canonical entries — they map to existing canonical names above.
// Weight, Height, BMI, BP, Waist, Body Fat from vitals sheet are vital signs, not labs.
// But some get stored in lab_results if classification misses them.
// Keep them mapped so outcomes queries can find them.

// ── Fibroscan ─────────────────────────────────────────────────────────────────
add("FIB4", "fib4", "fib-4", "fibrosis-4", "fibrosis 4", "fib 4");
add(
  "Fibroscan CAP",
  "fibroscan cap",
  "cap",
  "cap (fibroscan)",
  "controlled attenuation parameter",
  "cap score",
  "fibroscan cap score",
  "fibroscan cap (db/m)",
);
add(
  "Fibroscan LSM",
  "fibroscan lsm",
  "lsm",
  "liver stiffness measurement",
  "liver stiffness",
  "ekpa",
  "ekpa (fibroscan)",
  "ekpa/f2",
  "fibroscan ekpa",
  "fibroscan ekpa/f2",
  "fibroscan kpa",
  "fibroscan e",
  "liver stiffness (kpa)",
  "lsm (kpa)",
);

// ── Screening tests (kept as-is for the screenings panel) ────────────────────
add("VPT", "vpt", "vibration perception threshold");
add(
  "VPT Left",
  "vpt left",
  "vpt l",
  "vpt - left",
  "vibration perception threshold left",
  "vpt (left)",
);
add(
  "VPT Right",
  "vpt right",
  "vpt r",
  "vpt - right",
  "vibration perception threshold right",
  "vpt (right)",
);
add("ABI", "abi", "ankle brachial index");
add("ABI Left", "abi left", "abi l", "abi - left", "ankle brachial index left", "abi (left)");
add("ABI Right", "abi right", "abi r", "abi - right", "ankle brachial index right", "abi (right)");
add("Retinopathy", "retinopathy");
add("ECG", "ecg");
add("Doppler", "doppler");
add("DEXA", "dexa");
add("Ultrasound", "ultrasound");
add("X-Ray", "x-ray");
add("MRI", "mri");
add("Fibroscan", "fibroscan");

// ── Osmolarity ───────────────────────────────────────────────────────────────
add(
  "Serum Osmolarity",
  "serum osmolarity",
  "s osmolarity",
  "s. osmolarity",
  "serum osmolality",
  "s osmolality",
  "plasma osmolality",
  "plasma osmolarity",
);
add(
  "Urine Osmolarity",
  "urine osmolarity",
  "u osmolarity",
  "u. osmolarity",
  "urine osmolality",
  "urinary osmolality",
  "urinary osmolarity",
);

// ── Misc ─────────────────────────────────────────────────────────────────────
add("Amylase", "amylase", "s.amylase", "s amylase", "serum amylase", "ams");
add("Lipase", "lipase", "s.lipase", "serum lipase");
add("LDH", "ldh", "lactate dehydrogenase");
add("Fibrinogen", "fibrinogen", "fib");
add("Fructosamine", "fructosamine", "fructosamine sugar", "serum fructosamine");
add("Tacrolimus", "tacrolimus");
add("Mentzer Index", "mentzer index", "mi");
add("Haptoglobin", "haptoglobin");
add("VMA", "vma", "vanillylmandelic acid");
add("AFP", "afp", "alpha fetoprotein");
add("CEA", "cea", "carcinoembryonic antigen");
add("CA-125", "ca-125", "ca 125");
add("CA 19-9", "ca 19-9", "ca 19.9", "ca19.9");

export const NORMALIZE_TEST = map;

// Strip embedded date suffix like "(13/12/2025)" or "(14/1/26)" before lookup.
// Some lab reports embed the collection date in the test name itself.
function stripEmbeddedDate(str) {
  return str.replace(/\s*\(\d{1,2}\/\d{1,2}\/\d{2,4}\)\s*$/i, "").trim();
}

export function normalizeTestName(name) {
  if (!name) return name;
  const cleaned = stripEmbeddedDate(name);
  const lower = cleaned.toLowerCase().trim();
  // Try exact match first, then with underscores→spaces (lab_healthray format)
  return map[lower] || map[lower.replace(/_/g, " ")] || cleaned;
}
