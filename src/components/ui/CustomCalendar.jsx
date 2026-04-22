// CustomCalendar — standalone month-grid calendar popover.
// Extracted from src/components/opd/LiveDashboard.jsx so multiple modals /
// forms can share the same date-picker look & feel instead of the browser's
// native <input type="date">.
//
// API (unchanged from the LiveDashboard original):
//   <CustomCalendar
//     value={"2026-04-22"}        // YYYY-MM-DD string (or empty)
//     maxDate={"2026-04-22"}      // optional — cells beyond this are disabled
//     onSelect={(dateStr) => …}   // fires when a day is clicked
//     onClose={() => …}           // called after onSelect and on backdrop/esc
//   />
//
// Positioning: the component is absolutely positioned relative to its nearest
// positioned ancestor. Callers wrap it in a `position: relative` container.

import { useState } from "react";

const T = "#009e8c";
const WH = "#fff";
const INK = "#1a2332";
const INK2 = "#3d4f63";
const INK3 = "#6b7d90";
const BD = "#dde3ea";
const FB = "'Inter',system-ui,sans-serif";
const FM = "'DM Mono',monospace";

// Inject hover style once per page (same strategy as LiveDashboard).
if (typeof document !== "undefined" && !document.getElementById("cc-cal-kf")) {
  const s = document.createElement("style");
  s.id = "cc-cal-kf";
  s.textContent = `
.cc-cal-day { transition: background .1s; }
.cc-cal-day:hover:not(:disabled) { background: #e6f6f4; }
`;
  document.head.appendChild(s);
}

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

export default function CustomCalendar({ value, maxDate, onSelect, onClose, fullWidth = false }) {
  const initial = value ? new Date(value + "T00:00:00") : new Date();
  const [view, setView] = useState(() => ({
    y: initial.getFullYear(),
    m: initial.getMonth(),
  }));
  const max = maxDate ? new Date(maxDate + "T00:00:00") : null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const first = new Date(view.y, view.m, 1);
  const startDow = first.getDay();
  const daysInMonth = new Date(view.y, view.m + 1, 0).getDate();
  const prevMonthDays = new Date(view.y, view.m, 0).getDate();

  const cells = [];
  for (let i = 0; i < startDow; i++) {
    cells.push({ day: prevMonthDays - startDow + 1 + i, outside: true, date: null });
  }
  for (let d = 1; d <= daysInMonth; d++) {
    const dateObj = new Date(view.y, view.m, d);
    cells.push({ day: d, outside: false, date: dateObj });
  }
  while (cells.length % 7 !== 0 || cells.length < 42) {
    const d = cells.length - startDow - daysInMonth + 1;
    cells.push({ day: d, outside: true, date: null });
    if (cells.length >= 42) break;
  }

  const step = (delta) => {
    const next = new Date(view.y, view.m + delta, 1);
    setView({ y: next.getFullYear(), m: next.getMonth() });
  };

  const selected = value ? new Date(value + "T00:00:00") : null;
  const sameDay = (a, b) =>
    a &&
    b &&
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();

  return (
    <div
      style={{
        position: "absolute",
        top: "calc(100% + 6px)",
        right: 0,
        ...(fullWidth ? { left: 0, width: "auto" } : { width: 260 }),
        zIndex: 50,
        background: WH,
        border: `1px solid ${BD}`,
        borderRadius: 10,
        boxShadow: "0 8px 24px rgba(0,0,0,.12)",
        padding: 12,
        boxSizing: "border-box",
        fontFamily: FB,
      }}
      onClick={(e) => e.stopPropagation()}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 8,
        }}
      >
        <button
          type="button"
          onClick={() => step(-1)}
          style={{
            background: "none",
            border: "none",
            cursor: "pointer",
            color: INK2,
            fontSize: 16,
            padding: "2px 8px",
          }}
          aria-label="Previous month"
        >
          ‹
        </button>
        <div style={{ fontSize: 12, fontWeight: 700, color: INK }}>
          {MONTHS[view.m]} {view.y}
        </div>
        <button
          type="button"
          onClick={() => step(1)}
          style={{
            background: "none",
            border: "none",
            cursor: "pointer",
            color: INK2,
            fontSize: 16,
            padding: "2px 8px",
          }}
          aria-label="Next month"
        >
          ›
        </button>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 2 }}>
        {["S", "M", "T", "W", "T", "F", "S"].map((d, i) => (
          <div
            key={i}
            style={{
              fontSize: 9,
              fontWeight: 700,
              textAlign: "center",
              color: INK3,
              padding: "4px 0",
              letterSpacing: ".06em",
            }}
          >
            {d}
          </div>
        ))}
        {cells.map((c, i) => {
          const disabled = c.outside || (max && c.date && c.date > max);
          const isSel = !c.outside && sameDay(c.date, selected);
          const isToday = !c.outside && sameDay(c.date, today);
          return (
            <button
              key={i}
              type="button"
              className="cc-cal-day"
              disabled={disabled}
              onClick={() => {
                if (disabled || !c.date) return;
                const y = c.date.getFullYear();
                const mo = String(c.date.getMonth() + 1).padStart(2, "0");
                const da = String(c.date.getDate()).padStart(2, "0");
                onSelect(`${y}-${mo}-${da}`);
                onClose();
              }}
              style={{
                fontFamily: FM,
                fontSize: 11,
                padding: "7px 0",
                border: isToday && !isSel ? `1px solid ${T}` : "1px solid transparent",
                borderRadius: 6,
                background: isSel ? T : "transparent",
                color: isSel ? WH : c.outside ? "#c4cdd8" : disabled ? "#c4cdd8" : INK,
                cursor: disabled ? "default" : "pointer",
                fontWeight: isSel || isToday ? 700 : 500,
              }}
            >
              {c.day}
            </button>
          );
        })}
      </div>
      <div
        style={{
          marginTop: 10,
          paddingTop: 8,
          borderTop: `1px solid ${BD}`,
          display: "flex",
          justifyContent: "flex-end",
        }}
      >
        <button
          type="button"
          onClick={() => {
            if (max && today > max) return;
            const y = today.getFullYear();
            const mo = String(today.getMonth() + 1).padStart(2, "0");
            const da = String(today.getDate()).padStart(2, "0");
            onSelect(`${y}-${mo}-${da}`);
            onClose();
          }}
          style={{
            fontFamily: FB,
            fontSize: 11,
            fontWeight: 600,
            color: T,
            background: "transparent",
            border: `1px solid ${T}`,
            borderRadius: 6,
            padding: "4px 12px",
            cursor: "pointer",
          }}
        >
          Today
        </button>
      </div>
    </div>
  );
}
