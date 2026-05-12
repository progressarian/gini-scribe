import { memo } from "react";
import { fmtDate, fmtLabVal } from "./helpers";

const VisitStrip = memo(function VisitStrip({
  summary,
  hba1cCurr,
  hba1cFirst,
  latestVitals,
  prevVitals,
  activeMeds,
  labStatus,
  tab,
}) {
  const weightCurr = latestVitals?.weight;
  const weightPrev = prevVitals?.weight;

  // Mirrors the OPD lab tags. labStatus is computed server-side in
  // /api/visit/:patientId so the chip shown here always matches what the
  // OPD list shows for the same patient.
  const labChips = (() => {
    if (!labStatus) return [];
    const chips = [];
    if (labStatus.pending_labs > 0) {
      chips.push({ label: "🔬 Gini Lab Processing", tone: "ss-a" });
    }
    if (labStatus.partial_labs > 0) {
      chips.push({
        label: "🟡 Gini Lab Partial",
        tone: "ss-a",
        date: labStatus.partial_labs_date ? fmtDate(labStatus.partial_labs_date) : null,
      });
    }
    if (labStatus.recent_labs > 0) {
      chips.push({
        label: "✅ Gini Lab Received",
        tone: "ss-g",
        date: labStatus.recent_labs_date ? fmtDate(labStatus.recent_labs_date) : null,
      });
    }
    if (labStatus.uploaded_labs > 0) {
      chips.push({
        label: "📄 Lab Uploaded",
        tone: "ss-b",
        date: labStatus.uploaded_labs_date ? fmtDate(labStatus.uploaded_labs_date) : null,
      });
    }
    return chips;
  })();

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

      {labChips.length > 0 && (
        <div className="ss-item">
          <div>
            <div className="ss-label">Lab Status</div>
            <div className="ss-val" style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
              {labChips.map((c, i) => (
                <span key={i} className={`ss-badge ${c.tone}`}>
                  {c.label}
                  {c.date ? ` · ${c.date}` : ""}
                </span>
              ))}
            </div>
          </div>
        </div>
      )}

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

      {latestVitals?.rbs &&
        (() => {
          const rbs = Number(latestVitals.rbs);
          const isFasting = (latestVitals.meal_type || "").toLowerCase() === "fasting";
          const high = isFasting ? rbs > 126 : rbs > 180;
          return (
            <div className="ss-item">
              <div>
                <div className="ss-label">
                  Sugar{latestVitals.meal_type ? ` — ${latestVitals.meal_type}` : ""}
                </div>
                <div className="ss-val">
                  {latestVitals.rbs} mg/dL
                  <span className={`ss-badge ${high ? "ss-a" : "ss-g"}`}>
                    {high ? "↑ Review" : "Normal"}
                  </span>
                </div>
              </div>
            </div>
          );
        })()}

      <div className="ss-sep" />

      {(() => {
        if (tab === "medcard") return null;
        const currentMeds = (activeMeds || []).filter(
          (m) => m.is_active !== false && !m.parent_medication_id,
        );
        if (currentMeds.length === 0) return null;
        return (
          <div className="ss-item">
            <div>
              <div className="ss-label">Current Regimen</div>
              <div className="regimen-tags">
                {currentMeds.slice(0, 4).map((m, i) => (
                  <span key={i} className="reg-tag">
                    {m.name}
                  </span>
                ))}
                {currentMeds.length > 4 && (
                  <span className="reg-tag">+{currentMeds.length - 4} more</span>
                )}
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
});

export default VisitStrip;
