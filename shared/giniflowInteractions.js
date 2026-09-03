// The interaction check's shared vocabulary (24-ADDENDUM-V11-PLAN.md §5.2).
//
// The check runs on drug CLASSES, not molecules, because that is what this
// database actually knows: `medications.composition` is set on 74 of 124,708
// active rows, while a class can be resolved for about a third of them. Class
// is also the axis the brief's own example lives on — "dual antiplatelet" is a
// class statement, not a molecule one.
//
// THE HONESTY RULE, which every consumer of this module has to keep: a pair the
// check could not resolve is UNCHECKED, never clear. Reporting "no interactions"
// for a patient on somebody else's Ramipril is worse than saying nothing, and
// two thirds of the list is unresolvable today.

export const SEVERITIES = ["severe", "moderate"];

// The class text in the database is free-form and inconsistent — "SU",
// "Sulfonylurea", "su"; "ACE Inhibitor", "ACE-I", "ACEi" — so nothing can be
// compared until it is folded onto one token per class.
const SYNONYMS = new Map(
  Object.entries({
    SULFONYLUREA: ["SU", "SULFONYLUREA", "GLINIDE"],
    BIGUANIDE: ["BIGUANIDE", "METFORMIN"],
    ACEI: ["ACEI", "ACE INHIBITOR", "ACE I", "ACE"],
    ARB: ["ARB"],
    ARNI: ["ARNI"],
    MRA: [
      "MRA",
      "MINERALOCORTICOID RECEPTOR ANTAGONIST",
      "ALDOSTERONE ANTAGONIST",
      "MINERALOCORTICOID",
    ],
    BETA_BLOCKER: ["BETA BLOCKER", "BETABLOCKER", "BETA 1 BLOCKER"],
    CCB: ["CCB", "CALCIUM CHANNEL BLOCKER"],
    THIAZIDE: ["THIAZIDE", "THIAZIDE LIKE"],
    LOOP_DIURETIC: ["LOOP DIURETIC"],
    DIURETIC: ["DIURETIC"],
    NITRATE: ["NITRATE"],
    PDE5I: ["PDE5I", "PDE5 INHIBITOR"],
    ALPHA_BLOCKER: ["ALPHA BLOCKER", "ALPHA 1 BLOCKER", "ALPHA1 BLOCKER"],
    STATIN: ["STATIN"],
    FIBRATE: ["FIBRATE", "PPAR ALPHA AGONIST", "PPARA AGONIST", "PPAR AGONIST"],
    ANTIPLATELET: ["ANTIPLATELET", "DUAL ANTIPLATELET"],
    ANTICOAGULANT: ["ANTICOAGULANT"],
    NSAID: ["NSAID", "COX 2 INHIBITOR"],
    CORTICOSTEROID: ["CORTICOSTEROID", "STEROID", "INHALED CORTICOSTEROID"],
    PPI: ["PPI", "PCAB", "P CAB"],
    H2RA: ["H2RA", "H2 BLOCKER", "H2 RECEPTOR ANTAGONIST"],
    THYROID: ["THYROID", "THYROID HORMONE"],
    IRON: ["IRON", "IRON SUPPLEMENT"],
    CALCIUM: ["CALCIUM", "CALCIUM SUPPLEMENT"],
    ANTACID: ["ANTACID"],
    DPP4I: ["DPP4I"],
    SGLT2I: ["SGLT2I", "SGLT2"],
    GLP1: ["GLP1", "GLP 1 RA", "GLP1 RA"],
    TZD: ["TZD"],
    INSULIN_BASAL: ["INSULIN BASAL"],
    INSULIN_BOLUS: ["INSULIN BOLUS"],
    INSULIN_PREMIX: ["INSULIN PREMIX"],
    INSULIN: ["INSULIN", "INSULIN PUMP", "INSULIN WEEKLY"],
    GABAPENTINOID: ["GABAPENTINOID"],
    BENZODIAZEPINE: ["BENZODIAZEPINE"],
    HYPNOTIC: ["HYPNOTIC", "SEDATIVE HYPNOTIC"],
    SSRI: ["SSRI"],
    SNRI: ["SNRI"],
    TCA: ["TCA", "TRICYCLIC ANTIDEPRESSANT"],
    ANTIFUNGAL: ["ANTIFUNGAL"],
    MACROLIDE: ["MACROLIDE"],
    XOI: ["XOI", "XANTHINE OXIDASE INHIBITOR"],
  }).flatMap(([canon, words]) => words.map((w) => [w, canon])),
);

// Duplication inside these classes is normal and says nothing — two vitamins is
// not a finding, and a warning nobody needs is how people learn to click past
// the ones they do.
const DUPLICATION_IS_NORMAL = new Set([
  "SUPPLEMENT",
  "VITAMIN",
  "VITAMIN D",
  "VITAMIN D ANALOG",
  "VITAMIN SUPPLEMENT",
  "MULTIVITAMIN",
  "PROTEIN SUPPLEMENT",
  "FIBER",
  "FIBER SUPPLEMENT",
  "HERBAL",
  "PROBIOTIC",
  "ANTIOXIDANT",
  "OTHER",
  "SALINE",
  "LUBRICANT",
  "ARTIFICIAL TEARS",
  "ANTISEPTIC",
  "MEDICAL DEVICE",
  "VACCINE",
  // Generic buckets that cannot support a duplication claim: two rows both
  // labelled "Antibiotic" are usually deliberate combination therapy, and the
  // label is too coarse to tell that from a mistake. Naming them here is the
  // difference between a screen worth reading and one people click past.
  "ANTIBIOTIC",
  "TOPICAL ANTIBIOTIC",
  "ANALGESIC",
  "HORMONE",
  "ENZYME",
  "DIGESTIVE ENZYME",
  "PANCREATIC ENZYME",
  "PROTEOLYTIC ENZYME",
  "HEPATOPROTECTIVE",
  "TOPICAL CORTICOSTEROID",
  "TOPICAL STEROID",
  "NOOTROPIC",
]);

// "INJ LANTUS 12U", "TAB LIPVAS F" — HealthRay writes the form first, so the
// brand is the second word. Without this the whole insulin list is unreadable.
const FORM_WORDS = new Set([
  "INJ",
  "INJECTION",
  "TAB",
  "TABLET",
  "CAP",
  "CAPSULE",
  "SYP",
  "SYRUP",
  "SUSP",
  "SOL",
  "SOLUTION",
  "OINT",
  "OINTMENT",
  "CREAM",
  "GEL",
  "DROPS",
  "POWDER",
  "SACHET",
  "PEN",
  "VIAL",
]);

// The name a reference table might know: the brand, with the form word and the
// dose stripped off it.
export const brandToken = (name) => {
  const words = String(name || "")
    .toUpperCase()
    .replace(/[^A-Z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  const first = words.findIndex((w) => !FORM_WORDS.has(w));
  return first === -1 ? "" : words[first];
};

const clean = (text) =>
  String(text || "")
    .toUpperCase()
    .replace(/[^A-Z0-9+/&]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

// A fixed-dose combination is two drugs. "ARB+CCB" beside a plain CCB is a real
// duplication, and splitting is the only way the check can see it.
export const splitClasses = (text) => {
  const parts = clean(text)
    .split(/[+/]|\bAND\b|\bWITH\b/)
    .map((p) => p.trim())
    .filter(Boolean);
  const out = [];
  for (const part of parts) {
    const canon = SYNONYMS.get(part) || part;
    if (canon && !out.includes(canon)) out.push(canon);
  }
  return out;
};

export const duplicationMatters = (cls) => !DUPLICATION_IS_NORMAL.has(cls);

// A stable identifier for one finding, so an acknowledgement can be recorded
// against it and survive the page being reloaded or the row being edited.
export const ruleKey = (classA, classB) => [classA, classB].sort().join("|");

export const SEVERITY_UI = {
  severe: { tone: "red", icon: "⛔", label: "Severe" },
  moderate: { tone: "amb", icon: "⚠", label: "Moderate" },
};
