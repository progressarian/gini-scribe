import { memo } from "react";

const DX_STATUS_OPTS = [
  "Controlled",
  "Improving",
  "Review",
  "Uncontrolled",
  "Monitoring",
  "Resolved",
];

const VisitDiagnoses = memo(function VisitDiagnoses({ activeDx, onAddDiagnosis, onDiagnosisNote, onUpdateDiagnosis }) {
  return (
    <div className="sc" id="diagnoses">
      <div className="sch">
        <div className="sct">
          <div className="sci ic-p">🏷</div>Diagnoses
        </div>
        <button className="bx bx-p" onClick={onAddDiagnosis}>+ Add Diagnosis</button>
      </div>
      <div className="scb">
        {activeDx.map((dx, i) => {
          const dotColor =
            dx.status === "Controlled" || dx.status === "Improving"
              ? "var(--green)"
              : dx.status === "Review" || dx.status === "Uncontrolled"
                ? "var(--amber)"
                : "var(--t3)";
          return (
            <div key={dx.id || i} className="dxi">
              <div className="dxi-dot" style={{ background: dotColor }} />
              <div style={{ flex: 1 }}>
                <div className="dxi-ttl">{dx.label || dx.diagnosis_id}</div>
                <div className="dxi-sub">
                  {dx.since_year ? `Since ${dx.since_year}` : ""}
                  {dx.notes ? ` · ${dx.notes}` : ""}
                </div>
              </div>
              <select
                className="sy-sel"
                value={dx.status || ""}
                style={{ fontSize: 12, height: 29, padding: "0 8px" }}
                onChange={(e) => onUpdateDiagnosis?.(dx.id, { status: e.target.value })}
              >
                {DX_STATUS_OPTS.map((o) => (
                  <option key={o}>{o}</option>
                ))}
              </select>
              <button className="bx bx-p" style={{ marginLeft: 5 }} onClick={() => onDiagnosisNote?.(dx)}>
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
