import { memo, useState } from "react";
import { fmtDate } from "./helpers";

function DiagnosisPills({ diagnoses }) {
  if (!diagnoses?.length) return null;
  const active = diagnoses.filter((d) => d.status !== "Absent");
  if (!active.length) return null;
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 5 }}>
      {active.slice(0, 6).map((d, i) => (
        <span
          key={i}
          style={{
            fontSize: 10,
            padding: "2px 7px",
            borderRadius: 10,
            background: "var(--bg2)",
            color: "var(--t2)",
            border: "1px solid var(--border)",
            fontWeight: 500,
          }}
        >
          {d.name || d.label}
          {d.details ? ` · ${d.details}` : ""}
        </span>
      ))}
      {active.length > 6 && (
        <span style={{ fontSize: 10, color: "var(--t3)", alignSelf: "center" }}>
          +{active.length - 6} more
        </span>
      )}
    </div>
  );
}

function MedList({ medications }) {
  if (!medications?.length) return null;
  const active = medications.filter(
    (m) => !m.is_stopped && !m.status?.toLowerCase().includes("stop"),
  );
  if (!active.length) return null;
  return (
    <div style={{ marginTop: 5 }}>
      {active.slice(0, 5).map((m, i) => (
        <div key={i} style={{ fontSize: 11, color: "var(--t2)", lineHeight: 1.6 }}>
          💊 <strong>{m.name}</strong>
          {m.dose ? ` ${m.dose}` : ""}
          {m.frequency ? ` · ${m.frequency}` : ""}
          {m.timing ? ` ${m.timing}` : ""}
          {m.is_new ? (
            <span style={{ color: "var(--primary)", marginLeft: 4, fontSize: 9, fontWeight: 700 }}>
              NEW
            </span>
          ) : null}
        </div>
      ))}
      {active.length > 5 && (
        <div style={{ fontSize: 10, color: "var(--t3)" }}>+{active.length - 5} more medicines</div>
      )}
    </div>
  );
}

function VisitCard({ c, visitNum, isToday, expanded, onToggle }) {
  const isAppt = c.source_type === "appointment";
  const diagnoses = c.healthray_diagnoses || c.con_data?.diagnoses || [];
  const medications = c.healthray_medications || c.con_data?.medications_confirmed || [];
  const summary = c.con_data?.assessment_summary;
  const advice = c.healthray_advice;
  const hasDetail = diagnoses.length > 0 || medications.length > 0 || summary || advice;

  const dotCls = isToday ? "" : c.status === "completed" ? "grn" : "amb";

  return (
    <div key={c.id} className="visit-line" style={{ alignItems: "flex-start" }}>
      <div className={`vl-dot ${dotCls}`}>{visitNum}</div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div className="vl-date">
            {fmtDate(c.visit_date)}
            {isToday ? " — TODAY" : ""}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            {isAppt && (
              <span
                style={{
                  fontSize: 9,
                  fontWeight: 700,
                  padding: "1px 5px",
                  borderRadius: 3,
                  background: "var(--pri-lt, #f0f4ff)",
                  color: "var(--pri, #3b5bdb)",
                  textTransform: "uppercase",
                  letterSpacing: 0.5,
                }}
              >
                HealthRay
              </span>
            )}
            {hasDetail && (
              <button
                onClick={onToggle}
                style={{
                  fontSize: 10,
                  color: "var(--t3)",
                  background: "none",
                  border: "none",
                  cursor: "pointer",
                  padding: "0 2px",
                }}
              >
                {expanded ? "▲" : "▼"}
              </button>
            )}
          </div>
        </div>

        <div className="vl-ttl">
          {c.visit_type || "Visit"} — {c.con_name || c.mo_name || "Doctor"}
        </div>

        {/* Status pills */}
        <div className="vl-pills">
          {c.status && (
            <span className={`vl-pill ${c.status === "completed" ? "g" : "b"}`}>{c.status}</span>
          )}
        </div>

        {/* Expandable detail */}
        {expanded && hasDetail && (
          <div
            style={{
              marginTop: 8,
              padding: "10px 12px",
              background: "var(--bg2)",
              borderRadius: "var(--rs)",
              border: "1px solid var(--border)",
            }}
          >
            {summary && (
              <div
                style={{ fontSize: 12, color: "var(--t2)", marginBottom: 6, fontStyle: "italic" }}
              >
                {summary}
              </div>
            )}
            {diagnoses.length > 0 && (
              <div style={{ marginBottom: 6 }}>
                <div
                  style={{
                    fontSize: 9,
                    fontWeight: 700,
                    color: "var(--t3)",
                    textTransform: "uppercase",
                    letterSpacing: 0.5,
                    marginBottom: 3,
                  }}
                >
                  Diagnoses
                </div>
                <DiagnosisPills diagnoses={diagnoses} />
              </div>
            )}
            {medications.length > 0 && (
              <div style={{ marginBottom: 6 }}>
                <div
                  style={{
                    fontSize: 9,
                    fontWeight: 700,
                    color: "var(--t3)",
                    textTransform: "uppercase",
                    letterSpacing: 0.5,
                    marginBottom: 3,
                  }}
                >
                  Medications
                </div>
                <MedList medications={medications} />
              </div>
            )}
            {advice && (
              <div style={{ fontSize: 11, color: "var(--t2)", marginTop: 4 }}>
                <span
                  style={{
                    fontSize: 9,
                    fontWeight: 700,
                    color: "var(--t3)",
                    textTransform: "uppercase",
                    letterSpacing: 0.5,
                  }}
                >
                  Advice ·{" "}
                </span>
                {advice.length > 200 ? advice.slice(0, 200) + "…" : advice}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

const VisitHistoryPanel = memo(function VisitHistoryPanel({ consultations }) {
  const [expanded, setExpanded] = useState({});

  const toggle = (id) => setExpanded((p) => ({ ...p, [id]: !p[id] }));

  return (
    <div className="panel-body">
      <div className="sc">
        <div className="sch">
          <div className="sct">
            <div className="sci ic-b">📅</div>Visit History — {consultations.length} Visits
          </div>
        </div>
        <div className="scb">
          {consultations.map((c, i) => {
            const visitNum = consultations.length - i;
            const today = new Date();
            const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
            const visitDateStr = c.visit_date ? String(c.visit_date).slice(0, 10) : null;
            const isToday = visitDateStr === todayStr;
            return (
              <VisitCard
                key={`${c.source_type}-${c.id}`}
                c={c}
                visitNum={visitNum}
                isToday={isToday}
                expanded={!!expanded[`${c.source_type}-${c.id}`]}
                onToggle={() => toggle(`${c.source_type}-${c.id}`)}
              />
            );
          })}
          {consultations.length === 0 && (
            <div style={{ fontSize: 13, color: "var(--t3)", padding: 20, textAlign: "center" }}>
              No visit history
            </div>
          )}
        </div>
      </div>
    </div>
  );
});

export default VisitHistoryPanel;
