// ── Medication Categories — single source of truth ─────────────────────────
// Update group metadata, ordering, and detection patterns ONLY here. Both the
// prescription PDF generator (server/templates/prescriptionTemplate.js) and
// the medication sort utility (server/utils/medicationSort.js) read from this
// module. The mirror used by the medcard UI lives in src/config/drugDatabase.js
// and src/components/visit/VisitMedications.jsx — keep them aligned when you
// add or rename a group here.

// Ordered list of categories. `rank` drives sort order in both the printed
// prescription and the medcard view; `label` is the section header that gets
// printed.
export const MED_CATEGORIES = [
  { id: "diabetes", label: "Diabetes", icon: "💉", rank: 1 },
  { id: "kidney", label: "Kidney Protection", icon: "🫘", rank: 2 },
  { id: "bp", label: "Blood Pressure", icon: "💓", rank: 3 },
  { id: "lipids", label: "Lipids", icon: "🫀", rank: 4 },
  { id: "thyroid", label: "Thyroid", icon: "🦋", rank: 5 },
  { id: "supplement", label: "Supplements", icon: "💊", rank: 6 },
  { id: "external", label: "Prescribed by External Doctor", icon: "👨‍⚕️", rank: 7 },
];

// Default category when none is set and no pattern matches.
export const DEFAULT_CATEGORY = "supplement";

// Diabetes drug class ordering (within the Diabetes group).
export const DIABETES_CLASS_RANK = {
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

// Drug class detection patterns (diabetes sub-classes).
export const DRUG_PATTERNS = {
  insulin:
    /\b(insulin|glargine|aspart|lispro|nph|novomix|humalog|lantus|toujeo|tresiba|levemir|apidra|novorapid|ryzodeg|degludec)\b/i,
  metformin: /\b(metformin|glycomet|glucophage|diamet|obimet|metafor|istamet)\b/i,
  sglt2:
    /\b(empagliflozin|dapagliflozin|canagliflozin|jardiance|forxiga|invokana|synjardy|daplo|xigduo|dapanorm)\b/i,
  glp1: /\b(tirzepatide|semaglutide|liraglutide|exenatide|dulaglutide|mounjaro|ozempic|rybelsus|wegovy|trulicity|victoza|saxenda|bydureon|byetta)\b/i,
  dpp4: /\b(sitagliptin|vildagliptin|linagliptin|saxagliptin|alogliptin|teneligliptin|januvia|galvus|trajenta|onglyza|zomelis|istavel|jalra|zita)\b/i,
  su: /\b(glimepiride|gliclazide|glipizide|glibenclamide|amaryl|diamicron|glimpid|glycinorm|glizid)\b/i,
  pioglitazone: /\b(pioglitazone|actos|pioglit)\b/i,
  acarbose: /\b(acarbose|glucobay|voglibose)\b/i,
};

// Category-level detection patterns for everything that isn't diabetes-specific.
export const CATEGORY_PATTERNS = {
  kidney:
    /\b(ramipril|enalapril|lisinopril|captopril|perindopril|cardace|hopace|encardil|coversyl|telmisartan|losartan|irbesartan|valsartan|candesartan|olmesartan|telma|telmikind|losacar|arbista|telisatan|finerenone|kerendia|spironolactone|eplerenone|aldactone)\b/i,
  bp: /\b(amlodipine|nifedipine|felodipine|norvasc|amlokind|amlong|amlopres|cilacar|cilnidipine|chlorthalidone|hydrochlorothiazide|metoprolol|bisoprolol|atenolol|carvedilol|nebivolol|betaloc|concor|aten|nebistar|carvedil|prazosin|aspirin|ecospirin|ecosprin|clopidogrel|prasugrel|ticagrelor|plavix)\b/i,
  lipids:
    /\b(rosuvastatin|atorvastatin|simvastatin|pravastatin|crestor|rozavel|lipitor|storvas|rosuvas|rosulip|rosuless|rosulast|rosutor|atorva|lipitas|fenofibrate|gemfibrozil|fenolip|tricor|lipicard|ezetimibe|bempedoic|nexlizet|statin)\b/i,
  thyroid: /\b(levothyroxine|thyronorm|eltroxin|thyrox|lethroxin|thyroxine)\b/i,
  external: /\b(tamsulosin|urimax|silodosin|dutasteride|finasteride|alfuzosin|flotral)\b/i,
  supplement:
    /\b(vitamin|aktiv|calcium|calci|omega|b12|d3|cobadex|methylcobal|shelcal|calshine|d-rise|maxepa|omacor|omega|iron|folic|cospiaq|probiot|enzyme|pantop|panto|rabep|omeprazole)\b/i,
};

// Detect the diabetes drug class for a med (used for sub-sort within Diabetes).
export function detectDrugClass(med) {
  const name = (med?.name || "").toLowerCase();
  const composition = (med?.composition || "").toLowerCase();
  const combined = `${name} ${composition}`;
  for (const [className, pattern] of Object.entries(DRUG_PATTERNS)) {
    if (pattern.test(combined)) return className;
  }
  return "other";
}

// Detect the category for a med. If `med.med_group` is set, that wins; otherwise
// we fall back to name/composition pattern matching.
export function detectMedCategory(med) {
  if (med?.external_doctor) return "external";

  const name = (med?.name || "").toLowerCase();
  const composition = (med?.composition || "").toLowerCase();
  const combined = `${name} ${composition}`;

  // Run pattern detection first. If a more-specific category matches, prefer
  // it over a stored `med_group` of "supplement" — historically meds saved
  // without explicit categorisation defaulted to "supplement", which buried
  // things like Wegovy (GLP-1) and Kerendia (kidney) in the supplements bucket.
  let patternMatch = null;
  for (const pattern of Object.values(DRUG_PATTERNS)) {
    if (pattern.test(combined)) {
      patternMatch = "diabetes";
      break;
    }
  }
  if (!patternMatch) {
    for (const cat of MED_CATEGORIES) {
      if (cat.id === "diabetes" || cat.id === "external") continue;
      const pat = CATEGORY_PATTERNS[cat.id];
      if (pat && pat.test(combined)) {
        patternMatch = cat.id;
        break;
      }
    }
  }
  if (!patternMatch && CATEGORY_PATTERNS.external.test(combined)) {
    patternMatch = "external";
  }

  const stored =
    med?.med_group && MED_CATEGORIES.some((c) => c.id === med.med_group) ? med.med_group : null;

  // If the stored group is the generic fallback "supplement", let a stronger
  // pattern match win. Otherwise trust the doctor-curated stored value.
  if (stored && stored !== DEFAULT_CATEGORY) return stored;
  if (patternMatch) return patternMatch;
  if (stored) return stored;
  return DEFAULT_CATEGORY;
}

// Look up a category's display label by id.
export function getCategoryLabel(id) {
  const cat = MED_CATEGORIES.find((c) => c.id === id);
  return cat ? cat.label : (id || "").charAt(0).toUpperCase() + (id || "").slice(1);
}

// Look up a category's icon by id.
export function getCategoryIcon(id) {
  const cat = MED_CATEGORIES.find((c) => c.id === id);
  return cat ? cat.icon : "💊";
}

// Bucket medications into categories. Returns { [categoryId]: med[] } with
// stable category ordering driven by MED_CATEGORIES.
export function groupMedicationsByCategory(medications = []) {
  const groups = {};
  for (const cat of MED_CATEGORIES) groups[cat.id] = [];
  for (const med of medications) {
    const id = detectMedCategory(med);
    (groups[id] ||= []).push(med);
  }
  return groups;
}

// Ordered list of category ids that actually contain medications (used by the
// prescription template to emit one section per non-empty group).
export function getOrderedNonEmptyCategories(groups) {
  return MED_CATEGORIES.filter((c) => (groups[c.id] || []).length > 0).map((c) => c.id);
}

export default {
  MED_CATEGORIES,
  DEFAULT_CATEGORY,
  DIABETES_CLASS_RANK,
  DRUG_PATTERNS,
  CATEGORY_PATTERNS,
  detectDrugClass,
  detectMedCategory,
  getCategoryLabel,
  getCategoryIcon,
  groupMedicationsByCategory,
  getOrderedNonEmptyCategories,
};
