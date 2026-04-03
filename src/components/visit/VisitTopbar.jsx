import { memo, useState, useEffect } from "react";
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

const VisitTopbar = memo(function VisitTopbar({
  patient,
  doctor,
  summary,
  latestVitals,
  onToggleAI,
  onEndVisit,
  onPrint,
  visitStart,
  hasActiveVisit,
}) {
  const today = new Date().toISOString().split("T")[0];
  return (
    <div className="topbar">
      <div className="logo">G</div>
      <div className="sep" />
      <div className="ptinfo">
        <div className="ptname">
          {patient.name}
          <span style={{ fontSize: 12, fontWeight: 400, color: "var(--t3)" }}>
            {patient.age}
            {patient.sex?.[0]} · ID #{patient.file_no || `P-${patient.id}`}
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
      {(hasActiveVisit || latestVitals) && (
        <div
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            padding: "4px 12px",
            borderRadius: 20,
            border: "1px solid #16a34a",
            background: "#f0fdf4",
            color: "#15803d",
            fontSize: 12,
            fontWeight: 600,
            whiteSpace: "nowrap",
            marginLeft: 12,
          }}
        >
          <span
            style={{
              width: 8,
              height: 8,
              borderRadius: "50%",
              background: "#16a34a",
              display: "inline-block",
            }}
          />
          Checked in{latestVitals ? " · Vitals done" : ""}
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
        <button className="btn" onClick={onPrint}>
          🖨 Print Rx
        </button>
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
