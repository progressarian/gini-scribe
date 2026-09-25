import { ORDER_STATE } from "../../../../shared/billingVocab.js";

export const ORDER_STATE_LABEL = {
  [ORDER_STATE.CLAIM_AT_RECEPTION]: "Claim at reception",
  [ORDER_STATE.PAID_AT_RECEPTION]: "Paid at reception",
};

export const ORDER_STATE_NOTE = {
  [ORDER_STATE.CLAIM_AT_RECEPTION]:
    "has its own insurance claim at reception, so this bill can't take money for it",
  [ORDER_STATE.PAID_AT_RECEPTION]:
    "was already paid at reception, so this bill can't take money for it",
};

export const orderStateText = (state) => ORDER_STATE_LABEL[state] ?? null;

export const PAYMENT_RULE_LABEL = {
  full: "Patient pays in full",
  amount: "Patient pays a fixed amount",
  percent: "Patient pays a percent",
  nothing: "Patient pays nothing",
};

export const paymentRuleText = (rule) => PAYMENT_RULE_LABEL[rule] ?? rule ?? "Patient pays in full";

export const BILL_STATUS_LABEL = { draft: "Draft", final: "Final", cancelled: "Cancelled" };

export const billStatusText = (status) => BILL_STATUS_LABEL[status] ?? status;

export const REQUEST_KIND_LABEL = { new_item: "New item", repeat_item: "Bill again" };

export const requestKindText = (kind) => REQUEST_KIND_LABEL[kind] ?? kind;

export const REQUEST_STATUS_LABEL = {
  pending: "Waiting for an admin",
  approved: "Approved",
  rejected: "Rejected",
  used: "Used",
};

export const requestStatusText = (status) => REQUEST_STATUS_LABEL[status] ?? status;

export const PAYMENT_MODE_LABEL = { cash: "Cash", card: "Card", upi: "UPI" };

export const CLAIM_BADGE = { pending: "CGHS pending", cleared: "CGHS cleared" };

export const claimBadgeText = (status) => CLAIM_BADGE[status] ?? null;

export const dueAgeText = (days) => {
  const age = Number(days || 0);
  if (age <= 0) return "Today";
  return age === 1 ? "1 day" : `${age} days`;
};

export const SHIFT_STATE_LABEL = { open: "Open", closed: "Closed" };

export const shiftStateText = (isOpen) =>
  isOpen ? SHIFT_STATE_LABEL.open : SHIFT_STATE_LABEL.closed;
