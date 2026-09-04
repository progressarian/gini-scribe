// ── Canonical medication-name normaliser (client) ───────────────────────────
// Mirror of server/services/medication/normalize.js — keep them in sync.
// Both files define the same FORM_RULES / canonicalMedKey contract so that
// names produced, displayed, and matched on the client agree with the names
// stored in the DB.

const FORM_RULES = [
  [/^tablets?\.?\s+/i, "Tablet", "Oral"],
  [/^tab\.?\s+/i, "Tablet", "Oral"],
  [/^capsules?\.?\s+/i, "Capsule", "Oral"],
  [/^cap\.?\s+/i, "Capsule", "Oral"],
  [/^injections?\.?\s+/i, "Injection", "SC"],
  [/^inj\.?\s+/i, "Injection", "SC"],
  [/^syrups?\.?\s+/i, "Syrup", "Oral"],
  [/^syp\.?\s+/i, "Syrup", "Oral"],
  [/^suspensions?\.?\s+/i, "Suspension", "Oral"],
  [/^susp\.?\s+/i, "Suspension", "Oral"],
  [/^drops?\.?\s+/i, "Drops", "Topical"],
  [/^ointments?\.?\s+/i, "Ointment", "Topical"],
  [/^oint\.?\s+/i, "Ointment", "Topical"],
  [/^creams?\.?\s+/i, "Cream", "Topical"],
  [/^gels?\.?\s+/i, "Gel", "Topical"],
  [/^lotions?\.?\s+/i, "Lotion", "Topical"],
  [/^sprays?\.?\s+/i, "Spray", "Topical"],
  [/^inhalers?\.?\s+/i, "Inhaler", "Inhaled"],
  [/^nebuliz(?:er|ation)s?\.?\s+/i, "Nebulizer", "Inhaled"],
  [/^sachets?\.?\s+/i, "Sachet", "Oral"],
  [/^powders?\.?\s+/i, "Powder", "Oral"],
  [/^pwd\.?\s+/i, "Powder", "Oral"],
  [/^patch(?:es)?\.?\s+/i, "Patch", "Topical"],
  [/^suppositor(?:y|ies)\.?\s+/i, "Suppository", "Rectal"],
  [/^pessar(?:y|ies)\.?\s+/i, "Pessary", "Vaginal"],
];

// Map route → short display badge used in the medication table
const ROUTE_BADGE = {
  Oral: "Oral",
  SC: "SC",
  IM: "IM",
  IV: "IV",
  Topical: "Topical",
  Inhaled: "Inhaled",
  Rectal: "Rectal",
  Vaginal: "Vaginal",
  Sublingual: "SL",
  Nasal: "Nasal",
};

// Short form-label badge used in the medication table (when we know the form
// precisely, we prefer it over the route — TAB is more useful than "Oral").
const FORM_BADGE = {
  Tablet: "TAB",
  Capsule: "CAP",
  Injection: "INJ",
  Syrup: "SYP",
  Suspension: "SUSP",
  Drops: "DROPS",
  Ointment: "OINT",
  Cream: "CRM",
  Gel: "GEL",
  Lotion: "LOT",
  Spray: "SPRAY",
  Inhaler: "INH",
  Nebulizer: "NEB",
  Sachet: "SAC",
  Powder: "PWD",
  Patch: "PATCH",
  Suppository: "SUPP",
  Pessary: "PES",
};

export function stripFormPrefix(rawName) {
  if (!rawName) return { name: "", form: null };
  const s = String(rawName).trim();
  for (const [re, form] of FORM_RULES) {
    if (re.test(s)) return { name: s.replace(re, "").trim(), form };
  }
  return { name: s, form: null };
}

export function canonicalMedKey(rawName) {
  const { name } = stripFormPrefix(rawName || "");
  return name
    .replace(/\s*\([\d\s+.\/mg%KkUuIL]+\)\s*$/i, "")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();
}

// Display helpers — components import these so they don't reinvent the rules.
export function displayMedName(med) {
  if (!med) return "";
  return stripFormPrefix(med.name || "").name || med.name || "";
}

export function displayFormBadge(med) {
  if (!med) return null;
  if (med.form && FORM_BADGE[med.form]) return FORM_BADGE[med.form];
  // Fall back: infer form from an embedded prefix on the raw name
  const { form } = stripFormPrefix(med.name || "");
  if (form && FORM_BADGE[form]) return FORM_BADGE[form];
  // Last resort: show route
  return med.route ? ROUTE_BADGE[med.route] || med.route : null;
}

// The strength written into a name or a search box — "Atchol 20mg", "TAB
// METFORMIN 500 MG", "Daplo M 10/500". The catalogue stores brands without a
// strength (one Glycomet covers 500/850/1000mg), so this is the one place a
// dose can be read back from what was typed or dictated rather than retyped.
const UNIT = {
  mg: "mg",
  mcg: "mcg",
  "\u00b5g": "mcg",
  g: "g",
  gm: "g",
  gram: "g",
  grams: "g",
  ml: "ml",
  iu: "IU",
  unit: "units",
  units: "units",
  "%": "%",
};

const STRENGTH_RE =
  /(\d+(?:\.\d+)?(?:\s*[/+]\s*\d+(?:\.\d+)?)*)\s*(mg|mcg|\u00b5g|gm|grams?|g|ml|iu|units?|%)\b/i;

export function extractStrength(text) {
  const m = String(text || "").match(STRENGTH_RE);
  if (!m) return "";
  const unit = UNIT[m[2].toLowerCase()] || m[2].toLowerCase();
  return `${m[1].replace(/\s+/g, "")}${unit}`;
}

// Many catalogue names carry the number without its unit — "Atchol 20",
// "Glycomet SR 500", 3,782 of them. The number is worth prefilling; the unit is
// NOT worth guessing (Thyronorm 50 is 50mcg, and "mg" there would be wrong by a
// thousand), so the consultant types it. Only a number standing on its own at
// the end counts: "Vitamin B12" is a name, not a dose.
const TRAILING_NUMBER_RE = /(?:^|\s)(\d+(?:\.\d+)?(?:\s*[/+]\s*\d+(?:\.\d+)?)*)\s*$/;

export function extractDose(text) {
  const withUnit = extractStrength(text);
  if (withUnit) return withUnit;
  const m = String(text || "").match(TRAILING_NUMBER_RE);
  return m ? m[1].replace(/\s+/g, "") : "";
}
