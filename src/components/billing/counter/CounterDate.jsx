import { useId } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";

const DAY_MS = 86400000;
const shift = (day, days) =>
  new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);

const LONG_DAY = new Intl.DateTimeFormat("en-IN", {
  weekday: "long",
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});

export const longDay = (day) => LONG_DAY.format(new Date(`${day}T00:00:00Z`));

export default function CounterDate({ date, today, firstDay, onDate }) {
  const id = useId();
  if (!today) return null;
  const shown = date || today;
  const go = (day) => onDate(day >= today ? "" : day);
  return (
    <div className="bc-date" role="group" aria-label="Counter date controls">
      <button
        type="button"
        className="bc-date__step"
        aria-label="Previous day"
        disabled={Boolean(firstDay) && shown <= firstDay}
        onClick={() => go(shift(shown, -1))}
      >
        <ChevronLeft size={14} aria-hidden="true" />
      </button>
      <label className="sr-only" htmlFor={id}>
        Counter date
      </label>
      <input
        id={id}
        type="date"
        className="bc-date__input"
        value={shown}
        min={firstDay || undefined}
        max={today}
        onChange={(e) => {
          const day = e.target.value;
          if (day && day <= today) go(day);
        }}
      />
      <button
        type="button"
        className="bc-date__step"
        aria-label="Next day"
        disabled={shown >= today}
        onClick={() => go(shift(shown, 1))}
      >
        <ChevronRight size={14} aria-hidden="true" />
      </button>
    </div>
  );
}

export function PastDayBanner({ date, onToday }) {
  return (
    <div className="bc-pastday" role="status">
      <span>
        <strong>Viewing {longDay(date)} — not today.</strong> New payments are recorded today, in
        your shift, against that day&apos;s bills.
      </span>
      <button type="button" className="st-btn st-btn-g" onClick={onToday}>
        Back to today
      </button>
    </div>
  );
}
