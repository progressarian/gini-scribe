import { fromPaise } from "../format";
import { PENDING_PARTS } from "../../../../shared/billingDashboardText.js";

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
  if (rupees >= 10000000) return `${sign}₹${(rupees / 10000000).toFixed(1).replace(/\.0$/, "")}Cr`;
  if (rupees >= 100000) return `${sign}₹${(rupees / 100000).toFixed(1).replace(/\.0$/, "")}L`;
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
  if (previous === 0) return current === 0 ? { direction: 0, text: "no change" } : null;
  const pct = Math.round((1000 * (current - previous)) / Math.abs(previous)) / 10;
  return { direction: Math.sign(pct), text: `${Math.abs(pct)}%` };
}

export function pendingNote(row) {
  const parts = PENDING_PARTS.filter((part) => row.pending_parts?.[part.key]).map(
    (part) => `${part.label}: ${money(row.pending_parts[part.key])}`,
  );
  return parts.join("\n");
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
