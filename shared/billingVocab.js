export const INT_MAX = 2147483647;
export const MONEY_MAX = 9999999999.99;
export const DEPOSIT_MAX = 500000;
export const YES_NO = ["yes", "no"];
export const ITEM_KINDS = ["consultation", "test", "procedure", "medicine", "other"];
export const CONSULTATION_DEFAULT_GROUP = { code: "OPD", name: "Out-patient Consultation" };
export const CONSULTATION_DEFAULT_SUBGROUP = { code: "OPD-CONS", name: "Consultation" };
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
export const BILL_SERIES = ["MAIN", "RCPT", "CN"];
export const REFUND_MODES = ["as_paid", "cash", "card", "upi", "deposit"];
export const AS_PAID = "as_paid";
export const HEALTHRAY_MODE = "healthray";
export const DEPOSIT_MODE = "deposit";
export const ORDER_STATE = {
  CLAIM_AT_RECEPTION: "claim_at_reception",
  PAID_AT_RECEPTION: "paid_at_reception",
};
export const COUNTER_BILL_STATE = {
  NONE: "none",
  DRAFT: "draft",
  DUE: "due",
  PAID: "paid",
  CLAIM_PENDING: "claim_pending",
  CLAIM_CLEARED: "claim_cleared",
};
export const DUE_AGES = [
  { key: "0-7", label: "0–7 days", min: 0, max: 7 },
  { key: "8-30", label: "8–30 days", min: 8, max: 30 },
  { key: "31-90", label: "31–90 days", min: 31, max: 90 },
  { key: "90+", label: "Over 90 days", min: 91, max: null },
];
export const DUE_SORTS = [
  { key: "oldest", label: "Oldest first" },
  { key: "largest", label: "Largest due first" },
];
export const DUES_PAGE_SIZE = 50;
export const DUES_PAGE_SIZE_MAX = 200;
export const CONSULTANT_FEES_PAGE_SIZE = 25;
export const CONSULTANT_FEES_PAGE_SIZE_MAX = 100;

export function financialYearOf(date) {
  const [year, month] = date.split("-").map(Number);
  const start = month >= 4 ? year : year - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, "0")}`;
}
export const BILL_DEPARTMENT = "OPD";
export const BILL_DOCUMENT_TITLES = {
  invoice: `${BILL_DEPARTMENT} BILL`,
  tax_invoice: "TAX INVOICE",
  credit_note: "CREDIT NOTE",
  receipt: "PAYMENT RECEIPT",
  refund_receipt: "REFUND RECEIPT",
};
