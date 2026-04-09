import { memo } from "react";
import { fmtDate, fmtLabVal } from "./helpers";

const VisitStrip = memo(function VisitStrip({
  summary,
  hba1cCurr,
  hba1cFirst,
  latestVitals,
  prevVitals,
  activeMeds,
}) {
  const weightCurr = latestVitals?.weight;
  const weightPrev = prevVitals?.weight;

  return (
    <div className="summary-strip">
      <div className="ss-item">
        <div>
          <div className="ss-label">With Gini</div>
          <div className="ss-val">
            {summary.monthsWithGini >= 12
              ? `${Math.floor(summary.monthsWithGini / 12)}+ Years`
              : `${summary.monthsWithGini} Months`}
            {summary.firstVisitDate && (
              <span className="ss-badge ss-b">Since {fmtDate(summary.firstVisitDate)}</span>
            )}
          </div>
        </div>
      </div>
      <div className="ss-item">
        <div>
          <div className="ss-label">Visits</div>
          <div className="ss-val">{summary.totalVisits} visits</div>
        </div>
      </div>
      <div className="ss-item">
        <div>
          <div className="ss-label">Care Phase</div>
          <div className="ss-val">
            🏆 <span className="ss-badge ss-p">{summary.carePhase}</span>
          </div>
        </div>
      </div>
      <div className="ss-sep" />

      {hba1cCurr && (
        <div className="ss-item">
          <div>
            <div className="ss-label">HbA1c — Since 1st Visit</div>
            <div className="ss-val">
              {hba1cFirst ? `${fmtLabVal(null, hba1cFirst.result)} → ` : ""}
              {fmtLabVal(null, hba1cCurr.result)}%
              {hba1cFirst && hba1cCurr.result < hba1cFirst.result && (
                <span className="ss-badge ss-g">
                  ↓ {Math.round(((hba1cFirst.result - hba1cCurr.result) / hba1cFirst.result) * 100)}
                  %
                </span>
              )}
            </div>
          </div>
        </div>
      )}

      {weightCurr && (
        <div className="ss-item">
          <div>
            <div className="ss-label">Weight — Since Last Visit</div>
            <div className="ss-val">
              {weightPrev ? `${weightPrev} → ` : ""}
              {weightCurr} kg
              {weightPrev && (
                <span className={`ss-badge ${weightCurr > weightPrev ? "ss-a" : "ss-g"}`}>
                  {weightCurr > weightPrev ? "↑" : "↓"}{" "}
                  {Math.abs(weightCurr - weightPrev).toFixed(1)} kg
                </span>
              )}
            </div>
          </div>
        </div>
      )}

      {latestVitals?.bp_sys && (
        <div className="ss-item">
          <div>
            <div className="ss-label">BP — Today</div>

            <div className="ss-val">
              {latestVitals.bp_sys}/{latestVitals.bp_dia}
              <span className={`ss-badge ${latestVitals.bp_sys > 140 ? "ss-a" : "ss-g"}`}>
                {latestVitals.bp_sys > 140 ? "↑ Review" : "Normal"}
              </span>
            </div>
          </div>
        </div>
      )}

      <div className="ss-sep" />

      {activeMeds.length > 0 && (
        <div className="ss-item">
          <div>
            <div className="ss-label">Current Regimen</div>
            <div className="regimen-tags">
              {activeMeds.slice(0, 4).map((m, i) => (
                <span key={i} className="reg-tag">
                  {m.name}
                </span>
              ))}
              {activeMeds.length > 4 && (
                <span className="reg-tag">+{activeMeds.length - 4} more</span>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
});

export default VisitStrip;
