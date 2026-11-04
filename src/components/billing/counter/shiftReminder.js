const IST_DAY = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" });
const IST_HOUR = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Kolkata",
  hour: "numeric",
  hour12: false,
});
const DAY_END_HOUR = 18;

export const istDay = (value = new Date()) => IST_DAY.format(new Date(value));

export function shiftReminder(shift, now = new Date()) {
  if (!shift?.is_open) return null;
  if (istDay(shift.opened_at) < istDay(now)) return "earlier";
  return Number(IST_HOUR.format(now)) >= DAY_END_HOUR ? "day_end" : null;
}
