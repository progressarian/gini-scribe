import "./DatePicker.css";
import { useEffect, useRef, useState } from "react";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
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

const toDateStr = (d) => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
};

const parseDate = (str) => {
  if (!str) return new Date();
  const [y, m, d] = str.split("-").map((n) => parseInt(n, 10));
  return new Date(y, (m || 1) - 1, d || 1);
};

function buildMonthGrid(year, month) {
  const first = new Date(year, month, 1);
  const startDow = first.getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const daysInPrev = new Date(year, month, 0).getDate();

  const cells = [];
  for (let i = startDow - 1; i >= 0; i--) {
    const day = daysInPrev - i;
    cells.push({ date: new Date(year, month - 1, day), inMonth: false });
  }
  for (let d = 1; d <= daysInMonth; d++) {
    cells.push({ date: new Date(year, month, d), inMonth: true });
  }
  const remaining = (7 - (cells.length % 7)) % 7;
  for (let d = 1; d <= remaining; d++) {
    cells.push({ date: new Date(year, month + 1, d), inMonth: false });
  }
  return cells;
}

export default function DatePicker({ value, onChange, children, className = "" }) {
  const [open, setOpen] = useState(false);
  const selected = parseDate(value);
  const [viewYear, setViewYear] = useState(selected.getFullYear());
  const [viewMonth, setViewMonth] = useState(selected.getMonth());
  const wrapRef = useRef(null);
  const todayStr = toDateStr(new Date());

  // Close on outside click / Escape
  useEffect(() => {
    if (!open) return;
    const onDown = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("touchstart", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("touchstart", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Reset viewed month to the selected date each time it reopens
  useEffect(() => {
    if (open) {
      setViewYear(selected.getFullYear());
      setViewMonth(selected.getMonth());
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const cells = buildMonthGrid(viewYear, viewMonth);

  const shiftMonth = (delta) => {
    const d = new Date(viewYear, viewMonth + delta, 1);
    setViewYear(d.getFullYear());
    setViewMonth(d.getMonth());
  };

  const pick = (date) => {
    onChange(toDateStr(date));
    setOpen(false);
  };

  return (
    <div ref={wrapRef} className={`dp ${className}`}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={`dp__trigger ${open ? "dp__trigger--open" : ""}`}
      >
        {children}
      </button>

      {open && (
        <div className="dp__pop" role="dialog" aria-label="Pick a date">
          <div className="dp__pop-header">
            <button
              type="button"
              onClick={() => shiftMonth(-1)}
              className="dp__nav"
              aria-label="Previous month"
            >
              ‹
            </button>
            <div className="dp__title">
              {MONTHS[viewMonth]} {viewYear}
            </div>
            <button
              type="button"
              onClick={() => shiftMonth(1)}
              className="dp__nav"
              aria-label="Next month"
            >
              ›
            </button>
          </div>

          <div className="dp__weekdays">
            {WEEKDAYS.map((w) => (
              <div key={w} className="dp__wd">
                {w[0]}
              </div>
            ))}
          </div>

          <div className="dp__grid">
            {cells.map(({ date, inMonth }, i) => {
              const ds = toDateStr(date);
              const isToday = ds === todayStr;
              const isSelected = ds === value;
              return (
                <button
                  key={i}
                  type="button"
                  onClick={() => pick(date)}
                  className={[
                    "dp__cell",
                    !inMonth ? "dp__cell--out" : "",
                    isToday ? "dp__cell--today" : "",
                    isSelected ? "dp__cell--sel" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                >
                  {date.getDate()}
                </button>
              );
            })}
          </div>

          <div className="dp__footer">
            <button type="button" onClick={() => pick(new Date())} className="dp__footer-btn">
              Today
            </button>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="dp__footer-btn dp__footer-btn--secondary"
            >
              Close
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
