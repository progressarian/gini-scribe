// Quick-select chip arrays for complaints, conditions, and lab orders
export const COMPLAINT_CHIPS = [
  "Routine follow-up",
  "Increased thirst",
  "Frequent urination",
  "Weight gain",
  "Weight loss",
  "Fatigue",
  "Blurred vision",
  "Tingling/numbness",
  "Foot pain",
  "Wound not healing",
  "Hair loss",
  "Palpitations",
  "Dizziness",
  "Headache",
  "Chest pain",
  "Breathlessness",
  "Joint pain",
  "Back pain",
  "Knee pain",
  "Swelling feet",
  "Nausea",
  "Abdominal pain",
  "Fever",
  "Cough",
  "Sleep issues",
];

export const CONDITION_CHIPS = [
  { id: "dm2", l: "Type 2 DM", cl: "#dc2626" },
  { id: "dm1", l: "Type 1 DM", cl: "#dc2626" },
  { id: "htn", l: "Hypertension", cl: "#7c3aed" },
  { id: "thyroid", l: "Hypothyroid", cl: "#6366f1" },
  { id: "hyperthyroid", l: "Hyperthyroid", cl: "#6366f1" },
  { id: "dyslip", l: "Dyslipidemia", cl: "#f59e0b" },
  { id: "ckd", l: "CKD", cl: "#0d9488" },
  { id: "obesity", l: "Obesity", cl: "#059669" },
  { id: "pcos", l: "PCOS", cl: "#e11d48" },
  { id: "cad", l: "CAD", cl: "#ef4444" },
  { id: "osteo", l: "Osteoporosis", cl: "#78716c" },
  { id: "nafld", l: "NAFLD/MAFLD", cl: "#a16207" },
  { id: "vitd", l: "Vit D Deficiency", cl: "#ca8a04" },
  { id: "b12", l: "B12 Deficiency", cl: "#0ea5e9" },
  { id: "gout", l: "Gout", cl: "#be123c" },
  { id: "osa", l: "OSA", cl: "#475569" },
  { id: "neuropathy", l: "DM Neuropathy", cl: "#9333ea" },
  { id: "retinopathy", l: "DM Retinopathy", cl: "#be185d" },
  { id: "nephropathy", l: "DM Nephropathy", cl: "#0f766e" },
  { id: "bph", l: "BPH", cl: "#64748b" },
  { id: "other", l: "Other", cl: "#475569" },
];

// LAB_ORDER_CHIPS re-exported from the canonical lab order config so every
// consumer of "chips.js" automatically gets the unified clinical order. See
// `src/config/labOrder.js` and `labOrder.md` at the project root.
export { LAB_ORDER_CHIPS } from "./labOrder";
