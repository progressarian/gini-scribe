import { fromPaise } from "../format";

export const balanceOf = (bill) => Math.max(0, bill.totals.payable - bill.totals.paid);

const schemeOf = (bill, schemes = []) => {
  const scheme = (schemes || []).find((entry) => entry.code === bill.category) || null;
  const parent = scheme ? (schemes || []).find((entry) => entry.code === scheme.parent_code) : null;
  return { scheme, parent: parent || null };
};

export function payLaterAllowed(bill, schemes = [], settings = null) {
  const { scheme, parent } = schemeOf(bill, schemes);
  const allowed = scheme?.allow_pay_later ?? parent?.allow_pay_later;
  if (allowed !== null && allowed !== undefined) return Boolean(allowed);
  return Boolean(settings?.allow_pay_later);
}

export function finaliseBlockers(bill, { schemes = [], settings = null, payLater = false } = {}) {
  if (bill.status !== "draft") return [];
  const blockers = [];
  if (!bill.lines.length) blockers.push("Add an item to this bill first.");
  const { scheme, parent } = schemeOf(bill, schemes);
  if (!bill.category) blockers.push("Confirm the patient's category first.");
  else if ((schemes || []).some((entry) => entry.parent_code === bill.category)) {
    blockers.push("Choose a sub-category before this bill can be made final.");
  }
  const needs = (flag) => Boolean(scheme?.[flag] || parent?.[flag]);
  if (scheme && needs("requires_referral") && !bill.referral_no) {
    blockers.push("Enter the referral number first.");
  }
  if (scheme && needs("requires_referral_doc") && !bill.referral_doc_id) {
    blockers.push("Attach the referral letter first.");
  }
  const balance = balanceOf(bill);
  if (balance > 0 && !(payLater && payLaterAllowed(bill, schemes, settings))) {
    blockers.push(`${fromPaise(balance)} is still to be collected on this bill.`);
  }
  return blockers;
}
