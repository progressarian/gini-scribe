import { ITEM_KINDS } from "./billingVocab.js";

export const AUDIT_RANGE_MAX_DAYS = 366;
export const AUDIT_PAGE_SIZES = [25, 50, 100];
export const AUDIT_PAGE_SIZE = 25;
export const AUDIT_EXPORT_MAX = 20000;
export const AUDIT_SEARCH_MAX = 100;
export const AUDIT_VIEWS = ["bills", "items"];

const KIND_LABEL = {
  consultation: "Consultation (OPD)",
  test: "Lab test",
  procedure: "Procedure",
  medicine: "Medicine",
  other: "Other",
};

export const AUDIT_BILL_KINDS = [
  ...ITEM_KINDS.map((value) => ({ value, label: KIND_LABEL[value] ?? value })),
  { value: "mixed", label: "Mixed" },
  { value: "none", label: "No items" },
];

export const AUDIT_ITEM_KINDS = ITEM_KINDS.map((value) => ({
  value,
  label: KIND_LABEL[value] ?? value,
}));

export const AUDIT_DOCUMENTS = [
  { value: "invoice", label: "Invoice" },
  { value: "credit_note", label: "Credit note" },
];

export const AUDIT_STATUSES = [
  { value: "draft", label: "Draft" },
  { value: "final", label: "Final" },
  { value: "cancelled", label: "Cancelled" },
];

export const AUDIT_PAYMENT_STATES = [
  { value: "paid", label: "Paid" },
  { value: "partial", label: "Partly paid" },
  { value: "unpaid", label: "Unpaid" },
  { value: "no_charge", label: "No charge" },
  { value: "not_applicable", label: "Not applicable" },
];

export const AUDIT_CLAIM_STATUSES = [
  { value: "none", label: "No claim" },
  { value: "pending", label: "Claim pending" },
  { value: "cleared", label: "Claim cleared" },
];

export const AUDIT_PAYMENT_MODES = [
  { value: "cash", label: "Cash" },
  { value: "card", label: "Card" },
  { value: "upi", label: "UPI" },
  { value: "neft", label: "NEFT / Cheque" },
  { value: "healthray", label: "HealthRay" },
  { value: "deposit", label: "Deposit" },
  { value: "prepaid", label: "Paid earlier / online" },
];

export const AUDIT_LINE_SOURCES = [
  { value: "visit", label: "Visit" },
  { value: "lab_order", label: "Lab order" },
  { value: "lab_case", label: "Lab case" },
  { value: "ordered", label: "Ordered" },
  { value: "added", label: "Added at desk" },
];

export const AUDIT_BILL_SORT_DEFAULT = "bill_no_desc";

export const AUDIT_BILL_SORTS = [
  { value: "newest", label: "Newest first" },
  { value: "oldest", label: "Oldest first" },
  { value: "payable", label: "Largest payable first" },
  { value: "due", label: "Largest due first" },
  { value: "bill_no", label: "Bill number (low to high)" },
  { value: "bill_no_desc", label: "Bill number (high to low)" },
];

export const AUDIT_ITEM_SORTS = [
  { value: "newest", label: "Newest first" },
  { value: "oldest", label: "Oldest first" },
  { value: "amount", label: "Largest amount first" },
];

export const labelOf = (list, value) => list.find((o) => o.value === value)?.label ?? value ?? "";

export const TIME_TEXT = /^([01]\d|2[0-3]):[0-5]\d$/;

export const daysBetween = (from, to) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);

export function auditRangeProblem({ from, to, from_time: fromTime, to_time: toTime }) {
  if (!from || !to) return "Choose a start date and an end date";
  if (to < from) return "The end date must be on or after the start date";
  if (daysBetween(from, to) + 1 > AUDIT_RANGE_MAX_DAYS) {
    return `Choose a range of ${AUDIT_RANGE_MAX_DAYS} days or less`;
  }
  if (fromTime && !TIME_TEXT.test(fromTime)) return "Enter the start time as HH:MM";
  if (toTime && !TIME_TEXT.test(toTime)) return "Enter the end time as HH:MM";
  if (from === to && fromTime && toTime && toTime < fromTime) {
    return "The end time must be after the start time on the same day";
  }
  return null;
}
