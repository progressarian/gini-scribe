export const UNRANKED_CLINICAL_RANK = 50;
export const SUPPLEMENT_CLINICAL_RANK = 90;
export const EXTERNAL_CLINICAL_RANK = 99;

export const CLINICAL_ORDER = [
  {
    key: "nephropathy",
    rank: 7,
    label: "Nephropathy",
    pattern:
      /nephropath|albuminuria|micro ?albumin|\bckd\b|\bdkd\b|\besrd\b|chronic kidney|kidney disease|renal (disease|failure|impairment)/i,
  },
  {
    key: "neuropathy",
    rank: 8,
    label: "Neuropathy",
    pattern: /neuropath|\bdpn\b|polyneurit|paraesthes|paresthes|autonomic dysfunction/i,
  },
  {
    key: "retinopathy",
    rank: 9,
    label: "Retinopathy",
    pattern: /retinopath|maculopath|macular (oedema|edema|degeneration)|\bnpdr\b|\bpdr\b/i,
  },
  {
    key: "cva",
    rank: 4,
    label: "CVA",
    pattern:
      /\bcva\b|\btia\b|stroke|cerebrovascular|cerebral (infarct|haemorrhage|hemorrhage|ischemia)|transient ischemic|hemiplegia|hemiparesis/i,
  },
  {
    key: "pvd",
    rank: 5,
    label: "PVD",
    pattern:
      /\bpvd\b|\bpad\b|peripheral (arterial|vascular)|claudication|\babi\b|diabetic foot|foot ulcer|gangrene/i,
  },
  {
    key: "cad",
    rank: 3,
    label: "CAD",
    pattern:
      /\bcad\b|\bihd\b|\bacs\b|\bcabg\b|\bpci\b|coronary|angina|myocardial|ischemic heart|ischaemic heart|heart failure|\bhfref\b|\bhfpef\b|cardiomyopath|stent|angioplasty/i,
  },
  {
    key: "hypercholesterolemia",
    rank: 6,
    label: "Hypercholesterolemia",
    pattern:
      /hypercholesterol|hyperlipid|dyslipid|cholesterol|\bhcn\b|\bldl\b|triglycerid|lipid|statin/i,
  },
  {
    key: "obesity",
    rank: 2,
    label: "Overweight & central obesity",
    pattern: /obes|overweight|adiposity|metabolic syndrome|\bbmi\b|central (obesity|adiposity)/i,
  },
  {
    key: "masld",
    rank: 11,
    label: "MASLD",
    pattern: /\bmasld\b|\bmafld\b|\bnafld\b|\bnash\b|fatty liver|steatohepat|steatosis/i,
  },
  {
    key: "hypertension",
    rank: 10,
    label: "Hypertension",
    pattern: /hypertens|\bhtn\b|(high|raised|elevated) blood pressure/i,
  },
  {
    key: "diabetes",
    rank: 1,
    label: "Diabetes",
    pattern:
      /diabet|\bdm\b|\bdm[12]\b|\bt[123]dm\b|type ?[12] ?dm|type ?3c|\bmody\b|\blada\b|prediabet|hyperglyc|impaired (glucose|fasting)|insulin resistance/i,
  },
  {
    key: "thyroid",
    rank: 12,
    label: "Thyroid",
    pattern: /thyroid|hashimoto|graves|goit(er|re)|myx(o)?edema/i,
  },
];

export const CLINICAL_RANK_BY_KEY = CLINICAL_ORDER.reduce((acc, e) => {
  acc[e.key] = e.rank;
  return acc;
}, {});

export function clinicalKey(text) {
  const t = String(text || "").toLowerCase();
  if (!t.trim()) return null;
  for (const entry of CLINICAL_ORDER) {
    if (entry.pattern.test(t)) return entry.key;
  }
  return null;
}

export function clinicalRank(text) {
  const key = clinicalKey(text);
  return key ? CLINICAL_RANK_BY_KEY[key] : UNRANKED_CLINICAL_RANK;
}

export function clinicalRankForDiagnosis(dx) {
  if (dx && Number.isFinite(Number(dx.clinical_rank))) return Number(dx.clinical_rank);
  return clinicalRank(`${dx?.diagnosis_id || ""} ${dx?.label || dx?.name || ""}`);
}

export default {
  CLINICAL_ORDER,
  CLINICAL_RANK_BY_KEY,
  UNRANKED_CLINICAL_RANK,
  SUPPLEMENT_CLINICAL_RANK,
  EXTERNAL_CLINICAL_RANK,
  clinicalKey,
  clinicalRank,
  clinicalRankForDiagnosis,
};
