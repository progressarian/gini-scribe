export const PERIODS = [
  { value: "today", label: "Today" },
  { value: "yesterday", label: "Yesterday" },
  { value: "this_week", label: "This week" },
  { value: "last_week", label: "Last week" },
  { value: "this_month", label: "This month" },
  { value: "last_month", label: "Last month" },
  { value: "custom", label: "Custom range" },
];

export const GROUPS = [
  { value: "", label: "Auto" },
  { value: "day", label: "By day" },
  { value: "week", label: "By week" },
  { value: "month", label: "By month" },
];

export const SERIES = [
  "#2a78d6",
  "#eb6834",
  "#1baf7a",
  "#eda100",
  "#e87ba4",
  "#008300",
  "#6250d6",
  "#e34948",
];

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function dayText(iso) {
  if (!iso) return "";
  const [y, m, d] = iso.split("-").map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

export function rangeText(from, to) {
  return from === to ? dayText(from) : `${dayText(from)} – ${dayText(to)}`;
}

export function deltaText(now, before) {
  if (now == null || before == null) return null;
  const diff = now - before;
  if (diff === 0) return "Same as before";
  return `${diff > 0 ? "+" : "−"}${Math.abs(diff)} vs before`;
}

export const pct = (n) => (n == null ? "—" : `${n}%`);

export function shortDateTime(ts) {
  if (!ts) return "—";
  return new Date(ts).toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    timeZone: "Asia/Kolkata",
  });
}

export const istToday = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
