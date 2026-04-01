import "./ConsultantPage.css";
import { useNavigate } from "react-router-dom";
import useAuthStore from "../stores/authStore";
import usePatientStore from "../stores/patientStore";
import useClinicalStore from "../stores/clinicalStore";
import useVitalsStore from "../stores/vitalsStore";
import useLabStore from "../stores/labStore";
import useVisitStore from "../stores/visitStore";
import useExamStore from "../stores/examStore";
import usePlanStore from "../stores/planStore";
import useUiStore from "../stores/uiStore";
import NewReportsBanner from "../components/NewReportsBanner.jsx";
import ClinicalReasoningPanel from "../components/ClinicalReasoningPanel.jsx";
import AudioInput from "../components/AudioInput.jsx";
import Err from "../components/Err.jsx";
import { sa, ts } from "../config/constants.js";

export default function ConsultantPage() {
  const navigate = useNavigate();
  const dgKey = useAuthStore((s) => s.dgKey);
  const whisperKey = useAuthStore((s) => s.whisperKey);
  const conName = useAuthStore((s) => s.conName);
  const setConName = useAuthStore((s) => s.setConName);
  const doctorsList = useAuthStore((s) => s.doctorsList);
  const patient = usePatientStore((s) => s.patient);
  const dbPatientId = usePatientStore((s) => s.dbPatientId);
  const pfd = usePatientStore((s) => s.getPfd());
  const isFollowUp = usePatientStore((s) => s.getIsFollowUp());
  const vitals = useVitalsStore((s) => s.vitals);
  const labData = useLabStore((s) => s.labData);
  const conTranscript = useClinicalStore((s) => s.conTranscript);
  const setConTranscript = useClinicalStore((s) => s.setConTranscript);
  const moBrief = useClinicalStore((s) => s.moBrief);
  const conData = useClinicalStore((s) => s.conData);
  const setConData = useClinicalStore((s) => s.setConData);
  const conPasteMode = useClinicalStore((s) => s.conPasteMode);
  const setConPasteMode = useClinicalStore((s) => s.setConPasteMode);
  const conPasteText = useClinicalStore((s) => s.conPasteText);
  const setConPasteText = useClinicalStore((s) => s.setConPasteText);
  const conSourceMode = useClinicalStore((s) => s.conSourceMode);
  const setConSourceMode = useClinicalStore((s) => s.setConSourceMode);
  const processConsultant = useClinicalStore((s) => s.processConsultant);
  const handleClarification = useClinicalStore((s) => s.handleClarification);
  const copyLastRx = useClinicalStore((s) => s.copyLastRx);
  const processPastedRx = useClinicalStore((s) => s.processPastedRx);
  const visitActive = useVisitStore((s) => s.visitActive);
  const complaints = useVisitStore((s) => s.complaints);
  const shadowAI = useExamStore((s) => s.shadowAI);
  const setShadowAI = useExamStore((s) => s.setShadowAI);
  const shadowData = useExamStore((s) => s.shadowData);
  const shadowTxDecisions = useExamStore((s) => s.shadowTxDecisions);
  const setShadowTxDecisions = useExamStore((s) => s.setShadowTxDecisions);
  const hxConditions = useExamStore((s) => s.hxConditions);
  const hxAllergies = useExamStore((s) => s.hxAllergies);
  const toggleHxCond = useExamStore((s) => s.toggleHxCond);
  const getBiomarkerValues = useExamStore((s) => s.getBiomarkerValues);
  const getExamSummary = useExamStore((s) => s.getExamSummary);
  const examData = useExamStore((s) => s.examData);
  const nextVisitDate = usePlanStore((s) => s.nextVisitDate);
  const setNextVisitDate = usePlanStore((s) => s.setNextVisitDate);
  const addMedToPlan = usePlanStore((s) => s.addMedToPlan);
  const loading = useUiStore((s) => s.loading);
  const errors = useUiStore((s) => s.errors);
  const clearErr = useUiStore((s) => s.clearErr);

  return (
    <div>
      <NewReportsBanner />
      <div className="consultant__name-row">
        <label className="consultant__name-label">Consultant:</label>
        {doctorsList.filter((d) => d.role === "consultant").length > 0 ? (
          <select
            value={conName}
            onChange={(e) => setConName(e.target.value)}
            style={{
              padding: "4px 8px",
              border: "1px solid #e2e8f0",
              borderRadius: 4,
              fontSize: 12,
              fontWeight: 600,
              width: 260,
              background: "white",
            }}
          >
            {doctorsList
              .filter((d) => d.role === "consultant")
              .map((d) => (
                <option key={d.id} value={d.short_name}>
                  {d.name} — {d.specialty}
                </option>
              ))}
            <option value="">— Other —</option>
          </select>
        ) : (
          <input
            value={conName}
            onChange={(e) => setConName(e.target.value)}
            placeholder="Dr. Name"
            style={{
              padding: "4px 8px",
              border: "1px solid #e2e8f0",
              borderRadius: 4,
              fontSize: 12,
              fontWeight: 600,
              width: 160,
            }}
          />
        )}
        <div style={{ flex: 1 }} />
        {dbPatientId && pfd?.consultations?.length > 0 && (
          <button
            onClick={copyLastRx}
            style={{
              background: "#eff6ff",
              border: "1px solid #bfdbfe",
              padding: "4px 10px",
              borderRadius: 6,
              fontSize: 10,
              fontWeight: 700,
              cursor: "pointer",
              color: "#2563eb",
            }}
          >
            📋 Copy Last Rx
          </button>
        )}
        <button
          onClick={() => setConPasteMode(!conPasteMode)}
          style={{
            background: conPasteMode ? "#1e293b" : "#f1f5f9",
            border: "1px solid #e2e8f0",
            padding: "4px 10px",
            borderRadius: 6,
            fontSize: 10,
            fontWeight: 700,
            cursor: "pointer",
            color: conPasteMode ? "white" : "#475569",
          }}
        >
          📝 Paste Rx
        </button>
      </div>

      {moBrief && (
        <div
          style={{
            marginBottom: 8,
            background: "linear-gradient(135deg,#eff6ff,#f0fdf4)",
            border: "1px solid #bfdbfe",
            borderRadius: 8,
            padding: "8px 10px",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
            <span style={{ fontSize: 11, fontWeight: 800, color: "#1e40af" }}>
              📋 {moBrief.isFollowUp ? "FOLLOW-UP" : "NEW"} BRIEF
            </span>
            {moBrief.isFollowUp && (
              <span style={{ fontSize: 9, color: "#64748b", fontWeight: 600 }}>
                {moBrief.totalVisits} visits • {moBrief.daysSince}d ago
              </span>
            )}
            <div style={{ flex: 1 }} />
            <button
              onClick={() => navigator.clipboard.writeText(moBrief.briefText)}
              style={{
                fontSize: 9,
                background: "white",
                border: "1px solid #bfdbfe",
                padding: "2px 6px",
                borderRadius: 4,
                cursor: "pointer",
                color: "#2563eb",
                fontWeight: 600,
              }}
            >
              Copy
            </button>
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 3, marginBottom: 4 }}>
            {moBrief.diagnoses.slice(0, 6).map((d, i) => (
              <span
                key={i}
                style={{
                  fontSize: 9,
                  padding: "1px 5px",
                  borderRadius: 4,
                  fontWeight: 600,
                  background: d.status === "Uncontrolled" ? "#fef2f2" : "#f0fdf4",
                  color: d.status === "Uncontrolled" ? "#dc2626" : "#059669",
                }}
              >
                {d.label}
              </span>
            ))}
          </div>
          {moBrief.worsening.length > 0 && (
            <div style={{ fontSize: 9, color: "#dc2626", fontWeight: 600 }}>
              ⚠️ Worsening:{" "}
              {moBrief.worsening.map((l) => `${l.name} ${l.previous}→${l.latest}`).join(", ")}
            </div>
          )}
          {moBrief.improving.length > 0 && (
            <div style={{ fontSize: 9, color: "#059669", fontWeight: 600 }}>
              📈 Improving:{" "}
              {moBrief.improving.map((l) => `${l.name} ${l.previous}→${l.latest}`).join(", ")}
            </div>
          )}
          <div style={{ fontSize: 9, color: "#64748b", marginTop: 2 }}>
            💊 {moBrief.medications.length} meds
            {moBrief.newLabs.length > 0 ? ` • 🔬 ${moBrief.newLabs.length} new labs` : ""}
          </div>
        </div>
      )}

      {visitActive &&
        (complaints.length > 0 || hxConditions.length > 0 || Object.keys(examData).length > 0) && (
          <div
            style={{
              marginBottom: 8,
              background: "linear-gradient(135deg,#f0f9ff,#faf5ff)",
              border: "2px solid #c7d2fe",
              borderRadius: 10,
              padding: 10,
            }}
          >
            <div style={{ fontSize: 11, fontWeight: 800, color: "#6d28d9", marginBottom: 6 }}>
              📋 PATIENT BRIEF — Current Visit
            </div>
            <div
              style={{
                fontSize: 11,
                color: "#374151",
                lineHeight: 1.6,
                padding: "6px 10px",
                background: "white",
                borderRadius: 6,
                border: "1px solid #e9d5ff",
                marginBottom: 6,
              }}
            >
              <b>
                {patient.name} | {patient.age}Y/{(patient.sex || "?").charAt(0)} |{" "}
                {hxConditions.join(" + ") || "No dx yet"}
              </b>
              {vitals.bp_sys && (
                <span>
                  {" "}
                  | BP {vitals.bp_sys}/{vitals.bp_dia}
                </span>
              )}
              {vitals.weight && <span> | Wt {vitals.weight}kg</span>}
              {vitals.bmi && <span> | BMI {vitals.bmi}</span>}
            </div>
            {complaints.length > 0 && (
              <div style={{ marginBottom: 4 }}>
                <span style={{ fontSize: 9, fontWeight: 700, color: "#dc2626" }}>CC: </span>
                <span style={{ fontSize: 10 }}>{complaints.join(", ")}</span>
              </div>
            )}
            {hxConditions.length > 0 && (
              <div style={{ marginBottom: 4 }}>
                <span style={{ fontSize: 9, fontWeight: 700, color: "#6d28d9" }}>DX: </span>
                {hxConditions.map((c, i) => {
                  const bms = getBiomarkerValues(c).filter((b) => b.found);
                  return (
                    <span key={i} style={{ fontSize: 10 }}>
                      <b>{c}</b>
                      {bms.length > 0 && ` (${bms.map((b) => `${b.name}:${b.value}`).join(", ")})`}
                      {i < hxConditions.length - 1 ? ", " : ""}
                    </span>
                  );
                })}
              </div>
            )}
            {hxAllergies.length > 0 && hxAllergies[0] !== "None known" && (
              <div style={{ marginBottom: 4 }}>
                <span style={{ fontSize: 9, fontWeight: 700, color: "#dc2626" }}>
                  ⚠️ ALLERGIES:{" "}
                </span>
                <span style={{ fontSize: 10, color: "#dc2626" }}>{hxAllergies.join(", ")}</span>
              </div>
            )}
            {getExamSummary() && (
              <div style={{ marginBottom: 4 }}>
                <span style={{ fontSize: 9, fontWeight: 700, color: "#1e40af" }}>EXAM: </span>
                <span style={{ fontSize: 10 }}>{getExamSummary()}</span>
              </div>
            )}
            {labData?.panels &&
              (() => {
                const abnormal = labData.panels
                  .flatMap((p) => p.tests)
                  .filter((t) => t.flag === "H" || t.flag === "L");
                return abnormal.length > 0 ? (
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 3, marginTop: 4 }}>
                    {abnormal.slice(0, 10).map((t, i) => (
                      <span
                        key={i}
                        style={{
                          fontSize: 9,
                          padding: "2px 5px",
                          borderRadius: 3,
                          fontWeight: 600,
                          background: t.flag === "H" ? "#fef2f2" : "#eff6ff",
                          color: t.flag === "H" ? "#dc2626" : "#2563eb",
                        }}
                      >
                        {t.test_name}: {t.result}
                        {t.unit ? " " + t.unit : ""} {t.flag === "H" ? "↑" : "↓"}
                      </span>
                    ))}
                  </div>
                ) : null;
              })()}
          </div>
        )}

      {shadowData && (
        <div
          style={{
            marginBottom: 8,
            background: "linear-gradient(135deg,#faf5ff,#f0f9ff)",
            borderRadius: 10,
            border: "2px solid #c4b5fd",
            overflow: "hidden",
          }}
        >
          <div
            style={{
              padding: "6px 12px",
              background: "#7c3aed10",
              display: "flex",
              alignItems: "center",
              gap: 6,
              borderBottom: "1px solid #e9d5ff",
            }}
          >
            <span>🤖</span>
            <span style={{ fontSize: 11, fontWeight: 800, color: "#7c3aed" }}>
              AI Shadow Analysis
            </span>
            <span
              style={{
                fontSize: 8,
                background: "#e9d5ff",
                color: "#6d28d9",
                padding: "2px 6px",
                borderRadius: 4,
                fontWeight: 700,
              }}
            >
              For Review
            </span>
            <div style={{ flex: 1 }} />
            <button
              onClick={() => setShadowAI(!shadowAI)}
              style={{
                fontSize: 9,
                background: "none",
                border: "1px solid #c4b5fd",
                borderRadius: 4,
                padding: "2px 8px",
                cursor: "pointer",
                color: "#7c3aed",
                fontWeight: 600,
              }}
            >
              {shadowAI ? "▲ Collapse" : "▼ Expand"}
            </button>
          </div>
          {shadowAI && (
            <div style={{ padding: 10, fontSize: 10, lineHeight: 1.6 }}>
              <div style={{ fontWeight: 700, color: "#6d28d9", marginBottom: 3 }}>DIAGNOSES</div>
              {(shadowData.diagnoses || []).map((d, i) => (
                <div
                  key={i}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 4,
                    padding: "3px 6px",
                    background: "white",
                    borderRadius: 4,
                    marginBottom: 2,
                    borderLeft: "3px solid #7c3aed",
                  }}
                >
                  <span style={{ flex: 1 }}>
                    <b>{d.label}</b> — {d.status}{" "}
                    <span style={{ color: "#94a3b8" }}>({d.reason})</span>
                  </span>
                  <button
                    onClick={() => {
                      if (!hxConditions.includes(d.label)) toggleHxCond(d.label);
                    }}
                    style={{
                      fontSize: 8,
                      padding: "2px 6px",
                      borderRadius: 3,
                      border: "1px solid #059669",
                      background: hxConditions.includes(d.label) ? "#059669" : "white",
                      color: hxConditions.includes(d.label) ? "white" : "#059669",
                      cursor: "pointer",
                      fontWeight: 700,
                    }}
                  >
                    {hxConditions.includes(d.label) ? "✓" : "Adopt"}
                  </button>
                </div>
              ))}
              <div style={{ fontWeight: 700, color: "#6d28d9", marginTop: 6, marginBottom: 3 }}>
                TREATMENT PLAN
              </div>
              {(shadowData.treatment_plan || []).map((t, i) => {
                const key = t.drug || `tx_${i}`;
                const dec = shadowTxDecisions[key];
                return (
                  <div
                    key={i}
                    style={{
                      padding: "4px 6px",
                      borderRadius: 4,
                      marginBottom: 3,
                      fontSize: 10,
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
                    <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                      <div style={{ flex: 1 }}>
                        <b>{t.action}</b>: {t.drug} {t.detail}{" "}
                        <span style={{ color: "#94a3b8" }}>— {t.reason}</span>
                      </div>
                      <div style={{ display: "flex", gap: 2, flexShrink: 0 }}>
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
                          style={{
                            fontSize: 8,
                            padding: "2px 6px",
                            borderRadius: 3,
                            border: `1px solid ${dec === "adopt" ? "#059669" : "#e2e8f0"}`,
                            background: dec === "adopt" ? "#059669" : "white",
                            color: dec === "adopt" ? "white" : "#059669",
                            cursor: "pointer",
                            fontWeight: 700,
                          }}
                        >
                          {dec === "adopt" ? "✓" : "Adopt"}
                        </button>
                        <button
                          onClick={() =>
                            setShadowTxDecisions((p) => ({
                              ...p,
                              [key]: p[key] === "disagree" ? null : "disagree",
                            }))
                          }
                          style={{
                            fontSize: 8,
                            padding: "2px 6px",
                            borderRadius: 3,
                            border: `1px solid ${dec === "disagree" ? "#dc2626" : "#e2e8f0"}`,
                            background: dec === "disagree" ? "#dc2626" : "white",
                            color: dec === "disagree" ? "white" : "#dc2626",
                            cursor: "pointer",
                            fontWeight: 700,
                          }}
                        >
                          {dec === "disagree" ? "✗" : "Disagree"}
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
              {(shadowData.red_flags || []).length > 0 && (
                <div style={{ marginTop: 6 }}>
                  <div style={{ fontWeight: 700, color: "#dc2626", marginBottom: 2 }}>
                    🚨 RED FLAGS
                  </div>
                  {shadowData.red_flags.map((f, i) => (
                    <div
                      key={i}
                      style={{
                        fontSize: 10,
                        color: "#dc2626",
                        padding: "2px 6px",
                        background: "#fef2f2",
                        borderRadius: 3,
                        marginBottom: 1,
                      }}
                    >
                      ⚠️ {f}
                    </div>
                  ))}
                </div>
              )}
              {(shadowData.investigations || []).length > 0 && (
                <div style={{ marginTop: 6 }}>
                  <div style={{ fontWeight: 700, color: "#6d28d9", marginBottom: 2 }}>
                    🔬 SUGGESTED TESTS
                  </div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 3 }}>
                    {shadowData.investigations.map((t, i) => (
                      <span
                        key={i}
                        style={{
                          fontSize: 9,
                          padding: "2px 6px",
                          borderRadius: 4,
                          background: "#eff6ff",
                          color: "#2563eb",
                          fontWeight: 600,
                        }}
                      >
                        {ts(t)}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {shadowData && (
        <div
          style={{
            marginBottom: 8,
            borderRadius: 8,
            overflow: "hidden",
            border: "2px solid #c4b5fd",
          }}
        >
          <div style={{ display: "flex", gap: 0 }}>
            {[
              {
                id: "merge",
                icon: "🔀",
                label: "AI + Your Notes",
                desc: "Start from AI, dictate changes",
              },
              {
                id: "own",
                icon: "🎙️",
                label: "Own Notes Only",
                desc: "Ignore AI, fresh dictation",
              },
            ].map((m) => (
              <button
                key={m.id}
                onClick={() => setConSourceMode(m.id)}
                style={{
                  flex: 1,
                  padding: "8px 6px",
                  border: "none",
                  cursor: "pointer",
                  transition: "all .15s",
                  background:
                    conSourceMode === m.id
                      ? m.id === "merge"
                        ? "linear-gradient(135deg,#7c3aed,#6d28d9)"
                        : "linear-gradient(135deg,#7c2d12,#9a3412)"
                      : "#f8fafc",
                  color: conSourceMode === m.id ? "white" : "#64748b",
                }}
              >
                <div style={{ fontSize: 13 }}>{m.icon}</div>
                <div style={{ fontSize: 10, fontWeight: 800 }}>{m.label}</div>
                <div style={{ fontSize: 8, opacity: 0.8 }}>{m.desc}</div>
              </button>
            ))}
          </div>
          {conSourceMode === "merge" && (
            <div
              style={{
                padding: "8px 10px",
                background: "#faf5ff",
                borderTop: "1px solid #e9d5ff",
                fontSize: 10,
              }}
            >
              <div style={{ fontWeight: 700, color: "#6d28d9", marginBottom: 4 }}>
                ✅ AI Baseline (adopted items):
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 3, marginBottom: 4 }}>
                {(shadowData.diagnoses || []).map((d, i) => (
                  <span
                    key={i}
                    style={{
                      padding: "1px 6px",
                      borderRadius: 4,
                      fontSize: 9,
                      fontWeight: 600,
                      background: d.status === "Uncontrolled" ? "#fef2f2" : "#f0fdf4",
                      color: d.status === "Uncontrolled" ? "#dc2626" : "#059669",
                    }}
                  >
                    {d.label} ({d.status})
                  </span>
                ))}
              </div>
              {(shadowData.treatment_plan || []).map((t, i) => {
                const key = t.drug || `tx_${i}`;
                const rejected = shadowTxDecisions[key] === "disagree";
                return (
                  <div
                    key={i}
                    style={{
                      padding: "2px 6px",
                      marginBottom: 1,
                      borderRadius: 3,
                      fontSize: 9,
                      background: rejected ? "#fef2f2" : "white",
                      textDecoration: rejected ? "line-through" : "none",
                      color: rejected ? "#94a3b8" : "#374151",
                      borderLeft: `3px solid ${rejected ? "#fca5a5" : t.action === "ADD" ? "#059669" : t.action === "STOP" ? "#dc2626" : "#f59e0b"}`,
                    }}
                  >
                    <b>{t.action}</b>: {t.drug} {t.dose || ""} {t.frequency || ""} {t.timing || ""}
                    {rejected && (
                      <span style={{ color: "#dc2626", fontWeight: 700 }}> ✕ Rejected</span>
                    )}
                  </div>
                );
              })}
              <div style={{ marginTop: 4, fontSize: 9, color: "#7c3aed", fontStyle: "italic" }}>
                💡 Now dictate your additions or changes — AI will merge both
              </div>
            </div>
          )}
        </div>
      )}

      <div
        style={{
          display: "flex",
          gap: 6,
          alignItems: "center",
          marginBottom: 8,
          padding: 6,
          background: "#eff6ff",
          borderRadius: 6,
          border: "1px solid #bfdbfe",
        }}
      >
        <span style={{ fontSize: 10, fontWeight: 700, color: "#1e40af" }}>📅 Next Visit:</span>
        <input
          type="date"
          value={nextVisitDate}
          onChange={(e) => setNextVisitDate(e.target.value)}
          style={{
            padding: "4px 8px",
            border: "1px solid #bfdbfe",
            borderRadius: 4,
            fontSize: 11,
            fontWeight: 600,
          }}
        />
        {nextVisitDate && (
          <span style={{ fontSize: 10, color: "#059669", fontWeight: 600 }}>
            {new Date(nextVisitDate).toLocaleDateString("en-IN", {
              weekday: "short",
              day: "2-digit",
              month: "short",
              year: "numeric",
            })}
          </span>
        )}
      </div>

      {conPasteMode && (
        <div
          style={{
            marginBottom: 8,
            background: "#faf5ff",
            border: "1px solid #d8b4fe",
            borderRadius: 8,
            padding: 10,
          }}
        >
          <div style={{ fontSize: 11, fontWeight: 700, color: "#6b21a8", marginBottom: 4 }}>
            📝 Paste prescription or notes — AI will structure it
          </div>
          <textarea
            value={conPasteText}
            onChange={(e) => setConPasteText(e.target.value)}
            placeholder="Paste old prescription, handwritten notes, or type freely...&#10;&#10;Example:&#10;Tab Glycomet GP2 - morning before food&#10;Tab Telmisartan 40 - morning&#10;Tab Ecosprin 75 - after lunch&#10;Continue insulin Lantus 20U at night&#10;HbA1c target < 7%&#10;Follow up in 3 months with HbA1c, lipids"
            rows={6}
            style={{
              width: "100%",
              border: "1px solid #d8b4fe",
              borderRadius: 6,
              padding: 10,
              fontSize: 12,
              resize: "vertical",
              boxSizing: "border-box",
              lineHeight: 1.6,
              fontFamily: "inherit",
            }}
            autoFocus
          />
          <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
            <button
              onClick={processPastedRx}
              disabled={!conPasteText.trim()}
              style={{
                flex: 1,
                background: conPasteText.trim() ? "#7c2d12" : "#94a3b8",
                color: "white",
                border: "none",
                padding: "8px",
                borderRadius: 6,
                fontSize: 12,
                fontWeight: 700,
                cursor: conPasteText.trim() ? "pointer" : "not-allowed",
              }}
            >
              🔬 Process with AI
            </button>
            <button
              onClick={() => {
                setConPasteMode(false);
                setConPasteText("");
              }}
              style={{
                background: "#f1f5f9",
                border: "1px solid #e2e8f0",
                padding: "8px 14px",
                borderRadius: 6,
                fontSize: 12,
                cursor: "pointer",
                color: "#64748b",
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      <AudioInput
        label={
          shadowData && conSourceMode === "merge"
            ? "Dictate changes to AI plan (or say 'agree with everything')"
            : "Consultant — Treatment Decisions"
        }
        dgKey={dgKey}
        whisperKey={whisperKey}
        color="#7c2d12"
        onTranscript={(t) => {
          setConTranscript(t);
          setConData(null);
          clearErr("con");
        }}
      />
      {conTranscript && (
        <button
          onClick={processConsultant}
          disabled={loading.con}
          style={{
            marginTop: 6,
            width: "100%",
            background: loading.con
              ? "#6b7280"
              : conData
                ? "#059669"
                : shadowData && conSourceMode === "merge"
                  ? "#7c3aed"
                  : "#7c2d12",
            color: "white",
            border: "none",
            padding: "10px",
            borderRadius: 8,
            fontSize: 13,
            fontWeight: 700,
            cursor: loading.con ? "wait" : "pointer",
          }}
        >
          {loading.con
            ? "🔬 Merging AI + Notes..."
            : shadowData && conSourceMode === "merge"
              ? conData
                ? "✅ Done — Re-merge"
                : "🔀 Merge AI Analysis + Your Notes"
              : conData
                ? "✅ Done — Re-process"
                : "🔬 Extract Treatment Plan"}
        </button>
      )}
      <Err msg={errors.con} onDismiss={() => clearErr("con")} />
      {conData && (
        <div style={{ marginTop: 8, display: "flex", gap: 8 }}>
          <div
            style={{ flex: 1, border: "1px solid #fed7aa", borderRadius: 6, overflow: "hidden" }}
          >
            <div
              style={{
                background: "#7c2d12",
                color: "white",
                padding: "6px 8px",
                fontSize: 12,
                fontWeight: 700,
              }}
            >
              Assessment
            </div>
            <div style={{ padding: 8, fontSize: 12, lineHeight: 1.5 }}>
              <div style={{ fontWeight: 600, marginBottom: 3 }}>{conData.assessment_summary}</div>
              {sa(conData, "key_issues").map((x, i) => (
                <div key={i}>• {x}</div>
              ))}
              {sa(conData, "goals").length > 0 && (
                <table
                  style={{
                    width: "100%",
                    borderCollapse: "collapse",
                    fontSize: 10,
                    marginTop: 6,
                    border: "1px solid #bbf7d0",
                  }}
                >
                  <thead>
                    <tr style={{ background: "#059669", color: "white" }}>
                      <th style={{ padding: "3px 5px" }}>Marker</th>
                      <th style={{ padding: "3px 5px" }}>Now</th>
                      <th style={{ padding: "3px 5px" }}>Target</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sa(conData, "goals").map((g, i) => (
                      <tr key={i}>
                        <td style={{ padding: "2px 5px" }}>{g.marker}</td>
                        <td style={{ padding: "2px 5px", color: "#dc2626", fontWeight: 700 }}>
                          {g.current}
                        </td>
                        <td style={{ padding: "2px 5px", color: "#059669", fontWeight: 700 }}>
                          {g.target}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
          <div
            style={{ flex: 1, border: "1px solid #e2e8f0", borderRadius: 6, overflow: "hidden" }}
          >
            <div
              style={{
                background: "#1e293b",
                color: "white",
                padding: "6px 8px",
                fontSize: 12,
                fontWeight: 700,
                display: "flex",
                justifyContent: "space-between",
              }}
            >
              <span>Medications</span>
              <button
                onClick={() => navigate("/plan")}
                style={{
                  background: "rgba(255,255,255,0.2)",
                  border: "none",
                  color: "white",
                  padding: "1px 6px",
                  borderRadius: 3,
                  fontSize: 10,
                  cursor: "pointer",
                }}
              >
                Plan →
              </button>
            </div>
            <div style={{ padding: 8, fontSize: 11, maxHeight: 280, overflow: "auto" }}>
              {sa(conData, "medications_confirmed").map((m, i) => (
                <div
                  key={i}
                  style={{
                    background: "#f0fdf4",
                    border: "1px solid #bbf7d0",
                    borderRadius: 4,
                    padding: "4px 8px",
                    marginBottom: 3,
                  }}
                >
                  <div>
                    ✅ <strong>{m.name}</strong>
                  </div>
                  <div style={{ fontSize: 10, color: "#475569" }}>
                    {m.dose} • {m.frequency} • <strong>{m.timing}</strong>
                  </div>
                </div>
              ))}
              {sa(conData, "medications_needs_clarification").map((m, i) => (
                <div
                  key={i}
                  style={{
                    background: "#fffbeb",
                    border: "1px solid #fde68a",
                    borderRadius: 4,
                    padding: 6,
                    marginBottom: 3,
                    marginTop: i === 0 ? 4 : 0,
                  }}
                >
                  <div style={{ fontSize: 10, color: "#92400e", marginBottom: 3 }}>
                    ⚠️ "{m.what_consultant_said}" ({m.drug_class})
                  </div>
                  {m.default_dose && (
                    <div style={{ fontSize: 9, color: "#64748b", marginBottom: 2 }}>
                      Suggested: {m.default_dose}, {m.default_timing}
                    </div>
                  )}
                  <div style={{ display: "flex", gap: 3, flexWrap: "wrap" }}>
                    <input
                      placeholder="Brand name"
                      onChange={(e) => handleClarification(i, "resolved_name", e.target.value)}
                      style={{
                        flex: 2,
                        minWidth: 70,
                        padding: "3px 5px",
                        border: "1px solid #fde68a",
                        borderRadius: 3,
                        fontSize: 10,
                      }}
                    />
                    <input
                      placeholder={m.default_dose || "Dose"}
                      onChange={(e) => handleClarification(i, "resolved_dose", e.target.value)}
                      style={{
                        flex: 1,
                        minWidth: 40,
                        padding: "3px 5px",
                        border: "1px solid #fde68a",
                        borderRadius: 3,
                        fontSize: 10,
                      }}
                    />
                    <input
                      placeholder={m.default_timing || "Timing"}
                      onChange={(e) => handleClarification(i, "resolved_timing", e.target.value)}
                      style={{
                        flex: 1,
                        minWidth: 50,
                        padding: "3px 5px",
                        border: "1px solid #fde68a",
                        borderRadius: 3,
                        fontSize: 10,
                      }}
                    />
                  </div>
                  {m.suggested_options?.length > 0 && (
                    <div style={{ fontSize: 9, color: "#94a3b8", marginTop: 2 }}>
                      Options: {m.suggested_options.join(" • ")}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
      <ClinicalReasoningPanel />
    </div>
  );
}
