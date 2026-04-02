import { memo } from "react";
import { MED_COLORS, statusClass } from "./helpers";

const VisitSidebar = memo(function VisitSidebar({
  summary,
  latestVitals,
  activeDx,
  activeMeds,
  flags,
}) {
  const v = latestVitals;

  return (
    <div className="sidebar">
      <div className="sb-hd">
        <span className="sb-lbl">Patient Snapshot</span>
        <span className="sb-v">V{summary.totalVisits}</span>
      </div>
      <div className="sb-scroll">
        {/* Vitals */}
        {v && (
          <div className="sbsec">
            <div className="sbsec-title">Today's Vitals</div>
            <div className="vgrid">
              {v.bp_sys && (
                <div className="vbox">
                  <div className="vval">
                    {v.bp_sys}
                    <span style={{ fontSize: 9, color: "var(--sbmuted)" }}>/{v.bp_dia}</span>
                  </div>
                  <div className="vlbl">BP mmHg</div>
                </div>
              )}
              {v.pulse && (
                <div className="vbox">
                  <div className="vval">{v.pulse}</div>
                  <div className="vlbl">HR bpm</div>
                </div>
              )}
              {v.weight && (
                <div className="vbox">
                  <div className="vval">
                    {v.weight}
                    <span style={{ fontSize: 9, color: "var(--sbmuted)" }}>kg</span>
                  </div>
                  <div className="vlbl">Weight</div>
                </div>
              )}
              {v.bmi && (
                <div className="vbox">
                  <div className="vval">{Number(v.bmi).toFixed(1)}</div>
                  <div className="vlbl">BMI</div>
                </div>
              )}
            </div>
            <div
              style={{
                marginTop: 5,
                background: "var(--sb2)",
                border: "1px solid var(--sbb)",
                borderRadius: 6,
                padding: "5px 8px",
                display: "flex",
                justifyContent: "space-between",
              }}
            >
              {v.height && (
                <div style={{ textAlign: "center" }}>
                  <div className="vval" style={{ fontSize: 12 }}>
                    {v.height} cm
                  </div>
                  <div className="vlbl">Height</div>
                </div>
              )}
              {v.spo2 && (
                <div style={{ textAlign: "center" }}>
                  <div className="vval" style={{ fontSize: 12 }}>
                    {v.spo2}%
                  </div>
                  <div className="vlbl">SpO2</div>
                </div>
              )}
              {v.temp && (
                <div style={{ textAlign: "center" }}>
                  <div className="vval" style={{ fontSize: 12 }}>
                    {v.temp}°F
                  </div>
                  <div className="vlbl">Temp</div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Diagnoses */}
        {activeDx.length > 0 && (
          <div className="sbsec">
            <div className="sbsec-title">Diagnoses ({activeDx.length})</div>
            {activeDx.map((dx, i) => (
              <div key={i} className="sdx">
                <div>
                  <div className="sdx-nm">
                    {dx.label?.replace(/\s*\(.*\)/, "") || dx.diagnosis_id}
                  </div>
                  <div className="sdx-sub">
                    {dx.since_year ? `Since ${dx.since_year}` : ""}
                    {dx.notes ? ` · ${dx.notes}` : ""}
                  </div>
                </div>
                <span className={`spill ${statusClass(dx.status)}`}>{dx.status}</span>
              </div>
            ))}
          </div>
        )}

        {/* Active Meds */}
        {activeMeds.length > 0 && (
          <div className="sbsec">
            <div className="sbsec-title">Active Meds ({activeMeds.length})</div>
            {activeMeds.map((m, i) => (
              <div key={i} className="smed">
                <div
                  className="smed-dot"
                  style={{ background: MED_COLORS[i % MED_COLORS.length] }}
                />
                <div>
                  <div className="smed-nm">{m.name}</div>
                  <div className="smed-dose">
                    {m.dose} · {m.frequency || "OD"}
                    {m.timing ? ` · ${m.timing}` : ""}
                  </div>
                  {m.for_diagnosis?.length > 0 && (
                    <div className="smed-for">{m.for_diagnosis.join(", ")}</div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Flags */}
        {flags.length > 0 && (
          <div className="sbsec">
            <div className="sbsec-title">Flags</div>
            {flags.map((f, i) => (
              <div key={i} className={`salert ${f.type === "red" ? "red" : ""}`}>
                <span style={{ fontSize: 13 }}>{f.icon}</span>
                <div>
                  <div className="salert-txt">{f.text}</div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
});

export default VisitSidebar;
