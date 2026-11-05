import { DAY_MS, dayMs, dayText } from "../../billing/reportRanges";
import { OPD_DASHBOARD_STATES, OPD_GROUPS } from "../../../../shared/opdMetrics.js";
import { OPD_TYPE_SETS } from "../../../../shared/opdSummary.js";

export const OPD_DASHBOARD_PATH = "/reports/opd-dashboard";

const RANGE_DAYS_MAX = 366;
const DAY_BUCKETS_MAX = 92;

const back = (today, days) => dayText(dayMs(today) - days * DAY_MS);
const weekStart = (day) => back(day, (new Date(dayMs(day)).getUTCDay() + 6) % 7);

export const OPD_PRESETS = [
  { key: "today", label: "Today", range: (today) => ({ from: today, to: today }) },
  {
    key: "yesterday",
    label: "Yesterday",
    range: (today) => ({ from: back(today, 1), to: back(today, 1) }),
  },
  { key: "week", label: "This week", range: (today) => ({ from: weekStart(today), to: today }) },
  { key: "last_7", label: "Last 7 days", range: (today) => ({ from: back(today, 6), to: today }) },
  {
    key: "month",
    label: "This month",
    range: (today) => ({ from: `${today.slice(0, 8)}01`, to: today }),
  },
  {
    key: "last_month",
    label: "Last month",
    range: (today) => {
      const end = back(`${today.slice(0, 8)}01`, 1);
      return { from: `${end.slice(0, 8)}01`, to: end };
    },
  },
  {
    key: "last_30",
    label: "Last 30 days",
    range: (today) => ({ from: back(today, 29), to: today }),
  },
  {
    key: "last_12_weeks",
    label: "Last 12 weeks",
    range: (today) => ({ from: weekStart(back(today, 77)), to: today }),
  },
  {
    key: "last_12_months",
    label: "Last 12 months",
    range: (today) => {
      const year = Number(today.slice(0, 4));
      const month = Number(today.slice(5, 7));
      const from = new Date(Date.UTC(year, month - 12, 1)).toISOString().slice(0, 10);
      return { from, to: today };
    },
  },
  { key: "custom", label: "Custom", range: null },
];

const DEFAULT_PRESET = "month";

export function readFilters(params, today) {
  const asked = params.get("range") || (params.get("from") ? "custom" : DEFAULT_PRESET);
  const preset = OPD_PRESETS.find((p) => p.key === asked);
  const dates = preset?.range ? preset.range(today) : {};
  const group = params.get("group");
  const type = params.get("type");
  return {
    range: preset ? asked : "custom",
    from: preset?.range ? dates.from : params.get("from") || "",
    to: preset?.range ? dates.to : params.get("to") || "",
    group: OPD_GROUPS.includes(group) ? group : "",
    type: OPD_TYPE_SETS[type] ? type : "opd",
    doctors: params.getAll("doctor").filter(Boolean),
  };
}

const realDay = (text) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const parsed = new Date(`${text}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === text;
};

export function rangeProblem(filters, today) {
  if (!filters.from || !filters.to) return "Choose a start and an end date.";
  if (!realDay(filters.from)) return "Choose a valid start date.";
  if (!realDay(filters.to)) return "Choose a valid end date.";
  if (filters.from > filters.to) return "The start date is after the end date.";
  if (filters.to > today) return "The end date can't be after today.";
  const days = Math.round((dayMs(filters.to) - dayMs(filters.from)) / DAY_MS) + 1;
  if (days > RANGE_DAYS_MAX) return `Choose at most ${RANGE_DAYS_MAX} days at a time.`;
  if (filters.group === "day" && days > DAY_BUCKETS_MAX) {
    return `Day by day covers at most ${DAY_BUCKETS_MAX} days — group by week or month.`;
  }
  return null;
}

export const apiParams = (filters) => ({
  from: filters.from,
  to: filters.to,
  type: filters.type,
  ...(filters.group ? { group: filters.group } : {}),
  ...(filters.doctors.length ? { doctor: filters.doctors } : {}),
});

export function visitsHref(filters, extra = {}) {
  const params = new URLSearchParams({ from: filters.from, to: filters.to, type: filters.type });
  const { doctors, ...rest } = extra;
  for (const name of doctors ?? filters.doctors) params.append("doctor", name);
  for (const [key, value] of Object.entries(rest)) {
    if (value !== undefined && value !== null && value !== "") params.set(key, String(value));
  }
  return `${OPD_DASHBOARD_PATH}/visits?${params}`;
}

export const stateLabel = (state) => OPD_DASHBOARD_STATES[state] ?? OPD_DASHBOARD_STATES.booked;
export const knownState = (state) => (OPD_DASHBOARD_STATES[state] ? state : "booked");
