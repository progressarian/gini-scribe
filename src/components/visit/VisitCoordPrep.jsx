import { memo } from "react";
import "./VisitCoordPrep.css";

const VisitCoordPrep = memo(function VisitCoordPrep({ prep = {} }) {
  const { medPct, missed, symptoms = [] } = prep;

  const hasPct = medPct !== null && medPct !== undefined;
  const hasMissed = missed && String(missed).trim().length > 0;
  const hasSymptoms = symptoms.length > 0;

  if (!hasPct && !hasMissed && !hasSymptoms) return null;

  const pctColor = !hasPct ? "" : medPct < 50 ? "vcp-red" : medPct < 80 ? "vcp-amber" : "vcp-green";

  return (
    <div className="vcp-card">
      <div className="vcp-heading">Coordinator Prep</div>

      <div className="vcp-body">
        {hasPct && (
          <div className="vcp-row">
            <span className="vcp-label">Compliance</span>
            <span className={`vcp-value ${pctColor}`}>{medPct}%</span>
          </div>
        )}

        {hasMissed && (
          <div className="vcp-row">
            <span className="vcp-label">Missed meds</span>
            <span className="vcp-value">{missed}</span>
          </div>
        )}

        {hasSymptoms && (
          <div className="vcp-row vcp-row--chips">
            <span className="vcp-label">Symptoms</span>
            <div className="vcp-chips">
              {symptoms.map((s, i) => (
                <span key={i} className="vcp-chip">
                  {s}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
});

export default VisitCoordPrep;
