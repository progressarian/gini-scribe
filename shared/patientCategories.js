// The scheme a visit is booked under — CGHS, ECHS, Himachal Govt and whatever
// the hospital adds next.
//
// The list now lives in `patient_schemes` (33-PATIENT-SCHEME-PLAN.md §1), not
// here: adding a scheme was a code change and a deploy, and the brief says more
// are coming. This module is the import surface every screen already uses, so
// it keeps its exported shape exactly — `categoryLabel`, `categoryColor` and
// `isValidCategory` have the same synchronous signatures they always had.
//
// The array below is the SEED, not the truth. It is what the table was created
// with, and it is what these helpers answer from until `hydrateCategories()`
// replaces it with the live list. That fallback is deliberate:
//
//   · the helpers are called during render, where an await is not available;
//   · a failed or not-yet-finished fetch degrades to the five schemes that have
//     existed for months rather than to an empty dropdown;
//   · the server never relies on it — `isKnownScheme()` in
//     services/patientSchemes.js reads the table directly, so a scheme added a
//     minute ago is accepted by the very next request.
const SEED = [
  { value: "", label: "— General", color: "gray" },
  { value: "cghs", label: "CGHS", color: "blue" },
  { value: "echs", label: "ECHS", color: "teal" },
  { value: "himachal_govt", label: "Himachal Government", color: "green" },
  { value: "senior_citizen", label: "Senior Citizen", color: "purple" },
  { value: "special_discount", label: "Special Discount", color: "amber" },
];

// Mutated in place rather than reassigned: `PATIENT_CATEGORIES` is imported by
// value in GHMPage.jsx, and rebinding the export would leave that module holding
// the seed forever.
export const PATIENT_CATEGORIES = [...SEED];

// "General" is the absence of a scheme, not a scheme. It leads the dropdown and
// is never counted, capped or priced.
const GENERAL = { value: "", label: "— General", color: "gray" };

// Replace the vocabulary with the live one from GET /api/patient-schemes.
// Rows are `{ code, label, color }`; anything malformed is ignored rather than
// rendering a blank pill.
export function hydrateCategories(rows) {
  if (!Array.isArray(rows)) return PATIENT_CATEGORIES;
  const next = rows
    .filter((r) => r && r.code && r.label)
    .map((r) => ({ value: r.code, label: r.label, color: r.color || "gray" }));
  if (!next.length) return PATIENT_CATEGORIES;
  PATIENT_CATEGORIES.length = 0;
  PATIENT_CATEGORIES.push(GENERAL, ...next);
  // Same in-place treatment, for the callers that hold the array itself.
  CATEGORY_VALUES.length = 0;
  CATEGORY_VALUES.push(...next.map((c) => c.value));
  return PATIENT_CATEGORIES;
}

// Everything except the "no category" entry — the set that gets counted.
// A getter, not a frozen constant: the list changes when the live one arrives,
// and a value captured at import time would be the seed forever.
export const categoryValues = () => PATIENT_CATEGORIES.filter((c) => c.value).map((c) => c.value);

// Kept for the callers that read it as an array (the GHM count query). Mutated
// in place by hydrateCategories for the same reason PATIENT_CATEGORIES is —
// a rebound export would leave importers holding the seed.
export const CATEGORY_VALUES = SEED.filter((c) => c.value).map((c) => c.value);

export const categoryMeta = (v) => PATIENT_CATEGORIES.find((c) => c.value === (v || "")) || null;
export const categoryLabel = (v) => categoryMeta(v)?.label || v || "";
export const categoryColor = (v) => categoryMeta(v)?.color || "gray";

export const isValidCategory = (v) => !v || categoryValues().includes(v);
