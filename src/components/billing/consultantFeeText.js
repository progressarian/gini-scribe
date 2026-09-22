import { rupees } from "./format";

export const whoOf = (row) => (row.is_default ? "Hospital default" : row.doctor_name);

export const paysText = (pays) => {
  if (pays.patient_pays === "nothing") return "pays nothing";
  if (pays.patient_pays === "amount") return `pays ${rupees(pays.patient_value)}`;
  if (pays.patient_pays === "percent") return `pays ${pays.patient_value}%`;
  return "pays full";
};

export const feeSourceText = (cell, parentLabel) => {
  if (cell.general) return "base price, set on the Services page";
  if (cell.fee_source === "own") return "own fee";
  if (cell.fee_source === "parent") return `fee inherited from ${parentLabel}`;
  return "fee inherited from the base price";
};

export const paysSourceText = (pays, parentLabel) => {
  if (pays.source === "own") return "own rule";
  if (pays.source === "parent") return `rule inherited from ${parentLabel}`;
  if (pays.source === "category") return `inherited from this category's ${pays.scope} rule`;
  return "no rule, so the patient pays in full";
};

export const cellSummary = (cell, parentLabel) =>
  `${rupees(cell.fee)} ${feeSourceText(cell, parentLabel)}, ${paysText(cell.pays)} (${paysSourceText(cell.pays, parentLabel)})`;
