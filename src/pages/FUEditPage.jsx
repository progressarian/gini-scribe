import { useNavigate } from "react-router-dom";
import usePatientStore from "../stores/patientStore.js";
import useClinicalStore from "../stores/clinicalStore.js";
import useVisitStore from "../stores/visitStore.js";
import "./FUEditPage.css";

export default function FUEditPage() {
  const navigate = useNavigate();
  const { patient, getPfd } = usePatientStore();
  const { conData } = useClinicalStore();
  const { fuMedEdits, setFuMedEdits, fuNewMeds, setFuNewMeds } = useVisitStore();

  const pfd = getPfd();

  return (
    <div>
      <div className="fu-edit__header">
        <span className="fu-edit__header-icon">📋</span>
        <div className="fu-edit__header-info">
          <div className="fu-edit__header-title">Edit Last Treatment Plan</div>
          <div className="fu-edit__header-sub">Make quick adjustments to medications & goals</div>
        </div>
        <span className="fu-edit__header-step">Step 3/5</span>
      </div>

      {(() => {
        const lastCon = pfd?.consultations?.[0];
        const lastConData = conData || lastCon?.con_data || {};
        const conMeds = lastConData.medications_confirmed || [];
        const lastMeds =
          conMeds.length > 0
            ? conMeds
            : (() => {
                const seen = new Set();
                return (pfd?.medications || [])
                  .filter((m) => {
                    const k = (m.name || "").toUpperCase().replace(/\s+/g, "");
                    if (seen.has(k)) return false;
                    seen.add(k);
                    return true;
                  })
                  .map((m) => ({
                    name: m.name || "",
                    composition: m.composition || "",
                    dose: m.dose || "",
                    frequency: m.frequency || "",
                    timing: m.timing || "",
                    route: m.route || "Oral",
                    forDiagnosis: m.for_diagnosis ? [m.for_diagnosis] : [],
                    isNew: false,
                  }));
              })();
        const lastGoals = lastConData.goals || conData?.goals || [];

        const lastMedNames = new Set(
          lastMeds.map((m) => (m.name || "").toUpperCase().replace(/\s+/g, "")),
        );
        const extMeds = (pfd?.medications || [])
          .filter(
            (m) =>
              m.is_active !== false &&
              !lastMedNames.has((m.name || "").toUpperCase().replace(/\s+/g, "")) &&
              (m.prescriber || m.con_name || "") !== (pfd?.consultations?.[0]?.con_name || ""),
          )
          .map((m) => ({
            name: m.name || "",
            composition: m.composition || "",
            dose: m.dose || "",
            frequency: m.frequency || "",
            timing: m.timing || "",
            route: m.route || "Oral",
            forDiagnosis: m.for_diagnosis ? [m.for_diagnosis] : [],
            isExternal: true,
            prescriber: m.prescriber || m.con_name || "External",
          }));
        const extSeen = new Set();
        const uniqueExtMeds = extMeds.filter((m) => {
          const k = (m.name || "").toUpperCase().replace(/\s+/g, "");
          if (extSeen.has(k)) return false;
          extSeen.add(k);
          return true;
        });

        return (
          <div>
            {/* Medications Table */}
            <div className="fu-edit__med-table">
              <div className="fu-edit__med-header">
                <span className="fu-edit__med-title">💊 Medications ({lastMeds.length})</span>
                <button
                  onClick={() =>
                    setFuNewMeds((p) => [
                      ...p,
                      { name: "", dose: "", freq: "OD", timing: "Morning", forDx: "" },
                    ])
                  }
                  className="fu-edit__med-add-btn"
                >
                  + Add
                </button>
              </div>
              <table className="fu-edit__table">
                <thead>
                  <tr className="fu-edit__table-head">
                    <td className="fu-edit__table-cell">Medicine</td>
                    <td className="fu-edit__table-cell">Dose</td>
                    <td className="fu-edit__table-cell">Freq</td>
                    <td className="fu-edit__table-cell">For</td>
                    <td className="fu-edit__table-cell fu-edit__table-cell--center">Action</td>
                  </tr>
                </thead>
                <tbody>
                  {lastMeds.map((m, i) => {
                    const edit = fuMedEdits[i] || {};
                    const stopped = edit.action === "STOP";
                    const modified = edit.action === "MODIFY" || edit.dose || edit.freq;
                    return (
                      <tr
                        key={i}
                        className={`fu-edit__med-row ${stopped ? "fu-edit__med-row--stopped" : modified ? "fu-edit__med-row--modified" : ""}`}
                      >
                        <td className="fu-edit__table-cell--body">
                          <span
                            className={`fu-edit__med-name ${stopped ? "fu-edit__med-name--stopped" : ""}`}
                          >
                            {m.name}
                          </span>
                          {modified && <span className="fu-edit__med-modified-icon">✏️</span>}
                        </td>
                        <td className="fu-edit__table-cell--body">
                          <input
                            defaultValue={m.dose || ""}
                            disabled={stopped}
                            className="fu-edit__med-input"
                            onChange={(e) =>
                              setFuMedEdits((p) => ({
                                ...p,
                                [i]: { ...(p[i] || {}), dose: e.target.value, action: "MODIFY" },
                              }))
                            }
                          />
                        </td>
                        <td className="fu-edit__table-cell--body">
                          <input
                            defaultValue={m.frequency || m.freq || ""}
                            disabled={stopped}
                            className="fu-edit__med-freq-input"
                            onChange={(e) =>
                              setFuMedEdits((p) => ({
                                ...p,
                                [i]: { ...(p[i] || {}), freq: e.target.value, action: "MODIFY" },
                              }))
                            }
                          />
                        </td>
                        <td className="fu-edit__table-cell--body fu-edit__med-dx">
                          {(m.forDiagnosis || []).join(", ")}
                        </td>
                        <td className="fu-edit__table-cell--body fu-edit__table-cell--center">
                          <button
                            onClick={() =>
                              setFuMedEdits((p) => ({
                                ...p,
                                [i]: { ...(p[i] || {}), action: stopped ? "CONTINUE" : "STOP" },
                              }))
                            }
                            className={`fu-edit__med-action-btn ${stopped ? "fu-edit__med-action-btn--continue" : "fu-edit__med-action-btn--stop"}`}
                          >
                            {stopped ? "↩" : "🛑"}
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                  {fuNewMeds.map((nm, i) => (
                    <tr key={`n${i}`} className="fu-edit__med-row--new">
                      <td className="fu-edit__table-cell--body">
                        <input
                          placeholder="Medicine"
                          value={nm.name}
                          onChange={(e) =>
                            setFuNewMeds((p) =>
                              p.map((m, j) => (j === i ? { ...m, name: e.target.value } : m)),
                            )
                          }
                          className="fu-edit__med-input fu-edit__med-input--new"
                        />
                      </td>
                      <td className="fu-edit__table-cell--body">
                        <input
                          placeholder="Dose"
                          value={nm.dose}
                          onChange={(e) =>
                            setFuNewMeds((p) =>
                              p.map((m, j) => (j === i ? { ...m, dose: e.target.value } : m)),
                            )
                          }
                          className="fu-edit__med-input fu-edit__med-input--new"
                        />
                      </td>
                      <td className="fu-edit__table-cell--body">
                        <input
                          placeholder="OD"
                          value={nm.freq}
                          onChange={(e) =>
                            setFuNewMeds((p) =>
                              p.map((m, j) => (j === i ? { ...m, freq: e.target.value } : m)),
                            )
                          }
                          className="fu-edit__med-freq-input fu-edit__med-freq-input--new"
                        />
                      </td>
                      <td colSpan={2} className="fu-edit__table-cell--body">
                        <span className="fu-edit__new-badge">➕ NEW</span>
                        <button
                          onClick={() => setFuNewMeds((p) => p.filter((_, j) => j !== i))}
                          className="fu-edit__new-remove-btn"
                        >
                          ✕
                        </button>
                      </td>
                    </tr>
                  ))}
                  {uniqueExtMeds.length > 0 && (
                    <>
                      <tr className="fu-edit__med-row--ext-header">
                        <td colSpan={5} className="fu-edit__ext-section-header">
                          🏥 FROM OTHER CONSULTANTS ({uniqueExtMeds.length})
                        </td>
                      </tr>
                      {uniqueExtMeds.map((m, i) => {
                        const extIdx = `ext_${i}`;
                        const edit = fuMedEdits[extIdx] || {};
                        const stopped = edit.action === "STOP";
                        return (
                          <tr
                            key={extIdx}
                            className={`fu-edit__med-row--ext ${stopped ? "fu-edit__med-row--stopped" : ""}`}
                          >
                            <td className="fu-edit__table-cell--body">
                              <span
                                className={`fu-edit__med-name ${stopped ? "fu-edit__med-name--stopped" : ""}`}
                              >
                                {m.name}
                              </span>
                              <div className="fu-edit__ext-prescriber">via {m.prescriber}</div>
                            </td>
                            <td className="fu-edit__table-cell--body">
                              <input
                                defaultValue={m.dose || ""}
                                disabled={stopped}
                                className="fu-edit__med-input fu-edit__med-input--ext"
                                onChange={(e) =>
                                  setFuMedEdits((p) => ({
                                    ...p,
                                    [extIdx]: {
                                      ...(p[extIdx] || {}),
                                      dose: e.target.value,
                                      action: "MODIFY",
                                    },
                                  }))
                                }
                              />
                            </td>
                            <td className="fu-edit__table-cell--body">
                              <input
                                defaultValue={m.frequency || ""}
                                disabled={stopped}
                                className="fu-edit__med-freq-input fu-edit__med-freq-input--ext"
                                onChange={(e) =>
                                  setFuMedEdits((p) => ({
                                    ...p,
                                    [extIdx]: {
                                      ...(p[extIdx] || {}),
                                      freq: e.target.value,
                                      action: "MODIFY",
                                    },
                                  }))
                                }
                              />
                            </td>
                            <td className="fu-edit__table-cell--body fu-edit__med-dx">
                              {(m.forDiagnosis || []).join(", ")}
                            </td>
                            <td className="fu-edit__table-cell--body fu-edit__table-cell--center">
                              <button
                                onClick={() =>
                                  setFuMedEdits((p) => ({
                                    ...p,
                                    [extIdx]: {
                                      ...(p[extIdx] || {}),
                                      action: stopped ? "CONTINUE" : "STOP",
                                    },
                                  }))
                                }
                                className={`fu-edit__med-action-btn ${stopped ? "fu-edit__med-action-btn--continue" : "fu-edit__med-action-btn--stop"}`}
                              >
                                {stopped ? "↩" : "🛑"}
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </>
                  )}
                </tbody>
              </table>
            </div>

            {/* Goals */}
            {lastGoals.length > 0 && (
              <div className="fu-edit__goals">
                <div className="fu-edit__goals-title">🎯 Goals — Update targets</div>
                <div className="fu-edit__goals-grid">
                  {lastGoals.map((g, i) => (
                    <div key={i} className="fu-edit__goal-card">
                      <div className="fu-edit__goal-name">{g.marker}</div>
                      <div className="fu-edit__goal-target-row">
                        <span className="fu-edit__goal-target-label">Target:</span>
                        <input
                          defaultValue={g.target || ""}
                          className="fu-edit__goal-target-input"
                        />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Quick summary of changes */}
            {(Object.keys(fuMedEdits).length > 0 || fuNewMeds.length > 0) && (
              <div className="fu-edit__changes-summary">
                <span className="fu-edit__changes-modified">
                  ✏️ {Object.values(fuMedEdits).filter((e) => e.action === "MODIFY").length}{" "}
                  modified
                </span>
                <span className="fu-edit__changes-stopped">
                  🛑 {Object.values(fuMedEdits).filter((e) => e.action === "STOP").length} stopped
                </span>
                <span className="fu-edit__changes-new">
                  ➕ {fuNewMeds.filter((m) => m.name).length} new
                </span>
              </div>
            )}
          </div>
        );
      })()}

      <button onClick={() => navigate("/fu-symptoms")} className="fu-edit__next-btn">
        Next: Symptoms →
      </button>
    </div>
  );
}
