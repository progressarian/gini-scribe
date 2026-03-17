import { useState } from "react";
import { useNavigate } from "react-router-dom";
import useVisitStore from "../stores/visitStore.js";
import useUiStore from "../stores/uiStore.js";
import { COMPLAINT_CHIPS } from "../config/chips.js";
import "./FUSymptomsPage.css";

export default function FUSymptomsPage() {
  const navigate = useNavigate();
  const [continuing, setContinuing] = useState(false);
  const {
    complaints,
    setComplaints,
    complaintText,
    setComplaintText,
    fuChecks,
    setFuChecks,
    fuExtMeds,
    setFuExtMeds,
    fuNewConditions,
    setFuNewConditions,
    saveDraft,
  } = useVisitStore();

  const toggleChip = (arr, setFn, val) => {
    setFn(arr.includes(val) ? arr.filter((x) => x !== val) : [...arr, val]);
  };

  return (
    <div>
      <div className="fu-symptoms__header">
        <span className="fu-symptoms__header-icon">🗣️</span>
        <div className="fu-symptoms__header-info">
          <div className="fu-symptoms__header-title">Symptoms & Assessment</div>
          <div className="fu-symptoms__header-sub">Quick checks + complaints</div>
        </div>
        <span className="fu-symptoms__header-step">Step 4/5</span>
      </div>

      {/* Quick Assessment */}
      <div className="fu-symptoms__card">
        <div className="fu-symptoms__assess-grid">
          {[
            {
              key: "medCompliance",
              label: "💊 Medicine Compliance",
              opts: ["Good", "Partial", "Poor"],
              colors: ["#059669", "#d97706", "#dc2626"],
            },
            {
              key: "dietExercise",
              label: "🥗 Diet & Exercise",
              opts: ["Adherent", "Partial", "Not following"],
              colors: ["#059669", "#d97706", "#dc2626"],
            },
            {
              key: "sideEffects",
              label: "⚠️ Side Effects",
              opts: ["None", "Mild", "Significant"],
              colors: ["#059669", "#d97706", "#dc2626"],
            },
            {
              key: "newSymptoms",
              label: "🆕 New Symptoms",
              opts: ["None", "Mild", "Concerning"],
              colors: ["#059669", "#d97706", "#dc2626"],
            },
          ].map((q) => (
            <div key={q.key}>
              <div className="fu-symptoms__assess-label">{q.label}</div>
              <div className="fu-symptoms__assess-opts">
                {q.opts.map((o, oi) => {
                  const active = fuChecks[q.key] === o;
                  return (
                    <button
                      key={o}
                      onClick={() =>
                        setFuChecks((p) => ({ ...p, [q.key]: p[q.key] === o ? "" : o }))
                      }
                      className="fu-symptoms__assess-btn"
                      style={{
                        border: `2px solid ${active ? q.colors[oi] : "#e2e8f0"}`,
                        background: active ? q.colors[oi] : "white",
                        color: active ? "white" : "#475569",
                      }}
                    >
                      {o}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>

        {/* Complaints */}
        <div className="fu-symptoms__complaints-title">🗣️ Chief Complaints</div>
        <div className="fu-symptoms__chips">
          {COMPLAINT_CHIPS.map((c) => (
            <button
              key={c}
              onClick={() => toggleChip(complaints, setComplaints, c)}
              className={`fu-symptoms__chip ${complaints.includes(c) ? "fu-symptoms__chip--active" : "fu-symptoms__chip--inactive"}`}
            >
              {c}
            </button>
          ))}
        </div>
        {complaints.filter((c) => !COMPLAINT_CHIPS.includes(c)).length > 0 && (
          <div className="fu-symptoms__custom-complaints">
            {complaints
              .filter((c) => !COMPLAINT_CHIPS.includes(c))
              .map((c, i) => (
                <span key={i} className="fu-symptoms__custom-complaint">
                  {c}
                  <button
                    onClick={() => setComplaints((p) => p.filter((x) => x !== c))}
                    className="fu-symptoms__custom-complaint-remove"
                  >
                    ×
                  </button>
                </span>
              ))}
          </div>
        )}
        <div className="fu-symptoms__add-complaint">
          <input
            value={complaintText}
            onChange={(e) => setComplaintText(e.target.value)}
            placeholder="Add complaint..."
            className="fu-symptoms__complaint-input"
            onKeyDown={(e) => {
              if (e.key === "Enter" && complaintText.trim()) {
                setComplaints((p) => [...p, complaintText.trim()]);
                setComplaintText("");
              }
            }}
          />
          <button
            onClick={() => {
              if (complaintText.trim()) {
                setComplaints((p) => [...p, complaintText.trim()]);
                setComplaintText("");
              }
            }}
            className="fu-symptoms__complaint-add-btn"
          >
            + Add
          </button>
        </div>

        {/* Challenges */}
        <div className="fu-symptoms__challenges-title">💬 Challenges / Notes</div>
        <textarea
          value={fuChecks.challenges || ""}
          onChange={(e) => setFuChecks((p) => ({ ...p, challenges: e.target.value }))}
          placeholder="Patient reports: difficulty with timing of meds, sugar cravings..."
          rows={2}
          className="fu-symptoms__challenges-textarea"
        />

        {/* New external meds + conditions */}
        <div className="fu-symptoms__extras-grid">
          <div>
            <div className="fu-symptoms__extra-title fu-symptoms__extra-title--amber">
              💊 New External Medicines
            </div>
            {fuExtMeds.map((m, i) => (
              <div key={i} className="fu-symptoms__ext-med-item">
                <span className="fu-symptoms__ext-med-name">
                  {m.name} {m.dose}{" "}
                  {m.doctor ? (
                    <span className="fu-symptoms__ext-med-doctor">— {m.doctor}</span>
                  ) : (
                    ""
                  )}
                </span>
                <button
                  onClick={() => setFuExtMeds((p) => p.filter((_, j) => j !== i))}
                  className="fu-symptoms__ext-med-remove"
                >
                  ×
                </button>
              </div>
            ))}
            <div className="fu-symptoms__ext-med-add">
              <input
                id="fuExtName2"
                placeholder="Medicine"
                className="fu-symptoms__ext-med-input fu-symptoms__ext-med-input--name"
              />
              <input
                id="fuExtDose2"
                placeholder="Dose"
                className="fu-symptoms__ext-med-input fu-symptoms__ext-med-input--dose"
              />
              <button
                onClick={() => {
                  const n = document.getElementById("fuExtName2");
                  const d = document.getElementById("fuExtDose2");
                  if (n.value.trim()) {
                    setFuExtMeds((p) => [
                      ...p,
                      { name: n.value.trim(), dose: d.value.trim(), doctor: "" },
                    ]);
                    n.value = "";
                    d.value = "";
                  }
                }}
                className="fu-symptoms__ext-med-submit"
              >
                +
              </button>
            </div>
          </div>
          <div>
            <div className="fu-symptoms__extra-title fu-symptoms__extra-title--red">
              🆕 New Conditions
            </div>
            {fuNewConditions.map((c, i) => (
              <div key={i} className="fu-symptoms__condition-item">
                <span className="fu-symptoms__condition-name">{c}</span>
                <button
                  onClick={() => setFuNewConditions((p) => p.filter((_, j) => j !== i))}
                  className="fu-symptoms__condition-remove"
                >
                  ×
                </button>
              </div>
            ))}
            <div className="fu-symptoms__condition-add">
              <input
                id="fuNewCond2"
                placeholder="e.g. Hyperuricemia"
                className="fu-symptoms__condition-add-input"
                onKeyDown={(e) => {
                  if (e.key === "Enter" && e.target.value.trim()) {
                    setFuNewConditions((p) => [...p, e.target.value.trim()]);
                    e.target.value = "";
                  }
                }}
              />
              <button
                onClick={() => {
                  const el = document.getElementById("fuNewCond2");
                  if (el.value.trim()) {
                    setFuNewConditions((p) => [...p, el.value.trim()]);
                    el.value = "";
                  }
                }}
                className="fu-symptoms__condition-add-btn"
              >
                + Add
              </button>
            </div>
          </div>
        </div>
      </div>

      <button
        disabled={continuing}
        onClick={async () => {
          setContinuing(true);
          try {
            await saveDraft();
          } catch {}
          setContinuing(false);
          navigate("/fu-gen");
        }}
        className="fu-symptoms__next-btn"
      >
        {continuing ? "Saving..." : "Next: Create Plan →"}
      </button>
    </div>
  );
}
