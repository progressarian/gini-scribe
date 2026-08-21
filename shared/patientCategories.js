// Discount categories a visit can be booked under. The sheet tallies how many
// of the day's patients sit in each one, so the desk can see the mix at a
// glance without counting rows.
export const PATIENT_CATEGORIES = [
  { value: "", label: "— General", color: "gray" },
  { value: "cghs", label: "CGHS", color: "blue" },
  { value: "himachal_govt", label: "Himachal Government", color: "green" },
  { value: "senior_citizen", label: "Senior Citizen", color: "purple" },
  { value: "special_discount", label: "Special Discount", color: "amber" },
];

// Everything except the "no category" entry — the set that gets counted.
export const CATEGORY_VALUES = PATIENT_CATEGORIES.filter((c) => c.value).map((c) => c.value);

export const categoryMeta = (v) => PATIENT_CATEGORIES.find((c) => c.value === (v || "")) || null;
export const categoryLabel = (v) => categoryMeta(v)?.label || v || "";
export const categoryColor = (v) => categoryMeta(v)?.color || "gray";

export const isValidCategory = (v) => !v || CATEGORY_VALUES.includes(v);
