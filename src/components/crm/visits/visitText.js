import {
  VISIT_OUTCOMES,
  VISIT_ROW_STATES,
  VISIT_SHEET_STATUSES,
  VISIT_TYPES,
} from "../../../../shared/crmVocab.js";

const labelOf = (list) => (v) => list.find((x) => x.value === v)?.label ?? "";

export const stateMeta = (v) =>
  VISIT_ROW_STATES.find((s) => s.value === v) ?? { label: "Pending", tone: "dup" };
export const statusLabel = labelOf(VISIT_SHEET_STATUSES);
export const typeLabel = labelOf(VISIT_TYPES);
export const outcomeLabel = labelOf(VISIT_OUTCOMES);
export const shortDate = (iso) => (iso ? iso.split("-").reverse().join("-") : "");
export const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
