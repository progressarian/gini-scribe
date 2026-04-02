import { memo, useState, useMemo } from "react";
import { MED_COLORS, fmtDate } from "./helpers";

// Deduplicate meds by name (same logic as Outcomes page)
function dedup(meds) {
  const grouped = {};
  meds.forEach((m) => {
    const key = (m.pharmacy_match || m.name || "").toUpperCase();
    if (!key) return;
    if (!grouped[key]) {
      grouped[key] = { ...m, _entries: [] };
    }
    // Keep the entry with latest data
    const k = `${m.dose}|${m.frequency}|${m.prescribed_date || m.created_at}`;
    const isDup = grouped[key]._entries.some(
      (e) => `${e.dose}|${e.frequency}|${e.prescribed_date || e.created_at}` === k,
    );
    if (!isDup) grouped[key]._entries.push(m);
    // Use the most recent entry's data
    if (
      !grouped[key].prescribed_date ||
      (m.prescribed_date && m.prescribed_date > grouped[key].prescribed_date)
    ) {
      const entries = grouped[key]._entries;
      Object.assign(grouped[key], m, { _entries: entries });
    }
  });
  return Object.values(grouped);
}

const VisitMedications = memo(function VisitMedications({ activeMeds, stoppedMeds, onAddMed, onEditMed, onStopMed }) {
  const [showStopped, setShowStopped] = useState(false);

  const uniqueActive = useMemo(() => dedup(activeMeds), [activeMeds]);
  const uniqueStopped = useMemo(() => dedup(stoppedMeds), [stoppedMeds]);

  return (
    <div className="sc" id="medications">
      <div className="sch">
        <div className="sct">
          <div className="sci ic-g">💊</div>Medications
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          {uniqueStopped.length > 0 && (
            <button className="bx bx-n" onClick={() => setShowStopped(!showStopped)}>
              Stopped Meds
            </button>
          )}
          <button className="bx bx-p" onClick={onAddMed}>+ Add Medicine</button>
        </div>
      </div>
      <div className="scb">
        <div className="mth">
          <span className="mthl">Medicine</span>
          <span className="mthl">Dose</span>
          <span className="mthl">Timing</span>
          <span className="mthl">For / Since</span>
          <span className="mthl">Actions</span>
        </div>

        {uniqueActive.map((m, i) => (
          <div key={m.id || i} className="mtr">
            <div className="mmain">
              <div className="mdot" style={{ background: MED_COLORS[i % MED_COLORS.length] }} />
              <div>
                <div className="mbrand">{m.name}</div>
                <div className="mgen">
                  {m.composition || ""}
                  {m.route ? ` · ${m.route}` : ""}
                </div>
              </div>
            </div>
            <div className="mtd">{m.dose || "—"}</div>
            <div className="mtd">
              {m.frequency || "OD"}
              {m.timing && (
                <>
                  <br />
                  <span style={{ fontSize: 10, color: "var(--t3)" }}>{m.timing}</span>
                </>
              )}
            </div>
            <div>
              {m.for_diagnosis?.length > 0 && <span className="mfor">{m.for_diagnosis[0]}</span>}
              {m.prescribed_date && (
                <div style={{ fontSize: 9, color: "var(--t4)", marginTop: 3 }}>
                  Since {fmtDate(m.prescribed_date)}
                  {m.prescriber ? ` · ${m.prescriber}` : ""}
                </div>
              )}
            </div>
            <div className="macts">
              <button className="ma ma-e" onClick={() => onEditMed?.(m)}>Edit</button>
              <button className="ma ma-s" onClick={() => onStopMed?.(m)}>Stop</button>
              {m.route === "SC" ||
              m.route === "Subcutaneous" ||
              (m.name || "").toLowerCase().includes("inj") ? (
                <button
                  className="ma"
                  style={{
                    color: "var(--amber)",
                    borderColor: "var(--amb-bd)",
                    background: "var(--amb-lt)",
                  }}
                >
                  Pause
                </button>
              ) : null}
            </div>
          </div>
        ))}

        {uniqueActive.length === 0 && (
          <div style={{ fontSize: 13, color: "var(--t3)", padding: 16, textAlign: "center" }}>
            No active medications
          </div>
        )}

        {/* Stopped meds */}
        {showStopped && uniqueStopped.length > 0 && (
          <>
            <div className="stp-lbl">Stopped Medications</div>
            {uniqueStopped.map((m, i) => (
              <div key={m.id || i} className="mtr stp">
                <div className="mmain">
                  <div className="mdot" style={{ background: "var(--t4)" }} />
                  <div>
                    <div className="mbrand">{m.name}</div>
                    <div className="mgen">{m.composition || ""}</div>
                  </div>
                </div>
                <div className="mtd">{m.dose || "—"}</div>
                <div className="mtd">Was {m.frequency || "OD"}</div>
                <div>
                  <span className="stoptag">Stopped</span>
                  {m.stopped_date && (
                    <div style={{ fontSize: 9, color: "var(--t4)", marginTop: 2 }}>
                      {fmtDate(m.stopped_date)}
                    </div>
                  )}
                  {m.stop_reason && (
                    <div style={{ fontSize: 9, color: "var(--t3)", marginTop: 2 }}>
                      {m.stop_reason}
                    </div>
                  )}
                </div>
                <div className="macts">
                  <button className="ma ma-r">Restart?</button>
                </div>
              </div>
            ))}
          </>
        )}

        {/* Add new medicine row */}
        <div className="addr" style={{ marginTop: 9 }} onClick={onAddMed}>
          <span style={{ fontSize: 16, color: "var(--t3)" }}>+</span>
          <span className="addr-lbl">Add new medicine — type to search</span>
        </div>
      </div>
    </div>
  );
});

export default VisitMedications;
