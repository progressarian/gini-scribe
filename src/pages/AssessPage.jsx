import "./AssessPage.css";
import { useNavigate } from "react-router-dom";
import { makeNavClick } from "../lib/navClick";
import useAuthStore from "../stores/authStore";
import usePatientStore from "../stores/patientStore";
import useClinicalStore from "../stores/clinicalStore";
import useVitalsStore from "../stores/vitalsStore";
import useLabStore from "../stores/labStore";
import useVisitStore from "../stores/visitStore";
import useExamStore from "../stores/examStore";
import usePlanStore from "../stores/planStore";
import useUiStore from "../stores/uiStore";
import AudioInput from "../components/AudioInput.jsx";
import { ts } from "../config/constants.js";
import { CONDITIONS } from "../config/conditions.js";
import { CONDITION_CHIPS, LAB_ORDER_CHIPS } from "../config/chips.js";
import { LAB_PACKAGES } from "../config/labOrder.js";
import { toggleChip } from "../utils/helpers.js";

export default function AssessPage() {
  const navigate = useNavigate();
  const navClick = makeNavClick(navigate);
  const dgKey = useAuthStore((s) => s.dgKey);
  const whisperKey = useAuthStore((s) => s.whisperKey);
  const patientFullData = usePatientStore((s) => s.patientFullData);
  const pfd = usePatientStore((s) => s.getPfd());
  const vitals = useVitalsStore((s) => s.vitals);
  const labData = useLabStore((s) => s.labData);
  const setLabRequisition = useLabStore((s) => s.setLabRequisition);
  const moTranscript = useClinicalStore((s) => s.moTranscript);
  const setMoTranscript = useClinicalStore((s) => s.setMoTranscript);
  const moData = useClinicalStore((s) => s.moData);
  const processMO = useClinicalStore((s) => s.processMO);
  const setConSourceMode = useClinicalStore((s) => s.setConSourceMode);
  const complaints = useVisitStore((s) => s.complaints);
  const assessDx = useExamStore((s) => s.assessDx);
  const setAssessDx = useExamStore((s) => s.setAssessDx);
  const assessLabs = useExamStore((s) => s.assessLabs);
  const setAssessLabs = useExamStore((s) => s.setAssessLabs);
  const assessNotes = useExamStore((s) => s.assessNotes);
  const setAssessNotes = useExamStore((s) => s.setAssessNotes);
  const shadowAI = useExamStore((s) => s.shadowAI);
  const setShadowAI = useExamStore((s) => s.setShadowAI);
  const shadowData = useExamStore((s) => s.shadowData);
  const shadowOriginal = useExamStore((s) => s.shadowOriginal);
  const shadowTxDecisions = useExamStore((s) => s.shadowTxDecisions);
  const setShadowTxDecisions = useExamStore((s) => s.setShadowTxDecisions);
  const shadowLoading = useExamStore((s) => s.shadowLoading);
  const hxConditions = useExamStore((s) => s.hxConditions);
  const hxSurgeries = useExamStore((s) => s.hxSurgeries);
  const hxAllergies = useExamStore((s) => s.hxAllergies);
  const runShadowAI = useExamStore((s) => s.runShadowAI);
  const createPlanFromShadow = useExamStore((s) => s.createPlanFromShadow);
  const editShadowItem = useExamStore((s) => s.editShadowItem);
  const addShadowItem = useExamStore((s) => s.addShadowItem);
  const removeShadowItem = useExamStore((s) => s.removeShadowItem);
  const getExamSummary = useExamStore((s) => s.getExamSummary);
  const addMedToPlan = usePlanStore((s) => s.addMedToPlan);
  const loading = useUiStore((s) => s.loading);

  return (
    <div>
      <div className="assess__header">
        <span className="assess__header-icon">🧪</span>
        <div className="assess__header-info">
          <div className="assess__header-title">Assessment</div>
          <div className="assess__header-sub">Diagnoses + Labs + Notes</div>
        </div>
        <span className="assess__header-step">Step 4/6</span>
      </div>

      <div className="assess__section">
        <div className="assess__section-title">🏥 Diagnoses</div>
        {hxConditions.length > 0 &&
          (() => {
            const unconfirmed = hxConditions.filter((c) => {
              const chip = CONDITION_CHIPS.find((x) =>
                x.l.toLowerCase().includes(c.toLowerCase().slice(0, 4)),
              );
              return chip && !assessDx.includes(chip.id);
            });
            return unconfirmed.length > 0 ? (
              <div className="assess__hx-box">
                <div className="assess__hx-title">📜 From Clinical History — click to confirm</div>
                <div className="assess__hx-chips">
                  {unconfirmed.map((c) => {
                    const chip = CONDITION_CHIPS.find((x) =>
                      x.l.toLowerCase().includes(c.toLowerCase().slice(0, 4)),
                    );
                    return (
                      <button
                        key={c}
                        onClick={() => {
                          if (chip && !assessDx.includes(chip.id))
                            setAssessDx((prev) => [...prev, chip.id]);
                        }}
                        className="assess__hx-chip"
                      >
                        + {c}
                      </button>
                    );
                  })}
                  <button
                    onClick={() => {
                      const allIds = hxConditions
                        .map(
                          (c) =>
                            CONDITION_CHIPS.find((x) =>
                              x.l.toLowerCase().includes(c.toLowerCase().slice(0, 4)),
                            )?.id,
                        )
                        .filter(Boolean);
                      setAssessDx((prev) => [...new Set([...prev, ...allIds])]);
                    }}
                    className="assess__hx-confirm-btn"
                  >
                    ✓ Confirm All ({unconfirmed.length})
                  </button>
                </div>
              </div>
            ) : null;
          })()}
        <div className="assess__dx-chips">
          {CONDITION_CHIPS.map((c) => (
            <button
              key={c.id}
              onClick={() => toggleChip(assessDx, setAssessDx, c.id)}
              className="assess__dx-chip"
              style={{
                border: `1.5px solid ${assessDx.includes(c.id) ? c.cl : "#e2e8f0"}`,
                background: assessDx.includes(c.id) ? c.cl + "12" : "white",
                color: assessDx.includes(c.id) ? c.cl : "#64748b",
              }}
            >
              {c.l}
            </button>
          ))}
        </div>
        {assessDx.length > 0 && (
          <div className="assess__dx-selected">
            <div className="assess__dx-selected-title">Selected: {assessDx.length}</div>
            <div className="assess__dx-selected-chips">
              {assessDx.map((id) => {
                const c = CONDITION_CHIPS.find((x) => x.id === id);
                return (
                  c && (
                    <span
                      key={id}
                      className="assess__dx-selected-chip"
                      style={{ background: c.cl }}
                    >
                      {c.l}
                    </span>
                  )
                );
              })}
            </div>
          </div>
        )}
      </div>

      <div className="assess__section">
        <div className="assess__section-title">🔬 Order Labs</div>
        {(() => {
          const dxMap = {
            dm2: "Type 2 DM",
            htn: "Hypertension",
            hypo: "Hypothyroid",
            hyper: "Hyperthyroid",
            dyslip: "Dyslipidemia",
            obesity: "Obesity",
            pcos: "PCOS",
            ckd: "CKD",
            cad: "CAD",
            vitd: "Vit D Deficiency",
            b12: "B12 Deficiency",
          };
          const suggestedTests = [
            ...new Set(
              assessDx.flatMap((id) => {
                const condName = dxMap[id];
                if (!condName || !CONDITIONS[condName]) return [];
                return CONDITIONS[condName].biomarkers || [];
              }),
            ),
          ];
          const hxTests = [
            ...new Set(hxConditions.flatMap((c) => CONDITIONS[c]?.biomarkers || [])),
          ];
          const allSuggested = [...new Set([...suggestedTests, ...hxTests])];
          return allSuggested.length > 0 ? (
            <div className="assess__lab-ai">
              <div className="assess__lab-ai-header">
                <span className="assess__lab-ai-title">🤖 Suggested for selected diagnoses</span>
                <button
                  onClick={() => {
                    const newLabs = allSuggested.filter((t) => !assessLabs.includes(t));
                    setAssessLabs((prev) => [...prev, ...newLabs]);
                  }}
                  className="assess__lab-ai-add-btn"
                >
                  + Add All ({allSuggested.filter((t) => !assessLabs.includes(t)).length})
                </button>
              </div>
              <div className="assess__lab-ai-chips">
                {allSuggested.map((t) => (
                  <button
                    key={t}
                    onClick={() => {
                      if (!assessLabs.includes(t)) setAssessLabs((prev) => [...prev, t]);
                    }}
                    className="assess__lab-ai-chip"
                    style={{
                      border: `1.5px solid ${assessLabs.includes(t) ? "#059669" : "#c4b5fd"}`,
                      background: assessLabs.includes(t) ? "#f0fdf4" : "white",
                      color: assessLabs.includes(t) ? "#059669" : "#7c3aed",
                    }}
                  >
                    {assessLabs.includes(t) ? "✅" : "+"} {t}
                  </button>
                ))}
              </div>
            </div>
          ) : null;
        })()}

        <div className="assess__lab-packages">
          {LAB_PACKAGES.map((pkg) => (
            <button
              key={pkg.label}
              onClick={() => setAssessLabs((prev) => [...new Set([...prev, ...pkg.tests])])}
              className="assess__lab-package-btn"
            >
              {pkg.label}
            </button>
          ))}
        </div>

        <div className="assess__lab-chips">
          {LAB_ORDER_CHIPS.map((t) => (
            <button
              key={t}
              onClick={() => toggleChip(assessLabs, setAssessLabs, t)}
              className="assess__lab-chip"
              style={{
                border: `1.5px solid ${assessLabs.includes(t) ? "#059669" : "#e2e8f0"}`,
                background: assessLabs.includes(t) ? "#f0fdf4" : "white",
                color: assessLabs.includes(t) ? "#059669" : "#64748b",
              }}
            >
              {t}
            </button>
          ))}
        </div>
        {assessLabs.length > 0 && (
          <div className="assess__lab-ordered">
            <div className="assess__lab-ordered-header">
              <div className="assess__lab-ordered-count">✅ {assessLabs.length} tests ordered</div>
              <div className="assess__lab-ordered-btns">
                <button
                  onClick={() => {
                    const cur = useLabStore.getState().labRequisition;
                    setLabRequisition([...new Set([...cur, ...assessLabs])]);
                  }}
                  className="assess__lab-ordered-btn assess__lab-ordered-btn--save"
                >
                  💾 Save to Dashboard
                </button>
                <button
                  onClick={() => window.print()}
                  className="assess__lab-ordered-btn assess__lab-ordered-btn--print"
                >
                  🖨️ Print Requisition
                </button>
              </div>
            </div>
            <div className="assess__lab-ordered-list">{assessLabs.join(", ")}</div>
          </div>
        )}
      </div>

      <div className="assess__section">
        <div className="assess__section-title--sm">📝 MO Notes</div>
        <AudioInput
          label="🎤 Dictate assessment notes"
          dgKey={dgKey}
          whisperKey={whisperKey}
          color="#7c3aed"
          compact
          onTranscript={(t) => setAssessNotes(assessNotes ? assessNotes + "\n" + t : t)}
        />
        <textarea
          value={assessNotes}
          onChange={(e) => setAssessNotes(e.target.value)}
          placeholder="Clinical notes, impressions..."
          rows={3}
          className="assess__notes-textarea"
        />
      </div>

      {getExamSummary() && (
        <div className="assess__exam-summary">
          <div className="assess__exam-title">🔍 EXAM SUMMARY</div>
          <div className="assess__exam-text">{getExamSummary()}</div>
        </div>
      )}

      <button
        onClick={() => {
          const parts = [];
          if (complaints.length) parts.push("Chief Complaints: " + complaints.join(", "));
          const examSum = getExamSummary();
          if (examSum) parts.push("Examination: " + examSum);
          if (assessDx.length) {
            const dxLabels = assessDx.map(
              (id) => CONDITION_CHIPS.find((c) => c.id === id)?.l || id,
            );
            parts.push("Diagnoses: " + dxLabels.join(", "));
          }
          if (hxConditions.length) parts.push("History Conditions: " + hxConditions.join(", "));
          if (hxAllergies.length) parts.push("Allergies: " + hxAllergies.join(", "));
          if (hxSurgeries.length)
            parts.push(
              "Surgeries: " +
                hxSurgeries.map((s) => `${s.name}${s.year ? ` (${s.year})` : ""}`).join(", "),
            );
          if (assessNotes) parts.push("Notes: " + assessNotes);
          if (vitals.bp_sys)
            parts.push(
              `Vitals: BP ${vitals.bp_sys}/${vitals.bp_dia}, Pulse ${vitals.pulse}, SpO2 ${vitals.spo2}, Wt ${vitals.weight}kg, BMI ${vitals.bmi}`,
            );
          if (labData?.panels) {
            const labParts = labData.panels.flatMap((p) =>
              (p.tests || [])
                .filter((t) => t.flag)
                .map((t) => `${t.test_name}: ${t.result}${t.unit || ""} (${t.flag})`),
            );
            if (labParts.length) parts.push("Key Labs: " + labParts.join(", "));
          }
          if (patientFullData?.medications?.length) {
            const medList = pfd?.medications
              ?.filter((m) => m.is_active !== false)
              .map((m) => `${m.name} ${m.dose || ""} ${m.frequency || ""} [${m.prescriber || ""}]`)
              .join(", ");
            parts.push("Current Medications: " + medList);
          }
          if (assessLabs.length) parts.push("Labs Ordered: " + assessLabs.join(", "));
          const fullText = parts.join(". ");
          setMoTranscript(fullText);
          processMO(fullText);
        }}
        disabled={loading.mo}
        className="assess__gen-btn"
        style={{
          background: loading.mo ? "#94a3b8" : "#7c3aed",
          cursor: loading.mo ? "wait" : "pointer",
        }}
      >
        {loading.mo ? "🔬 Processing..." : "🤖 Generate MO Summary"}
      </button>

      {moData && (
        <div className="assess__mo-result">
          <div className="assess__mo-result-title">✅ MO Summary Generated</div>
          <div className="assess__mo-result-chips">
            {(moData.diagnoses || []).map((d, i) => (
              <span
                key={i}
                className="assess__mo-result-chip"
                style={{
                  background: d.status === "Uncontrolled" ? "#fef2f2" : "#f0fdf4",
                  color: d.status === "Uncontrolled" ? "#dc2626" : "#059669",
                }}
              >
                {d.label}
              </span>
            ))}
          </div>
        </div>
      )}

      <div className="assess__nav">
        <button onClick={navClick("/exam")} className="assess__nav-btn assess__nav-btn--back">
          ← Exam
        </button>
        <button
          onClick={runShadowAI}
          disabled={shadowLoading}
          className="assess__nav-btn assess__nav-btn--shadow"
          style={{
            background: shadowLoading ? "#94a3b8" : "#7c3aed",
            cursor: shadowLoading ? "wait" : "pointer",
          }}
        >
          {shadowLoading ? "🔄 Analyzing..." : "🤖 Shadow AI"}
        </button>
        <button onClick={navClick("/consultant")} className="assess__nav-btn assess__nav-btn--next">
          Consultant →
        </button>
      </div>

      {shadowAI && shadowData && (
        <div className="assess__shadow">
          <div className="assess__shadow-header">
            <span>🤖</span>
            <span className="assess__shadow-title">AI Shadow Analysis</span>
            <span className="assess__shadow-badge assess__shadow-badge--independent">
              Independent
            </span>
            {shadowOriginal && (
              <span className="assess__shadow-badge assess__shadow-badge--edited">Edited</span>
            )}
            <div className="assess__shadow-spacer" />
            <button
              onClick={() => {
                setConSourceMode("merge");
                navigate("/consultant");
              }}
              className="assess__shadow-btn assess__shadow-btn--merge"
            >
              🔀 Edit + Dictate
            </button>
            <button
              onClick={createPlanFromShadow}
              className="assess__shadow-btn assess__shadow-btn--plan"
            >
              🚀 AI Only → Plan
            </button>
            <button onClick={() => setShadowAI(false)} className="assess__shadow-btn--close">
              ✕
            </button>
          </div>
          <div className="assess__shadow-body">
            <div className="assess__shadow-section-title">
              DIAGNOSIS
              <button
                onClick={() =>
                  addShadowItem("diagnoses", { label: "New Diagnosis", status: "New", reason: "" })
                }
                className="assess__shadow-add-btn"
              >
                + Add
              </button>
            </div>
            {(shadowData.diagnoses || []).map((d, i) => (
              <div
                key={i}
                className="assess__shadow-dx-item"
                style={{
                  borderLeft: `3px solid ${d.status === "Controlled" ? "#059669" : d.status === "Uncontrolled" ? "#dc2626" : "#7c3aed"}`,
                }}
              >
                <div className="assess__shadow-dx-info">
                  <b
                    contentEditable
                    suppressContentEditableWarning
                    onBlur={(e) => editShadowItem("diagnoses", i, "label", e.target.innerText)}
                  >
                    {d.label}
                  </b>
                  {" — "}
                  <select
                    value={d.status}
                    onChange={(e) => editShadowItem("diagnoses", i, "status", e.target.value)}
                    className="assess__shadow-dx-status-select"
                    style={{ color: d.status === "Controlled" ? "#059669" : "#dc2626" }}
                  >
                    <option value="Controlled">Controlled</option>
                    <option value="Uncontrolled">Uncontrolled</option>
                    <option value="New">New</option>
                  </select>
                  <span className="assess__shadow-dx-reason"> ({d.reason})</span>
                </div>
                <button
                  onClick={() => removeShadowItem("diagnoses", i)}
                  className="assess__shadow-remove-btn"
                >
                  ✕
                </button>
              </div>
            ))}

            <div className="assess__shadow-section-title assess__shadow-section-title--mt">
              TREATMENT PLAN
            </div>
            {(shadowData.treatment_plan || []).map((t, i) => {
              const key = t.drug || `tx_${i}`;
              const dec = shadowTxDecisions[key];
              return (
                <div
                  key={i}
                  className="assess__shadow-tx-item"
                  style={{
                    background:
                      dec === "disagree"
                        ? "#f1f5f9"
                        : t.action === "ADD"
                          ? "#f0fdf4"
                          : t.action === "STOP"
                            ? "#fef2f2"
                            : t.action === "MODIFY"
                              ? "#fffbeb"
                              : "white",
                    borderLeft: `3px solid ${dec === "disagree" ? "#94a3b8" : t.action === "ADD" ? "#059669" : t.action === "STOP" ? "#dc2626" : t.action === "MODIFY" ? "#f59e0b" : "#e2e8f0"}`,
                    opacity: dec === "disagree" ? 0.5 : 1,
                  }}
                >
                  <div className="assess__shadow-tx-row">
                    <div className="assess__shadow-tx-info">
                      <span
                        style={{
                          fontWeight: 700,
                          color:
                            t.action === "ADD"
                              ? "#059669"
                              : t.action === "STOP"
                                ? "#dc2626"
                                : t.action === "MODIFY"
                                  ? "#f59e0b"
                                  : "#475569",
                        }}
                      >
                        {t.action === "ADD"
                          ? "✅ ADD"
                          : t.action === "STOP"
                            ? "🔻 STOP"
                            : t.action === "MODIFY"
                              ? "⚠️ MODIFY"
                              : "💊 CONTINUE"}
                        :
                      </span>{" "}
                      {t.drug} {t.detail}{" "}
                      <span className="assess__shadow-tx-reason">— {t.reason}</span>
                    </div>
                    <div className="assess__shadow-tx-btns">
                      <button
                        onClick={() => {
                          const current = shadowTxDecisions[key];
                          if (current === "adopt") {
                            setShadowTxDecisions((p) => ({ ...p, [key]: null }));
                          } else {
                            setShadowTxDecisions((p) => ({ ...p, [key]: "adopt" }));
                            if (t.action === "ADD" && t.drug) {
                              addMedToPlan({
                                name: (t.drug || "").toUpperCase(),
                                dose: t.dose || "",
                                frequency: t.frequency || "OD",
                                timing: t.timing || "Morning",
                                isNew: true,
                                route: "Oral",
                                forDiagnosis: t.forDiagnosis || [],
                              });
                            }
                          }
                        }}
                        className="assess__shadow-tx-btn"
                        style={{
                          border: `1px solid ${dec === "adopt" ? "#059669" : "#e2e8f0"}`,
                          background: dec === "adopt" ? "#059669" : "white",
                          color: dec === "adopt" ? "white" : "#059669",
                        }}
                      >
                        {dec === "adopt" ? "✓ Adopted" : "Adopt"}
                      </button>
                      <button
                        onClick={() =>
                          setShadowTxDecisions((p) => ({
                            ...p,
                            [key]: p[key] === "disagree" ? null : "disagree",
                          }))
                        }
                        className="assess__shadow-tx-btn"
                        style={{
                          border: `1px solid ${dec === "disagree" ? "#dc2626" : "#e2e8f0"}`,
                          background: dec === "disagree" ? "#dc2626" : "white",
                          color: dec === "disagree" ? "white" : "#dc2626",
                        }}
                      >
                        {dec === "disagree" ? "✗ Rejected" : "Disagree"}
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}

            {(shadowData.red_flags || []).length > 0 && (
              <div style={{ marginTop: 8 }}>
                <div className="assess__shadow-section-title assess__shadow-section-title--red">
                  🚨 RED FLAGS
                </div>
                {shadowData.red_flags.map((f, i) => (
                  <div key={i} className="assess__shadow-flag">
                    ⚠️ {f}
                  </div>
                ))}
              </div>
            )}

            {(shadowData.investigations || []).length > 0 && (
              <div style={{ marginTop: 8 }}>
                <div className="assess__shadow-section-title assess__shadow-section-title--mt">
                  🔬 SUGGESTED TESTS
                  <button
                    onClick={() => {
                      const t = prompt("Add test:");
                      if (t) addShadowItem("investigations", t);
                    }}
                    className="assess__shadow-add-btn"
                  >
                    + Add
                  </button>
                </div>
                <div className="assess__shadow-test-list">
                  {shadowData.investigations.map((t, i) => (
                    <span key={i} className="assess__shadow-test">
                      {ts(t)}
                      <button
                        onClick={() => removeShadowItem("investigations", i)}
                        className="assess__shadow-test-remove"
                      >
                        ✕
                      </button>
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
