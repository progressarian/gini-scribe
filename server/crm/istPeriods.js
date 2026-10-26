export const IST = "'Asia/Kolkata'";

export const istDayOf = (column) => `(${column} AT TIME ZONE ${IST})::date`;

const startOf = (unit) => `(date_trunc('${unit}', now() AT TIME ZONE ${IST}) AT TIME ZONE ${IST})`;

export const IST_DAY_START = startOf("day");
export const IST_WEEK_START = startOf("week");
export const IST_MONTH_START = startOf("month");
export const IST_TODAY = `(now() AT TIME ZONE ${IST})::date`;

export const periodCounts = (column = "occurred_at") => `
  count(*) FILTER (WHERE ${column} >= ${IST_DAY_START})::int AS visits_today,
  count(*) FILTER (WHERE ${column} >= ${IST_WEEK_START})::int AS visits_week,
  count(*) FILTER (WHERE ${column} >= ${IST_MONTH_START})::int AS visits_month`;

export function uploadWindow(now = new Date()) {
  const today = istDate(now);
  const weekStart = mondayOf(today);
  const monthStart = monthStartOf(today);
  return { from: weekStart < monthStart ? weekStart : monthStart, to: today };
}

export function mondayOf(day) {
  const weekday = (new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7;
  return addDays(day, -weekday);
}

export const monthStartOf = (day) => `${day.slice(0, 7)}-01`;

export function addMonths(day, n) {
  const d = new Date(`${monthStartOf(day)}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + n);
  return d.toISOString().slice(0, 10);
}

export const monthEndOf = (day) => addDays(addMonths(day, 1), -1);

export const daysBetween = (from, to) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

export function istDate(at = new Date()) {
  return new Date(at.getTime() + 330 * 60_000).toISOString().slice(0, 10);
}

export function addDays(day, n) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export const ddmmyyyy = (day) => (day ? day.split("-").reverse().join("-") : "");
