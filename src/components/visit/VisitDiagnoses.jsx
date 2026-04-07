import { memo } from "react";
import { DX_STATUS_STYLE, DX_STATUS_DEFAULT, getDxSuggestion } from "./helpers";

const DX_STATUS_OPTS = [
  "New",
  "Active",
  "Controlled",
  "Improving",
  "Review",
  "Uncontrolled",
  "Monitoring",
  "Resolved",
];

const VisitDiagnoses = memo(function VisitDiagnoses({
  activeDx,
  labResults,
  vitals,
  onAddDiagnosis,
  onDiagnosisNote,
  onUpdateDiagnosis,
}) {
  return (
    <div className="sc" id="diagnoses">
      <div className="sch">
        <div className="sct">
          <div className="sci ic-p">🏷</div>Diagnoses
        </div>
        <button className="bx bx-p" onClick={onAddDiagnosis}>
          + Add Diagnosis
        </button>
      </div>
      <div className="scb">
        {activeDx.map((dx, i) => {
          const suggestion = getDxSuggestion(dx.diagnosis_id, labResults, vitals);
          // Auto-apply: use suggestion.status if it exists, otherwise use dx.status
          const effectiveStatus = suggestion?.status || dx.status;
          const st = DX_STATUS_STYLE[effectiveStatus] || DX_STATUS_DEFAULT;
          const isAutoSet = suggestion && !dx.status;
          const isManuallyOverridden = suggestion && suggestion.status !== dx.status && dx.status;

          return (
            <div key={dx.id || i} className="dxi" style={{ position: "relative" }}>
              <div className="dxi-dot" style={{ background: st.dot }} />
              <div style={{ flex: 1 }}>
                <div className="dxi-ttl">{dx.label || dx.diagnosis_id}</div>
                <div className="dxi-sub">
                  {dx.since_year ? `Since ${dx.since_year}` : ""}
                  {dx.notes ? ` · ${dx.notes}` : ""}
                  {suggestion && (
                    <>
                      {" · "}
                      <span
                        title={`Based on ${suggestion.biomarker}: ${suggestion.value} ${suggestion.unit} | Goal: ${suggestion.goal}`}
                        style={{ color: "var(--primary)", fontWeight: 500 }}
                      >
                        {isAutoSet ? "✓" : "⚙️"} {suggestion.biomarker}: {suggestion.value}
                        {suggestion.unit}
                      </span>
                      {isManuallyOverridden && (
                        <span style={{ color: "var(--amber)", fontWeight: 600, marginLeft: 4 }}>
                          (overridden)
                        </span>
                      )}
                    </>
                  )}
                </div>
              </div>
              <select
                className="sy-sel"
                value={effectiveStatus || ""}
                style={{
                  fontSize: 12,
                  height: 29,
                  padding: "0 8px",
                  background: isManuallyOverridden ? "#fff8f0" : st.bg,
                  color: isManuallyOverridden ? "#b45309" : st.color,
                  borderColor: isManuallyOverridden ? "#fde68a" : st.border,
                  fontWeight: 600,
                  border: isManuallyOverridden ? "1.5px solid #fde68a" : undefined,
                  opacity: isAutoSet ? 0.7 : 1,
                }}
                onChange={(e) => onUpdateDiagnosis?.(dx.id, { status: e.target.value })}
                title={isAutoSet ? "Auto-set based on biomarkers. Change to override." : ""}
              >
                {DX_STATUS_OPTS.map((o) => (
                  <option key={o}>{o}</option>
                ))}
              </select>
              {isManuallyOverridden && (
                <button
                  className="bx"
                  style={{
                    marginLeft: 5,
                    background: "#10b981",
                    color: "white",
                    fontSize: 11,
                    fontWeight: 600,
                    padding: "0 8px",
                    height: 29,
                  }}
                  title="Reset to auto-calculated status"
                  onClick={() => onUpdateDiagnosis?.(dx.id, { status: "" })}
                >
                  Reset
                </button>
              )}
              <button
                className="bx bx-p"
                style={{ marginLeft: 5 }}
                onClick={() => onDiagnosisNote?.(dx)}
              >
                Note
              </button>
            </div>
          );
        })}
        {activeDx.length === 0 && (
          <div style={{ fontSize: 13, color: "var(--t3)", padding: 16, textAlign: "center" }}>
            No diagnoses recorded
          </div>
        )}
        <div className="addr" onClick={onAddDiagnosis}>
          <span style={{ fontSize: 16, color: "var(--t3)" }}>+</span>
          <span className="addr-lbl">Add new diagnosis</span>
        </div>
      </div>
    </div>
  );
});

export default VisitDiagnoses;
