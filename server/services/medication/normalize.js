// ── Canonical medication-name normaliser (server) ───────────────────────────
// Single source of truth for how a prescribed medication string is split into
//   { name, form, route, canonicalKey }
//
// A prescription like "INJ. WEGOVY 0.5 mg" arrives from multiple sources:
//   • AI extraction (Claude vision / Claude text) — may or may not strip prefix
//   • HealthRay sync — prefix is always present
//   • Manual entry from the UI — user may type "TAB Concor"
// Without normalisation, the same drug ends up in the DB as "TAB Concor",
// "Concor", "CONCOR AM" etc. and the stop-medicine / dedupe logic can't tell
// they're the same row. This module guarantees a clean `name` + canonical key.
//
// The client mirror lives at src/lib/medName.js — keep them in sync.

// Ordered: longest-first so "TABLET " matches before "TAB " etc.
// Each entry: [pattern, canonical form label, default route hint]
// The pattern is anchored to the START of the trimmed string, case-insensitive,
// and accepts an optional trailing dot (e.g. "INJ." / "Tab.").
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

// Valid route whitelist — keeps data consistent with the existing schema
// comment (Oral/IV/IM/SC/Topical/Inhaled plus Rectal/Vaginal for completeness).
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

/**
 * Strip a dosage-form prefix from a medication name.
 * Returns { name, form } where `form` is the canonical label (e.g. "Tablet")
 * or null if no prefix was detected. `name` is the original string with the
 * prefix removed and trimmed — casing preserved so display stays readable.
 */
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

/**
 * Infer a route from a detected dosage form when no explicit route was given.
 * Prefers an already-set route over inferring. Returns null if nothing sensible
 * can be inferred.
 */
export function routeForForm(form) {
  if (!form) return null;
  const rule = FORM_RULES.find(([, label]) => label === form);
  return rule ? rule[2] : null;
}

/**
 * Reconcile a medication's {name, form, route} fields. Run on every write.
 *   - strips any surviving TAB/INJ/etc. prefix from `name`
 *   - fills `form` from the prefix if it wasn't already set
 *   - fills `route` from the form when route is empty, otherwise keeps caller's
 * Returns a shallow-copied object — never mutates the input.
 */
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

/**
 * Canonical lookup key for de-duplication and stop-medicine matching.
 * Strips prefix, trailing parenthesised dose (e.g. "(60K units)"), collapses
 * whitespace, and uppercases. This is the exact string that goes into
 * `pharmacy_match` and that the ON CONFLICT indexes compare against.
 */
export function canonicalMedKey(rawName) {
  const { name } = stripFormPrefix(rawName || "");
  return name
    .replace(/\s*\([\d\s+.\/mg%KkUuIL]+\)\s*$/i, "")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();
}

// Back-compat alias: matches the old normalizeMedName() signature in
// server/services/healthray/db.js so callers can swap in the shared helper
// without changing their call sites.
export const normalizeMedName = canonicalMedKey;
