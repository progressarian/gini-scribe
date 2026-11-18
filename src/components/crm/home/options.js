import {
  SELECTABLE_DOCTOR_PRIORITIES,
  VISIT_DUE_STATES,
  VISIT_SLOTS,
} from "../../../../shared/crmVocab.js";

export const PRIORITY_OPTIONS = SELECTABLE_DOCTOR_PRIORITIES.map((p) => ({
  value: p.value,
  label: p.label,
}));
export const SLOT_OPTIONS = VISIT_SLOTS.map((s) => ({
  value: s.value,
  label: `${s.label} visits`,
}));
export const DUE_OPTIONS = VISIT_DUE_STATES.map((s) => ({ value: s.value, label: s.label }));
export const territoryOptions = (data) =>
  (data?.territories || []).map((t) => ({ value: t, label: t }));
export const hasFilters = (filters, keys) => keys.some((k) => filters[k]);
export const staffOptions = (data) => [
  { value: "unassigned", label: "Unassigned" },
  ...(data?.staff || []).map((s) => ({ value: s.id, label: s.full_name })),
];
export const SORT_OPTIONS = [
  { value: "visits_most", label: "Most visits this month" },
  { value: "visits_least", label: "Fewest visits this month" },
];
