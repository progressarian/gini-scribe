export const DIRECT_CONSULT_DOCTORS = ["Dr. Rahul Katyal"];

const nameKey = (name) =>
  String(name || "")
    .trim()
    .toLowerCase()
    .replace(/^dr\.?\s*/, "")
    .replace(/[^a-z]/g, "");

const DIRECT_KEYS = new Set(DIRECT_CONSULT_DOCTORS.map(nameKey));

export const consultsDirect = (...names) => names.some((name) => DIRECT_KEYS.has(nameKey(name)));

const sqlKey = (column) =>
  `regexp_replace(regexp_replace(lower(btrim(COALESCE(${column}, ''))), '^dr\\.?\\s*', ''), '[^a-z]', '', 'g')`;

export const directConsultSql = (column) =>
  `(${sqlKey(column)} IN (${[...DIRECT_KEYS].map((key) => `'${key}'`).join(", ")}))`;

export const CONSULT_CHOICES = [
  { value: "chief", label: "Chief Consultant Only" },
  { value: "consultant", label: "Consultant Only" },
  { value: "both", label: "Both" },
];

export const consultSide = (step) => {
  if (step.catalogId === "wait_sd") return "consultant";
  if (step.catalogId === "wait_chief") return "chief";
  if (step.catalogId === "rx_ready") return null;
  if (step.role === "sd") return "consultant";
  if (step.role === "chief" || step.role === "mo") return "chief";
  return null;
};

export const keepsForChoice = (step, choice) => {
  if (choice === "both") return true;
  const side = consultSide(step);
  return !side || side === choice;
};

export const withoutChief = (steps) => steps.filter((step) => keepsForChoice(step, "consultant"));
