import { indiaToday } from "./categoryResolver.js";
import { cleanDate, INT_MAX, readNumber } from "./common.js";
import { httpError } from "./transaction.js";

export const IST = "Asia/Kolkata";
export const RANGE_DAYS_MAX = 366;
export const PERIODS = ["none", "day", "week", "month"];
export const CODE_MAX = 40;

export const FILTER_LABELS = {
  from: "From",
  to: "To",
  period: "By",
  category: "Category",
  sub_category: "Sub-category",
  group: "Group",
  subgroup: "Subgroup",
  consultant: "Consultant",
  user: "User",
};

export const FILTER_KEYS = Object.keys(FILTER_LABELS);
const DATE_KEYS = ["from", "to"];
const CODE_KEYS = ["category", "sub_category", "group", "subgroup"];
const ID_KEYS = ["consultant", "user"];

const given = (value) => value !== undefined && value !== null && value !== "";

const firstOfMonth = (day) => `${day.slice(0, 8)}01`;

const daysBetween = (from, to) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000) + 1;

function cleanCodeFilter(value, label) {
  const code = typeof value === "string" ? value.trim() : "";
  if (!code || /\s/.test(code) || code.length > CODE_MAX) {
    throw httpError(400, `${label} must be a code without spaces`);
  }
  return code;
}

function cleanIdFilter(value, label) {
  const id = readNumber(value, `${label} must be an id`);
  if (!Number.isInteger(id) || id <= 0 || id > INT_MAX) {
    throw httpError(400, `${label} must be an id`);
  }
  return id;
}

function cleanRange(input, report) {
  const to = cleanDate(input.to, FILTER_LABELS.to) ?? indiaToday();
  const asked = cleanDate(input.from, FILTER_LABELS.from);
  const from = asked ?? (report.openStart ? null : firstOfMonth(to));
  if (from && from > to) throw httpError(400, "The start date is after the end date");
  if (from && !report.openStart && daysBetween(from, to) > RANGE_DAYS_MAX) {
    throw httpError(
      400,
      `The ${report.title} report covers at most ${RANGE_DAYS_MAX} days at a time — choose a shorter range`,
    );
  }
  return { from, to };
}

export function cleanFilters(input, report) {
  const raw = input && typeof input === "object" ? input : {};
  const allowed = new Set([...DATE_KEYS, ...report.filters]);
  for (const key of Object.keys(raw)) {
    if (!given(raw[key])) continue;
    if (!FILTER_KEYS.includes(key)) throw httpError(400, `Unknown filter: ${key}`);
    if (!allowed.has(key)) {
      throw httpError(
        400,
        `The ${report.title} report can't be filtered by ${FILTER_LABELS[key].toLowerCase()}`,
      );
    }
  }
  const filters = cleanRange(raw, report);
  for (const key of CODE_KEYS) {
    if (allowed.has(key) && given(raw[key])) {
      filters[key] = cleanCodeFilter(raw[key], FILTER_LABELS[key]);
    }
  }
  for (const key of ID_KEYS) {
    if (allowed.has(key) && given(raw[key])) {
      filters[key] = cleanIdFilter(raw[key], FILTER_LABELS[key]);
    }
  }
  if (allowed.has("period")) {
    const period = given(raw.period) ? String(raw.period).trim() : report.period;
    if (!PERIODS.includes(period)) {
      throw httpError(400, `${FILTER_LABELS.period} must be one of: ${PERIODS.join(", ")}`);
    }
    filters.period = period;
  }
  return filters;
}

const PERIOD_SQL = {
  none: () => "NULL::date",
  day: (column) => column,
  week: (column) => `date_trunc('week', ${column})::date`,
  month: (column) => `date_trunc('month', ${column})::date`,
};

export const periodOf = (filters, column) => PERIOD_SQL[filters.period ?? "none"](column);

export const dayOfInstant = (column) => `(${column} AT TIME ZONE '${IST}')::date`;

const COMPARE = {
  category: (column, $) => `${column} = ${$}`,
  sub_category: (column, $) => `${column} = ${$}`,
  group: (column, $) => `lower(${column}) = lower(${$})`,
  subgroup: (column, $) => `lower(${column}) = lower(${$})`,
  consultant: (column, $) => `${column} = ${$}::int`,
  user: (column, $) => `${column} = ${$}::int`,
};

function dayWithin(day, bind, { from, to }) {
  const conditions = [];
  if (day.date) {
    if (from) conditions.push(`${day.date} >= ${bind(from)}::date`);
    conditions.push(`${day.date} <= ${bind(to)}::date`);
    return conditions;
  }
  if (from) {
    conditions.push(`${day.instant} >= (${bind(from)}::date)::timestamp AT TIME ZONE '${IST}'`);
  }
  conditions.push(`${day.instant} < (${bind(to)}::date + 1)::timestamp AT TIME ZONE '${IST}'`);
  return conditions;
}

export function reportScope(filters, columns, params = []) {
  if (!columns?.day?.date && !columns?.day?.instant) {
    throw new Error("Every report query names the day it is filtered on");
  }
  const bind = (value) => {
    params.push(value);
    return `$${params.length}`;
  };
  const where = dayWithin(columns.day, bind, filters);
  for (const key of Object.keys(COMPARE)) {
    if (filters[key] === undefined) continue;
    if (!columns[key]) throw new Error(`This report query has no column for the ${key} filter`);
    where.push(COMPARE[key](columns[key], bind(filters[key])));
  }
  return { sql: where.join(" AND "), params, bind };
}
