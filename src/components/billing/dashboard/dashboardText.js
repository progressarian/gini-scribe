import { fromPaise } from "../format";
import { pendingEffects } from "../../../../shared/billingDashboardText.js";

export {
  bucketLabel,
  dayLabel,
  fullDayLabel,
  PENDING_PARTS,
  PERIOD_LABELS,
  rangeLabel,
} from "../../../../shared/billingDashboardText.js";

export const money = (paise) => (paise < 0 ? `−${fromPaise(-paise)}` : fromPaise(paise ?? 0));

export const negativeMoney = (paise) => (paise ? money(-paise) : fromPaise(0));

export function compactMoney(paise) {
  const rupees = Math.abs(paise) / 100;
  const sign = paise < 0 ? "−" : "";
  const short = (value, digits) => value.toFixed(digits).replace(/\.?0+$/, "");
  if (rupees >= 10000000) return `${sign}₹${short(rupees / 10000000, 2)}Cr`;
  if (rupees >= 100000) return `${sign}₹${short(rupees / 100000, 2)}L`;
  if (rupees >= 1000) return `${sign}₹${(rupees / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  return `${sign}₹${Math.round(rupees)}`;
}

export const count = (value) => Number(value ?? 0).toLocaleString("en-IN");

export function changeOf(current, previous, { points = false } = {}) {
  if (current === null || current === undefined || previous === null || previous === undefined) {
    return null;
  }
  if (points) {
    const diff = Math.round((current - previous) * 100) / 100;
    return { direction: Math.sign(diff), text: `${Math.abs(diff)} pt` };
  }
  if (previous === 0) {
    return current === 0
      ? { direction: 0, text: "no change" }
      : { direction: Math.sign(current), text: null, from: 0 };
  }
  const pct = Math.round((1000 * (current - previous)) / Math.abs(previous)) / 10;
  if (Math.abs(pct) >= 1000) return { direction: Math.sign(pct), text: null, from: previous };
  return { direction: Math.sign(pct), text: `${Math.abs(pct)}%` };
}

export function pendingNote(row) {
  return pendingEffects(row.pending_parts)
    .map((part) => `${part.amount > 0 ? "+" : ""}${money(part.amount)}  ${part.label}`)
    .join("\n");
}

const CARRIED = ["category", "sub_category", "consultant"];

export function reportHref(key, filters) {
  const params = new URLSearchParams({
    report: key,
    range: "custom",
    from: filters.from,
    to: filters.to,
  });
  for (const name of CARRIED) if (filters[name]) params.set(name, String(filters[name]));
  return `/billing/reports?${params}`;
}

const STEPS = [1, 2, 2.5, 5, 10];

export function niceAxis(values, count = 4) {
  const top = Math.max(0, ...values);
  const bottom = Math.min(0, ...values);
  const span = top - bottom;
  if (!span) {
    return {
      domain: [0, 100000],
      ticks: [0, 25000, 50000, 75000, 100000],
      format: axisMoney(100000),
    };
  }
  const raw = span / count;
  const power = 10 ** Math.floor(Math.log10(raw));
  const step = STEPS.map((s) => s * power).find((s) => s >= raw) ?? 10 * power;
  const low = Math.floor(bottom / step) * step;
  const high = Math.ceil(top / step) * step;
  const ticks = [];
  for (let t = low; t <= high + step / 2; t += step) ticks.push(Math.round(t));
  return { domain: [low, high], ticks, format: axisMoney(Math.max(high, -low)) };
}

const UNITS = [
  [1000000000, "Cr"],
  [10000000, "L"],
  [100000, "k"],
];

export function axisMoney(top) {
  const [size, unit] = UNITS.find(([size]) => top >= size) ?? [100, ""];
  return (paise) => {
    const value = Math.round((100 * paise) / size) / 100;
    if (!value) return "₹0";
    return `${value < 0 ? "−" : ""}₹${Math.abs(value).toLocaleString("en-IN")}${unit}`;
  };
}

export function shareOf(part, whole) {
  if (!whole) return "—";
  const share = Math.round((1000 * part) / whole) / 10;
  return part && !share ? "<0.1%" : `${share}%`;
}
