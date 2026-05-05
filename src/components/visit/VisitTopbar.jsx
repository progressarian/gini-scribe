import { memo, useState, useEffect, useRef } from "react";
import { fmtDate } from "./helpers";

// In-clinic elapsed timer — updates every minute
const InClinicTimer = memo(function InClinicTimer({ startIso }) {
  const [mins, setMins] = useState(0);

  useEffect(() => {
    if (!startIso) return;
    const calc = () => Math.max(0, Math.floor((Date.now() - new Date(startIso).getTime()) / 60000));
    setMins(calc());
    const id = setInterval(() => setMins(calc()), 60000);
    return () => clearInterval(id);
  }, [startIso]);

  if (!startIso) return null;
  const label = mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${mins} min`;

  return (
    <div
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        padding: "3px 10px",
        borderRadius: 20,
        border: "1px solid #f7bc55",
        background: "#fffbeb",
        color: "#f5a21e",
        fontSize: 12,
        fontWeight: 600,
        whiteSpace: "nowrap",
      }}
    >
      <span style={{ fontSize: 13 }}>⊙</span> In clinic: {label}
    </div>
  );
});

// Isolated clock to prevent re-renders of the rest of the page every second
const Clock = memo(function Clock() {
  const [time, setTime] = useState("");
  const [date, setDate] = useState("");

  useEffect(() => {
    const tick = () => {
      const n = new Date();
      const h = n.getHours() % 12 || 12;
      const m = String(n.getMinutes()).padStart(2, "0");
      const ap = n.getHours() >= 12 ? "PM" : "AM";
      setTime(`${h}:${m} ${ap}`);
      const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
      const months = [
        "Jan",
        "Feb",
        "Mar",
        "Apr",
        "May",
        "Jun",
        "Jul",
        "Aug",
        "Sep",
        "Oct",
        "Nov",
        "Dec",
      ];
      setDate(`${days[n.getDay()]}, ${n.getDate()} ${months[n.getMonth()]} ${n.getFullYear()}`);
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="clock-block">
      <div className="clock-time">{time}</div>
      <div className="clock-date">{date}</div>
    </div>
  );
});

// Mirrors statusSty() in src/OPD.jsx so the visit topbar pill matches the
// chip OPD shows for the same appointment.
function apptStatusStyle(s) {
  if (s === "seen" || s === "completed")
    return {
      label: "Seen",
      bg: "#dcfce7",
      color: "#15803d",
      border: "#bbf7d0",
      dot: "#22c55e",
      icon: "✓",
    };
  if (s === "in_visit")
    return {
      label: "In Visit",
      bg: "#f5f3ff",
      color: "#7c3aed",
      border: "#ddd6fe",
      dot: "#8b5cf6",
      icon: "●",
    };
  if (s === "checkedin")
    return {
      label: "Checked In",
      bg: "#eff6ff",
      color: "#2563eb",
      border: "#bfdbfe",
      dot: "#3b82f6",
      icon: "→",
    };
  if (s === "prepped")
    return {
      label: "Ready",
      bg: "#ecfeff",
      color: "#0e7490",
      border: "#a5f3fc",
      dot: "#06b6d4",
      icon: "✦",
    };
  if (s === "no_show")
    return {
      label: "No Show",
      bg: "#f3f4f6",
      color: "#6b7280",
      border: "#e5e7eb",
      dot: "#9ca3af",
      icon: "—",
    };
  return {
    label: "Pending",
    bg: "#f9fafb",
    color: "#6b7280",
    border: "#e5e7eb",
    dot: "#9ca3af",
    icon: "○",
  };
}

function isApptReady(prepSteps) {
  const ps = prepSteps || {};
  return !!(ps.biomarkers && ps.compliance && ps.categorized && ps.assigned);
}

const printMenuItemStyle = {
  display: "block",
  width: "100%",
  textAlign: "left",
  padding: "8px 12px",
  background: "transparent",
  border: "none",
  borderRadius: 6,
  fontSize: 13,
  color: "var(--t1)",
  cursor: "pointer",
};

const VisitTopbar = memo(function VisitTopbar({
  patient,
  doctor,
  summary,
  latestVitals,
  onToggleAI,
  onEndVisit,
  onPasteNotes,
  onPrintRx,
  onPrintMedCard,
  onPrintBoth,
  visitStart,
  hasActiveVisit,
  appointment,
}) {
  // Derive the OPD-style status label. When prep is fully done but the
  // appointment hasn't been flipped to a downstream state, OPD shows "Ready"
  // — mirror that promotion here.
  const apptStatusRaw = appointment?.status || null;
  const promotedStatus =
    apptStatusRaw &&
    !["in_visit", "seen", "completed", "no_show"].includes(apptStatusRaw) &&
    isApptReady(appointment?.prep_steps)
      ? "prepped"
      : apptStatusRaw;
  const apptSty = apptStatusRaw ? apptStatusStyle(promotedStatus) : null;
  const today = new Date().toISOString().split("T")[0];
  const [printOpen, setPrintOpen] = useState(false);
  const printRef = useRef(null);

  useEffect(() => {
    if (!printOpen) return;
    const onDocClick = (e) => {
      if (printRef.current && !printRef.current.contains(e.target)) setPrintOpen(false);
    };
    const onKey = (e) => {
      if (e.key === "Escape") setPrintOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [printOpen]);

  return (
    <div className="topbar">
      <div className="logo">G</div>
      <div className="sep" />
      <div className="ptinfo">
        <div className="ptname">
          {patient.name}
          <span style={{ fontSize: 12, fontWeight: 400, color: "var(--t3)" }}>
            {patient.age}/{patient.sex?.[0]} · ID #{patient.file_no || `P-${patient.id}`}
            {patient.blood_group ? ` · ${patient.blood_group}` : ""}
          </span>
        </div>
        <div className="ptmeta">
          <span>{doctor?.name || "Doctor"}</span>
          <span>·</span>
          <span>Visit #{summary.totalVisits}</span>
          <span>·</span>
          <span>📅 {fmtDate(today)}</span>
          <span className="allergy">{patient.allergies || "No known drug allergies"}</span>
        </div>
      </div>
      {apptSty && (
        <div
          className="visit-status-pill"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            fontSize: 11,
            fontWeight: 600,
            padding: "4px 10px 4px 8px",
            borderRadius: 999,
            background: apptSty.bg,
            color: apptSty.color,
            border: `1px solid ${apptSty.border}`,
            whiteSpace: "nowrap",
            marginLeft: 12,
            letterSpacing: 0.1,
            boxShadow: "0 1px 1px rgba(15, 23, 42, 0.04)",
          }}
        >
          <span
            aria-hidden
            style={{
              display: "inline-block",
              width: 6,
              height: 6,
              borderRadius: "50%",
              background: apptSty.dot,
              boxShadow: `0 0 0 3px ${apptSty.bg}, 0 0 0 4px ${apptSty.dot}22`,
            }}
          />
          <span className="visit-status-label">{apptSty.label}</span>
          {promotedStatus === "checkedin" && latestVitals && (
            <>
              <span
                aria-hidden
                style={{
                  display: "inline-block",
                  width: 1,
                  height: 10,
                  background: apptSty.border,
                  margin: "0 2px",
                }}
              />
              <span
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 3,
                  fontWeight: 500,
                  opacity: 0.85,
                }}
              >
                <span aria-hidden style={{ fontSize: 10 }}>
                  ✓
                </span>
                Vitals done
              </span>
            </>
          )}
        </div>
      )}
      <div className="sep" />
      <Clock />
      <InClinicTimer startIso={visitStart} />
      <div className="tbr">
        <button
          className="btn"
          onClick={onToggleAI}
          style={{
            borderColor: "var(--pri-bd)",
            color: "var(--primary)",
            background: "var(--pri-lt)",
          }}
        >
          ✦ Gini AI
        </button>
        {onPasteNotes && (
          <button className="btn" onClick={onPasteNotes} title="Paste clinical notes to auto-fill">
            📋 Paste
          </button>
        )}
        <div ref={printRef} style={{ position: "relative" }}>
          <button
            className="btn"
            onClick={() => setPrintOpen((o) => !o)}
            aria-haspopup="menu"
            aria-expanded={printOpen}
          >
            🖨 Print ▾
          </button>
          {printOpen && (
            <div
              role="menu"
              style={{
                position: "absolute",
                top: "calc(100% + 4px)",
                right: 0,
                minWidth: 180,
                background: "#fff",
                border: "1px solid var(--border)",
                borderRadius: 8,
                boxShadow: "0 8px 24px rgba(15, 23, 42, 0.12)",
                padding: 4,
                zIndex: 100,
              }}
            >
              <button
                className="print-menu-item"
                onClick={() => {
                  setPrintOpen(false);
                  onPrintRx?.();
                }}
                style={printMenuItemStyle}
              >
                📄 Prescription
              </button>
              <button
                className="print-menu-item"
                onClick={() => {
                  // Don't close before invoking — keeping the user-gesture intact
                  // ensures window.open in printMedCard isn't popup-blocked.
                  onPrintMedCard?.();
                  setPrintOpen(false);
                }}
                style={printMenuItemStyle}
              >
                💊 Medicine Card
              </button>
              <button
                className="print-menu-item"
                onClick={() => {
                  onPrintBoth?.();
                  setPrintOpen(false);
                }}
                style={printMenuItemStyle}
              >
                🖨 Both
              </button>
            </div>
          )}
        </div>
        {onEndVisit && (
          <button className="btn-p" onClick={onEndVisit}>
            ✓ End Visit
          </button>
        )}
      </div>
    </div>
  );
});

export default VisitTopbar;
