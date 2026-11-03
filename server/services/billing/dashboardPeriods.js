import { indiaToday } from "./categoryResolver.js";
import { cleanDate, INT_MAX } from "./common.js";
import { CODE_MAX, RANGE_DAYS_MAX } from "./reportsFilters.js";
import { httpError } from "./transaction.js";

export const DASHBOARD_PERIODS = ["day", "week", "month"];
export const DAY_BUCKETS_MAX = 92;
const DAY_MS = 86400000;
const CODE_FILTERS = { category: "Category", sub_category: "Sub-category" };

const ms = (day) => Date.parse(`${day}T00:00:00Z`);
const dayText = (time) => new Date(time).toISOString().slice(0, 10);
const given = (value) => value !== undefined && value !== null && value !== "";

export const addDays = (day, count) => dayText(ms(day) + count * DAY_MS);
export const daysBetween = (from, to) => Math.round((ms(to) - ms(from)) / DAY_MS) + 1;
export const autoPeriod = (days) => (days <= 31 ? "day" : days <= 120 ? "week" : "month");

function cleanConsultant(value) {
  const id = Number(String(value).trim());
  if (!Number.isInteger(id) || id <= 0 || id > INT_MAX) {
    throw httpError(400, "Consultant must be an id");
  }
  return id;
}

function cleanCode(value, label) {
  const code = String(value).trim();
  if (!code || /\s/.test(code) || code.length > CODE_MAX) {
    throw httpError(400, `${label} must be a code without spaces`);
  }
  return code;
}

export function cleanDashboardFilters(input = {}, today = indiaToday()) {
  const raw = input && typeof input === "object" ? input : {};
  const to = cleanDate(raw.to, "To") ?? today;
  const from = cleanDate(raw.from, "From") ?? `${to.slice(0, 8)}01`;
  if (from > to) throw httpError(400, "The start date is after the end date");
  const days = daysBetween(from, to);
  if (days > RANGE_DAYS_MAX) {
    throw httpError(
      400,
      `The dashboard covers at most ${RANGE_DAYS_MAX} days at a time — choose a shorter range`,
    );
  }
  const asked = given(raw.period) ? String(raw.period).trim() : "";
  if (asked && !DASHBOARD_PERIODS.includes(asked)) {
    throw httpError(400, "View by must be day, week or month");
  }
  const period = asked || autoPeriod(days);
  if (period === "day" && days > DAY_BUCKETS_MAX) {
    throw httpError(
      400,
      `Day by day covers at most ${DAY_BUCKETS_MAX} days — view by week or month, or choose a shorter range`,
    );
  }
  const filters = { from, to, period };
  for (const [key, label] of Object.entries(CODE_FILTERS)) {
    if (given(raw[key])) filters[key] = cleanCode(raw[key], label);
  }
  if (given(raw.consultant)) filters.consultant = cleanConsultant(raw.consultant);
  return filters;
}

export function previousRange({ from, to }) {
  const before = addDays(from, -1);
  return { from: addDays(before, -(daysBetween(from, to) - 1)), to: before };
}

const weekStart = (day) => addDays(day, -((new Date(ms(day)).getUTCDay() + 6) % 7));
const monthEnd = (start) => {
  const date = new Date(ms(start));
  return dayText(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0));
};

const STARTS = { day: (day) => day, week: weekStart, month: (day) => `${day.slice(0, 8)}01` };
const ENDS = { day: (start) => start, week: (start) => addDays(start, 6), month: monthEnd };

export function isoWeek(day) {
  const thursday = addDays(weekStart(day), 3);
  const yearStart = `${thursday.slice(0, 4)}-01-01`;
  return Math.floor((ms(thursday) - ms(yearStart)) / (7 * DAY_MS)) + 1;
}

export function bucketsOf({ from, to, period }) {
  const buckets = [];
  for (let start = STARTS[period](from); start <= to; ) {
    const end = ENDS[period](start);
    buckets.push({
      bucket: start,
      start: start < from ? from : start,
      end: end > to ? to : end,
      partial: start < from || end > to,
      ...(period === "week" ? { week: isoWeek(start) } : {}),
    });
    start = addDays(end, 1);
  }
  return buckets;
}
