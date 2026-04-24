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
