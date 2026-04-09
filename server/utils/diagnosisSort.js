// ── Diagnosis Sorting Utility ──────────────────────────────────────────────
// Implements clinical ordering rules from diagnosis-rx-brief

// Category rank: Primary → Complication → Comorbidity → External → Monitoring
const CATEGORY_RANK = {
  primary: 1,
  complication: 2,
  comorbidity: 3,
  external: 4,
  monitoring: 5,
};

// Complication severity: Nephropathy > Neuropathy > Retinopathy > Foot > Other
const COMPLICATION_SEVERITY = {
  nephropathy: 1,
  neuropathy: 2,
  retinopathy: 3,
  foot: 4,
  other: 5,
};

// Comorbidity order: HTN → Dyslipidemia → Obesity → NAFLD → Others
const COMORBIDITY_ORDER = {
  htn: 1,
  hypertension: 1,
  dyslipidemia: 2,
  lipid: 2,
  obesity: 3,
  nafld: 4,
  masld: 4,
  fatty: 4,
  thyroid: 5,
  hypothyroid: 5,
  hyperthyroid: 5,
  cad: 6,
  ckd: 7,
  anemia: 8,
  gout: 9,
  hyperuricemia: 9,
};

// Auto-detect category from diagnosis_id or label
export function detectDiagnosisCategory(dx) {
  const id = (dx.diagnosis_id || "").toLowerCase();
  const label = (dx.label || "").toLowerCase();

  // Primary: T2DM, T1DM
  if (id.includes("dm2") || id.includes("t2dm") || id.includes("dm1") || id.includes("t1dm")) {
    if (
      label.includes("type 2") ||
      label.includes("type 1") ||
      label.includes("diabetes mellitus")
    ) {
      return "primary";
    }
  }

  // Complications: diabetic nephropathy, neuropathy, retinopathy, foot
  if (
    label.includes("nephropathy") ||
    label.includes("neuropathy") ||
    label.includes("retinopathy") ||
    label.includes("diabetic foot") ||
    label.includes("kidney disease") ||
    id.includes("neuropathy") ||
    id.includes("nephropathy") ||
    id.includes("retinopathy") ||
    id.includes("ckd")
  ) {
    return "complication";
  }

  // Comorbidities: HTN, dyslipidemia, obesity, NAFLD
  if (
    id.includes("htn") ||
    id.includes("hypertension") ||
    label.includes("hypertension") ||
    label.includes("blood pressure")
  ) {
    return "comorbidity";
  }
  if (
    id.includes("lipid") ||
    id.includes("dyslipidemia") ||
    label.includes("dyslipidemia") ||
    label.includes("cholesterol")
  ) {
    return "comorbidity";
  }
  if (id.includes("obesity") || label.includes("obesity") || label.includes("bmi")) {
    return "comorbidity";
  }
  if (id.includes("nafld") || id.includes("masld") || label.includes("fatty liver")) {
    return "comorbidity";
  }
  if (id.includes("thyroid") || label.includes("thyroid") || label.includes("hypothyroid")) {
    return "comorbidity";
  }

  // Monitoring: prediabetes, borderline values
  if (id.includes("prediabet") || label.includes("prediabet") || label.includes("borderline")) {
    return "monitoring";
  }

  return "comorbidity"; // Default to comorbidity
}

// Detect complication type from diagnosis
export function detectComplicationType(dx) {
  const label = (dx.label || "").toLowerCase();
  const id = (dx.diagnosis_id || "").toLowerCase();

  if (label.includes("nephropathy") || label.includes("kidney") || id.includes("nephropathy")) {
    return "nephropathy";
  }
  if (label.includes("neuropathy") || id.includes("neuropathy")) {
    return "neuropathy";
  }
  if (label.includes("retinopathy") || id.includes("retinopathy")) {
    return "retinopathy";
  }
  if (label.includes("foot") || label.includes("ulcer")) {
    return "foot";
  }
  return "other";
}

// Get comorbidity sort key
function getComorbiditySortKey(dx) {
  const id = (dx.diagnosis_id || "").toLowerCase();
  const label = (dx.label || "").toLowerCase();

  for (const [key, rank] of Object.entries(COMORBIDITY_ORDER)) {
    if (id.includes(key) || label.includes(key)) {
      return rank;
    }
  }
  return 99; // Unknown comorbidities go last
}

// Sort diagnoses according to clinical order
export function sortDiagnoses(diagnoses) {
  if (!diagnoses || diagnoses.length === 0) return diagnoses;

  return diagnoses
    .map((dx) => ({
      ...dx,
      _category: dx.category || detectDiagnosisCategory(dx),
      _complicationType: dx.complication_type || detectComplicationType(dx),
    }))
    .sort((a, b) => {
      // 1. Sort by category rank
      const catA = CATEGORY_RANK[a._category] || 99;
      const catB = CATEGORY_RANK[b._category] || 99;
      if (catA !== catB) return catA - catB;

      // 2. Within category, apply specific ordering
      // Complications: by severity (nephropathy first)
      if (a._category === "complication") {
        const sevA = COMPLICATION_SEVERITY[a._complicationType] || 99;
        const sevB = COMPLICATION_SEVERITY[b._complicationType] || 99;
        if (sevA !== sevB) return sevA - sevB;
      }

      // Comorbidities: HTN → Dyslipidemia → Obesity → NAFLD → Others
      if (a._category === "comorbidity") {
        const comA = getComorbiditySortKey(a);
        const comB = getComorbiditySortKey(b);
        if (comA !== comB) return comA - comB;
      }

      // 3. Use sort_order if specified
      if (a.sort_order !== b.sort_order) {
        return (a.sort_order || 0) - (b.sort_order || 0);
      }

      // 4. Sort by label alphabetically as final tiebreaker
      return (a.label || "").localeCompare(b.label || "");
    });
}

// Format diagnosis for display
export function formatDiagnosis(dx, index) {
  const parts = [];

  // Number
  parts.push(`${index + 1}.`);

  // Diagnosis name
  parts.push(dx.label || dx.diagnosis_id);

  // Key value (e.g. "HbA1c 10.6%")
  if (dx.key_value) {
    parts.push(`— ${dx.key_value}`);
  }

  // Status label
  let statusLabel = dx.status || "";
  if (dx.trend && dx.status === "Worsening") {
    statusLabel = `Worsening — ${dx.trend}`;
  }
  if (dx.external_doctor && dx.category === "external") {
    statusLabel = `On Treatment — Dr. ${dx.external_doctor}`;
  }
  if (statusLabel) {
    parts.push(`(${statusLabel})`);
  }

  return parts.join(" ");
}

export default {
  sortDiagnoses,
  detectDiagnosisCategory,
  detectComplicationType,
  formatDiagnosis,
  CATEGORY_RANK,
  COMPLICATION_SEVERITY,
  COMORBIDITY_ORDER,
};
