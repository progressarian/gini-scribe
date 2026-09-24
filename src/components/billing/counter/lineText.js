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
