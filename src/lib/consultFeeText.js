import { fromPaise } from "../components/billing/format";

export function consultFeeText(fee, name) {
  if (fee.visit === false) {
    return "Not on the floor yet — only the consultant changes; the fee is picked up when the bill is made.";
  }
  if (fee.fee_missing)
    return `${name} has no consultation fee set — the counter will need to add it.`;
  if (fee.new_fee === null) return `${name}'s fee is worked out when the bill is made.`;
  const now = fromPaise(fee.new_fee);
  if (fee.bill_state === "none") return `${name}'s fee is ${now} — billed when the bill is made.`;
  if (fee.bill_state === "draft") {
    return `Draft bill: ${fromPaise(fee.charged)} → ${now}. The consultation line is swapped when you save.`;
  }
  if (fee.difference === 0) return `Same fee (${now}) — nothing changes on the paid bill.`;
  const gap = fromPaise(Math.abs(fee.difference));
  return fee.difference > 0
    ? `Billed ${fromPaise(fee.charged)} → ${name} ${now} · ${gap} more to collect. The Billing Counter confirms it.`
    : `Billed ${fromPaise(fee.charged)} → ${name} ${now} · ${gap} goes back to the patient (deposit or refund). The Billing Counter confirms it.`;
}
