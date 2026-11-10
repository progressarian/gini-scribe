import { dayText } from "../progress/progressText.js";

const nextDay = (day) => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
};

const isSunday = (day) => new Date(`${day}T00:00:00Z`).getUTCDay() === 0;

export function countDays(from, to) {
  let span = 0;
  let sundays = 0;
  for (let d = from; d <= to && span <= 400; d = nextDay(d)) {
    span += 1;
    if (isSunday(d)) sundays += 1;
  }
  return { span, sundays, working: span - sundays };
}

export const datesText = (from, to) =>
  from === to ? dayText(from) : `${dayText(from)} – ${dayText(to)}`;

export const dayCount = (n) => `${Number.isInteger(n) ? n : n.toFixed(1)} day${n === 1 ? "" : "s"}`;
