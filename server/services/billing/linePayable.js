import { PATIENT_PAYS, REMAINDERS } from "../../../shared/billingVocab.js";
import { paise } from "../../../shared/labPayment.js";

const rupees = (amount) =>
  `₹${Number(amount).toLocaleString("en-IN", {
    minimumFractionDigits: Number.isInteger(Number(amount)) ? 0 : 2,
    maximumFractionDigits: 2,
  })}`;

const RULE_TEXT = {
  full: () => "full",
  amount: (value) => `amount ${rupees(value)}`,
  percent: (value) => `percent ${Number(value)}%`,
  nothing: () => "nothing",
};

const ruleText = (patientPays, value, { capped, total }) =>
  capped
    ? `${RULE_TEXT[patientPays](value)} (capped at ${rupees(total / 100)})`
    : RULE_TEXT[patientPays](value);

function cleanTotal(total) {
  if (!Number.isSafeInteger(total) || total < 0) {
    throw new Error("A line total must be a whole number of paise, 0 or more");
  }
  return total;
}

function cleanQuantity(quantity) {
  if (quantity === undefined) return 1;
  if (!Number.isSafeInteger(quantity) || quantity < 1) {
    throw new Error("Quantity must be a whole number, 1 or more");
  }
  return quantity;
}

function cleanValue(value, { max }) {
  const n =
    typeof value === "number" || (typeof value === "string" && value.trim() !== "")
      ? Number(value)
      : NaN;
  if (!Number.isFinite(n) || n < 0 || (max !== undefined && n > max)) {
    throw new Error(
      `A payment rule value must be a number${max === undefined ? ", 0 or more" : ` from 0 to ${max}`}`,
    );
  }
  return n;
}

const shareOf = (total, hundredths) =>
  Number((BigInt(total) * BigInt(hundredths) * 2n + 10000n) / 20000n);

function patientShare(total, patientPays, value, quantity) {
  if (patientPays === "full") return total;
  if (patientPays === "nothing") return 0;
  if (patientPays === "amount") return paise(cleanValue(value, {})) * quantity;
  return shareOf(total, Math.round(cleanValue(value, { max: 100 }) * 100));
}

export function linePayable({ total, payment, quantity } = {}) {
  cleanTotal(total);
  const count = cleanQuantity(quantity);
  const patientPays = payment?.patient_pays ?? "full";
  if (!PATIENT_PAYS.includes(patientPays)) {
    throw new Error(`Patient pays must be one of: ${PATIENT_PAYS.join(", ")}`);
  }
  const remainder = patientPays === "full" ? null : payment.remainder;
  if (patientPays !== "full" && !REMAINDERS.includes(remainder)) {
    throw new Error(`The rest must go to one of: ${REMAINDERS.join(", ")}`);
  }
  const share = patientShare(total, patientPays, payment?.patient_value, count);
  const capped = share > total;
  const patient_payable = capped ? total : share;
  const rest = total - patient_payable;
  const result = {
    patient_payable,
    claim: remainder === "claim" ? rest : 0,
    adjustment: remainder === "adjustment" ? rest : 0,
    payment_rule_id: payment?.rule?.id ?? null,
    payment_rule_text: ruleText(patientPays, payment?.patient_value, { capped, total }),
    remainder,
    capped,
  };
  if (result.patient_payable + result.claim + result.adjustment !== total) {
    throw new Error("The patient payable and the rest don't add up to the line total");
  }
  return result;
}
