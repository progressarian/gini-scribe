// ── Medication Sorting Utility ──────────────────────────────────────────────
// Implements clinical ordering rules from diagnosis-rx-brief

// Group rank: Diabetes → Kidney → BP → Lipids → Thyroid → Supplements → External
const GROUP_RANK = {
  diabetes: 1,
  kidney: 2,
  bp: 3,
  cardiovascular: 3,
  lipids: 4,
  thyroid: 5,
  supplement: 6,
  supplements: 6,
  external: 7,
};

// Diabetes drug class rank: Insulin → Metformin → SGLT2 → GLP-1 → DPP-4 → SU → Other
const DIABETES_CLASS_RANK = {
  insulin: 1.1,
  metformin: 1.2,
  sglt2: 1.3,
  glp1: 1.4,
  gip: 1.4,
  dpp4: 1.5,
  su: 1.6,
  sulphonylurea: 1.6,
  other: 1.7,
};

// Drug class detection patterns
const DRUG_PATTERNS = {
  insulin:
    /\b(insulin|glargine|aspart|lispro|nph|novomix|humalog|lantus|toujeo|tresiba|levemir|apidra|novorapid)\b/i,
  metformin: /\b(metformin|glycomet|glucophage|diamet|obimet|metafor)\b/i,
  sglt2:
    /\b(empagliflozin|dapagliflozin|canagliflozin|jardiance|forxiga|invokana|synjardy|daplo|xigduo)\b/i,
  glp1: /\b(tirzepatide|semaglutide|liraglutide|exenatide|dulaglutide|mounjaro|ozempic|rybelsus|trulicity|victoza|bydureon|byetta)\b/i,
  dpp4: /\b(sitagliptin|vildagliptin|linagliptin|saxagliptin|alogliptin|januvia|galvus|trajenta|onglyza|zomelis|istavel)\b/i,
  su: /\b(glimepiride|gliclazide|glipizide|glibenclamide|amaryl|diamicron|glimpid|glycinorm)\b/i,
  pioglitazone: /\b(pioglitazone|actos|pioglit)\b/i,
  acarbose: /\b(acarbose|glucobay)\b/i,
};

// ACE inhibitors for kidney protection
const ACE_INHIBITORS =
  /\b(ramipril|enalapril|lisinopril|captopril|perindopril|cardace|hopace|encardil|lisinopril|coversyl)\b/i;

// ARBs for kidney protection
const ARBS =
  /\b(telmisartan|losartan|irbesartan|valsartan|candesartan|olmesartan|telma|telmikind|losacar|arbista)\b/i;

// Calcium channel blockers for BP
const CCB = /\b(amlodipine|nifedipine|felodipine|norvasc|amlokind|amlong|amlopres)\b/i;

// Beta blockers for BP
const BETA_BLOCKERS =
  /\b(metoprolol|bisoprolol|atenolol|carvedilol|nebivolol|betaloc|concor|aten|nebistar|carvedil)\b/i;

// Statins for lipids
const STATINS =
  /\b(rosuvastatin|atorvastatin|simvastatin|pravastatin|crestor|rozavel|lipitor|storvas|rosuvas|atorva)\b/i;

// Fibrates for lipids
const FIBRATES = /\b(fenofibrate|gemfibrozil|fenolip|tricor|lipicard)\b/i;

// Thyroid medications
const THYROID_MEDS = /\b(levothyroxine|thyronorm|eltroxin|thyrox|lethroxin)\b/i;

// Supplements
const SUPPLEMENTS =
  /\b(vitamin|calcium|omega|b12|d3|cobadex|methylcobal|shelcal|calshine|d-rise|maxepa|omacor)\b/i;

// Detect drug class from medication name or composition
export function detectDrugClass(med) {
  const name = (med.name || "").toLowerCase();
  const composition = (med.composition || "").toLowerCase();
  const combined = `${name} ${composition}`;

  for (const [className, pattern] of Object.entries(DRUG_PATTERNS)) {
    if (pattern.test(combined)) {
      return className;
    }
  }

  return "other";
}

// Detect medication group from medication data
export function detectMedGroup(med) {
  const name = (med.name || "").toLowerCase();
  const composition = (med.composition || "").toLowerCase();
  const combined = `${name} ${composition}`;

  // Diabetes medications (check first)
  for (const pattern of Object.values(DRUG_PATTERNS)) {
    if (pattern.test(combined)) {
      return "diabetes";
    }
  }

  // Kidney protection (ACE/ARB)
  if (ACE_INHIBITORS.test(combined) || ARBS.test(combined)) {
    return "kidney";
  }

  // BP medications
  if (CCB.test(combined) || BETA_BLOCKERS.test(combined)) {
    return "bp";
  }

  // Lipid medications
  if (STATINS.test(combined) || FIBRATES.test(combined) || /\bezetimibe\b/i.test(combined)) {
    return "lipids";
  }

  // Thyroid medications
  if (THYROID_MEDS.test(combined)) {
    return "thyroid";
  }

  // Supplements
  if (SUPPLEMENTS.test(combined)) {
    return "supplement";
  }

  // Anti-platelet
  if (/\b(aspirin|ecosprin|clopidogrel|plavix)\b/i.test(combined)) {
    return "bp"; // Group with cardiovascular
  }

  return "supplement"; // Default to supplement
}

// Group medications by their clinical group
export function groupMedications(medications) {
  const groups = {
    diabetes: [],
    kidney: [],
    bp: [],
    lipids: [],
    thyroid: [],
    supplement: [],
    external: [],
  };

  for (const med of medications || []) {
    const group = med.med_group || detectMedGroup(med);
    if (groups[group]) {
      groups[group].push(med);
    } else {
      groups.supplement.push(med);
    }
  }

  // Sort each group
  for (const group of Object.keys(groups)) {
    groups[group] = sortMedicationsByClass(groups[group], group);
  }

  return groups;
}

// Sort medications within a group
function sortMedicationsByClass(meds, group) {
  if (group === "diabetes") {
    return meds
      .map((m) => ({
        ...m,
        _drugClass: m.drug_class || detectDrugClass(m),
      }))
      .sort((a, b) => {
        const rankA = DIABETES_CLASS_RANK[a._drugClass] || 1.7;
        const rankB = DIABETES_CLASS_RANK[b._drugClass] || 1.7;
        if (rankA !== rankB) return rankA - rankB;

        // Use sort_order as tiebreaker
        if (a.sort_order !== b.sort_order) {
          return (a.sort_order || 0) - (b.sort_order || 0);
        }

        return (a.name || "").localeCompare(b.name || "");
      });
  }

  // Non-diabetes groups: sort by sort_order, then name
  return [...meds].sort((a, b) => {
    if (a.sort_order !== b.sort_order) {
      return (a.sort_order || 0) - (b.sort_order || 0);
    }
    return (a.name || "").localeCompare(b.name || "");
  });
}

// Sort all medications according to clinical order
export function sortMedications(medications) {
  if (!medications || medications.length === 0) return medications;

  // Group medications
  const groups = groupMedications(medications);

  // Flatten in order
  const result = [];
  for (const group of ["diabetes", "kidney", "bp", "lipids", "thyroid", "supplement", "external"]) {
    result.push(...groups[group]);
  }

  return result;
}

// Get display label for medication group
export function getGroupLabel(group) {
  const labels = {
    diabetes: "Diabetes",
    kidney: "Kidney Protection",
    bp: "Blood Pressure",
    lipids: "Lipids",
    thyroid: "Thyroid",
    supplement: "Supplements",
    external: "Prescribed by External Doctor",
  };
  return labels[group] || group;
}

// Format medication for display
export function formatMedication(med, index) {
  const parts = [];

  // Number
  parts.push(`${index + 1}.`);

  // Medicine name
  parts.push(med.name);

  // Dose
  if (med.dose) {
    parts.push(med.dose);
  }

  // Frequency
  parts.push("|");
  parts.push(med.frequency || "OD");

  // Timing
  if (med.timing) {
    parts.push("|");
    parts.push(med.timing);
  }

  return parts.join(" ");
}

export default {
  sortMedications,
  groupMedications,
  detectDrugClass,
  detectMedGroup,
  getGroupLabel,
  formatMedication,
  GROUP_RANK,
  DIABETES_CLASS_RANK,
};
