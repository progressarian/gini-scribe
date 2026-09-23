import { rupees } from "./format";

export const METHOD_LABEL = { auto: "Automatic", code: "Code" };
export const KIND_LABEL = {
  percent: "Percent off",
  flat: "Flat ₹ off",
  fixed_price: "Fixed price",
};
export const ROLE_LABEL = {
  reception: "Reception",
  reception_admin: "Reception admin",
  admin: "Admin",
};

export const valueOf = (rule) => {
  const amount =
    rule.kind === "percent"
      ? `${rule.value}%${rule.max_discount !== null && rule.max_discount !== undefined ? ` up to ${rupees(rule.max_discount)}` : ""}`
      : rule.kind === "flat"
        ? `${rupees(rule.value)} off`
        : `fixed ${rupees(rule.value)}`;
  return rule.applies_per === "bill" ? `${amount} on the bill` : amount;
};

const listed = (label, names) => (names?.length ? `${label}: ${names.join(", ")}` : null);

export const offLabel = (name, isActive) => (isActive === false ? `${name} (switched off)` : name);

const targetNames = (targets) => (targets ?? []).map((t) => offLabel(t.name, t.is_active));

export const coversOf = (rule) => {
  const parts = [
    listed("Groups", targetNames(rule.groups)),
    listed("Subgroups", targetNames(rule.subgroups)),
    listed("Items", targetNames(rule.items)),
    listed("Doctors", targetNames(rule.doctors)),
    listed("Visits", rule.visit_types),
  ].filter(Boolean);
  return parts.length ? parts : ["Every service"];
};

export const ageText = (min, max) =>
  min === null && max === null
    ? null
    : max === null
      ? `Age ${min}+`
      : min === null
        ? `Age up to ${max}`
        : `Age ${min}–${max}`;

export const whoOf = (rule) => {
  const categories = (rule.categories ?? []).map((c) => offLabel(c.display_label, c.is_active));
  const parts = [
    categories.length ? categories.join(", ") : null,
    ageText(rule.min_age ?? null, rule.max_age ?? null),
    rule.gender,
  ].filter(Boolean);
  return parts.length ? parts : ["Everyone"];
};

export const datesOf = (rule) =>
  !rule.valid_from && !rule.valid_to
    ? "Always"
    : `${rule.valid_from ?? "any time"} → ${rule.valid_to ?? "no end"}`;

export const usageOf = (rule) => {
  const today = rule.usage_today ?? { count: 0, by_doctor: [] };
  const parts = [
    rule.max_uses_total
      ? `${rule.uses_total ?? 0} / ${rule.max_uses_total} in all`
      : `${rule.uses_total ?? 0} used`,
    rule.max_uses_per_patient ? `${rule.max_uses_per_patient} per patient` : null,
    rule.max_uses_per_day
      ? `${today.count} / ${rule.max_uses_per_day} today`
      : `${today.count} today`,
  ];
  if (rule.max_uses_per_doctor_per_day) {
    const doctors = today.by_doctor ?? [];
    if (doctors.length) {
      for (const d of doctors) {
        parts.push(`${d.name}: ${d.count} / ${rule.max_uses_per_doctor_per_day} today`);
      }
    } else {
      parts.push(`Each doctor: 0 / ${rule.max_uses_per_doctor_per_day} today`);
    }
  }
  return parts.filter(Boolean);
};

export const paise = (amount) => rupees((amount ?? 0) / 100);
