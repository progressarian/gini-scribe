import { paise } from "../../../shared/labPayment.js";
import { MONEY_MAX } from "./common.js";
import { httpError } from "./transaction.js";

export const MANUAL_KINDS = ["percent", "flat"];
export const LINE_DISCOUNT_NAME = "Discount";
export const BILL_DISCOUNT_NAME = "Additional discount";

export function cleanManualDiscount(input, label) {
  if (input === undefined || input === null) return null;
  if (typeof input !== "object" || Array.isArray(input)) {
    throw httpError(400, `${label} must be a kind and a value, like 10 percent or ₹100 flat`);
  }
  if (!MANUAL_KINDS.includes(input.kind)) {
    throw httpError(400, `${label} must be a percent or a flat ₹ amount`);
  }
  const value = Number(input.value);
  if (!Number.isFinite(value) || value <= 0) throw httpError(400, `${label} must be more than 0`);
  if (input.kind === "percent" && value > 100) {
    throw httpError(400, `${label} can't be more than 100%`);
  }
  if (input.kind === "flat" && value > MONEY_MAX) throw httpError(400, `${label} is too large`);
  return { kind: input.kind, value: Math.round(value * 100) / 100 };
}

export const manualAmount = (discount, base) =>
  Math.max(
    0,
    Math.min(
      base,
      discount.kind === "percent"
        ? Math.round((base * discount.value) / 100)
        : paise(discount.value),
    ),
  );

export const manualRule = (discount, name) => ({
  id: null,
  code: null,
  name,
  kind: discount.kind,
  value: discount.value,
  method: "manual",
});

export const manualOf = (row) =>
  row?.manual_discount_kind
    ? { kind: row.manual_discount_kind, value: Number(row.manual_discount_value) }
    : null;
