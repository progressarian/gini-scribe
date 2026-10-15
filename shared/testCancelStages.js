export const CANCEL_STAGE = {
  direct: "direct",
  cancelStartFirst: "cancel_start_first",
  request: "request",
  locked: "locked",
};

const LAB_DIRECT = ["ordered", "payment_pending", "paid"];
const LAB_STARTED = ["drawing"];
const LAB_COLLECTED = [
  "sample_collected",
  "sample_sent",
  "sent_outside",
  "sample_received",
  "processing",
];
const MACHINE_DIRECT = ["ordered", "payment_pending", "paid"];
const MACHINE_STARTED = ["in_progress", "done"];

export function orderCancelStage({ kind, sampleStatus, hasOutput }) {
  if (hasOutput) return CANCEL_STAGE.locked;
  if (kind === "machine") {
    if (MACHINE_DIRECT.includes(sampleStatus)) return CANCEL_STAGE.direct;
    if (MACHINE_STARTED.includes(sampleStatus)) return CANCEL_STAGE.request;
    return CANCEL_STAGE.locked;
  }
  if (LAB_DIRECT.includes(sampleStatus)) return CANCEL_STAGE.direct;
  if (LAB_STARTED.includes(sampleStatus)) return CANCEL_STAGE.cancelStartFirst;
  if (LAB_COLLECTED.includes(sampleStatus)) return CANCEL_STAGE.request;
  return CANCEL_STAGE.locked;
}

export function caseCancelStage({ live, reported, collected, drawing }) {
  if (!live || reported) return CANCEL_STAGE.locked;
  if (collected) return CANCEL_STAGE.request;
  if (drawing) return CANCEL_STAGE.cancelStartFirst;
  return CANCEL_STAGE.direct;
}

export const orderCancelKey = (orderId, testId = null) => `order:${orderId}:${testId || "all"}`;
export const caseCancelKey = (caseNo) => `case:${caseNo}`;

export const CHARGE_TYPES = ["percent", "fixed"];

export function chargeOf({ type, value, paid }) {
  const paise = Math.round(Number(paid) * 100);
  const v = value === "" || value === null || value === undefined ? NaN : Number(value);
  if (!CHARGE_TYPES.includes(type)) return { error: "Choose a percentage or a fixed amount" };
  if (!Number.isFinite(v) || v < 0 || Math.abs(Math.round(v * 100) - v * 100) > 1e-6) {
    return {
      error:
        type === "percent"
          ? "Enter a percentage from 0 to 100, up to 2 decimals"
          : "Enter an amount of 0 or more, up to 2 decimals",
    };
  }
  if (type === "percent" && v > 100) return { error: "Enter a percentage from 0 to 100" };
  const charge = type === "percent" ? Math.round((paise * v) / 100) : Math.round(v * 100);
  if (charge > paise) {
    return { error: `The charge can't be more than ₹${(paise / 100).toFixed(2)}` };
  }
  return { charge, refund: paise - charge, paid: paise };
}
