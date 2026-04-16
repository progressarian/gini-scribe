// Test name normalization map — maps AI variations to canonical names for outcomes matching
export const NORMALIZE_TEST = (() => {
  const map = {};
  const add = (canonical, ...aliases) =>
    aliases.forEach((a) => {
      map[a.toLowerCase().trim()] = canonical;
    });
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
  );
  add(
    "PPBS",
    "post prandial blood sugar",
    "pp glucose",
    "ppg",
    "ppbs",
    "post prandial glucose",
    "pp blood sugar",
    "blood sugar pp",
    "glucose pp",
    "2hr pp glucose",
    "pp2bs",
  );
  add(
    "Total Cholesterol",
    "total cholesterol",
    "cholesterol total",
    "cholesterol, total",
    "serum cholesterol",
    "t.cholesterol",
  );
  add(
    "LDL",
    "ldl cholesterol",
    "ldl-c",
    "ldl-cholesterol",
    "ldl cholesterol (direct)",
    "ldl direct",
    "low density lipoprotein",
  );
  add(
    "HDL",
    "hdl cholesterol",
    "hdl-c",
    "hdl-cholesterol",
    "hdl cholesterol (direct)",
    "high density lipoprotein",
  );
  add("Triglycerides", "triglycerides", "triglyceride", "tg", "trigs", "serum triglycerides");
  add("VLDL", "vldl cholesterol", "vldl-c", "vldl", "very low density lipoprotein");
  add("Non-HDL", "non-hdl cholesterol", "non hdl cholesterol", "nonhdl", "non-hdl", "non hdl");
  add(
    "Creatinine",
    "creatinine",
    "serum creatinine",
    "creatinine, serum",
    "s. creatinine",
    "creatinine (serum)",
  );
  add("BUN", "blood urea nitrogen", "bun", "urea", "blood urea", "serum urea");
  add("Uric Acid", "uric acid", "serum uric acid", "uric acid, serum", "s. uric acid");
  add("eGFR", "egfr", "estimated gfr", "gfr", "glomerular filtration rate");
  add(
    "UACR",
    "uacr",
    "urine albumin creatinine ratio",
    "microalbumin",
    "urine microalbumin",
    "albumin creatinine ratio",
  );
  add("Sodium", "sodium", "na", "na+", "serum sodium");
  add("Potassium", "potassium", "k", "k+", "serum potassium");
  add("Calcium", "calcium", "ca", "serum calcium", "calcium, total");
  add(
    "TSH",
    "tsh",
    "thyroid stimulating hormone",
    "serum tsh",
    "tsh ultrasensitive",
    "tsh (ultrasensitive)",
  );
  add("T3", "t3", "total t3", "triiodothyronine");
  add("T4", "t4", "total t4", "thyroxine");
  add("Free T3", "free t3", "ft3");
  add("Free T4", "free t4", "ft4", "free thyroxine");
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
  );
  add(
    "Direct Bilirubin",
    "direct bilirubin",
    "bilirubin direct",
    "bilirubin, direct",
    "conjugated bilirubin",
  );
  add("Albumin", "albumin", "serum albumin", "s. albumin");
  add("Total Protein", "total protein", "protein total", "serum total protein", "s. protein");
  add("Hemoglobin", "hemoglobin", "haemoglobin", "hb", "hgb");
  add(
    "WBC",
    "wbc",
    "white blood cells",
    "total wbc",
    "total leucocyte count",
    "tlc",
    "leucocyte count",
  );
  add("RBC", "rbc", "red blood cells", "total rbc", "erythrocyte count");
  add("Platelets", "platelets", "platelet count", "plt");
  add("ESR", "esr", "erythrocyte sedimentation rate", "sed rate");
  add("CRP", "crp", "c-reactive protein", "hs-crp", "c reactive protein");
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
  );
  add("Vitamin B12", "vitamin b12", "vit b12", "b12", "cyanocobalamin", "cobalamin");
  add("Ferritin", "ferritin", "serum ferritin", "s. ferritin");
  add("Iron", "iron", "serum iron", "s. iron", "iron, serum");
  add("TIBC", "tibc", "total iron binding capacity", "iron binding capacity");
  add("Fasting Insulin", "fasting insulin", "insulin fasting", "serum insulin", "insulin");
  add("C-Peptide", "c-peptide", "c peptide", "c-peptide fasting");
  add("PSA", "psa", "prostate specific antigen");
  add("Phosphorus", "phosphorus", "phosphate", "serum phosphorus", "inorganic phosphorus");
  add(
    "Total Testosterone",
    "total testosterone",
    "testosterone total",
    "testosterone, total",
    "serum testosterone",
    "testosterone",
  );
  add("Free Testosterone", "free testosterone", "testosterone free", "testosterone, free");
  add("Cortisol", "cortisol", "serum cortisol", "cortisol morning", "cortisol am");
  add("LH", "lh", "luteinizing hormone", "luteinising hormone");
  add("FSH", "fsh", "follicle stimulating hormone");
  add("Prolactin", "prolactin", "serum prolactin");
  add("AMH", "amh", "anti mullerian hormone", "anti-mullerian hormone", "anti müllerian hormone");
  add("Estradiol", "estradiol", "e2", "oestradiol", "serum estradiol");
  add("Progesterone", "progesterone", "serum progesterone");
  add("DHEAS", "dheas", "dhea-s", "dehydroepiandrosterone sulfate", "dhea sulfate");
  add("IGF-1", "igf-1", "igf1", "insulin-like growth factor", "insulin like growth factor 1");
  add(
    "Mean Plasma Glucose",
    "mean plasma glucose",
    "mean blood glucose",
    "average blood glucose",
    "estimated average glucose",
  );
  add("RBS", "rbs", "random blood sugar", "random glucose", "random blood glucose");
  add("Indirect Bilirubin", "indirect bilirubin", "unconjugated bilirubin", "bilirubin indirect");
  add("PCV", "pcv", "packed cell volume", "hematocrit", "haematocrit", "hct");
  add("Homocysteine", "homocysteine", "serum homocysteine");
  add("Lipoprotein(a)", "lipoprotein(a)", "lp(a)", "lpa", "lipoprotein a");
  add("D-Dimer", "d-dimer", "d dimer");
  add("Procalcitonin", "procalcitonin", "pct");
  add("Fructosamine", "fructosamine", "glycated albumin");
  add("MCV", "mcv", "mean corpuscular volume");
  add("MCH", "mch", "mean corpuscular hemoglobin", "mean corpuscular haemoglobin");
  add("MCHC", "mchc", "mean corpuscular hemoglobin concentration");
  return map;
})();

export const normalizeTestName = (name) => {
  if (!name) return name;
  const lower = name.toLowerCase().trim();
  return NORMALIZE_TEST[lower] || name;
};
