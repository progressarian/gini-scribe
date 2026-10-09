const sqlKey = (column) =>
  `regexp_replace(regexp_replace(lower(btrim(COALESCE(${column}, ''))), '^dr\\.?\\s*', ''), '[^a-z]', '', 'g')`;

export const directConsultSql = (column) =>
  `EXISTS (SELECT 1 FROM doctors dc
            WHERE dc.direct_consult
              AND ${sqlKey("dc.name")} = ${sqlKey(column)}
              AND ${sqlKey(column)} <> '')`;

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
