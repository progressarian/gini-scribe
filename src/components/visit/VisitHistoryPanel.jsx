import { memo } from "react";
import { fmtDate } from "./helpers";

const VisitHistoryPanel = memo(function VisitHistoryPanel({ consultations }) {
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
            const isToday = i === 0;
            const dotCls = isToday ? "" : c.status === "completed" ? "grn" : "amb";

            // Build pills from consultation data
            const pills = [];
            if (c.status) {
              pills.push({ label: c.status, cls: c.status === "completed" ? "g" : "b" });
            }
            if (c.visit_type) {
              pills.push({ label: c.visit_type, cls: "b" });
            }

            return (
              <div key={c.id || i} className="visit-line">
                <div className={`vl-dot ${dotCls}`}>{visitNum}</div>
                <div style={{ flex: 1 }}>
                  <div className="vl-date">
                    {fmtDate(c.visit_date)}
                    {isToday ? " — TODAY" : ""}
                  </div>
                  <div className="vl-ttl">
                    {c.visit_type || "Visit"} — {c.con_name || c.mo_name || "Doctor"}
                  </div>
                  {c.con_data?.assessment_summary && (
                    <div className="vl-sub">{c.con_data.assessment_summary}</div>
                  )}
                  {pills.length > 0 && (
                    <div className="vl-pills">
                      {pills.map((p, j) => (
                        <span key={j} className={`vl-pill ${p.cls}`}>
                          {p.label}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              </div>
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
