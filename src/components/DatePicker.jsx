import { useEffect, useMemo, useRef, useState } from "react";

// Lightweight custom calendar popover. value/onChange use ISO "YYYY-MM-DD".
// minDate / maxDate are also "YYYY-MM-DD" (inclusive) and disable everything
// outside that window. Designed for the Refills filter bar — no deps.

const WEEK_DAYS = ["S", "M", "T", "W", "T", "F", "S"];
const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function toIso(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function parseIso(s) {
  if (!s) return null;
  const [y, m, d] = s.split("-").map(Number);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d);
}

function startOfMonth(d) {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

function fmtDisplay(iso) {
  const d = parseIso(iso);
  if (!d) return "";
  return d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
}

export default function DatePicker({
  value,
  onChange,
  minDate,
  maxDate,
  placeholder = "Select date",
  disabled = false,
  style,
  activeStyle,
  label,
}) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState(() => startOfMonth(parseIso(value) || new Date()));
  const wrapperRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e) => {
      if (!wrapperRef.current?.contains(e.target)) setOpen(false);
    };
    const onEsc = (e) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onEsc);
    };
  }, [open]);

  useEffect(() => {
    if (open) setView(startOfMonth(parseIso(value) || new Date()));
  }, [open, value]);

  const min = useMemo(() => parseIso(minDate), [minDate]);
  const max = useMemo(() => parseIso(maxDate), [maxDate]);

  const days = useMemo(() => {
    const first = startOfMonth(view);
    const startWeekday = first.getDay();
    const lastDay = new Date(view.getFullYear(), view.getMonth() + 1, 0).getDate();
    const cells = [];
    for (let i = 0; i < startWeekday; i++) cells.push(null);
    for (let d = 1; d <= lastDay; d++) {
      cells.push(new Date(view.getFullYear(), view.getMonth(), d));
    }
    while (cells.length % 7 !== 0) cells.push(null);
    return cells;
  }, [view]);

  const selectedIso = value || "";
  const todayIso = toIso(new Date());

  const isDisabled = (d) => {
    if (!d) return true;
    if (min && d < min) return true;
    if (max && d > max) return true;
    return false;
  };

  const goPrevMonth = () => setView(new Date(view.getFullYear(), view.getMonth() - 1, 1));
  const goNextMonth = () => setView(new Date(view.getFullYear(), view.getMonth() + 1, 1));

  const canPrev =
    !min ||
    new Date(view.getFullYear(), view.getMonth(), 0) >= new Date(min.getFullYear(), min.getMonth(), 1);
  const canNext =
    !max ||
    new Date(view.getFullYear(), view.getMonth() + 1, 1) <=
      new Date(max.getFullYear(), max.getMonth(), 1);

  const baseStyle = {
    width: "100%",
    padding: "9px 32px 9px 34px",
    border: "1px solid #e2e8f0",
    borderRadius: 10,
    fontSize: 13,
    color: value ? "#0f172a" : "#94a3b8",
    background: "#fff",
    outline: "none",
    WebkitAppearance: "none",
    appearance: "none",
    WebkitTapHighlightColor: "transparent",
    boxSizing: "border-box",
    cursor: disabled ? "not-allowed" : "pointer",
    textAlign: "left",
    transition: "border-color 0.15s, box-shadow 0.15s, background 0.15s",
    ...style,
  };

  return (
    <div ref={wrapperRef} style={{ position: "relative" }}>
      {label && (
        <label
          style={{
            display: "block",
            fontSize: 10,
            fontWeight: 800,
            color: "#64748b",
            letterSpacing: 0.5,
            marginBottom: 4,
          }}
        >
          {label}
        </label>
      )}
      <div style={{ position: "relative" }}>
        <div
          role="button"
          tabIndex={disabled ? -1 : 0}
          aria-disabled={disabled}
          onClick={() => !disabled && setOpen((o) => !o)}
          onKeyDown={(e) => {
            if (disabled) return;
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              setOpen((o) => !o);
            }
          }}
          style={baseStyle}
        >
          <span
            style={{
              position: "absolute",
              left: 10,
              top: "50%",
              transform: "translateY(-50%)",
              fontSize: 14,
              color: "#94a3b8",
              pointerEvents: "none",
              lineHeight: 1,
            }}
          >
            📅
          </span>
          {value ? fmtDisplay(value) : placeholder}
        </div>
        {value && !disabled && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onChange("");
            }}
            aria-label="Clear date"
            title="Clear"
            style={{
              position: "absolute",
              right: 6,
              top: "50%",
              transform: "translateY(-50%)",
              width: 22,
              height: 22,
              borderRadius: 999,
              background: "#f1f5f9",
              color: "#64748b",
              cursor: "pointer",
              border: "none",
              padding: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              transition: "background 0.15s ease, color 0.15s ease",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = "#fee2e2";
              e.currentTarget.style.color = "#b91c1c";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = "#f1f5f9";
              e.currentTarget.style.color = "#64748b";
            }}
          >
            <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden="true">
              <path
                d="M2.5 2.5 L9.5 9.5 M9.5 2.5 L2.5 9.5"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
              />
            </svg>
          </button>
        )}
      </div>

      {open && (
        <div
          style={{
            position: "absolute",
            top: "calc(100% + 6px)",
            left: 0,
            zIndex: 50,
            background: "#fff",
            border: "1px solid #e2e8f0",
            borderRadius: 12,
            boxShadow: "0 10px 30px rgba(15,23,42,0.12), 0 2px 8px rgba(15,23,42,0.06)",
            padding: 12,
            width: 280,
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              marginBottom: 10,
            }}
          >
            <button
              type="button"
              onClick={goPrevMonth}
              disabled={!canPrev}
              style={navBtnStyle(canPrev)}
              aria-label="Previous month"
            >
              ‹
            </button>
            <div style={{ fontSize: 13, fontWeight: 800, color: "#0f172a" }}>
              {MONTH_NAMES[view.getMonth()]} {view.getFullYear()}
            </div>
            <button
              type="button"
              onClick={goNextMonth}
              disabled={!canNext}
              style={navBtnStyle(canNext)}
              aria-label="Next month"
            >
              ›
            </button>
          </div>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(7,1fr)",
              gap: 2,
              marginBottom: 4,
            }}
          >
            {WEEK_DAYS.map((w, i) => (
              <div
                key={i}
                style={{
                  fontSize: 10,
                  fontWeight: 800,
                  color: "#94a3b8",
                  textAlign: "center",
                  padding: "4px 0",
                  letterSpacing: 0.4,
                }}
              >
                {w}
              </div>
            ))}
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(7,1fr)", gap: 2 }}>
            {days.map((d, i) => {
              if (!d) return <div key={i} style={{ height: 32 }} />;
              const iso = toIso(d);
              const isSelected = iso === selectedIso;
              const isToday = iso === todayIso;
              const dis = isDisabled(d);
              return (
                <button
                  type="button"
                  key={i}
                  disabled={dis}
                  onClick={() => {
                    onChange(iso);
                    setOpen(false);
                  }}
                  style={{
                    height: 32,
                    border: isToday && !isSelected ? "1px solid #c7d2fe" : "1px solid transparent",
                    borderRadius: 8,
                    background: isSelected ? "#7c3aed" : dis ? "transparent" : "#fff",
                    color: isSelected
                      ? "#fff"
                      : dis
                        ? "#cbd5e1"
                        : isToday
                          ? "#4338ca"
                          : "#0f172a",
                    fontSize: 12,
                    fontWeight: isSelected || isToday ? 800 : 600,
                    cursor: dis ? "not-allowed" : "pointer",
                    padding: 0,
                    transition: "background 0.12s ease",
                  }}
                  onMouseEnter={(e) => {
                    if (!dis && !isSelected) e.currentTarget.style.background = "#f5f3ff";
                  }}
                  onMouseLeave={(e) => {
                    if (!dis && !isSelected) e.currentTarget.style.background = "#fff";
                  }}
                >
                  {d.getDate()}
                </button>
              );
            })}
          </div>

          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              marginTop: 10,
              paddingTop: 10,
              borderTop: "1px solid #f1f5f9",
            }}
          >
            {(() => {
              const now = new Date();
              const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
              const todayDisabled = (!!min && today < min) || (!!max && today > max);
              return (
                <button
                  type="button"
                  disabled={todayDisabled}
                  onClick={() => {
                    if (todayDisabled) return;
                    onChange(toIso(today));
                    setOpen(false);
                  }}
                  style={{
                    fontSize: 11,
                    fontWeight: 700,
                    color: todayDisabled ? "#cbd5e1" : "#7c3aed",
                    background: "transparent",
                    border: "none",
                    cursor: todayDisabled ? "not-allowed" : "pointer",
                    padding: "4px 6px",
                  }}
                  title={todayDisabled ? "Today is outside the allowed range" : "Jump to today"}
                >
                  Today
                </button>
              );
            })()}
            <button
              type="button"
              onClick={() => {
                onChange("");
                setOpen(false);
              }}
              style={{
                fontSize: 11,
                fontWeight: 700,
                color: "#475569",
                background: "transparent",
                border: "none",
                cursor: "pointer",
                padding: "4px 6px",
              }}
            >
              Clear
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function navBtnStyle(enabled) {
  return {
    width: 28,
    height: 28,
    borderRadius: 8,
    border: "1px solid #e2e8f0",
    background: enabled ? "#fff" : "#f8fafc",
    color: enabled ? "#475569" : "#cbd5e1",
    cursor: enabled ? "pointer" : "not-allowed",
    fontSize: 16,
    fontWeight: 800,
    lineHeight: 1,
    padding: 0,
  };
}
