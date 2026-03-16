import "./PlanPage.css";
import { useNavigate } from "react-router-dom";
import useAuthStore from "../stores/authStore";
import usePatientStore from "../stores/patientStore";
import useClinicalStore from "../stores/clinicalStore";
import useVitalsStore from "../stores/vitalsStore";
import useVisitStore from "../stores/visitStore";
import useExamStore from "../stores/examStore";
import usePlanStore from "../stores/planStore";
import useUiStore from "../stores/uiStore";
import useRxReviewStore from "../stores/rxReviewStore";
import useHistoryStore from "../stores/historyStore";
import NewReportsBanner from "../components/NewReportsBanner.jsx";
import ClinicalReasoningPanel from "../components/ClinicalReasoningPanel.jsx";
import { DC, FRIENDLY, sa, ts } from "../config/constants.js";
import { RECON_REASONS, DISAGREEMENT_TAGS } from "../config/reconciliation.js";
import Badge from "../components/Badge.jsx";
import PlanBlock from "../components/PlanSection.jsx";
import EditText from "../components/EditText.jsx";
import RemoveBtn from "../components/RemoveBtn.jsx";

export default function PlanPage() {
  const navigate = useNavigate();
  const moName = useAuthStore((s) => s.moName);
  const conName = useAuthStore((s) => s.conName);
  const patient = usePatientStore((s) => s.patient);
  const pfd = usePatientStore((s) => s.getPfd());
  const vitals = useVitalsStore((s) => s.vitals);
  const conTranscript = useClinicalStore((s) => s.conTranscript);
  const moData = useClinicalStore((s) => s.moData);
  const setMoData = useClinicalStore((s) => s.setMoData);
  const conData = useClinicalStore((s) => s.conData);
  const setConData = useClinicalStore((s) => s.setConData);
  const processConsultant = useClinicalStore((s) => s.processConsultant);
  const copyPlanToClipboard = useClinicalStore((s) => s.copyPlanToClipboard);
  const planCopied = useClinicalStore((s) => s.planCopied);
  const visitActive = useVisitStore((s) => s.visitActive);
  const complaints = useVisitStore((s) => s.complaints);
  const shadowData = useExamStore((s) => s.shadowData);
  const shadowOriginal = useExamStore((s) => s.shadowOriginal);
  const showShadowDiff = useExamStore((s) => s.showShadowDiff);
  const setShowShadowDiff = useExamStore((s) => s.setShowShadowDiff);
  const planHidden = usePlanStore((s) => s.planHidden);
  const medRecon = usePlanStore((s) => s.medRecon);
  const setMedRecon = usePlanStore((s) => s.setMedRecon);
  const medReconReasons = usePlanStore((s) => s.medReconReasons);
  const setMedReconReasons = usePlanStore((s) => s.setMedReconReasons);
  const showMedCard = usePlanStore((s) => s.showMedCard);
  const setShowMedCard = usePlanStore((s) => s.setShowMedCard);
  const nextVisitDate = usePlanStore((s) => s.nextVisitDate);
  const setNextVisitDate = usePlanStore((s) => s.setNextVisitDate);
  const planAddMode = usePlanStore((s) => s.planAddMode);
  const setPlanAddMode = usePlanStore((s) => s.setPlanAddMode);
  const planAddText = usePlanStore((s) => s.planAddText);
  const setPlanAddText = usePlanStore((s) => s.setPlanAddText);
  const planAddMed = usePlanStore((s) => s.planAddMed);
  const setPlanAddMed = usePlanStore((s) => s.setPlanAddMed);
  const toggleBlock = usePlanStore((s) => s.toggleBlock);
  const editPlan = usePlanStore((s) => s.editPlan);
  const getPlan = usePlanStore((s) => s.getPlan);
  const resetPlanEdits = usePlanStore((s) => s.resetPlanEdits);
  const editMedField = usePlanStore((s) => s.editMedField);
  const editLifestyleField = usePlanStore((s) => s.editLifestyleField);
  const addMedToPlan = usePlanStore((s) => s.addMedToPlan);
  const addLifestyleToPlan = usePlanStore((s) => s.addLifestyleToPlan);
  const addGoalToPlan = usePlanStore((s) => s.addGoalToPlan);
  const addComplaintToPlan = usePlanStore((s) => s.addComplaintToPlan);
  const removeMed = usePlanStore((s) => s.removeMed);
  const removeLifestyle = usePlanStore((s) => s.removeLifestyle);
  const removeFuture = usePlanStore((s) => s.removeFuture);
  const removeGoal = usePlanStore((s) => s.removeGoal);
  const removeMonitor = usePlanStore((s) => s.removeMonitor);
  const removeDiag = usePlanStore((s) => s.removeDiag);
  const handlePrintPlan = usePlanStore((s) => s.handlePrintPlan);
  const buildMedicineSchedule = usePlanStore((s) => s.buildMedicineSchedule);
  const planDiags = usePlanStore((s) => s.planDiags);
  const planMeds = usePlanStore((s) => s.planMeds);
  const planGoals = usePlanStore((s) => s.planGoals);
  const planLifestyle = usePlanStore((s) => s.planLifestyle);
  const planMonitors = usePlanStore((s) => s.planMonitors);
  const planFuture = usePlanStore((s) => s.planFuture);
  const allMeds = usePlanStore((s) => s.allMeds);
  const externalMeds = usePlanStore((s) => s.externalMeds);
  const externalMedsByDoctor = usePlanStore((s) => s.externalMedsByDoctor);
  const loading = useUiStore((s) => s.loading);
  const rxReview = useRxReviewStore((s) => s.rxReview);
  const setRxReview = useRxReviewStore((s) => s.setRxReview);
  const rxReviewLoading = useRxReviewStore((s) => s.rxReviewLoading);
  const rxFbAgreement = useRxReviewStore((s) => s.rxFbAgreement);
  const setRxFbAgreement = useRxReviewStore((s) => s.setRxFbAgreement);
  const rxFbText = useRxReviewStore((s) => s.rxFbText);
  const setRxFbText = useRxReviewStore((s) => s.setRxFbText);
  const rxFbCorrect = useRxReviewStore((s) => s.rxFbCorrect);
  const setRxFbCorrect = useRxReviewStore((s) => s.setRxFbCorrect);
  const rxFbReason = useRxReviewStore((s) => s.rxFbReason);
  const setRxFbReason = useRxReviewStore((s) => s.setRxFbReason);
  const rxFbTags = useRxReviewStore((s) => s.rxFbTags);
  const setRxFbTags = useRxReviewStore((s) => s.setRxFbTags);
  const rxFbSeverity = useRxReviewStore((s) => s.rxFbSeverity);
  const setRxFbSeverity = useRxReviewStore((s) => s.setRxFbSeverity);
  const rxFbSaving = useRxReviewStore((s) => s.rxFbSaving);
  const rxFbSaved = useRxReviewStore((s) => s.rxFbSaved);
  const runRxReview = useRxReviewStore((s) => s.runRxReview);
  const saveRxFeedback = useRxReviewStore((s) => s.saveRxFeedback);
  const reports = useHistoryStore((s) => s.reports);

  return (
    <div data-plan-area>
      <NewReportsBanner />
      {/* Shadow AI Origin Banner */}
      {conData?._fromShadow && shadowOriginal && (
        <div
          className="no-print"
          style={{
            marginBottom: 8,
            padding: "8px 12px",
            background: "linear-gradient(135deg,#faf5ff,#f0f9ff)",
            border: "2px solid #c4b5fd",
            borderRadius: 8,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span>🤖</span>
            <span style={{ fontSize: 11, fontWeight: 800, color: "#7c3aed" }}>
              Plan from AI Shadow Analysis
            </span>
            <button
              onClick={() => setShowShadowDiff((p) => !p)}
              style={{
                fontSize: 9,
                padding: "2px 8px",
                background: "#e9d5ff",
                color: "#6d28d9",
                border: "none",
                borderRadius: 4,
                cursor: "pointer",
                fontWeight: 700,
              }}
            >
              {showShadowDiff ? "Hide Diff" : "View Original"}
            </button>
          </div>
          {showShadowDiff && (
            <div
              style={{
                marginTop: 6,
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                gap: 8,
                fontSize: 9,
              }}
            >
              <div>
                <div style={{ fontWeight: 800, color: "#94a3b8", marginBottom: 3 }}>
                  ORIGINAL AI
                </div>
                {(shadowOriginal.diagnoses || []).map((d, i) => (
                  <div
                    key={i}
                    style={{
                      padding: "2px 6px",
                      background: "#f1f5f9",
                      borderRadius: 3,
                      marginBottom: 1,
                    }}
                  >
                    {d.label}: {d.status}
                  </div>
                ))}
                <div style={{ marginTop: 3, fontWeight: 700 }}>Meds:</div>
                {(shadowOriginal.treatment_plan || []).map((t, i) => (
                  <div
                    key={i}
                    style={{
                      padding: "2px 6px",
                      background: "#f1f5f9",
                      borderRadius: 3,
                      marginBottom: 1,
                    }}
                  >
                    {t.action}: {t.drug}
                  </div>
                ))}
              </div>
              <div>
                <div style={{ fontWeight: 800, color: "#7c3aed", marginBottom: 3 }}>CURRENT</div>
                {(shadowData?.diagnoses || []).map((d, i) => {
                  const orig = shadowOriginal.diagnoses?.[i];
                  const changed = !orig || orig.label !== d.label || orig.status !== d.status;
                  return (
                    <div
                      key={i}
                      style={{
                        padding: "2px 6px",
                        background: changed ? "#fef3c7" : "#f0fdf4",
                        borderRadius: 3,
                        marginBottom: 1,
                      }}
                    >
                      {d.label}: {d.status} {changed ? "✏️" : ""}
                    </div>
                  );
                })}
                <div style={{ marginTop: 3, fontWeight: 700 }}>Meds:</div>
                {(conData?.medications_confirmed || []).map((m, i) => (
                  <div
                    key={i}
                    style={{
                      padding: "2px 6px",
                      background: "#f0fdf4",
                      borderRadius: 3,
                      marginBottom: 1,
                    }}
                  >
                    {m._shadowAction || "KEEP"}: {m.name}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
      <div
        style={{ display: "flex", gap: 4, marginBottom: 8, flexWrap: "wrap", alignItems: "center" }}
      >
        <button
          onClick={() => navigate(visitActive ? "/intake" : "/docs")}
          style={{
            background: "#f1f5f9",
            border: "1px solid #e2e8f0",
            padding: "4px 8px",
            borderRadius: 4,
            fontSize: 10,
            cursor: "pointer",
            fontWeight: 600,
          }}
        >
          + Reports
        </button>
        <button
          onClick={() => navigate("/mo")}
          style={{
            background: "#f1f5f9",
            border: "1px solid #e2e8f0",
            padding: "4px 8px",
            borderRadius: 4,
            fontSize: 10,
            cursor: "pointer",
            fontWeight: 600,
          }}
        >
          ✏️ MO
        </button>
        <button
          onClick={() => navigate("/consultant")}
          style={{
            background: "#f1f5f9",
            border: "1px solid #e2e8f0",
            padding: "4px 8px",
            borderRadius: 4,
            fontSize: 10,
            cursor: "pointer",
            fontWeight: 600,
          }}
        >
          ✏️ Consultant
        </button>
        <button
          className="no-print"
          onClick={resetPlanEdits}
          style={{
            background: "#fef3c7",
            border: "1px solid #fcd34d",
            padding: "4px 8px",
            borderRadius: 4,
            fontSize: 10,
            cursor: "pointer",
            fontWeight: 600,
            color: "#92400e",
          }}
        >
          ↩ Reset
        </button>
        {conTranscript && (
          <button
            className="no-print"
            onClick={processConsultant}
            disabled={loading.con}
            style={{
              background: loading.con ? "#94a3b8" : "#7c2d12",
              color: "white",
              border: "none",
              padding: "4px 10px",
              borderRadius: 4,
              fontSize: 10,
              fontWeight: 700,
              cursor: loading.con ? "wait" : "pointer",
            }}
          >
            {loading.con ? "⏳ Regenerating..." : "🔄 Regenerate"}
          </button>
        )}
        <button
          className="no-print"
          onClick={runRxReview}
          disabled={rxReviewLoading}
          style={{
            background: rxReview ? "#7c3aed" : "linear-gradient(135deg,#7c3aed,#2563eb)",
            color: "white",
            border: "none",
            padding: "4px 12px",
            borderRadius: 4,
            fontSize: 10,
            fontWeight: 700,
            cursor: rxReviewLoading ? "wait" : "pointer",
            opacity: rxReviewLoading ? 0.7 : 1,
          }}
        >
          {rxReviewLoading ? "⏳ Reviewing..." : "🤖 Review Rx"}
        </button>
        <div style={{ flex: 1 }} />
        <button
          className="no-print"
          onClick={copyPlanToClipboard}
          style={{
            background: planCopied ? "#059669" : "#f1f5f9",
            color: planCopied ? "white" : "#475569",
            border: `1px solid ${planCopied ? "#059669" : "#e2e8f0"}`,
            padding: "4px 10px",
            borderRadius: 4,
            fontSize: 10,
            fontWeight: 700,
            cursor: "pointer",
          }}
        >
          {planCopied ? "✅ Copied!" : "📋 Copy Rx"}
        </button>
        <button
          onClick={handlePrintPlan}
          style={{
            background: "#1e293b",
            color: "white",
            border: "none",
            padding: "4px 12px",
            borderRadius: 4,
            fontSize: 10,
            fontWeight: 700,
            cursor: "pointer",
          }}
        >
          🖨️ Print & Save
        </button>
      </div>

      {/* AI Rx Review Results */}
      {rxReview && rxReview.length > 0 && (
        <div
          className="no-print"
          style={{
            marginBottom: 10,
            border: "2px solid #7c3aed",
            borderRadius: 8,
            overflow: "hidden",
          }}
        >
          <div
            style={{
              background: "linear-gradient(135deg,#7c3aed,#4f46e5)",
              color: "white",
              padding: "6px 12px",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
            }}
          >
            <span style={{ fontWeight: 700, fontSize: 12 }}>🤖 AI Prescription Review</span>
            <button
              onClick={() => setRxReview(null)}
              style={{
                background: "rgba(255,255,255,.2)",
                border: "none",
                color: "white",
                borderRadius: 4,
                padding: "1px 6px",
                fontSize: 10,
                cursor: "pointer",
                fontWeight: 700,
              }}
            >
              ✕
            </button>
          </div>
          <div style={{ padding: 8, maxHeight: 300, overflow: "auto", background: "#faf5ff" }}>
            {rxReview.map((f, i) => {
              const icons = { warning: "⚠️", suggestion: "💡", good: "✅", missing: "❌" };
              const colors = {
                warning: "#fef2f2",
                suggestion: "#eff6ff",
                good: "#f0fdf4",
                missing: "#fef2f2",
              };
              const borders = {
                warning: "#fecaca",
                suggestion: "#bfdbfe",
                good: "#bbf7d0",
                missing: "#fecaca",
              };
              const textC = {
                warning: "#dc2626",
                suggestion: "#1e40af",
                good: "#059669",
                missing: "#dc2626",
              };
              return (
                <div
                  key={i}
                  style={{
                    background: colors[f.type] || "#f8fafc",
                    border: `1px solid ${borders[f.type] || "#e2e8f0"}`,
                    borderRadius: 6,
                    padding: "6px 10px",
                    marginBottom: 4,
                    fontSize: 11,
                  }}
                >
                  <div style={{ display: "flex", gap: 4, alignItems: "flex-start" }}>
                    <span style={{ fontSize: 13 }}>{icons[f.type] || "📋"}</span>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: 700, color: textC[f.type] || "#334155" }}>
                        {f.text}
                        {f.priority === "high" && (
                          <span
                            style={{
                              background: "#dc2626",
                              color: "white",
                              fontSize: 8,
                              padding: "0 4px",
                              borderRadius: 3,
                              marginLeft: 4,
                              fontWeight: 800,
                            }}
                          >
                            HIGH
                          </span>
                        )}
                        <span
                          style={{ fontSize: 8, color: "#94a3b8", fontWeight: 500, marginLeft: 4 }}
                        >
                          {f.category}
                        </span>
                      </div>
                      {f.detail && (
                        <div style={{ color: "#64748b", marginTop: 2, lineHeight: 1.4 }}>
                          {f.detail}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          {/* ── RX REVIEW FEEDBACK ── */}
          {!rxFbSaved ? (
            <div style={{ borderTop: "2px solid #7c3aed", padding: 10, background: "#faf5ff" }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: "#4c1d95", marginBottom: 6 }}>
                👨‍⚕️ Doctor's Review
              </div>
              <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
                {[
                  ["agree", "✅ Agree", "#059669", "#f0fdf4"],
                  ["partially_agree", "🔶 Partial", "#d97706", "#fffbeb"],
                  ["disagree", "❌ Disagree", "#dc2626", "#fef2f2"],
                ].map(([val, label, color, bg]) => (
                  <button
                    key={val}
                    onClick={() => setRxFbAgreement(val)}
                    style={{
                      flex: 1,
                      padding: "6px 4px",
                      fontSize: 11,
                      fontWeight: 700,
                      border: `2px solid ${rxFbAgreement === val ? color : "#e2e8f0"}`,
                      borderRadius: 6,
                      cursor: "pointer",
                      background: rxFbAgreement === val ? bg : "white",
                      color: rxFbAgreement === val ? color : "#64748b",
                      transition: "all .15s",
                    }}
                  >
                    {label}
                  </button>
                ))}
              </div>

              {rxFbAgreement && (
                <>
                  <textarea
                    value={rxFbText}
                    onChange={(e) => setRxFbText(e.target.value)}
                    rows={2}
                    placeholder={
                      rxFbAgreement === "agree"
                        ? "Any additional notes? (optional)"
                        : "What would you change or what did the AI miss?"
                    }
                    style={{
                      width: "100%",
                      border: "1px solid #e2e8f0",
                      borderRadius: 6,
                      padding: 8,
                      fontSize: 11,
                      marginBottom: 6,
                      resize: "vertical",
                      boxSizing: "border-box",
                    }}
                  />

                  {rxFbAgreement !== "agree" && (
                    <>
                      <textarea
                        value={rxFbCorrect}
                        onChange={(e) => setRxFbCorrect(e.target.value)}
                        rows={2}
                        placeholder="What should be the correct approach?"
                        style={{
                          width: "100%",
                          border: "1px solid #e2e8f0",
                          borderRadius: 6,
                          padding: 8,
                          fontSize: 11,
                          marginBottom: 6,
                          resize: "vertical",
                          boxSizing: "border-box",
                        }}
                      />
                      <textarea
                        value={rxFbReason}
                        onChange={(e) => setRxFbReason(e.target.value)}
                        rows={2}
                        placeholder="Reason for difference (most valuable field)"
                        style={{
                          width: "100%",
                          border: "1px solid #fecaca",
                          borderRadius: 6,
                          padding: 8,
                          fontSize: 11,
                          marginBottom: 6,
                          resize: "vertical",
                          boxSizing: "border-box",
                          background: "#fff5f5",
                        }}
                      />

                      {/* Quick tags */}
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 6 }}>
                        {DISAGREEMENT_TAGS.map((tag) => (
                          <button
                            key={tag}
                            onClick={() =>
                              setRxFbTags((prev) =>
                                prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag],
                              )
                            }
                            style={{
                              fontSize: 9,
                              padding: "3px 8px",
                              borderRadius: 10,
                              border: `1px solid ${rxFbTags.includes(tag) ? "#7c3aed" : "#e2e8f0"}`,
                              background: rxFbTags.includes(tag) ? "#f5f3ff" : "white",
                              color: rxFbTags.includes(tag) ? "#7c3aed" : "#64748b",
                              cursor: "pointer",
                              fontWeight: 600,
                            }}
                          >
                            {tag}
                          </button>
                        ))}
                      </div>

                      {/* Severity */}
                      <div style={{ display: "flex", gap: 4, marginBottom: 8 }}>
                        <span
                          style={{
                            fontSize: 10,
                            color: "#64748b",
                            fontWeight: 600,
                            alignSelf: "center",
                          }}
                        >
                          Severity:
                        </span>
                        {[
                          ["minor", "Minor", "#94a3b8"],
                          ["moderate", "Moderate", "#d97706"],
                          ["major", "Major", "#dc2626"],
                        ].map(([v, l, c]) => (
                          <button
                            key={v}
                            onClick={() => setRxFbSeverity(v)}
                            style={{
                              fontSize: 9,
                              padding: "3px 10px",
                              borderRadius: 6,
                              border: `1px solid ${rxFbSeverity === v ? c : "#e2e8f0"}`,
                              background: rxFbSeverity === v ? c + "15" : "white",
                              color: rxFbSeverity === v ? c : "#94a3b8",
                              cursor: "pointer",
                              fontWeight: 700,
                            }}
                          >
                            {l}
                          </button>
                        ))}
                      </div>
                    </>
                  )}

                  <button
                    onClick={saveRxFeedback}
                    disabled={rxFbSaving}
                    style={{
                      width: "100%",
                      background: rxFbSaving ? "#94a3b8" : "#7c3aed",
                      color: "white",
                      border: "none",
                      padding: "8px",
                      borderRadius: 6,
                      fontSize: 11,
                      fontWeight: 700,
                      cursor: rxFbSaving ? "wait" : "pointer",
                    }}
                  >
                    {rxFbSaving ? "⏳ Saving..." : "💾 Save Feedback"}
                  </button>
                </>
              )}
            </div>
          ) : (
            <div
              style={{
                borderTop: "2px solid #059669",
                padding: 8,
                background: "#f0fdf4",
                textAlign: "center",
                fontSize: 11,
                fontWeight: 700,
                color: "#059669",
              }}
            >
              ✅ Feedback saved —{" "}
              {rxFbSaved.agreement_level === "agree"
                ? "AI analysis confirmed"
                : "Corrections recorded for AI improvement"}
            </div>
          )}
        </div>
      )}

      {!moData && !conData ? (
        <div style={{ textAlign: "center", padding: 24, color: "#94a3b8" }}>
          Complete MO & Consultant first
        </div>
      ) : (
        <div data-plan-content>
          {/* Plan Header */}
          <div
            style={{
              background: "linear-gradient(135deg,#1e293b,#334155)",
              color: "white",
              padding: "12px 16px",
              borderRadius: "10px 10px 0 0",
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <div
                  style={{
                    width: 26,
                    height: 26,
                    background: "white",
                    borderRadius: 5,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    color: "#1e293b",
                    fontWeight: 900,
                    fontSize: 11,
                  }}
                >
                  G
                </div>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 800 }}>GINI ADVANCED CARE HOSPITAL</div>
                  <div style={{ fontSize: 9, opacity: 0.7 }}>Sector 69, Mohali | 0172-4120100</div>
                </div>
              </div>
              <div style={{ textAlign: "right", fontSize: 10 }}>
                <div style={{ fontWeight: 700 }}>{conName}</div>
                <div style={{ opacity: 0.8 }}>Consultant</div>
              </div>
            </div>
            <div
              style={{
                borderTop: "1px solid rgba(255,255,255,.12)",
                marginTop: 6,
                paddingTop: 5,
                fontSize: 12,
              }}
            >
              <strong>{patient.name}</strong> | {patient.age}Y / {patient.sex}{" "}
              {patient.phone && `| ${patient.phone}`} {patient.fileNo && `| ${patient.fileNo}`}
              <span style={{ float: "right", fontSize: 11, fontWeight: 700 }}>
                {(() => {
                  const ld = pfd?.consultations?.[0]?.visit_date;
                  if (ld) {
                    const s = String(ld);
                    const d = s.length >= 10 ? new Date(s.slice(0, 10) + "T12:00:00") : new Date(s);
                    return d.toLocaleDateString("en-IN", {
                      day: "2-digit",
                      month: "short",
                      year: "numeric",
                    });
                  }
                  return new Date().toLocaleDateString("en-IN", {
                    day: "2-digit",
                    month: "short",
                    year: "numeric",
                  });
                })()}
              </span>
            </div>
          </div>

          <div
            style={{
              border: "1px solid #e2e8f0",
              borderTop: "none",
              borderRadius: "0 0 10px 10px",
              padding: 14,
            }}
          >
            {/* Summary */}
            {!planHidden.has("summary") && conData?.assessment_summary && (
              <div
                style={{
                  background: "linear-gradient(135deg,#eff6ff,#f0fdf4)",
                  border: "1px solid #bfdbfe",
                  borderRadius: 8,
                  padding: 10,
                  marginBottom: 12,
                  position: "relative",
                }}
              >
                <button
                  className="no-print"
                  onClick={() => toggleBlock("summary")}
                  style={{
                    position: "absolute",
                    top: 4,
                    right: 4,
                    background: "#fee2e2",
                    border: "none",
                    borderRadius: 3,
                    padding: "1px 5px",
                    fontSize: 9,
                    cursor: "pointer",
                    color: "#dc2626",
                    fontWeight: 700,
                  }}
                >
                  ✕
                </button>
                <div style={{ fontSize: 10, fontWeight: 700, color: "#1e40af", marginBottom: 4 }}>
                  📋 Dear {patient.name ? patient.name.split(" ")[0] : "Patient"}:
                </div>
                <textarea
                  className="no-print"
                  value={getPlan("summary", conData.assessment_summary)}
                  onChange={(e) => editPlan("summary", e.target.value)}
                  rows={3}
                  style={{
                    width: "100%",
                    border: "1px solid #bfdbfe",
                    borderRadius: 6,
                    padding: 8,
                    fontSize: 12,
                    color: "#334155",
                    lineHeight: 1.6,
                    resize: "vertical",
                    boxSizing: "border-box",
                    background: "white",
                    outline: "none",
                    fontFamily: "inherit",
                  }}
                  onFocus={(e) => (e.target.style.borderColor = "#3b82f6")}
                  onBlur={(e) => (e.target.style.borderColor = "#bfdbfe")}
                />
                <div
                  className="print-only"
                  style={{ display: "none", fontSize: 12, color: "#334155", lineHeight: 1.6 }}
                >
                  {getPlan("summary", conData.assessment_summary)}
                </div>
              </div>
            )}
            {planHidden.has("summary") && (
              <div
                className="no-print"
                style={{
                  marginBottom: 4,
                  opacity: 0.4,
                  cursor: "pointer",
                  fontSize: 10,
                  color: "#94a3b8",
                }}
                onClick={() => toggleBlock("summary")}
              >
                ➕ Summary
              </div>
            )}

            {/* Chief Complaints */}
            {(() => {
              const skipPhrases = [
                "no gmi",
                "no hypoglycemia",
                "no hypoglycaemia",
                "routine follow-up",
                "follow-up visit",
                "no complaints",
              ];
              const filtered = (moData?.chief_complaints || []).filter(
                (c) => !skipPhrases.some((s) => String(c).toLowerCase().includes(s)),
              );
              return (
                filtered.length > 0 && (
                  <PlanBlock
                    id="complaints"
                    title="🗣️ Chief Complaints"
                    color="#dc2626"
                    hidden={planHidden.has("complaints")}
                    onToggle={() => toggleBlock("complaints")}
                  >
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                      {filtered.map((c, i) => (
                        <span
                          key={i}
                          style={{
                            fontSize: 11,
                            padding: "3px 8px",
                            background: "#fef2f2",
                            border: "1px solid #fecaca",
                            borderRadius: 6,
                            color: "#dc2626",
                            fontWeight: 600,
                            display: "flex",
                            alignItems: "center",
                            gap: 4,
                          }}
                        >
                          ⚠️{" "}
                          <EditText
                            value={c}
                            onChange={(v) => {
                              const all = [...(moData.chief_complaints || [])];
                              const realIdx = all.indexOf(c);
                              if (realIdx >= 0) {
                                all[realIdx] = v;
                                setMoData((prev) => ({ ...prev, chief_complaints: all }));
                              }
                            }}
                            style={{ fontSize: 11, color: "#dc2626", fontWeight: 600 }}
                          />
                          <button
                            className="no-print"
                            onClick={() => {
                              const all = [...(moData.chief_complaints || [])];
                              const realIdx = all.indexOf(c);
                              if (realIdx >= 0) {
                                all.splice(realIdx, 1);
                                setMoData((prev) => ({ ...prev, chief_complaints: all }));
                              }
                            }}
                            style={{
                              background: "none",
                              border: "none",
                              color: "#dc2626",
                              fontSize: 10,
                              cursor: "pointer",
                              padding: 0,
                              fontWeight: 700,
                            }}
                          >
                            ✕
                          </button>
                        </span>
                      ))}
                      <button
                        className="no-print"
                        onClick={() => {
                          const t = prompt("Add complaint");
                          if (t) addComplaintToPlan(t);
                        }}
                        style={{
                          fontSize: 11,
                          padding: "3px 8px",
                          background: "white",
                          border: "1px dashed #fecaca",
                          borderRadius: 6,
                          color: "#dc2626",
                          fontWeight: 600,
                          cursor: "pointer",
                        }}
                      >
                        + Add
                      </button>
                    </div>
                  </PlanBlock>
                )
              );
            })()}

            {/* Diagnoses */}
            {planDiags.length > 0 && (
              <PlanBlock
                id="diagnoses"
                title="🏥 Your Conditions"
                color="#1e293b"
                hidden={planHidden.has("diagnoses")}
                onToggle={() => toggleBlock("diagnoses")}
              >
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 3 }}>
                  {planDiags.map((d, i) => {
                    const origIdx = sa(moData, "diagnoses").indexOf(d);
                    return (
                      <div
                        key={i}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 4,
                          padding: "4px 8px",
                          background: (DC[d.id] || "#64748b") + "08",
                          border: `1px solid ${DC[d.id] || "#64748b"}22`,
                          borderRadius: 5,
                          fontSize: 11,
                        }}
                      >
                        <div
                          style={{
                            width: 6,
                            height: 6,
                            borderRadius: "50%",
                            background: DC[d.id] || "#64748b",
                          }}
                        />
                        <strong style={{ flex: 1 }}>{FRIENDLY[d.id] || d.label}</strong>
                        <span
                          style={{
                            fontSize: 9,
                            fontWeight: 600,
                            padding: "0 4px",
                            borderRadius: 6,
                            background: d.status === "Uncontrolled" ? "#fef2f2" : "#f0fdf4",
                            color: d.status === "Uncontrolled" ? "#dc2626" : "#059669",
                          }}
                        >
                          {d.status}
                        </span>
                        <RemoveBtn onClick={() => removeDiag(origIdx)} />
                      </div>
                    );
                  })}
                </div>
              </PlanBlock>
            )}

            {/* Vitals */}
            {vitals.bp_sys && (
              <PlanBlock
                id="vitals"
                title="📊 Vitals"
                color="#ea580c"
                hidden={planHidden.has("vitals")}
                onToggle={() => toggleBlock("vitals")}
              >
                <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                  {[
                    {
                      l: "BP",
                      v: vitals.bp_sys ? `${vitals.bp_sys}/${vitals.bp_dia}` : null,
                      suffix: vitals.bp2_sys ? " (Sitting)" : "",
                    },
                    {
                      l: "BP Standing",
                      v: vitals.bp2_sys ? `${vitals.bp2_sys}/${vitals.bp2_dia}` : null,
                    },
                    { l: "Pulse", v: vitals.pulse },
                    { l: "SpO2", v: vitals.spo2 && `${vitals.spo2}%` },
                    { l: "Weight", v: vitals.weight && `${vitals.weight}kg` },
                    { l: "Height", v: vitals.height && `${vitals.height}cm` },
                    { l: "BMI", v: vitals.bmi },
                    { l: "Waist", v: vitals.waist && `${vitals.waist}cm` },
                    { l: "Body Fat", v: vitals.body_fat && `${vitals.body_fat}%` },
                  ]
                    .filter((x) => x.v && x.v !== "/")
                    .map((x, i) => (
                      <span
                        key={i}
                        style={{
                          background: "#fff7ed",
                          border: "1px solid #fed7aa",
                          borderRadius: 4,
                          padding: "2px 6px",
                          fontSize: 11,
                        }}
                      >
                        <strong style={{ color: "#9a3412" }}>{x.l}:</strong> {x.v}
                        {x.suffix || ""}
                      </span>
                    ))}
                </div>
              </PlanBlock>
            )}

            {/* Goals */}
            {planGoals.length > 0 && (
              <PlanBlock
                id="goals"
                title="🎯 Your Health Goals"
                color="#059669"
                hidden={planHidden.has("goals")}
                onToggle={() => toggleBlock("goals")}
              >
                <table
                  style={{
                    width: "100%",
                    borderCollapse: "collapse",
                    fontSize: 11,
                    border: "1px solid #bbf7d0",
                  }}
                >
                  <thead>
                    <tr style={{ background: "#059669", color: "white" }}>
                      <th style={{ padding: "4px 8px", textAlign: "left" }}>Marker</th>
                      <th style={{ padding: "4px 8px" }}>Current</th>
                      <th style={{ padding: "4px 8px" }}>Target</th>
                      <th style={{ padding: "4px 8px" }}>By</th>
                      <th className="no-print" style={{ padding: "4px 8px", width: 20 }}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {planGoals.map((g, i) => {
                      const origIdx = sa(conData, "goals").indexOf(g);
                      const editGoalField = (field, val) => {
                        const goals = [...(conData?.goals || [])];
                        const idx = goals.indexOf(g);
                        if (idx >= 0) {
                          goals[idx] = { ...goals[idx], [field]: val };
                          setConData((prev) => ({ ...prev, goals }));
                        }
                      };
                      return (
                        <tr
                          key={i}
                          style={{
                            background:
                              g.priority === "critical" ? "#fef2f2" : i % 2 ? "#f0fdf4" : "white",
                          }}
                        >
                          <td style={{ padding: "3px 8px" }}>
                            <EditText
                              value={g.marker}
                              onChange={(v) => editGoalField("marker", v)}
                              style={{ fontWeight: 600 }}
                            />
                          </td>
                          <td style={{ padding: "3px 8px", textAlign: "center" }}>
                            <EditText
                              value={g.current || ""}
                              onChange={(v) => editGoalField("current", v)}
                              style={{ fontWeight: 700, color: "#dc2626" }}
                            />
                          </td>
                          <td style={{ padding: "3px 8px", textAlign: "center" }}>
                            <EditText
                              value={g.target || ""}
                              onChange={(v) => editGoalField("target", v)}
                              style={{ fontWeight: 700, color: "#059669" }}
                            />
                          </td>
                          <td style={{ padding: "3px 8px", textAlign: "center" }}>
                            <EditText
                              value={g.timeline || ""}
                              onChange={(v) => editGoalField("timeline", v)}
                              style={{ color: "#64748b" }}
                            />
                          </td>
                          <td className="no-print" style={{ padding: "3px 4px" }}>
                            <RemoveBtn onClick={() => removeGoal(origIdx)} />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                {/* Quick Add Goal */}
                <button
                  className="no-print"
                  onClick={() => {
                    const marker = prompt("Goal marker (e.g., HbA1c, Weight, BP)");
                    if (!marker) return;
                    const current = prompt("Current value") || "";
                    const target = prompt("Target value") || "";
                    const timeline = prompt("Timeline (e.g., 3 months)") || "";
                    addGoalToPlan({ marker, current, target, timeline });
                  }}
                  style={{
                    marginTop: 6,
                    background: "#f8fafc",
                    border: "1px dashed #cbd5e1",
                    borderRadius: 6,
                    padding: "6px 12px",
                    fontSize: 11,
                    fontWeight: 600,
                    cursor: "pointer",
                    color: "#64748b",
                    width: "100%",
                  }}
                >
                  + Add Goal
                </button>
              </PlanBlock>
            )}

            {/* Medications */}
            {planMeds.length > 0 && (
              <PlanBlock
                id="meds"
                title="💊 Your Medications"
                color="#dc2626"
                hidden={planHidden.has("meds")}
                onToggle={() => toggleBlock("meds")}
              >
                <table
                  style={{
                    width: "100%",
                    borderCollapse: "collapse",
                    fontSize: 11,
                    border: "1px solid #e2e8f0",
                  }}
                >
                  <thead>
                    <tr style={{ background: "#1e293b", color: "white" }}>
                      <th style={{ padding: "5px 8px", textAlign: "left" }}>Medicine</th>
                      <th style={{ padding: "5px 8px" }}>Dose</th>
                      <th style={{ padding: "5px 8px" }}>When to Take</th>
                      <th style={{ padding: "5px 8px", textAlign: "left" }}>For</th>
                      <th className="no-print" style={{ padding: "5px 8px", width: 20 }}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {planMeds.map((m, i) => {
                      const origIdx = allMeds.indexOf(m);
                      return (
                        <tr
                          key={i}
                          style={{
                            background:
                              m.isNew || m.resolved ? "#eff6ff" : i % 2 ? "#fafafa" : "white",
                          }}
                        >
                          <td style={{ padding: "4px 8px" }}>
                            <EditText
                              value={m.name}
                              onChange={(v) => editMedField(m, "name", v)}
                              style={{ fontWeight: 700 }}
                            />
                            {m._matched && (
                              <span
                                title={`Pharmacy match: ${m._matched} (${m._confidence}%)`}
                                style={{ color: "#059669", fontSize: 9, marginLeft: 3 }}
                              >
                                ✓
                              </span>
                            )}
                            {(m.isNew || m.resolved) && (
                              <span
                                style={{
                                  background: "#1e40af",
                                  color: "white",
                                  padding: "0 3px",
                                  borderRadius: 3,
                                  fontSize: 8,
                                  marginLeft: 3,
                                }}
                              >
                                NEW
                              </span>
                            )}
                            {m.composition && (
                              <div style={{ fontSize: 9, color: "#94a3b8" }}>{m.composition}</div>
                            )}
                          </td>
                          <td style={{ padding: "4px 8px", textAlign: "center" }}>
                            <EditText
                              value={m.dose || ""}
                              onChange={(v) => editMedField(m, "dose", v)}
                              style={{ fontWeight: 600 }}
                            />
                          </td>
                          <td style={{ padding: "4px 8px", textAlign: "center" }}>
                            <EditText
                              value={m.timing || m.frequency || ""}
                              onChange={(v) => editMedField(m, "timing", v)}
                              style={{ fontSize: 10, fontWeight: 600, color: "#1e40af" }}
                            />
                          </td>
                          <td style={{ padding: "4px 8px" }}>
                            {(m.forDiagnosis || []).map((d) => (
                              <Badge key={d} id={d} friendly />
                            ))}
                          </td>
                          <td className="no-print" style={{ padding: "4px 4px" }}>
                            <RemoveBtn onClick={() => removeMed(origIdx)} />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                {/* Quick Add Medicine */}
                {planAddMode === "med" ? (
                  <div
                    className="no-print"
                    style={{
                      display: "flex",
                      gap: 4,
                      marginTop: 6,
                      flexWrap: "wrap",
                      alignItems: "center",
                      background: "#eff6ff",
                      padding: 8,
                      borderRadius: 6,
                      border: "1px solid #bfdbfe",
                    }}
                  >
                    <input
                      value={planAddMed.name}
                      onChange={(e) => setPlanAddMed((p) => ({ ...p, name: e.target.value }))}
                      placeholder="Medicine name"
                      style={{
                        flex: 2,
                        minWidth: 120,
                        padding: "5px 8px",
                        border: "1px solid #e2e8f0",
                        borderRadius: 4,
                        fontSize: 11,
                      }}
                      autoFocus
                    />
                    <input
                      value={planAddMed.dose}
                      onChange={(e) => setPlanAddMed((p) => ({ ...p, dose: e.target.value }))}
                      placeholder="Dose"
                      style={{
                        width: 70,
                        padding: "5px 8px",
                        border: "1px solid #e2e8f0",
                        borderRadius: 4,
                        fontSize: 11,
                      }}
                    />
                    <select
                      value={planAddMed.frequency}
                      onChange={(e) => setPlanAddMed((p) => ({ ...p, frequency: e.target.value }))}
                      style={{
                        padding: "5px 4px",
                        border: "1px solid #e2e8f0",
                        borderRadius: 4,
                        fontSize: 11,
                      }}
                    >
                      {["OD", "BD", "TDS", "QID", "SOS", "Weekly"].map((f) => (
                        <option key={f}>{f}</option>
                      ))}
                    </select>
                    <select
                      value={planAddMed.timing}
                      onChange={(e) => setPlanAddMed((p) => ({ ...p, timing: e.target.value }))}
                      style={{
                        padding: "5px 4px",
                        border: "1px solid #e2e8f0",
                        borderRadius: 4,
                        fontSize: 11,
                      }}
                    >
                      {[
                        "Morning",
                        "Night",
                        "Before meals",
                        "After meals",
                        "Empty stomach",
                        "Bedtime",
                      ].map((t) => (
                        <option key={t}>{t}</option>
                      ))}
                    </select>
                    <button
                      onClick={() => {
                        if (planAddMed.name.trim()) {
                          addMedToPlan({
                            name: planAddMed.name.toUpperCase(),
                            dose: planAddMed.dose,
                            frequency: planAddMed.frequency,
                            timing: planAddMed.timing,
                            isNew: true,
                            route: "Oral",
                          });
                          setPlanAddMed({ name: "", dose: "", frequency: "OD", timing: "Morning" });
                        }
                      }}
                      style={{
                        background: "#2563eb",
                        color: "white",
                        border: "none",
                        padding: "5px 10px",
                        borderRadius: 4,
                        fontSize: 11,
                        fontWeight: 700,
                        cursor: "pointer",
                      }}
                    >
                      ✓ Add
                    </button>
                    <button
                      onClick={() => setPlanAddMode(null)}
                      style={{
                        background: "#f1f5f9",
                        border: "1px solid #e2e8f0",
                        padding: "5px 8px",
                        borderRadius: 4,
                        fontSize: 11,
                        cursor: "pointer",
                      }}
                    >
                      ✕
                    </button>
                  </div>
                ) : (
                  <button
                    className="no-print"
                    onClick={() => setPlanAddMode("med")}
                    style={{
                      marginTop: 6,
                      background: "#f8fafc",
                      border: "1px dashed #cbd5e1",
                      borderRadius: 6,
                      padding: "6px 12px",
                      fontSize: 11,
                      fontWeight: 600,
                      cursor: "pointer",
                      color: "#64748b",
                      width: "100%",
                    }}
                  >
                    + Add Medicine
                  </button>
                )}
              </PlanBlock>
            )}

            {/* ═══ EXTERNAL MEDICATION RECONCILIATION — Grouped by Doctor ═══ */}
            {externalMedsByDoctor.length > 0 && (
              <PlanBlock
                id="extmeds"
                title={`🏥 Medications by Other Consultants (${externalMeds.length})`}
                color="#f59e0b"
                hidden={planHidden.has("extmeds")}
                onToggle={() => toggleBlock("extmeds")}
              >
                <div
                  style={{
                    background: "#fffbeb",
                    border: "1px solid #fde68a",
                    borderRadius: 6,
                    padding: "6px 10px",
                    marginBottom: 8,
                    fontSize: 10,
                    color: "#92400e",
                  }}
                >
                  <b>Note:</b> External consultant medications based on prescriptions provided by
                  patient. Verified during this visit.
                </div>
                <div
                  className="no-print"
                  style={{ display: "flex", gap: 4, marginBottom: 8, flexWrap: "wrap" }}
                >
                  <button
                    onClick={() => {
                      const recon = {};
                      externalMeds.forEach((m) => {
                        if (!medRecon[m.name]) recon[m.name] = "continue";
                      });
                      setMedRecon((prev) => ({ ...prev, ...recon }));
                    }}
                    style={{
                      padding: "5px 12px",
                      background: "#059669",
                      color: "white",
                      border: "none",
                      borderRadius: 6,
                      fontSize: 11,
                      fontWeight: 700,
                      cursor: "pointer",
                    }}
                  >
                    ✅ Confirm All Continue
                  </button>
                  <button
                    onClick={() => {
                      const contMeds = externalMeds.filter(
                        (m) => medRecon[m.name] !== "stop" && medRecon[m.name] !== "hold",
                      );
                      const heldMeds = externalMeds.filter((m) => medRecon[m.name] === "hold");
                      const stoppedMeds = externalMeds.filter((m) => medRecon[m.name] === "stop");
                      let summary = "";
                      if (contMeds.length) {
                        const byDoc = {};
                        contMeds.forEach((m) => {
                          const d = m.prescriber || "External";
                          if (!byDoc[d]) byDoc[d] = [];
                          byDoc[d].push(m.name);
                        });
                        summary +=
                          "Medications continued: " +
                          Object.entries(byDoc)
                            .map(([doc, meds]) => `${meds.join(", ")} (prescribed by ${doc})`)
                            .join("; ") +
                          ". ";
                      }
                      if (stoppedMeds.length) {
                        summary +=
                          "Medications stopped: " +
                          stoppedMeds
                            .map((m) => {
                              const reason = medReconReasons[m.name];
                              return `${m.name}${reason ? ` (${reason})` : ""}`;
                            })
                            .join(", ") +
                          ". ";
                      }
                      if (heldMeds.length) {
                        summary +=
                          "Medications on hold: " +
                          heldMeds
                            .map((m) => {
                              const reason = medReconReasons[m.name];
                              return `${m.name}${reason ? ` (${reason})` : ""}`;
                            })
                            .join(", ") +
                          ". ";
                      }
                      if (summary) {
                        const existing = getPlan("summary", conData?.assessment_summary || "");
                        const reconTag = "\n\n📋 Medication Reconciliation: ";
                        const cleaned = existing.includes("📋 Medication Reconciliation:")
                          ? existing.split("📋 Medication Reconciliation:")[0].trim()
                          : existing;
                        editPlan("summary", cleaned + reconTag + summary);
                      }
                    }}
                    style={{
                      padding: "5px 12px",
                      background: "#2563eb",
                      color: "white",
                      border: "none",
                      borderRadius: 6,
                      fontSize: 11,
                      fontWeight: 700,
                      cursor: "pointer",
                    }}
                  >
                    📋 Done — Add to Summary
                  </button>
                </div>
                {externalMedsByDoctor.map((group, gi) => (
                  <div
                    key={gi}
                    style={{
                      marginBottom: 10,
                      borderRadius: 8,
                      overflow: "hidden",
                      border: "1px solid #e2e8f0",
                    }}
                  >
                    <div
                      style={{
                        background: "linear-gradient(135deg,#f1f5f9,#e2e8f0)",
                        padding: "8px 14px",
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                      }}
                    >
                      <div>
                        <div style={{ fontSize: 12, fontWeight: 800, color: "#1e293b" }}>
                          {group.doctor}
                          {group.specialty && (
                            <span style={{ fontWeight: 600, color: "#475569" }}>
                              {" "}
                              ({group.specialty})
                            </span>
                          )}
                        </div>
                        {group.date && (
                          <div style={{ fontSize: 10, color: "#64748b", marginTop: 1 }}>
                            {new Date(
                              String(group.date).slice(0, 10) + "T12:00:00",
                            ).toLocaleDateString("en-IN", {
                              day: "2-digit",
                              month: "short",
                              year: "numeric",
                            })}
                          </div>
                        )}
                      </div>
                      <div style={{ textAlign: "right" }}>
                        {group.hospital && (
                          <div style={{ fontSize: 10, fontWeight: 700, color: "#dc2626" }}>
                            {group.hospital}
                          </div>
                        )}
                        <div style={{ fontSize: 9, color: "#94a3b8" }}>
                          {group.meds.length} medicine{group.meds.length > 1 ? "s" : ""}
                        </div>
                      </div>
                    </div>
                    {group.meds.map((m, mi) => {
                      const status = medRecon[m.name] || "continue";
                      const reason = medReconReasons[m.name] || "";
                      return (
                        <div key={mi}>
                          <div
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: 6,
                              padding: "8px 14px",
                              background:
                                status === "stop"
                                  ? "#fef2f2"
                                  : status === "hold"
                                    ? "#fef3c7"
                                    : "white",
                              borderTop: "1px solid #f1f5f9",
                            }}
                          >
                            <span
                              style={{
                                fontSize: 16,
                                color:
                                  status === "stop"
                                    ? "#dc2626"
                                    : status === "hold"
                                      ? "#f59e0b"
                                      : "#059669",
                              }}
                            >
                              {status === "stop" ? "🛑" : status === "hold" ? "⏸" : "✅"}
                            </span>
                            <div style={{ flex: 1 }}>
                              <div
                                style={{
                                  fontSize: 12,
                                  fontWeight: 700,
                                  color: status === "stop" ? "#94a3b8" : "#1e293b",
                                  textDecoration: status === "stop" ? "line-through" : "none",
                                }}
                              >
                                {m.name}{" "}
                                <span style={{ fontSize: 10, fontWeight: 400, color: "#94a3b8" }}>
                                  {m.composition}
                                </span>
                              </div>
                            </div>
                            <div
                              style={{
                                fontSize: 11,
                                fontWeight: 700,
                                color: "#475569",
                                minWidth: 55,
                                textAlign: "right",
                              }}
                            >
                              {m.dose}
                            </div>
                            <div
                              style={{
                                fontSize: 11,
                                fontWeight: 600,
                                color: "#2563eb",
                                minWidth: 90,
                                textAlign: "center",
                              }}
                            >
                              {m.timing || m.frequency}
                            </div>
                            <div className="no-print" style={{ display: "flex", gap: 2 }}>
                              {[
                                { v: "continue", l: "Continue", c: "#059669" },
                                { v: "hold", l: "Hold", c: "#f59e0b" },
                                { v: "stop", l: "Stop", c: "#dc2626" },
                              ].map((o) => (
                                <button
                                  key={o.v}
                                  onClick={() => {
                                    setMedRecon((prev) => ({ ...prev, [m.name]: o.v }));
                                    if (o.v === "continue")
                                      setMedReconReasons((prev) => {
                                        const n = { ...prev };
                                        delete n[m.name];
                                        return n;
                                      });
                                  }}
                                  style={{
                                    padding: "3px 8px",
                                    borderRadius: 4,
                                    fontSize: 9,
                                    fontWeight: 700,
                                    cursor: "pointer",
                                    border: `1.5px solid ${status === o.v ? o.c : "#e2e8f0"}`,
                                    background: status === o.v ? o.c : "white",
                                    color: status === o.v ? "white" : "#475569",
                                  }}
                                >
                                  {o.l}
                                </button>
                              ))}
                            </div>
                          </div>
                          {(status === "hold" || status === "stop") && (
                            <div
                              className="no-print"
                              style={{
                                padding: "4px 14px 8px 44px",
                                background: status === "stop" ? "#fef2f2" : "#fef3c7",
                              }}
                            >
                              <div
                                style={{
                                  fontSize: 9,
                                  fontWeight: 700,
                                  color: status === "stop" ? "#dc2626" : "#92400e",
                                  marginBottom: 3,
                                }}
                              >
                                Reason for {status === "stop" ? "stopping" : "holding"}:
                              </div>
                              <div style={{ display: "flex", flexWrap: "wrap", gap: 3 }}>
                                {(RECON_REASONS[status] || []).map((r) => (
                                  <button
                                    key={r}
                                    onClick={() =>
                                      setMedReconReasons((prev) => ({ ...prev, [m.name]: r }))
                                    }
                                    style={{
                                      fontSize: 9,
                                      padding: "3px 8px",
                                      borderRadius: 12,
                                      cursor: "pointer",
                                      fontWeight: 600,
                                      border: `1.5px solid ${reason === r ? (status === "stop" ? "#dc2626" : "#f59e0b") : "#e2e8f0"}`,
                                      background:
                                        reason === r
                                          ? status === "stop"
                                            ? "#dc2626"
                                            : "#f59e0b"
                                          : "white",
                                      color: reason === r ? "white" : "#475569",
                                    }}
                                  >
                                    {r}
                                  </button>
                                ))}
                              </div>
                              {reason && (
                                <div
                                  style={{
                                    fontSize: 9,
                                    marginTop: 3,
                                    color: status === "stop" ? "#dc2626" : "#92400e",
                                    fontWeight: 600,
                                  }}
                                >
                                  ✓ {reason}
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                ))}
                {Object.values(medRecon).some((v) => v !== "continue") && (
                  <div
                    style={{
                      marginTop: 6,
                      padding: 10,
                      background: "#f8fafc",
                      borderRadius: 8,
                      border: "1px solid #e2e8f0",
                    }}
                  >
                    <div
                      style={{ fontSize: 10, fontWeight: 700, color: "#1e293b", marginBottom: 4 }}
                    >
                      📋 Reconciliation Summary
                    </div>
                    {Object.entries(medRecon)
                      .filter(([_, v]) => v === "stop")
                      .map(([k]) => (
                        <div
                          key={k}
                          style={{
                            fontSize: 10,
                            color: "#dc2626",
                            fontWeight: 600,
                            marginBottom: 2,
                            display: "flex",
                            gap: 4,
                          }}
                        >
                          <span>🛑</span>
                          <span>
                            {k} — STOPPED{medReconReasons[k] ? ` (${medReconReasons[k]})` : ""}
                          </span>
                        </div>
                      ))}
                    {Object.entries(medRecon)
                      .filter(([_, v]) => v === "hold")
                      .map(([k]) => (
                        <div
                          key={k}
                          style={{
                            fontSize: 10,
                            color: "#f59e0b",
                            fontWeight: 600,
                            marginBottom: 2,
                            display: "flex",
                            gap: 4,
                          }}
                        >
                          <span>⏸</span>
                          <span>
                            {k} — ON HOLD{medReconReasons[k] ? ` (${medReconReasons[k]})` : ""}
                          </span>
                        </div>
                      ))}
                  </div>
                )}
              </PlanBlock>
            )}

            {/* ═══ COMPLETE MEDICINE SCHEDULE — Time-of-Day Card ═══ */}
            {(planMeds.length > 0 || externalMeds.length > 0) && (
              <div style={{ marginBottom: 10 }}>
                <button
                  onClick={() => setShowMedCard(!showMedCard)}
                  style={{
                    width: "100%",
                    padding: "10px 14px",
                    background: showMedCard ? "linear-gradient(135deg,#1e293b,#334155)" : "#faf5ff",
                    color: showMedCard ? "white" : "#7c3aed",
                    border: "1.5px solid #c4b5fd",
                    borderRadius: 8,
                    fontSize: 13,
                    fontWeight: 800,
                    cursor: "pointer",
                  }}
                >
                  💊 {showMedCard ? "Hide" : "Show"} Complete Medicine Schedule
                </button>
                {showMedCard &&
                  (() => {
                    const schedule = buildMedicineSchedule();
                    const totalMeds =
                      planMeds.length +
                      externalMeds.filter((m) => medRecon[m.name] !== "stop").length;
                    return (
                      <div
                        data-medcard
                        style={{
                          marginTop: 6,
                          borderRadius: 10,
                          overflow: "hidden",
                          border: "2px solid #c4b5fd",
                        }}
                      >
                        <div
                          style={{
                            background: "linear-gradient(135deg,#1e293b,#334155)",
                            padding: "12px 16px",
                            color: "white",
                            display: "flex",
                            justifyContent: "space-between",
                            alignItems: "center",
                          }}
                        >
                          <div>
                            <div style={{ fontSize: 14, fontWeight: 800 }}>
                              💊 YOUR COMPLETE MEDICINE SCHEDULE
                            </div>
                            <div style={{ fontSize: 10, opacity: 0.7 }}>
                              {patient.name} | {patient.fileNo || ""} | Updated:{" "}
                              {new Date().toLocaleDateString("en-IN", {
                                day: "2-digit",
                                month: "short",
                                year: "numeric",
                              })}
                            </div>
                          </div>
                          <div style={{ textAlign: "right" }}>
                            <div style={{ fontSize: 24, fontWeight: 800 }}>{totalMeds}</div>
                            <div style={{ fontSize: 8, opacity: 0.7 }}>Active Medicines</div>
                          </div>
                        </div>
                        {schedule.map((slot) => (
                          <div key={slot.id}>
                            <div
                              style={{
                                background: "#f8fafc",
                                padding: "6px 16px",
                                display: "flex",
                                justifyContent: "space-between",
                                alignItems: "center",
                                borderBottom: "1px solid #e2e8f0",
                                borderTop: "1px solid #e2e8f0",
                              }}
                            >
                              <div style={{ fontSize: 12, fontWeight: 800, color: "#1e293b" }}>
                                {slot.label}
                              </div>
                              {slot.time && (
                                <div style={{ fontSize: 10, color: "#64748b", fontWeight: 600 }}>
                                  {slot.time}
                                </div>
                              )}
                            </div>
                            {slot.meds.map((m, mi) => (
                              <div
                                key={mi}
                                style={{
                                  display: "flex",
                                  alignItems: "center",
                                  gap: 10,
                                  padding: "8px 16px",
                                  borderBottom: "1px solid #f1f5f9",
                                }}
                              >
                                <span style={{ fontSize: 14, color: "#cbd5e1" }}>💊</span>
                                <div style={{ flex: 1 }}>
                                  <div style={{ fontSize: 12, fontWeight: 700 }}>
                                    {m.name}
                                    {m.isNew && (
                                      <span
                                        style={{
                                          background: "#dc2626",
                                          color: "white",
                                          padding: "0 4px",
                                          borderRadius: 3,
                                          fontSize: 8,
                                          marginLeft: 4,
                                          fontWeight: 800,
                                        }}
                                      >
                                        NEW
                                      </span>
                                    )}
                                  </div>
                                  <div style={{ fontSize: 10, color: "#94a3b8" }}>
                                    {m.dose} {m.frequency}{" "}
                                    {m.timing && m.timing !== m.frequency ? `• ${m.timing}` : ""}{" "}
                                    {(m.forDiagnosis || []).length > 0
                                      ? `— ${m.forDiagnosis.join(", ")}`
                                      : ""}
                                  </div>
                                </div>
                                <span
                                  style={{
                                    fontSize: 10,
                                    padding: "2px 8px",
                                    borderRadius: 4,
                                    fontWeight: 700,
                                    background: m.isGini ? "#2563eb" : "#f8fafc",
                                    color: m.isGini ? "white" : "#475569",
                                    border: m.isGini ? "none" : "1px solid #e2e8f0",
                                  }}
                                >
                                  {m.isGini
                                    ? conName || "Gini"
                                    : m.prescriber && m.prescriber !== "External"
                                      ? m.prescriber
                                      : "Other"}
                                </span>
                              </div>
                            ))}
                          </div>
                        ))}
                        {(conData?.self_monitoring || []).length > 0 && (
                          <div
                            style={{
                              padding: 12,
                              background: "#fef3c7",
                              borderTop: "2px solid #fde68a",
                            }}
                          >
                            <div style={{ fontSize: 11, fontWeight: 800, marginBottom: 4 }}>
                              ⚠️ IMPORTANT REMINDERS
                            </div>
                            {conData.self_monitoring.map((sm, i) => (
                              <div key={i} style={{ fontSize: 10, marginBottom: 2 }}>
                                {sm.alert && (
                                  <div>
                                    • 🔴 <b>{sm.title}:</b> {sm.alert}
                                  </div>
                                )}
                                {sm.targets && (
                                  <div>
                                    • 📊 <b>{sm.title}:</b> {sm.targets}
                                  </div>
                                )}
                                {(sm.instructions || []).map((inst, ii) => (
                                  <div key={ii}>• {inst}</div>
                                ))}
                              </div>
                            ))}
                          </div>
                        )}
                        {externalMeds.filter((m) => medRecon[m.name] === "hold").length > 0 && (
                          <div
                            style={{
                              padding: 12,
                              background: "#fef3c7",
                              borderTop: "2px solid #fde68a",
                            }}
                          >
                            <div
                              style={{
                                fontSize: 11,
                                fontWeight: 800,
                                color: "#92400e",
                                marginBottom: 4,
                              }}
                            >
                              ⏸ MEDICATIONS ON HOLD
                            </div>
                            {externalMeds
                              .filter((m) => medRecon[m.name] === "hold")
                              .map((m, i) => (
                                <div
                                  key={i}
                                  style={{
                                    fontSize: 11,
                                    padding: "4px 0",
                                    borderBottom: "1px solid #fde68a40",
                                  }}
                                >
                                  <div style={{ display: "flex", justifyContent: "space-between" }}>
                                    <span style={{ fontWeight: 700 }}>
                                      ⏸ {m.name} {m.dose}
                                    </span>
                                    <span style={{ fontSize: 10, color: "#92400e" }}>
                                      {m.prescriber && m.prescriber !== "External"
                                        ? m.prescriber
                                        : ""}
                                    </span>
                                  </div>
                                  {medReconReasons[m.name] && (
                                    <div
                                      style={{
                                        fontSize: 9,
                                        color: "#b45309",
                                        fontStyle: "italic",
                                        marginTop: 1,
                                      }}
                                    >
                                      Reason: {medReconReasons[m.name]}
                                    </div>
                                  )}
                                </div>
                              ))}
                          </div>
                        )}
                        {externalMeds.filter((m) => medRecon[m.name] === "stop").length > 0 && (
                          <div
                            style={{
                              padding: 12,
                              background: "#fef2f2",
                              borderTop: "2px solid #fecaca",
                            }}
                          >
                            <div
                              style={{
                                fontSize: 11,
                                fontWeight: 800,
                                color: "#dc2626",
                                marginBottom: 4,
                              }}
                            >
                              🛑 MEDICATIONS STOPPED
                            </div>
                            {externalMeds
                              .filter((m) => medRecon[m.name] === "stop")
                              .map((m, i) => (
                                <div
                                  key={i}
                                  style={{
                                    fontSize: 11,
                                    padding: "4px 0",
                                    borderBottom: "1px solid #fecaca40",
                                  }}
                                >
                                  <div style={{ display: "flex", justifyContent: "space-between" }}>
                                    <span
                                      style={{
                                        fontWeight: 700,
                                        textDecoration: "line-through",
                                        opacity: 0.7,
                                      }}
                                    >
                                      🛑 {m.name} {m.dose}
                                    </span>
                                    <span style={{ fontSize: 10, color: "#dc2626" }}>
                                      {m.prescriber && m.prescriber !== "External"
                                        ? m.prescriber
                                        : ""}
                                    </span>
                                  </div>
                                  {medReconReasons[m.name] && (
                                    <div
                                      style={{
                                        fontSize: 9,
                                        color: "#dc2626",
                                        fontStyle: "italic",
                                        marginTop: 1,
                                      }}
                                    >
                                      Reason: {medReconReasons[m.name]}
                                    </div>
                                  )}
                                </div>
                              ))}
                          </div>
                        )}
                        {(nextVisitDate || conData?.follow_up) && (
                          <div
                            style={{
                              padding: 12,
                              background: "#f0f9ff",
                              borderTop: "2px solid #bfdbfe",
                            }}
                          >
                            <div style={{ fontSize: 11, fontWeight: 800, marginBottom: 2 }}>
                              📅 NEXT VISIT
                            </div>
                            {nextVisitDate ? (
                              <div style={{ fontSize: 16, fontWeight: 800, color: "#2563eb" }}>
                                {new Date(nextVisitDate + "T12:00:00").toLocaleDateString("en-IN", {
                                  weekday: "long",
                                  day: "2-digit",
                                  month: "short",
                                  year: "numeric",
                                })}
                              </div>
                            ) : (
                              <div style={{ fontSize: 16, fontWeight: 800 }}>
                                {getPlan("followup_dur", conData?.follow_up?.duration || "")}
                              </div>
                            )}
                            {nextVisitDate && conData?.follow_up?.duration && (
                              <div style={{ fontSize: 10, color: "#64748b" }}>
                                ({conData.follow_up.duration})
                              </div>
                            )}
                            {(conData?.follow_up?.tests_to_bring || []).length > 0 && (
                              <div style={{ fontSize: 10, color: "#64748b", marginTop: 2 }}>
                                ⚠️ {conData.follow_up.tests_to_bring.map(ts).join(", ")}
                              </div>
                            )}
                          </div>
                        )}
                        <div
                          style={{
                            padding: "8px 16px",
                            background: "#f8fafc",
                            textAlign: "center",
                            fontSize: 9,
                            color: "#94a3b8",
                            borderTop: "1px solid #e2e8f0",
                          }}
                        >
                          Medicine schedule prepared at Gini Advanced Care Hospital, Mohali. Verify
                          with your doctor before changes. | 📞 0172-4120100
                        </div>
                        <div className="no-print" style={{ padding: 8, textAlign: "center" }}>
                          <button
                            onClick={() => {
                              const el = document.querySelector("[data-medcard]");
                              if (!el) return;
                              const w = window.open("", "", "width=800,height=1000");
                              w.document.write(
                                "<html><head><title>Medicine Card - " +
                                  patient.name +
                                  "</title><style>body{font-family:system-ui,sans-serif;margin:0;padding:12px}@media print{body{margin:0}}</style></head><body>",
                              );
                              w.document.write(el.innerHTML);
                              w.document.write("</body></html>");
                              w.document.close();
                              setTimeout(() => {
                                w.print();
                                w.close();
                              }, 300);
                            }}
                            style={{
                              padding: "8px 20px",
                              background: "#7c3aed",
                              color: "white",
                              border: "none",
                              borderRadius: 6,
                              fontSize: 12,
                              fontWeight: 700,
                              cursor: "pointer",
                            }}
                          >
                            🖨️ Print Medicine Card Only
                          </button>
                        </div>
                      </div>
                    );
                  })()}
              </div>
            )}

            {/* Lifestyle */}
            {planLifestyle.length > 0 && (
              <PlanBlock
                id="lifestyle"
                title="🥗 Lifestyle Changes"
                color="#059669"
                hidden={planHidden.has("lifestyle")}
                onToggle={() => toggleBlock("lifestyle")}
              >
                {planLifestyle.map((l, i) => {
                  const origIdx = sa(conData, "diet_lifestyle").indexOf(l);
                  const isString = typeof l === "string";
                  return (
                    <div
                      key={i}
                      style={{
                        display: "flex",
                        gap: 5,
                        padding: "3px 0",
                        borderBottom: "1px solid #f1f5f9",
                        fontSize: 11,
                        alignItems: "center",
                      }}
                    >
                      {!isString && l.category && (
                        <span
                          style={{
                            fontSize: 8,
                            fontWeight: 700,
                            padding: "1px 4px",
                            borderRadius: 4,
                            color: "white",
                            background:
                              l.category === "Critical"
                                ? "#dc2626"
                                : l.category === "Diet"
                                  ? "#059669"
                                  : "#2563eb",
                            alignSelf: "flex-start",
                            marginTop: 2,
                          }}
                        >
                          {l.category}
                        </span>
                      )}
                      {isString ? (
                        <div style={{ flex: 1 }}>
                          •{" "}
                          <EditText
                            value={l}
                            onChange={(v) => editLifestyleField(l, "advice", v)}
                            style={{ fontSize: 11 }}
                          />
                        </div>
                      ) : (
                        <div style={{ flex: 1 }}>
                          <EditText
                            value={l.advice}
                            onChange={(v) => editLifestyleField(l, "advice", v)}
                            style={{ fontWeight: 700, fontSize: 11 }}
                          />
                          {l.detail ? (
                            <span>
                              {" "}
                              —{" "}
                              <EditText
                                value={l.detail}
                                onChange={(v) => editLifestyleField(l, "detail", v)}
                                style={{ fontSize: 11 }}
                              />
                            </span>
                          ) : (
                            ""
                          )}{" "}
                          {(l.helps || []).map((d) => (
                            <Badge key={d} id={d} friendly />
                          ))}
                        </div>
                      )}
                      <RemoveBtn onClick={() => removeLifestyle(origIdx)} />
                    </div>
                  );
                })}
                {/* Quick Add Lifestyle */}
                {planAddMode === "lifestyle" ? (
                  <div
                    className="no-print"
                    style={{
                      display: "flex",
                      gap: 4,
                      marginTop: 6,
                      alignItems: "center",
                      background: "#f0fdf4",
                      padding: 8,
                      borderRadius: 6,
                      border: "1px solid #bbf7d0",
                    }}
                  >
                    <input
                      value={planAddText}
                      onChange={(e) => setPlanAddText(e.target.value)}
                      placeholder="e.g., Walk 30 minutes daily"
                      style={{
                        flex: 1,
                        padding: "5px 8px",
                        border: "1px solid #e2e8f0",
                        borderRadius: 4,
                        fontSize: 11,
                      }}
                      autoFocus
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && planAddText.trim()) {
                          addLifestyleToPlan({
                            advice: planAddText,
                            detail: "",
                            category: "Exercise",
                            helps: [],
                          });
                          setPlanAddText("");
                          setPlanAddMode(null);
                        }
                      }}
                    />
                    <select
                      id="planAddCat"
                      style={{
                        padding: "5px 4px",
                        border: "1px solid #e2e8f0",
                        borderRadius: 4,
                        fontSize: 10,
                      }}
                    >
                      <option>Exercise</option>
                      <option>Diet</option>
                      <option>Critical</option>
                      <option>Sleep</option>
                      <option>Stress</option>
                    </select>
                    <button
                      onClick={() => {
                        if (planAddText.trim()) {
                          addLifestyleToPlan({
                            advice: planAddText,
                            detail: "",
                            category: document.getElementById("planAddCat").value,
                            helps: [],
                          });
                          setPlanAddText("");
                          setPlanAddMode(null);
                        }
                      }}
                      style={{
                        background: "#059669",
                        color: "white",
                        border: "none",
                        padding: "5px 10px",
                        borderRadius: 4,
                        fontSize: 11,
                        fontWeight: 700,
                        cursor: "pointer",
                      }}
                    >
                      ✓
                    </button>
                    <button
                      onClick={() => {
                        setPlanAddMode(null);
                        setPlanAddText("");
                      }}
                      style={{
                        background: "#f1f5f9",
                        border: "1px solid #e2e8f0",
                        padding: "5px 8px",
                        borderRadius: 4,
                        fontSize: 11,
                        cursor: "pointer",
                      }}
                    >
                      ✕
                    </button>
                  </div>
                ) : (
                  <button
                    className="no-print"
                    onClick={() => setPlanAddMode("lifestyle")}
                    style={{
                      marginTop: 6,
                      background: "#f8fafc",
                      border: "1px dashed #cbd5e1",
                      borderRadius: 6,
                      padding: "6px 12px",
                      fontSize: 11,
                      fontWeight: 600,
                      cursor: "pointer",
                      color: "#64748b",
                      width: "100%",
                    }}
                  >
                    + Add Lifestyle Advice
                  </button>
                )}
              </PlanBlock>
            )}

            {/* Self Monitoring */}
            {planMonitors.length > 0 && (
              <PlanBlock
                id="monitoring"
                title="📊 What to Monitor at Home"
                color="#2563eb"
                hidden={planHidden.has("monitoring")}
                onToggle={() => toggleBlock("monitoring")}
              >
                {planMonitors.map((sm, i) => {
                  const origIdx = sa(conData, "self_monitoring").indexOf(sm);
                  const isString = typeof sm === "string";
                  return (
                    <div
                      key={i}
                      style={{
                        marginBottom: 6,
                        background: "#eff6ff",
                        borderRadius: 6,
                        padding: 8,
                        border: "1px solid #bfdbfe",
                      }}
                    >
                      <div style={{ display: "flex", justifyContent: "space-between" }}>
                        {isString ? (
                          <div style={{ fontSize: 11, fontWeight: 600 }}>• {sm}</div>
                        ) : (
                          <>
                            <div style={{ fontSize: 11, fontWeight: 700, color: "#1e40af" }}>
                              {sm.title}
                            </div>
                            <RemoveBtn onClick={() => removeMonitor(origIdx)} />
                          </>
                        )}
                      </div>
                      {!isString && (
                        <>
                          {(sm.instructions || []).map((ins, j) => (
                            <div key={j} style={{ fontSize: 10, color: "#334155", paddingLeft: 6 }}>
                              • {ins}
                            </div>
                          ))}
                          {sm.targets && (
                            <div
                              style={{
                                fontSize: 10,
                                fontWeight: 600,
                                color: "#059669",
                                marginTop: 3,
                              }}
                            >
                              🎯 Target: {sm.targets}
                            </div>
                          )}
                          {sm.alert && (
                            <div
                              style={{
                                fontSize: 10,
                                fontWeight: 700,
                                color: "#dc2626",
                                marginTop: 2,
                              }}
                            >
                              ⚠️ {sm.alert}
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  );
                })}
              </PlanBlock>
            )}

            {/* Investigations Ordered */}
            {(conData?.investigations_ordered || conData?.investigations_to_order || []).length >
              0 && (
              <PlanBlock
                id="investigations"
                title="🔬 Investigations Ordered"
                color="#7c3aed"
                hidden={planHidden.has("investigations")}
                onToggle={() => toggleBlock("investigations")}
              >
                <div style={{ display: "flex", flexWrap: "wrap", gap: 3 }}>
                  {(conData.investigations_ordered || conData.investigations_to_order || []).map(
                    (t, i) => (
                      <span
                        key={i}
                        style={{
                          background: "#f5f3ff",
                          border: "1px solid #c4b5fd",
                          borderRadius: 4,
                          padding: "2px 8px",
                          fontSize: 11,
                          fontWeight: 600,
                          color: "#6d28d9",
                        }}
                      >
                        {ts(t)}
                      </span>
                    ),
                  )}
                </div>
                {conData?.follow_up?.instructions && (
                  <div
                    style={{
                      marginTop: 8,
                      background: "#fefce8",
                      border: "1px solid #fde68a",
                      borderRadius: 6,
                      padding: 8,
                      fontSize: 11,
                      color: "#92400e",
                      lineHeight: 1.6,
                    }}
                  >
                    <div style={{ fontWeight: 700, marginBottom: 3 }}>📋 Instructions:</div>
                    {conData.follow_up.instructions
                      .split(/\n|(?=\d\.)/)
                      .filter(Boolean)
                      .map((line, j) => (
                        <div key={j}>• {line.trim()}</div>
                      ))}
                  </div>
                )}
              </PlanBlock>
            )}

            {/* Insulin Education */}
            {conData?.insulin_education && (
              <PlanBlock
                id="insulin"
                title="💉 Insulin Guide"
                color="#dc2626"
                hidden={planHidden.has("insulin")}
                onToggle={() => toggleBlock("insulin")}
              >
                <div style={{ border: "1px solid #fecaca", borderRadius: 8, overflow: "hidden" }}>
                  <div
                    style={{
                      background: "#dc2626",
                      color: "white",
                      padding: "6px 10px",
                      fontSize: 12,
                      fontWeight: 700,
                    }}
                  >
                    {conData.insulin_education.type} Insulin — {conData.insulin_education.device}
                  </div>
                  <div style={{ padding: 10 }}>
                    <div
                      style={{
                        marginBottom: 8,
                        background: "#f8fafc",
                        borderRadius: 6,
                        padding: 8,
                        border: "1px solid #e2e8f0",
                      }}
                    >
                      <div
                        style={{ fontSize: 11, fontWeight: 700, color: "#1e293b", marginBottom: 4 }}
                      >
                        📋 How to Inject
                      </div>
                      <div style={{ fontSize: 11, lineHeight: 1.8 }}>
                        {[
                          "Wash hands with soap",
                          "Choose injection site: " +
                            (
                              conData.insulin_education.injection_sites || ["Abdomen", "Thigh"]
                            ).join(" or "),
                          "Clean area with alcohol swab",
                          "Pinch skin gently, insert needle at 90°",
                          "Push plunger slowly, hold 10 seconds",
                          "Release skin, remove needle",
                          "Rotate injection site each time",
                        ].map((step, i) => (
                          <div
                            key={i}
                            style={{ display: "flex", gap: 6, alignItems: "flex-start" }}
                          >
                            <span
                              style={{
                                background: "#dc2626",
                                color: "white",
                                borderRadius: "50%",
                                width: 18,
                                height: 18,
                                display: "flex",
                                alignItems: "center",
                                justifyContent: "center",
                                fontSize: 9,
                                fontWeight: 800,
                                flexShrink: 0,
                              }}
                            >
                              {i + 1}
                            </span>
                            <span>{step}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                    {conData.insulin_education.titration && (
                      <div
                        style={{
                          marginBottom: 8,
                          background: "#fff7ed",
                          borderRadius: 6,
                          padding: 8,
                          border: "1px solid #fed7aa",
                        }}
                      >
                        <div
                          style={{
                            fontSize: 11,
                            fontWeight: 700,
                            color: "#9a3412",
                            marginBottom: 3,
                          }}
                        >
                          📈 Dose Adjustment (Titration)
                        </div>
                        <div style={{ fontSize: 12, fontWeight: 600 }}>
                          {conData.insulin_education.titration}
                        </div>
                        <table
                          style={{
                            width: "100%",
                            marginTop: 6,
                            borderCollapse: "collapse",
                            fontSize: 10,
                            border: "1px solid #fed7aa",
                          }}
                        >
                          <thead>
                            <tr style={{ background: "#ea580c", color: "white" }}>
                              <th style={{ padding: "3px 6px" }}>Fasting Sugar</th>
                              <th style={{ padding: "3px 6px" }}>Action</th>
                            </tr>
                          </thead>
                          <tbody>
                            <tr>
                              <td style={{ padding: "2px 6px", border: "1px solid #fed7aa" }}>
                                Above 130 mg/dL
                              </td>
                              <td
                                style={{
                                  padding: "2px 6px",
                                  border: "1px solid #fed7aa",
                                  fontWeight: 600,
                                  color: "#ea580c",
                                }}
                              >
                                ↑ Increase by 2 units
                              </td>
                            </tr>
                            <tr>
                              <td style={{ padding: "2px 6px", border: "1px solid #fed7aa" }}>
                                90-130 mg/dL
                              </td>
                              <td
                                style={{
                                  padding: "2px 6px",
                                  border: "1px solid #fed7aa",
                                  fontWeight: 600,
                                  color: "#059669",
                                }}
                              >
                                ✅ No change (at target)
                              </td>
                            </tr>
                            <tr>
                              <td style={{ padding: "2px 6px", border: "1px solid #fed7aa" }}>
                                Below 90 mg/dL
                              </td>
                              <td
                                style={{
                                  padding: "2px 6px",
                                  border: "1px solid #fed7aa",
                                  fontWeight: 600,
                                  color: "#dc2626",
                                }}
                              >
                                ↓ Decrease by 2 units
                              </td>
                            </tr>
                            <tr style={{ background: "#fef2f2" }}>
                              <td style={{ padding: "2px 6px", border: "1px solid #fed7aa" }}>
                                Below 70 mg/dL
                              </td>
                              <td
                                style={{
                                  padding: "2px 6px",
                                  border: "1px solid #fed7aa",
                                  fontWeight: 700,
                                  color: "#dc2626",
                                }}
                              >
                                🚨 STOP — call doctor
                              </td>
                            </tr>
                          </tbody>
                        </table>
                      </div>
                    )}
                    <div
                      style={{
                        background: "#fef2f2",
                        borderRadius: 6,
                        padding: 8,
                        border: "2px solid #dc2626",
                        marginBottom: 6,
                      }}
                    >
                      <div
                        style={{ fontSize: 11, fontWeight: 800, color: "#dc2626", marginBottom: 3 }}
                      >
                        🚨 LOW SUGAR EMERGENCY (Below 70 mg/dL)
                      </div>
                      <div style={{ fontSize: 11, lineHeight: 1.8 }}>
                        <div>
                          1️⃣ <strong>Eat 3 glucose tablets</strong> or 1 tablespoon sugar in water
                        </div>
                        <div>
                          2️⃣ <strong>Wait 15 minutes</strong>, recheck sugar
                        </div>
                        <div>
                          3️⃣ If still below 70 → <strong>repeat step 1</strong>
                        </div>
                        <div>
                          4️⃣ Once above 70 → <strong>eat a snack</strong> (biscuits + milk)
                        </div>
                        <div style={{ marginTop: 4, fontWeight: 700, color: "#dc2626" }}>
                          ⚠️ Always carry glucose tablets with you!
                        </div>
                      </div>
                    </div>
                    <div style={{ display: "flex", gap: 8, fontSize: 10, color: "#64748b" }}>
                      <span>
                        🧊 <strong>Storage:</strong>{" "}
                        {conData.insulin_education.storage ||
                          "Keep in fridge, room temp vial valid 28 days"}
                      </span>
                      <span>
                        🗑️ <strong>Needles:</strong>{" "}
                        {conData.insulin_education.needle_disposal ||
                          "Use sharps container, never reuse"}
                      </span>
                    </div>
                  </div>
                </div>
              </PlanBlock>
            )}

            {/* Follow Up */}
            {(conData?.follow_up || nextVisitDate) && (
              <PlanBlock
                id="followup"
                title="📅 Follow Up"
                color="#1e293b"
                hidden={planHidden.has("followup")}
                onToggle={() => toggleBlock("followup")}
              >
                <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
                  <div
                    style={{
                      background: "#f8fafc",
                      border: "2px solid #1e293b",
                      borderRadius: 6,
                      padding: "6px 14px",
                      textAlign: "center",
                      minWidth: 90,
                    }}
                  >
                    <div style={{ fontSize: 8, color: "#64748b" }}>NEXT VISIT</div>
                    {nextVisitDate ? (
                      <div style={{ fontSize: 14, fontWeight: 800, color: "#059669" }}>
                        {new Date(nextVisitDate + "T12:00:00").toLocaleDateString("en-IN", {
                          day: "2-digit",
                          month: "short",
                          year: "numeric",
                        })}
                      </div>
                    ) : (
                      <div style={{ fontSize: 18, fontWeight: 800 }}>
                        <EditText
                          value={getPlan(
                            "followup_dur",
                            conData?.follow_up?.duration?.toUpperCase() ||
                              conData?.follow_up?.date ||
                              "",
                          )}
                          onChange={(v) => editPlan("followup_dur", v)}
                          style={{ fontSize: 18, fontWeight: 800 }}
                        />
                      </div>
                    )}
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
                      <span style={{ fontSize: 10, fontWeight: 700, color: "#1e40af" }}>
                        📅 Date:
                      </span>
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
                        <span style={{ fontSize: 11, fontWeight: 700, color: "#059669" }}>
                          {new Date(nextVisitDate).toLocaleDateString("en-IN", {
                            weekday: "short",
                            day: "2-digit",
                            month: "short",
                            year: "numeric",
                          })}
                        </span>
                      )}
                    </div>
                    {(
                      conData?.follow_up?.tests_to_bring ||
                      conData?.investigations_ordered ||
                      conData?.investigations_to_order ||
                      []
                    ).length > 0 && (
                      <div>
                        <div style={{ fontSize: 11, fontWeight: 600, marginBottom: 2 }}>
                          Please bring these reports:
                        </div>
                        <div style={{ display: "flex", flexWrap: "wrap", gap: 2 }}>
                          {(
                            conData?.follow_up?.tests_to_bring ||
                            conData?.investigations_ordered ||
                            conData?.investigations_to_order ||
                            []
                          ).map((t, i) => (
                            <span
                              key={i}
                              style={{
                                background: "white",
                                border: "1px solid #e2e8f0",
                                borderRadius: 3,
                                padding: "1px 5px",
                                fontSize: 10,
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
                </div>
              </PlanBlock>
            )}

            {/* Shadow AI Suggested Tests for Treatment Plan */}
            {shadowData?.investigations?.length > 0 && (
              <PlanBlock
                id="aitests"
                title="🤖 AI Suggested Investigations"
                color="#7c3aed"
                hidden={planHidden.has("aitests")}
                onToggle={() => toggleBlock("aitests")}
              >
                <div style={{ display: "flex", flexWrap: "wrap", gap: 3 }}>
                  {shadowData.investigations.map((t, i) => (
                    <span
                      key={i}
                      style={{
                        fontSize: 10,
                        padding: "3px 8px",
                        borderRadius: 5,
                        fontWeight: 600,
                        background: "#faf5ff",
                        color: "#6d28d9",
                        border: "1px solid #c4b5fd",
                      }}
                    >
                      {ts(t)}
                    </span>
                  ))}
                </div>
              </PlanBlock>
            )}

            {/* Future Plan */}
            {planFuture.length > 0 && (
              <PlanBlock
                id="future"
                title="📋 Future Plan"
                color="#7c3aed"
                hidden={planHidden.has("future")}
                onToggle={() => toggleBlock("future")}
              >
                {planFuture.map((fp, i) => {
                  const origIdx = sa(conData, "future_plan").indexOf(fp);
                  return (
                    <div
                      key={i}
                      style={{
                        fontSize: 11,
                        padding: "2px 0",
                        display: "flex",
                        alignItems: "center",
                        gap: 4,
                      }}
                    >
                      <div style={{ flex: 1 }}>
                        <strong>If</strong> {fp.condition} → {fp.action}
                      </div>
                      <RemoveBtn onClick={() => removeFuture(origIdx)} />
                    </div>
                  );
                })}
              </PlanBlock>
            )}

            {/* Footer */}
            <div
              style={{
                borderTop: "2px solid #1e293b",
                paddingTop: 6,
                display: "flex",
                justifyContent: "space-between",
                fontSize: 10,
                color: "#94a3b8",
              }}
            >
              <div>
                {conName} | MO: {moName} | 📞 0172-4120100
              </div>
              <div>Gini Clinical Scribe v1</div>
            </div>
          </div>
        </div>
      )}

      {/* ── CLINICAL REASONING ── */}
      <ClinicalReasoningPanel />
    </div>
  );
}
