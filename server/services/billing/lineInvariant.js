import { REMAINDERS } from "../../../shared/billingVocab.js";
import { httpError } from "./transaction.js";

const MONEY = [
  "base_price",
  "rate",
  "actual",
  "listed_actual",
  "discount",
  "listed_discount",
  "payable_discount",
  "taxable",
  "cgst",
  "sgst",
  "tax",
  "total",
  "patient_payable",
  "claim",
  "adjustment",
];

const TAKEN_FROM = ["actual", "patient_payable"];

const sum = (steps) => steps.reduce((total, step) => total + step.amount, 0);

const takesPaise = (steps) =>
  Array.isArray(steps) &&
  steps.every((step) => Number.isSafeInteger(step?.amount) && step.amount > 0);

function faults(line, shared) {
  const money = shared ? [...MONEY, "bill_discount"] : MONEY;
  const bad = money.filter((field) => !Number.isSafeInteger(line[field]) || line[field] < 0);
  if (bad.length) return [`${bad.join(", ")} must be whole paise, 0 or more`];
  if (!takesPaise(line.discounts)) return ["every discount must take whole paise, more than 0"];
  if (line.discounts.some((step) => !TAKEN_FROM.includes(step.taken_from))) {
    return ["every discount must be taken from the actual or the patient payable"];
  }
  const billSteps = shared ? line.bill_discounts : [];
  if (!takesPaise(billSteps)) return ["every bill discount must take whole paise, more than 0"];
  const billDiscount = shared ? line.bill_discount : 0;
  const fromPayable = line.discounts.filter((step) => step.taken_from === "patient_payable");
  const offActual = line.discount - line.payable_discount - billDiscount;
  const listedOffActual = line.listed_discount - line.payable_discount;
  const rest = line.patient_payable + line.claim + line.adjustment;
  return [
    !Number.isSafeInteger(line.quantity) || line.quantity < 1
      ? "quantity must be a whole number, 1 or more"
      : line.listed_actual !== line.quantity * line.rate && "listed actual ≠ quantity × rate",
    line.remainder !== null &&
      !REMAINDERS.includes(line.remainder) &&
      `the rest must go to ${REMAINDERS.join(" or ")}, or be none on a full-pay line`,
    line.actual - line.discount + line.tax !== rest &&
      "actual − discount + tax ≠ patient payable + claim + adjustment",
    line.total - line.payable_discount - billDiscount !== rest &&
      (shared
        ? "total − payable discount − bill discount ≠ patient payable + claim + adjustment"
        : "total − payable discount ≠ patient payable + claim + adjustment"),
    line.taxable + line.tax !== line.total && "taxable + tax ≠ total",
    line.cgst !== line.sgst && "CGST ≠ SGST",
    line.cgst + line.sgst !== line.tax && "CGST + SGST ≠ tax",
    line.payable_discount > line.listed_discount && "payable discount is more than the discount",
    line.patient_payable > line.total && "patient payable is more than the total",
    sum(line.discounts) !== line.listed_discount &&
      "the discounts don't add up to the listed discount",
    sum(fromPayable) !== line.payable_discount &&
      "the discounts on the patient payable don't add up to the payable discount",
    sum(billSteps) !== billDiscount && "the bill discounts don't add up to the bill discount",
    (offActual < 0 ||
      offActual > listedOffActual ||
      (line.actual === line.listed_actual && offActual !== listedOffActual)) &&
      "the discount off the actual doesn't match the discounts taken off it",
    line.remainder !== "claim" && line.claim !== 0 && "a claim without a claim rule",
    line.remainder !== "adjustment" &&
      line.adjustment !== 0 &&
      "an adjustment without an adjustment rule",
    line.remainder === null &&
      line.payable_discount !== 0 &&
      "a payable discount on a line where the patient pays in full",
    line.remainder !== null &&
      listedOffActual > 0 &&
      "a discount off the actual on a line under a payment rule",
  ].filter(Boolean);
}

function check(line, shared) {
  const found = line && typeof line === "object" ? faults(line, shared) : ["it isn't a line"];
  if (found.length) {
    const name = line?.bill_name ?? line?.item_name ?? line?.item_id ?? "a line";
    const where = Number.isSafeInteger(line?.line_no) ? ` (line ${line.line_no})` : "";
    throw httpError(500, `The priced line "${name}"${where} doesn't balance: ${found.join("; ")}`);
  }
  return line;
}

export const assertLineBalances = (line) => check(line, false);

export const assertBillLineBalances = (line) => check(line, true);
