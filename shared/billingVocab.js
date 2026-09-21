export const INT_MAX = 2147483647;
export const MONEY_MAX = 9999999999.99;
export const YES_NO = ["yes", "no"];
export const ITEM_KINDS = ["consultation", "test", "procedure", "medicine", "other"];
export const DISCOUNT_KINDS = ["percent", "flat", "fixed_price"];
export const PATIENT_PAYS = ["full", "amount", "percent", "nothing"];
export const REMAINDERS = ["claim", "adjustment"];
export const DISCOUNT_METHODS = ["auto", "code"];
export const CATEGORY_RULE_MODES = ["suggest", "auto"];
export const VISIT_TYPES = ["New", "Follow Up", "Investigation"];
export const CONSULTATION_VISIT_TYPES = ["New", "Follow Up"];
export const GENDERS = ["Male", "Female", "Other"];
export const BILLING_ROLES = ["reception", "reception_admin", "admin"];
export const RESERVED_CATEGORY_CODES = ["general"];
export const STACKING_MODES = ["best_only", "per_rule"];
export const BILL_SERIES = ["MAIN", "RCPT"];

export function financialYearOf(date) {
  const [year, month] = date.split("-").map(Number);
  const start = month >= 4 ? year : year - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, "0")}`;
}
