import { useEffect, useRef } from "react";
import AnchoredPopover from "../ui/AnchoredPopover.jsx";
import "./FollowUpCalendar.css";

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const pad = (n) => String(n).padStart(2, "0");
const isoOf = (y, m, d) => `${y}-${pad(m + 1)}-${pad(d)}`;
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

const shiftMonth = ({ y, m }, delta) => {
  const next = new Date(Date.UTC(y, m + delta, 1));
  return { y: next.getUTCFullYear(), m: next.getUTCMonth() };
};

function weeksOf({ y, m }) {
  const lead = new Date(Date.UTC(y, m, 1)).getUTCDay();
  const days = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const cells = [
    ...Array.from({ length: lead }, () => null),
    ...Array.from({ length: days }, (_, i) => i + 1),
  ];
  while (cells.length % 7) cells.push(null);
  return Array.from({ length: cells.length / 7 }, (_, w) => cells.slice(w * 7, w * 7 + 7));
}

function stateOf(day, { counts, limits, minDate, value }) {
  const count = counts?.[day] || 0;
  const closed = new Date(`${day}T00:00:00Z`).getUTCDay() === 0;
  const past = day < minDate;
  const { allowedPerDay: allowed, maxPerDay: max } = limits || {};
  const full = !closed && !!max && count >= max;
  const over = !closed && !full && !!allowed && count + 1 > allowed;
  return {
    count,
    closed,
    past,
    full,
    over,
    selected: day === value,
    disabled: closed || past || (full && day !== value),
    fill: max ? Math.min(count / max, 1) : allowed ? Math.min(count / allowed, 1) : 0,
  };
}

function labelOf(dayNumber, monthName, s) {
  if (s.closed) return `${dayNumber} ${monthName}: Closed`;
  if (s.past) return `${dayNumber} ${monthName}: Past date`;
  const note = s.full ? " — full" : s.over ? " — over the allowed number" : "";
  return `${dayNumber} ${monthName}: ${plural(s.count, "follow-up")}${note}`;
}

export default function FollowUpCalendar({
  anchorRef,
  popoverRef,
  value,
  minDate,
  today,
  view,
  onViewChange,
  counts,
  limits,
  loading,
  error,
  onRetry,
  onSelect,
  onClose,
}) {
  const gridRef = useRef(null);
  const minMonth = { y: Number(minDate.slice(0, 4)), m: Number(minDate.slice(5, 7)) - 1 };
  const atStart = view.y * 12 + view.m <= minMonth.y * 12 + minMonth.m;
  const monthName = MONTHS[view.m];
  const weeks = weeksOf(view);
  const context = { counts, limits, minDate, value };
  const hasLimits = !!(limits?.allowedPerDay || limits?.maxPerDay);

  useEffect(() => {
    const target =
      gridRef.current?.querySelector('[aria-pressed="true"]:not(:disabled)') ||
      gridRef.current?.querySelector(".fu-cal__day:not(:disabled)");
    target?.focus({ preventScroll: true });
  }, [view.y, view.m, loading]);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      onClose(true);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const moveFocus = (e) => {
    const steps = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[e.key];
    if (!steps) return;
    const buttons = [...gridRef.current.querySelectorAll(".fu-cal__day")];
    const from = buttons.indexOf(document.activeElement);
    if (from < 0) return;
    e.preventDefault();
    for (let i = from + steps; i >= 0 && i < buttons.length; i += steps) {
      if (!buttons[i].disabled) {
        buttons[i].focus();
        return;
      }
    }
  };

  return (
    <AnchoredPopover anchorRef={anchorRef} popoverRef={popoverRef} gap={6} align="right">
      <div className="fu-cal" role="dialog" aria-label="Follow-ups booked per date">
        <header className="fu-cal__head">
          <div>
            <p className="fu-cal__eyebrow">Follow-ups booked</p>
            <h3 className="fu-cal__month" aria-live="polite">
              {monthName} {view.y}
            </h3>
          </div>
          <div className="fu-cal__nav">
            <button
              type="button"
              className="fu-cal__navbtn"
              aria-label="Previous month"
              disabled={atStart}
              onClick={() => onViewChange(shiftMonth(view, -1))}
            >
              ‹
            </button>
            <button
              type="button"
              className="fu-cal__navbtn"
              aria-label="Next month"
              onClick={() => onViewChange(shiftMonth(view, 1))}
            >
              ›
            </button>
          </div>
        </header>

        <p className="fu-cal__limits">
          {hasLimits ? (
            <>
              {limits.allowedPerDay && (
                <span className="fu-cal__limit">
                  Allowed <strong>{limits.allowedPerDay}</strong>/day
                </span>
              )}
              {limits.maxPerDay && (
                <span className="fu-cal__limit fu-cal__limit--max">
                  Max <strong>{limits.maxPerDay}</strong>/day
                </span>
              )}
            </>
          ) : (
            <span className="fu-cal__limit">No daily limit set</span>
          )}
        </p>

        {error ? (
          <div className="fu-cal__error" role="alert">
            Couldn't load the follow-up counts.
            <button type="button" className="fu-cal__retry" onClick={onRetry}>
              Try again
            </button>
          </div>
        ) : (
          <div
            className={`fu-cal__grid${loading ? " is-loading" : ""}`}
            ref={gridRef}
            onKeyDown={moveFocus}
            aria-busy={loading}
          >
            {WEEKDAYS.map((d) => (
              <span key={d} className="fu-cal__weekday" aria-hidden="true">
                {d}
              </span>
            ))}
            {weeks.flat().map((dayNumber, i) => {
              if (!dayNumber) return <span key={`blank-${i}`} className="fu-cal__blank" />;
              const day = isoOf(view.y, view.m, dayNumber);
              const s = stateOf(day, context);
              const tone = s.closed
                ? "closed"
                : s.past
                  ? "past"
                  : s.full
                    ? "full"
                    : s.over
                      ? "over"
                      : s.count
                        ? "booked"
                        : "free";
              return (
                <button
                  key={day}
                  type="button"
                  className={`fu-cal__day fu-cal__day--${tone}${s.selected ? " is-selected" : ""}${
                    day === today ? " is-today" : ""
                  }`}
                  disabled={s.disabled}
                  aria-pressed={s.selected}
                  aria-label={labelOf(dayNumber, monthName, s)}
                  title={labelOf(dayNumber, monthName, s)}
                  onClick={() => onSelect(day)}
                >
                  <span className="fu-cal__num">{dayNumber}</span>
                  {!s.closed && !s.past && (
                    <span className="fu-cal__count" aria-hidden="true">
                      {loading ? "·" : s.count}
                    </span>
                  )}
                  {s.closed && (
                    <span className="fu-cal__closed" aria-hidden="true">
                      Closed
                    </span>
                  )}
                  {!s.closed && !s.past && hasLimits && (
                    <span className="fu-cal__bar" aria-hidden="true">
                      <span style={{ width: `${Math.round(s.fill * 100)}%` }} />
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        )}

        <footer className="fu-cal__legend" aria-label="Colour key">
          <span className="fu-cal__key fu-cal__key--free">Open</span>
          {limits?.allowedPerDay && (
            <span className="fu-cal__key fu-cal__key--over">Over allowed</span>
          )}
          {limits?.maxPerDay && <span className="fu-cal__key fu-cal__key--full">Full</span>}
          <span className="fu-cal__key fu-cal__key--sel">Selected</span>
        </footer>
      </div>
    </AnchoredPopover>
  );
}
