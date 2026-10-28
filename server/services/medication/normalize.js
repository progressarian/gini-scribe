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

const VALID_ROUTES = new Set([
  "Oral",
  "SC",
  "IM",
  "IV",
  "Topical",
  "Inhaled",
  "Rectal",
  "Vaginal",
  "Sublingual",
  "Nasal",
]);

export function stripFormPrefix(rawName) {
  if (!rawName) return { name: "", form: null };
  let s = String(rawName).trim();
  for (const [re, form] of FORM_RULES) {
    if (re.test(s)) {
      return { name: s.replace(re, "").trim(), form };
    }
  }
  return { name: s, form: null };
}

export function routeForForm(form) {
  if (!form) return null;
  const rule = FORM_RULES.find(([, label]) => label === form);
  return rule ? rule[2] : null;
}

export function normalizeMedication(input) {
  const out = { ...(input || {}) };
  const { name, form: detectedForm } = stripFormPrefix(out.name || "");
  out.name = name;
  if (!out.form && detectedForm) out.form = detectedForm;
  if (!out.route || !VALID_ROUTES.has(out.route)) {
    out.route = routeForForm(out.form) || out.route || "Oral";
  }
  return out;
}

export function canonicalMedKey(rawName) {
  const { name } = stripFormPrefix(rawName || "");
  return name
    .replace(/\s*\([\d\s+.\/mg%KkUuIL]+\)\s*$/i, "")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();
}

export const normalizeMedName = canonicalMedKey;
