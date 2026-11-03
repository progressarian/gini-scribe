export const DAY_MS = 86400000;
export const dayText = (ms) => new Date(ms).toISOString().slice(0, 10);
export const dayMs = (text) => Date.parse(`${text}T00:00:00Z`);

export const RANGES = [
  { key: "today", label: "Today", range: (today) => ({ from: today, to: today }) },
  {
    key: "yesterday",
    label: "Yesterday",
    range: (today) => {
      const day = dayText(dayMs(today) - DAY_MS);
      return { from: day, to: day };
    },
  },
  {
    key: "month",
    label: "This month",
    range: (today) => ({ from: `${today.slice(0, 8)}01`, to: today }),
  },
  {
    key: "last_month",
    label: "Last month",
    range: (today) => {
      const end = dayMs(`${today.slice(0, 8)}01`) - DAY_MS;
      return { from: `${dayText(end).slice(0, 8)}01`, to: dayText(end) };
    },
  },
  {
    key: "last_30",
    label: "Last 30 days",
    range: (today) => ({ from: dayText(dayMs(today) - 29 * DAY_MS), to: today }),
  },
  {
    key: "fy",
    label: "This financial year",
    range: (today) => {
      const year = Number(today.slice(0, 4));
      const start = Number(today.slice(5, 7)) >= 4 ? year : year - 1;
      return { from: `${start}-04-01`, to: today };
    },
  },
  { key: "all", label: "All dates", openOnly: true, range: (today) => ({ from: "", to: today }) },
  { key: "custom", label: "Custom range", range: null },
];

export const DEFAULT_RANGE = RANGES.find((r) => r.key === "month");
export const QUICK_RANGES = RANGES.filter((r) => r.key === "today" || r.key === "yesterday");
