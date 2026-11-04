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
  cancelled: "Cancelled",
  manual_discount: "Manual discount",
};
