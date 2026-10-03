import { HEALTHRAY_MODE, ORDER_STATE } from "../../../../shared/billingVocab.js";

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

const CLAIM_STATE_WORD = { submitted: "Claim submitted", approved: "Claim approved" };

export const claimText = (claim, money) =>
  `${CLAIM_STATE_WORD[claim.state] ?? "Claim"} ${money(claim.amount)}${claim.insurer ? ` · ${claim.insurer}` : ""}`;

export const PAYMENT_RULE_LABEL = {
  full: "Patient pays in full",
  amount: "Patient pays a fixed amount",
  percent: "Patient pays a percent",
  nothing: "Patient pays nothing",
};

export const paymentRuleText = (rule) => PAYMENT_RULE_LABEL[rule] ?? rule ?? "Patient pays in full";

export const BILL_STATUS_LABEL = { draft: "Draft", final: "Final", cancelled: "Cancelled" };

export const billStatusText = (status) => BILL_STATUS_LABEL[status] ?? status;

export const REQUEST_KIND_LABEL = {
  new_item: "New item",
  repeat_item: "Bill again",
  refund: "Refund",
};

export const requestKindText = (kind) => REQUEST_KIND_LABEL[kind] ?? kind;

export const REQUEST_STATUS_LABEL = {
  pending: "Waiting for an admin",
  approved: "Approved",
  rejected: "Rejected",
  used: "Used",
};

export const requestStatusText = (status) => REQUEST_STATUS_LABEL[status] ?? status;

export const PAYMENT_MODE_LABEL = { cash: "Cash", card: "Card", upi: "UPI" };

export const HEALTHRAY_LABEL = "Paid in HealthRay";

export const PAID_MODE_LABEL = { ...PAYMENT_MODE_LABEL, [HEALTHRAY_MODE]: HEALTHRAY_LABEL };

export const paymentModeText = (mode) => PAID_MODE_LABEL[mode] ?? mode ?? "";

const PAY_OUT_LABEL = { [HEALTHRAY_MODE]: "Refunded in HealthRay" };

export const payOutText = (mode) => PAY_OUT_LABEL[mode] ?? `${paymentModeText(mode)} refund`;

export const REFUND_MODE_LABEL = {
  as_paid: "Back the way it was paid",
  ...PAYMENT_MODE_LABEL,
  [HEALTHRAY_MODE]: "Refunded in HealthRay",
};

export const refundModeText = (mode) => REFUND_MODE_LABEL[mode] ?? mode ?? "";

const MODE_WORD = { cash: "cash", card: "card", upi: "UPI" };

const legText = (leg, money) =>
  leg.mode === HEALTHRAY_MODE
    ? `${money(leg.amount)} in HealthRay`
    : `${money(leg.amount)} by ${MODE_WORD[leg.mode] ?? leg.mode}`;

export const refundLegsText = (legs, money) =>
  (legs || []).map((leg) => legText(leg, money)).join(", ");

export const CLAIM_BADGE = { pending: "CGHS pending", cleared: "CGHS cleared" };

export const claimBadgeText = (status, clearedOn = null) =>
  status === "cleared" && clearedOn ? `Cleared on ${clearedOn}` : (CLAIM_BADGE[status] ?? null);

export const dueAgeText = (days) => {
  const age = Number(days || 0);
  if (age <= 0) return "Today";
  return age === 1 ? "1 day" : `${age} days`;
};

export const SHIFT_STATE_LABEL = { open: "Open", closed: "Closed" };

export const shiftStateText = (isOpen) =>
  isOpen ? SHIFT_STATE_LABEL.open : SHIFT_STATE_LABEL.closed;
