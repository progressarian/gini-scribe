// The one vocabulary for how a lab order gets paid for.
//
// An order can be settled by cash, by an insurance claim, or by both at once —
// a policy that covers ₹900 of a ₹1,250 order leaves ₹350 for the patient to
// pay at the desk. So the money is the truth and payment_status is derived from
// it, never set by hand: every screen and SQL filter still reads one column, but
// nothing has to know the derivation except this file.
//
// The gate the whole thing exists to guard (brief §2.2): the lab may not collect
// a sample until the order is settled — cash in hand plus an APPROVED claim. A
// submitted claim is a promise, not money, so it settles nothing.

export const PAYMENT_STATUS = {
  PENDING: "pending",
  PART_PAID: "part_paid",
  CLAIM_SUBMITTED: "insurance_claim",
  PAID: "paid",
  CLAIM_APPROVED: "claim_approved",
};

export const CLAIM_STATE = {
  NONE: "none",
  SUBMITTED: "submitted",
  APPROVED: "approved",
  REJECTED: "rejected",
};

export const PAYMENT_LABEL = {
  pending: "Payment pending",
  part_paid: "Part paid — balance due",
  insurance_claim: "Claim submitted — awaiting approval",
  paid: "Paid",
  claim_approved: "Insurance claim approved",
};

// What counts as cleared for the lab.
export const opensLabGate = (paymentStatus) =>
  [PAYMENT_STATUS.PAID, PAYMENT_STATUS.CLAIM_APPROVED].includes(paymentStatus);

// Rupees in, whole paise out. Money never rides on a float: 1250.1 - 900.1 is
// not 350 in binary, and a stray hundredth of a paisa would leave an order
// permanently one unit short of settled and the lab permanently blocked.
// NUMERIC also arrives from pg as a string, so everything lands here first.
export const paise = (amount) => Math.round(Number(amount || 0) * 100);

export const rupeesFromPaise = (p) => Math.round(p) / 100;

// A claim counts only once the insurer has said yes. Submitted and rejected
// claims are worth nothing to the hospital's bank balance.
export const settledPaise = (order) =>
  paise(order.amountPaid ?? order.amount_paid) +
  ((order.claimState ?? order.claim_state) === CLAIM_STATE.APPROVED
    ? paise(order.amountClaimed ?? order.amount_claimed)
    : 0);

export const outstandingPaise = (order) =>
  Math.max(0, paise(order.amountTotal ?? order.amount_total) - settledPaise(order));

export const outstandingOf = (order) => rupeesFromPaise(outstandingPaise(order));

// A claim that is still standing has money spoken for even though nothing has
// arrived: the desk cannot also take that ₹900 in cash, or the order would be
// collected twice over and the invariant the table enforces would break. What is
// left to collect is therefore the total minus cash minus any live claim.
export const committedPaise = (order) => {
  const claimState = order.claimState ?? order.claim_state ?? CLAIM_STATE.NONE;
  const live = claimState === CLAIM_STATE.SUBMITTED || claimState === CLAIM_STATE.APPROVED;
  return (
    paise(order.amountPaid ?? order.amount_paid) +
    (live ? paise(order.amountClaimed ?? order.amount_claimed) : 0)
  );
};

export const collectiblePaise = (order) =>
  Math.max(0, paise(order.amountTotal ?? order.amount_total) - committedPaise(order));

export const collectibleOf = (order) => rupeesFromPaise(collectiblePaise(order));

// The single place payment_status is computed. Order matters: a claim waiting on
// an insurer is the more useful thing for the desk to see than "part paid", so
// it wins while some cash is already in.
export const derivePaymentStatus = (order) => {
  const claimState = order.claimState ?? order.claim_state ?? CLAIM_STATE.NONE;
  if (outstandingPaise(order) === 0) {
    return claimState === CLAIM_STATE.APPROVED
      ? PAYMENT_STATUS.CLAIM_APPROVED
      : PAYMENT_STATUS.PAID;
  }
  if (claimState === CLAIM_STATE.SUBMITTED) return PAYMENT_STATUS.CLAIM_SUBMITTED;
  if (paise(order.amountPaid ?? order.amount_paid) > 0) return PAYMENT_STATUS.PART_PAID;
  return PAYMENT_STATUS.PENDING;
};
