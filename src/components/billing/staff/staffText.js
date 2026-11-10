const IST_CLOCK = new Intl.DateTimeFormat("en-IN", {
  timeZone: "Asia/Kolkata",
  day: "numeric",
  month: "short",
  hour: "numeric",
  minute: "2-digit",
});

const IST_TIME = new Intl.DateTimeFormat("en-IN", {
  timeZone: "Asia/Kolkata",
  hour: "numeric",
  minute: "2-digit",
});

export const clock = (value) => (value ? IST_CLOCK.format(new Date(value)) : "—");
export const timeOnly = (value) => (value ? IST_TIME.format(new Date(value)) : "—");

export function hoursOpen(shift, now = Date.now()) {
  const end = shift.closed_at ? Date.parse(shift.closed_at) : now;
  const minutes = Math.max(0, Math.round((end - Date.parse(shift.opened_at)) / 60000));
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  if (days) return `${days}d ${hours}h`;
  return `${hours}h ${minutes % 60}m`;
}

export function cashStatus(shift) {
  if (shift.is_open) {
    return shift.left_open
      ? { key: "left_open", label: "Left open" }
      : { key: "open", label: "Open" };
  }
  if (shift.counted_cash === null) return { key: "not_counted", label: "Not counted" };
  if (shift.difference < 0) return { key: "short", label: "Short" };
  if (shift.difference > 0) return { key: "over", label: "Over" };
  return { key: "matches", label: "Matches" };
}

export const nonCash = (shift) =>
  ["card", "upi", "neft"].reduce(
    (sum, mode) => sum + (shift.collected[mode] ?? 0) - (shift.refunded[mode] ?? 0),
    0,
  );

export const SOURCE_LABEL = {
  payments_tab: "Payments tab (taken in HealthRay)",
  fee_settle: "Fee change settled (taken in HealthRay)",
};

export const ACTIVITY_LABEL = {
  finalised: "Finalised",
  closed_by_cancel: "Closed by test cancel",
  cancelled: "Cancelled",
  manual_discount: "Manual discount",
};

const WHOLE_DIGITS_MAX = 10;
const MONEY_MAX_PAISE = 999999999999;
const FAR_OFF_PAISE = 1000000;
const FAR_OFF_SHARE = 0.25;

export function cashTyped(value) {
  const [whole, ...rest] = String(value)
    .replace(/[^\d.]/g, "")
    .split(".");
  const trimmed = whole.slice(0, WHOLE_DIGITS_MAX);
  return rest.length ? `${trimmed}.${rest.join("").slice(0, 2)}` : trimmed;
}

export const cashPaise = (text) => Math.round(Number(text || 0) * 100);

export function countedProblem(text) {
  const value = String(text ?? "").trim();
  if (!value) return "Enter the cash you counted in the drawer.";
  if (!/^\d+(\.\d{1,2})?$/.test(value)) return "Enter an amount like 12500 or 12500.50.";
  if (cashPaise(value) > MONEY_MAX_PAISE) return "That amount is too large — check the count.";
  return null;
}

export function countedWarning(countedPaise, expectedPaise) {
  const gap = countedPaise - expectedPaise;
  if (!gap) return null;
  const far =
    Math.abs(gap) >= FAR_OFF_PAISE || Math.abs(gap) > FAR_OFF_SHARE * Math.max(expectedPaise, 1);
  if (!far) return null;
  return gap > 0
    ? "This is far more than expected — check the amount for an extra digit before closing."
    : "This is far less than expected — check the count before closing.";
}
