import { useNavigate } from "react-router-dom";
import { useRef } from "react";
import useAuthStore from "../stores/authStore";
import usePatientStore from "../stores/patientStore";
import useClinicalStore from "../stores/clinicalStore";
import useVitalsStore from "../stores/vitalsStore";
import useLabStore from "../stores/labStore";
import useVisitStore from "../stores/visitStore";
import useExamStore from "../stores/examStore";
import useUiStore from "../stores/uiStore";
import AudioInput from "../components/AudioInput.jsx";
import Err from "../components/Err.jsx";
import { extractLab, extractImaging } from "../services/extraction.js";
import api from "../services/api.js";
import { CONDITIONS } from "../config/conditions.js";
import { COMPLAINT_CHIPS } from "../config/chips.js";
import { toggleChip } from "../utils/helpers.js";
import "./IntakePage.css";

export default function IntakePage() {
  const navigate = useNavigate();
  const intakeReportRef = useRef(null);
  const dgKey = useAuthStore((s) => s.dgKey);
  const whisperKey = useAuthStore((s) => s.whisperKey);
  const patient = usePatientStore((s) => s.patient);
  const dbPatientId = usePatientStore((s) => s.dbPatientId);
  const pfd = usePatientStore((s) => s.getPfd());
  const setPatientFullData = usePatientStore((s) => s.setPatientFullData);
  const vitals = useVitalsStore((s) => s.vitals);
  const updateVital = useVitalsStore((s) => s.updateVital);
  const voiceFillVitals = useVitalsStore((s) => s.voiceFillVitals);
  const labData = useLabStore((s) => s.labData);
  const setLabData = useLabStore((s) => s.setLabData);
  const labImageData = useLabStore((s) => s.labImageData);
  const intakeReports = useLabStore((s) => s.intakeReports);
  const setIntakeReports = useLabStore((s) => s.setIntakeReports);
  const saveIntakeReportToDB = useLabStore((s) => s.saveIntakeReportToDB);
  const saveAllIntakeReports = useLabStore((s) => s.saveAllIntakeReports);
  const processLab = useLabStore((s) => s.processLab);
  const conData = useClinicalStore((s) => s.conData);
  const complaints = useVisitStore((s) => s.complaints);
  const setComplaints = useVisitStore((s) => s.setComplaints);
  const complaintText = useVisitStore((s) => s.complaintText);
  const setComplaintText = useVisitStore((s) => s.setComplaintText);
  const fuChecks = useVisitStore((s) => s.fuChecks);
  const setFuChecks = useVisitStore((s) => s.setFuChecks);
  const fuExtMeds = useVisitStore((s) => s.fuExtMeds);
  const setFuExtMeds = useVisitStore((s) => s.setFuExtMeds);
  const fuNewConditions = useVisitStore((s) => s.fuNewConditions);
  const setFuNewConditions = useVisitStore((s) => s.setFuNewConditions);
  const hxConditions = useExamStore((s) => s.hxConditions);
  const aiDxSuggestions = useExamStore((s) => s.aiDxSuggestions);
  const toggleHxCond = useExamStore((s) => s.toggleHxCond);
  const autoDetectDiagnoses = useExamStore((s) => s.autoDetectDiagnoses);
  const loading = useUiStore((s) => s.loading);
  const errors = useUiStore((s) => s.errors);
  const clearErr = useUiStore((s) => s.clearErr);

  return (
    <div>
      <div className="intake__header">
        <span className="intake__header-icon">📝</span>
        <div className="intake__header-info">
          <div className="intake__header-title">Intake — {patient.name || "Patient"}</div>
          <div className="intake__header-sub">
            {pfd?.consultations?.length > 0
              ? `Follow-up Visit • ${pfd.consultations.length} previous visits`
              : "Complaints + Vitals + Reports"}
          </div>
        </div>
        <span className="intake__header-step">Step 1/6</span>
      </div>

      {/* ═══ FOLLOW-UP CLINICAL DASHBOARD ═══ */}
      {pfd?.consultations?.length > 0 &&
        (() => {
          const lastCon = pfd.consultations[0];
          const lastDate = lastCon?.visit_date
            ? new Date(String(lastCon.visit_date).slice(0, 10) + "T12:00:00")
            : null;
          const daysSince = lastDate ? Math.round((Date.now() - lastDate) / 86400000) : null;
          const lastConData = conData || lastCon?.con_data || {};
          const lastGoals = lastConData.goals || [];
          const lastFollowUp = lastConData.follow_up || {};
          const orderedTests =
            lastFollowUp.tests_to_bring || lastConData.investigations_to_order || [];
          const lastMeds = lastConData.medications_confirmed || [];
          const lastStopped = lastConData.medications_stopped || [];
          const uniqueDx = [
            ...new Map((pfd.diagnoses || []).map((d) => [d.diagnosis_id || d.label, d])).values(),
          ];
          const activeMeds = (pfd.medications || []).filter((m) => m.is_active !== false);
          const uniqueMeds = [
            ...new Map(activeMeds.map((m) => [(m.name || "").toUpperCase(), m])).values(),
          ];

          // Merge historical labs + freshly loaded intake labs
          const allLabs = [...(pfd.lab_results || [])];
          const hasNewLabs = !!labData?.panels;
          if (hasNewLabs) {
            const today = new Date().toISOString().split("T")[0];
            labData.panels.forEach((p) =>
              (p.tests || []).forEach((t) => {
                allLabs.push({
                  test_name: t.test_name,
                  result: t.result_text || String(t.result),
                  unit: t.unit || "",
                  flag: t.flag,
                  test_date: labData.report_date || today,
                  _isNew: true,
                });
              }),
            );
          }
          const labsByName = {};
          allLabs.forEach((l) => {
            if (!labsByName[l.test_name]) labsByName[l.test_name] = [];
            labsByName[l.test_name].push(l);
          });
          Object.values(labsByName).forEach((arr) =>
            arr.sort((a, b) => new Date(b.test_date) - new Date(a.test_date)),
          );

          const getTrend = (name) => {
            const vals = labsByName[name] || [];
            if (!vals.length) return null;
            const latest = vals[0];
            const prev = vals.length > 1 ? vals[1] : null;
            let direction = "stable";
            if (prev) {
              const diff = parseFloat(latest.result) - parseFloat(prev.result);
              const pct = Math.abs(diff / (parseFloat(prev.result) || 1)) * 100;
              if (pct > 5) direction = diff > 0 ? "up" : "down";
            }
            return {
              vals: vals.slice(0, 4).reverse(),
              latest: latest.result,
              unit: latest.unit || "",
              prev: prev?.result,
              direction,
              isNew: latest._isNew,
              flag: latest.flag,
            };
          };

          const DX_BIO = {
            "Type 2 DM": {
              markers: ["HbA1c", "FBS", "PPBS"],
              lower: true,
              targets: { HbA1c: "<7%", FBS: "<110", PPBS: "<180" },
            },
            "Type 1 DM": {
              markers: ["HbA1c", "FBS", "PPBS"],
              lower: true,
              targets: { HbA1c: "<7%" },
            },
            "Type 2 Diabetes Mellitus": {
              markers: ["HbA1c", "FBS", "PPBS"],
              lower: true,
              targets: { HbA1c: "<7%", FBS: "<110", PPBS: "<180" },
            },
            Hypertension: { markers: [], lower: true, targets: {} },
            Dyslipidemia: {
              markers: ["LDL", "HDL", "Triglycerides", "Non-HDL", "Total Cholesterol"],
              lower: true,
              targets: { LDL: "<100", HDL: ">40", Triglycerides: "<150", "Non-HDL": "<130" },
            },
            Hypothyroidism: {
              markers: ["TSH", "Free T4"],
              lower: false,
              targets: { TSH: "0.4-4.0" },
            },
            Hypothyroid: { markers: ["TSH", "Free T4"], lower: false, targets: { TSH: "0.4-4.0" } },
            CKD: {
              markers: ["Creatinine", "eGFR", "UACR"],
              lower: true,
              targets: { eGFR: ">60", UACR: "<30" },
            },
            Obesity: { markers: [], lower: true, targets: {} },
            CAD: { markers: ["LDL", "Triglycerides"], lower: true, targets: { LDL: "<70" } },
            "NAFLD/MAFLD": { markers: ["SGPT (ALT)", "SGOT (AST)"], lower: true, targets: {} },
            MASLD: { markers: ["SGPT (ALT)", "SGOT (AST)", "GGT"], lower: true, targets: {} },
            "Vit D Deficiency": {
              markers: ["Vitamin D"],
              lower: false,
              targets: { "Vitamin D": ">30" },
            },
            "B12 Deficiency": {
              markers: ["Vitamin B12"],
              lower: false,
              targets: { "Vitamin B12": ">300" },
            },
            "DM Nephropathy": {
              markers: ["UACR", "eGFR", "Creatinine"],
              lower: true,
              targets: { UACR: "<30", eGFR: ">60" },
            },
            Gout: { markers: ["Uric Acid"], lower: true, targets: { "Uric Acid": "<6" } },
          };
          const findBio = (label) =>
            DX_BIO[label] ||
            DX_BIO[
              Object.keys(DX_BIO).find((k) => label?.toLowerCase().includes(k.toLowerCase()))
            ] ||
            null;

          const allMarkers = new Map();
          uniqueDx.forEach((dx) => {
            const bio = findBio(dx.label);
            if (!bio) return;
            bio.markers.forEach((m) => {
              const t = getTrend(m);
              if (!t) return;
              const existing = allMarkers.get(m);
              const goal = lastGoals.find((g) => g.marker === m);
              const target = goal?.target || bio.targets?.[m] || "";
              if (existing) {
                existing.dxLabels.push(dx.label);
              } else {
                const linkedMeds = uniqueMeds.filter((med) => {
                  const forDx = (med.for_diagnosis || med.forDiagnosis || []).map((d) =>
                    d.toLowerCase(),
                  );
                  return forDx.some((f) =>
                    dx.label
                      .toLowerCase()
                      .split(/[\s\/]+/)
                      .some((k) => f.includes(k)),
                  );
                });
                allMarkers.set(m, {
                  name: m,
                  dxLabels: [dx.label],
                  lower: bio.lower,
                  target,
                  trend: t,
                  meds: linkedMeds,
                  goal,
                });
              }
            });
          });

          const flaggedNew = [];
          if (hasNewLabs) {
            labData.panels.forEach((p) =>
              (p.tests || []).forEach((t) => {
                if ((t.flag === "H" || t.flag === "L") && !allMarkers.has(t.test_name)) {
                  flaggedNew.push({
                    name: t.test_name,
                    result: t.result_text || String(t.result),
                    unit: t.unit || "",
                    flag: t.flag,
                  });
                }
              }),
            );
          }

          const getStatusBadge = (marker) => {
            const t = marker.trend;
            const improving =
              (marker.lower && t.direction === "down") || (!marker.lower && t.direction === "up");
            const worsening =
              (marker.lower && t.direction === "up") || (!marker.lower && t.direction === "down");
            if (worsening) return { label: "Worsening", bg: "#dc2626", icon: "📉" };
            if (improving) return { label: "Improving", bg: "#059669", icon: "📈" };
            return { label: "Stable", bg: "#d97706", icon: "➡️" };
          };

          return (
            <div
              style={{
                marginBottom: 14,
                borderRadius: 12,
                overflow: "hidden",
                boxShadow: "0 4px 24px rgba(124,58,237,.15)",
              }}
            >
              {/* ── HEADER ── */}
              <div
                style={{
                  background: "linear-gradient(135deg,#7c3aed,#4f46e5)",
                  color: "white",
                  padding: "14px 16px",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
                  <span style={{ fontSize: 24 }}>🔄</span>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 17, fontWeight: 900, letterSpacing: "-0.3px" }}>
                      Follow-up Dashboard
                    </div>
                    <div style={{ fontSize: 12, opacity: 0.85 }}>
                      Last:{" "}
                      {lastDate
                        ? lastDate.toLocaleDateString("en-IN", {
                            day: "2-digit",
                            month: "short",
                            year: "numeric",
                          })
                        : "—"}
                      {daysSince ? ` • ${daysSince} days ago` : ""} •{" "}
                      {lastCon.con_name || lastCon.mo_name || ""} • Visit #
                      {pfd.consultations.length + 1}
                    </div>
                  </div>
                  {hasNewLabs ? (
                    <span
                      style={{
                        fontSize: 12,
                        background: "#10b981",
                        padding: "5px 14px",
                        borderRadius: 8,
                        fontWeight: 800,
                      }}
                    >
                      🧪 Today's labs loaded
                    </span>
                  ) : (
                    <span
                      style={{
                        fontSize: 12,
                        background: "rgba(255,255,255,.2)",
                        padding: "5px 14px",
                        borderRadius: 8,
                        fontWeight: 700,
                        animation: "pulse 2s infinite",
                      }}
                    >
                      📤 Upload reports below
                    </span>
                  )}
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
                  {uniqueDx.slice(0, 10).map((dx, i) => {
                    const statusColor =
                      dx.status === "Uncontrolled"
                        ? "#fca5a5"
                        : dx.status === "Controlled"
                          ? "#86efac"
                          : "rgba(255,255,255,.4)";
                    return (
                      <span
                        key={i}
                        style={{
                          padding: "4px 12px",
                          borderRadius: 6,
                          fontSize: 12,
                          fontWeight: 700,
                          background: "rgba(255,255,255,.15)",
                          border: `1.5px solid ${statusColor}`,
                          color: "white",
                        }}
                      >
                        {dx.label} <span style={{ opacity: 0.7 }}>• {dx.status || "Active"}</span>
                      </span>
                    );
                  })}
                </div>
              </div>

              {/* ── LAST TREATMENT PLAN (always visible) ── */}
              <div
                style={{
                  padding: "12px 16px",
                  background: "linear-gradient(135deg,#faf5ff,#eff6ff)",
                  borderBottom: "2px solid #e9d5ff",
                }}
              >
                <div
                  style={{
                    fontSize: 14,
                    fontWeight: 900,
                    color: "#6d28d9",
                    marginBottom: 8,
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                  }}
                >
                  📋 Last Treatment Plan
                  <span style={{ fontSize: 11, color: "#94a3b8", fontWeight: 500 }}>
                    —{" "}
                    {lastDate
                      ? lastDate.toLocaleDateString("en-IN", {
                          day: "2-digit",
                          month: "short",
                          year: "numeric",
                        })
                      : ""}
                  </span>
                </div>
                {/* Medications table */}
                {(lastMeds.length > 0 || uniqueMeds.length > 0) && (
                  <div style={{ marginBottom: 10 }}>
                    <div
                      style={{ fontSize: 12, fontWeight: 800, color: "#1e40af", marginBottom: 4 }}
                    >
                      💊 Current Medications
                    </div>
                    <table style={{ width: "100%", borderCollapse: "collapse" }}>
                      <tbody>
                        {(lastMeds.length > 0 ? lastMeds : uniqueMeds).map((m, i) => (
                          <tr key={i} style={{ borderBottom: "1px solid #e9d5ff" }}>
                            <td
                              style={{
                                padding: "5px 8px",
                                fontSize: 12,
                                fontWeight: 700,
                                color: "#1e293b",
                              }}
                            >
                              {m.name}
                              {m.isNew && (
                                <span
                                  style={{
                                    fontSize: 8,
                                    color: "#059669",
                                    fontWeight: 800,
                                    marginLeft: 4,
                                    background: "#f0fdf4",
                                    padding: "1px 4px",
                                    borderRadius: 3,
                                  }}
                                >
                                  NEW
                                </span>
                              )}
                              {m._shadowAction === "MODIFY" && (
                                <span
                                  style={{
                                    fontSize: 8,
                                    color: "#f59e0b",
                                    fontWeight: 800,
                                    marginLeft: 4,
                                    background: "#fefce8",
                                    padding: "1px 4px",
                                    borderRadius: 3,
                                  }}
                                >
                                  MOD
                                </span>
                              )}
                            </td>
                            <td style={{ padding: "5px 8px", fontSize: 11, color: "#475569" }}>
                              {m.dose || ""}
                            </td>
                            <td style={{ padding: "5px 8px", fontSize: 11, color: "#475569" }}>
                              {m.frequency || ""}
                            </td>
                            <td style={{ padding: "5px 8px", fontSize: 11, color: "#64748b" }}>
                              {m.timing || ""}
                            </td>
                            <td style={{ padding: "5px 8px", fontSize: 10, color: "#94a3b8" }}>
                              {(m.forDiagnosis || []).join(", ")}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                {lastStopped.length > 0 && (
                  <div style={{ marginBottom: 8 }}>
                    <div
                      style={{ fontSize: 11, fontWeight: 700, color: "#dc2626", marginBottom: 3 }}
                    >
                      🛑 Stopped
                    </div>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                      {lastStopped.map((m, i) => (
                        <span
                          key={i}
                          style={{
                            fontSize: 11,
                            padding: "3px 10px",
                            background: "#fef2f2",
                            borderRadius: 5,
                            color: "#dc2626",
                            fontWeight: 600,
                            textDecoration: "line-through",
                          }}
                        >
                          {m.name} {m.reason ? `— ${m.reason}` : ""}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
                {/* Goals row */}
                {lastGoals.length > 0 && (
                  <div>
                    <div
                      style={{ fontSize: 12, fontWeight: 800, color: "#1e40af", marginBottom: 4 }}
                    >
                      🎯 Goals
                    </div>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                      {lastGoals.map((g, i) => {
                        const t = getTrend(g.marker);
                        const mk = allMarkers.get(g.marker);
                        const st = mk ? getStatusBadge(mk) : null;
                        return (
                          <div
                            key={i}
                            style={{
                              padding: "8px 12px",
                              background: "white",
                              borderRadius: 8,
                              border: `2px solid ${st?.bg || "#e2e8f0"}`,
                              borderLeft: `5px solid ${st?.bg || "#94a3b8"}`,
                              minWidth: 150,
                            }}
                          >
                            <div style={{ fontSize: 14, fontWeight: 800, color: "#1e293b" }}>
                              {g.marker}
                            </div>
                            <div style={{ fontSize: 11, color: "#64748b" }}>
                              {g.current ? `Was: ${g.current} → ` : ""}Target: <b>{g.target}</b>
                            </div>
                            {t ? (
                              <div
                                style={{
                                  display: "flex",
                                  alignItems: "center",
                                  gap: 6,
                                  marginTop: 4,
                                }}
                              >
                                <span
                                  style={{
                                    fontSize: 16,
                                    fontWeight: 900,
                                    color: st?.bg || "#475569",
                                  }}
                                >
                                  {t.latest}
                                  {t.unit}
                                </span>
                                {t.isNew && (
                                  <span
                                    style={{
                                      fontSize: 9,
                                      background: "#10b981",
                                      color: "white",
                                      padding: "1px 6px",
                                      borderRadius: 3,
                                      fontWeight: 800,
                                    }}
                                  >
                                    TODAY
                                  </span>
                                )}
                                {st && (
                                  <span
                                    style={{
                                      fontSize: 10,
                                      fontWeight: 700,
                                      color: "white",
                                      background: st.bg,
                                      padding: "2px 8px",
                                      borderRadius: 4,
                                    }}
                                  >
                                    {st.icon} {st.label}
                                  </span>
                                )}
                              </div>
                            ) : (
                              <div
                                style={{
                                  fontSize: 11,
                                  color: "#d97706",
                                  fontStyle: "italic",
                                  marginTop: 3,
                                }}
                              >
                                ⏳ Awaiting labs
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>

              {/* ── ORDERED TESTS (prominent when labs not loaded) ── */}
              {orderedTests.length > 0 && (
                <div
                  style={{
                    padding: "12px 16px",
                    background: hasNewLabs ? "#f0fdf4" : "#fffbeb",
                    borderBottom: "2px solid " + (hasNewLabs ? "#bbf7d0" : "#fde68a"),
                  }}
                >
                  <div
                    style={{
                      fontSize: 14,
                      fontWeight: 800,
                      color: hasNewLabs ? "#059669" : "#92400e",
                      marginBottom: 6,
                    }}
                  >
                    📋 Tests Ordered Last Visit{" "}
                    {!hasNewLabs && "— Upload reports to see updated trends"}
                  </div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                    {orderedTests.map((t, i) => {
                      const testName = typeof t === "string" ? t : t.test || t;
                      const done = (labsByName[testName] || []).some(
                        (l) => l.test_date && new Date(l.test_date) > (lastDate || new Date(0)),
                      );
                      return (
                        <span
                          key={i}
                          style={{
                            padding: "5px 12px",
                            borderRadius: 6,
                            fontSize: 12,
                            fontWeight: 700,
                            background: done ? "#f0fdf4" : "white",
                            color: done ? "#059669" : "#d97706",
                            border: `1.5px solid ${done ? "#bbf7d0" : "#fde68a"}`,
                          }}
                        >
                          {done ? "✅" : "⏳"} {testName}
                        </span>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* ── BIOMARKER TREND TABLE (historical + today) ── */}
              {allMarkers.size > 0 && (
                <div
                  style={{
                    padding: "12px 16px",
                    background: "white",
                    borderBottom: "1px solid #e2e8f0",
                  }}
                >
                  <div style={{ fontSize: 14, fontWeight: 900, color: "#1e293b", marginBottom: 8 }}>
                    🧪 Biomarker Trends {hasNewLabs ? "+ Today's Results" : "(Historical)"}
                  </div>
                  <div style={{ overflowX: "auto" }}>
                    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                      <thead>
                        <tr
                          style={{
                            background: "#f8fafc",
                            fontSize: 10,
                            fontWeight: 700,
                            color: "#64748b",
                            textTransform: "uppercase",
                            letterSpacing: "0.5px",
                          }}
                        >
                          <td style={{ padding: "8px", borderBottom: "2px solid #e2e8f0" }}>
                            Marker
                          </td>
                          <td
                            style={{
                              padding: "8px",
                              borderBottom: "2px solid #e2e8f0",
                              textAlign: "center",
                            }}
                          >
                            Trend
                          </td>
                          <td
                            style={{
                              padding: "8px",
                              borderBottom: "2px solid #e2e8f0",
                              textAlign: "center",
                            }}
                          >
                            Latest
                          </td>
                          <td
                            style={{
                              padding: "8px",
                              borderBottom: "2px solid #e2e8f0",
                              textAlign: "center",
                            }}
                          >
                            Target
                          </td>
                          <td
                            style={{
                              padding: "8px",
                              borderBottom: "2px solid #e2e8f0",
                              textAlign: "center",
                            }}
                          >
                            Status
                          </td>
                          <td style={{ padding: "8px", borderBottom: "2px solid #e2e8f0" }}>
                            Medications
                          </td>
                        </tr>
                      </thead>
                      <tbody>
                        {[...allMarkers.values()].map((mk, i) => {
                          const st = getStatusBadge(mk);
                          const vals = mk.trend.vals || [];
                          return (
                            <tr
                              key={i}
                              style={{
                                borderBottom: "1px solid #f1f5f9",
                                background: i % 2 === 0 ? "white" : "#fafbfc",
                              }}
                            >
                              <td style={{ padding: "8px", fontWeight: 700, color: "#1e293b" }}>
                                <div style={{ fontSize: 12 }}>{mk.name}</div>
                                <div style={{ fontSize: 9, color: "#94a3b8", fontWeight: 500 }}>
                                  {mk.dxLabels.join(", ")}
                                </div>
                              </td>
                              <td style={{ padding: "8px", textAlign: "center" }}>
                                <div
                                  style={{
                                    display: "flex",
                                    alignItems: "center",
                                    justifyContent: "center",
                                    gap: 3,
                                    flexWrap: "wrap",
                                  }}
                                >
                                  {vals.map((v, vi) => {
                                    const isLast = vi === vals.length - 1;
                                    return (
                                      <span
                                        key={vi}
                                        style={{
                                          display: "inline-flex",
                                          alignItems: "center",
                                          gap: 3,
                                        }}
                                      >
                                        <span
                                          style={{
                                            fontSize: isLast ? 14 : 10,
                                            fontWeight: isLast ? 800 : 500,
                                            color: isLast ? st.bg : "#94a3b8",
                                            background: isLast ? `${st.bg}12` : "none",
                                            padding: isLast ? "2px 6px" : "0",
                                            borderRadius: 4,
                                          }}
                                        >
                                          {parseFloat(v.result) || v.result}
                                        </span>
                                        {vi < vals.length - 1 && (
                                          <span style={{ color: "#d1d5db", fontSize: 9 }}>→</span>
                                        )}
                                      </span>
                                    );
                                  })}
                                </div>
                                {mk.trend.isNew && (
                                  <div
                                    style={{
                                      fontSize: 9,
                                      color: "#10b981",
                                      fontWeight: 800,
                                      marginTop: 2,
                                    }}
                                  >
                                    ● TODAY
                                  </div>
                                )}
                              </td>
                              <td
                                style={{
                                  padding: "8px",
                                  textAlign: "center",
                                  fontSize: 16,
                                  fontWeight: 900,
                                  color: st.bg,
                                }}
                              >
                                {mk.trend.latest}
                                {mk.trend.unit}
                              </td>
                              <td
                                style={{
                                  padding: "8px",
                                  textAlign: "center",
                                  fontSize: 12,
                                  fontWeight: 600,
                                  color: "#475569",
                                }}
                              >
                                {mk.target || "—"}
                              </td>
                              <td style={{ padding: "8px", textAlign: "center" }}>
                                <span
                                  style={{
                                    fontSize: 11,
                                    fontWeight: 700,
                                    color: "white",
                                    background: st.bg,
                                    padding: "3px 10px",
                                    borderRadius: 5,
                                    whiteSpace: "nowrap",
                                  }}
                                >
                                  {st.icon} {st.label}
                                </span>
                              </td>
                              <td style={{ padding: "8px" }}>
                                <div style={{ display: "flex", flexWrap: "wrap", gap: 2 }}>
                                  {mk.meds.length > 0 ? (
                                    mk.meds.slice(0, 3).map((m, mi) => (
                                      <span
                                        key={mi}
                                        style={{
                                          fontSize: 9,
                                          padding: "2px 6px",
                                          background: "#eff6ff",
                                          color: "#2563eb",
                                          borderRadius: 3,
                                          fontWeight: 600,
                                        }}
                                      >
                                        {m.name} {m.dose || ""}
                                      </span>
                                    ))
                                  ) : (
                                    <span style={{ fontSize: 9, color: "#cbd5e1" }}>—</span>
                                  )}
                                </div>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* ── FLAGGED NEW FINDINGS (only after labs loaded) ── */}
              {flaggedNew.length > 0 && (
                <div
                  style={{
                    padding: "12px 16px",
                    background: "#fef2f2",
                    borderBottom: "1px solid #fecaca",
                  }}
                >
                  <div style={{ fontSize: 14, fontWeight: 900, color: "#dc2626", marginBottom: 6 }}>
                    🚨 New Abnormal Findings (Today)
                  </div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                    {flaggedNew.map((f, i) => (
                      <span
                        key={i}
                        style={{
                          padding: "6px 14px",
                          background: "white",
                          borderRadius: 8,
                          fontSize: 13,
                          fontWeight: 700,
                          border: `2px solid ${f.flag === "H" ? "#dc2626" : "#2563eb"}`,
                          color: f.flag === "H" ? "#dc2626" : "#2563eb",
                        }}
                      >
                        {f.flag === "H" ? "⬆" : "⬇"} {f.name}: {f.result}
                        {f.unit}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {/* ── CHANGES SINCE LAST VISIT ── */}
              <div
                style={{
                  padding: "12px 16px",
                  background: "#f8fafc",
                  borderBottom: "1px solid #e2e8f0",
                }}
              >
                <div style={{ fontSize: 13, fontWeight: 800, color: "#1e293b", marginBottom: 8 }}>
                  🔀 Changes Since Last Visit
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                  <div>
                    <div
                      style={{ fontSize: 12, fontWeight: 700, color: "#92400e", marginBottom: 4 }}
                    >
                      💊 New External Medicines
                    </div>
                    {fuExtMeds.map((m, i) => (
                      <div
                        key={i}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 4,
                          padding: "4px 10px",
                          background: "#fef3c7",
                          borderRadius: 6,
                          marginBottom: 3,
                          fontSize: 12,
                          fontWeight: 600,
                        }}
                      >
                        <span style={{ flex: 1 }}>
                          {m.name} {m.dose}{" "}
                          {m.doctor ? (
                            <span style={{ color: "#64748b", fontWeight: 400 }}>— {m.doctor}</span>
                          ) : (
                            ""
                          )}
                        </span>
                        <button
                          onClick={() => setFuExtMeds((p) => p.filter((_, j) => j !== i))}
                          style={{
                            background: "none",
                            border: "none",
                            cursor: "pointer",
                            color: "#dc2626",
                            fontSize: 14,
                            padding: 0,
                          }}
                        >
                          ×
                        </button>
                      </div>
                    ))}
                    <div style={{ display: "flex", gap: 4, marginTop: 4 }}>
                      <input
                        id="fuExtMedName"
                        placeholder="Medicine name"
                        style={{
                          flex: 2,
                          padding: "7px 10px",
                          border: "1.5px solid #e2e8f0",
                          borderRadius: 6,
                          fontSize: 12,
                        }}
                      />
                      <input
                        id="fuExtMedDose"
                        placeholder="Dose"
                        style={{
                          flex: 1,
                          padding: "7px 10px",
                          border: "1.5px solid #e2e8f0",
                          borderRadius: 6,
                          fontSize: 12,
                        }}
                      />
                      <input
                        id="fuExtMedDoc"
                        placeholder="Dr. name"
                        style={{
                          flex: 1,
                          padding: "7px 10px",
                          border: "1.5px solid #e2e8f0",
                          borderRadius: 6,
                          fontSize: 12,
                        }}
                      />
                      <button
                        onClick={() => {
                          const n = document.getElementById("fuExtMedName");
                          const d = document.getElementById("fuExtMedDose");
                          const dr = document.getElementById("fuExtMedDoc");
                          if (n.value.trim()) {
                            setFuExtMeds((p) => [
                              ...p,
                              {
                                name: n.value.trim(),
                                dose: d.value.trim(),
                                doctor: dr.value.trim(),
                              },
                            ]);
                            n.value = "";
                            d.value = "";
                            dr.value = "";
                          }
                        }}
                        style={{
                          padding: "7px 14px",
                          background: "#f59e0b",
                          color: "white",
                          border: "none",
                          borderRadius: 6,
                          fontSize: 15,
                          fontWeight: 800,
                          cursor: "pointer",
                        }}
                      >
                        +
                      </button>
                    </div>
                  </div>
                  <div>
                    <div
                      style={{ fontSize: 12, fontWeight: 700, color: "#dc2626", marginBottom: 4 }}
                    >
                      🆕 New Conditions / Diagnoses
                    </div>
                    {fuNewConditions.map((c, i) => (
                      <div
                        key={i}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 4,
                          padding: "4px 10px",
                          background: "#fee2e2",
                          borderRadius: 6,
                          marginBottom: 3,
                          fontSize: 12,
                          fontWeight: 600,
                        }}
                      >
                        <span style={{ flex: 1 }}>{c}</span>
                        <button
                          onClick={() => setFuNewConditions((p) => p.filter((_, j) => j !== i))}
                          style={{
                            background: "none",
                            border: "none",
                            cursor: "pointer",
                            color: "#dc2626",
                            fontSize: 14,
                            padding: 0,
                          }}
                        >
                          ×
                        </button>
                      </div>
                    ))}
                    <div style={{ display: "flex", gap: 4, marginTop: 4 }}>
                      <input
                        id="fuNewCond"
                        placeholder="e.g. Sleep apnea by pulmonologist"
                        style={{
                          flex: 1,
                          padding: "7px 10px",
                          border: "1.5px solid #e2e8f0",
                          borderRadius: 6,
                          fontSize: 12,
                        }}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && e.target.value.trim()) {
                            setFuNewConditions((p) => [...p, e.target.value.trim()]);
                            e.target.value = "";
                          }
                        }}
                      />
                      <button
                        onClick={() => {
                          const el = document.getElementById("fuNewCond");
                          if (el.value.trim()) {
                            setFuNewConditions((p) => [...p, el.value.trim()]);
                            el.value = "";
                          }
                        }}
                        style={{
                          padding: "7px 14px",
                          background: "#dc2626",
                          color: "white",
                          border: "none",
                          borderRadius: 6,
                          fontSize: 15,
                          fontWeight: 800,
                          cursor: "pointer",
                        }}
                      >
                        +
                      </button>
                    </div>
                  </div>
                </div>
              </div>

              {/* ── QUICK ASSESSMENT ── */}
              <div style={{ padding: "14px 16px", background: "white" }}>
                <div style={{ fontSize: 14, fontWeight: 900, color: "#1e293b", marginBottom: 10 }}>
                  📝 Quick Assessment
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                  {[
                    {
                      key: "medCompliance",
                      label: "💊 Medicine Compliance",
                      opts: ["Good", "Partial", "Poor", "Missed doses"],
                      colors: ["#059669", "#d97706", "#dc2626", "#dc2626"],
                    },
                    {
                      key: "dietExercise",
                      label: "🥗 Diet & Exercise",
                      opts: ["Adherent", "Partial", "Not following", "Improved"],
                      colors: ["#059669", "#d97706", "#dc2626", "#2563eb"],
                    },
                    {
                      key: "sideEffects",
                      label: "⚠️ Side Effects",
                      opts: ["None", "Mild", "Significant", "Needs change"],
                      colors: ["#059669", "#d97706", "#dc2626", "#dc2626"],
                    },
                    {
                      key: "newSymptoms",
                      label: "🆕 New Symptoms",
                      opts: ["None", "Mild", "Concerning", "Urgent"],
                      colors: ["#059669", "#d97706", "#dc2626", "#dc2626"],
                    },
                  ].map((q) => (
                    <div key={q.key}>
                      <div
                        style={{ fontSize: 13, fontWeight: 700, color: "#374151", marginBottom: 5 }}
                      >
                        {q.label}
                      </div>
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
                        {q.opts.map((o, oi) => {
                          const active = fuChecks[q.key] === o;
                          const cl = q.colors[oi];
                          return (
                            <button
                              key={o}
                              onClick={() =>
                                setFuChecks((p) => ({ ...p, [q.key]: p[q.key] === o ? "" : o }))
                              }
                              style={{
                                fontSize: 13,
                                padding: "8px 16px",
                                borderRadius: 8,
                                cursor: "pointer",
                                fontWeight: 700,
                                transition: "all .15s",
                                border: `2px solid ${active ? cl : "#e2e8f0"}`,
                                background: active ? cl : "white",
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
                <div style={{ marginTop: 10 }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: "#374151", marginBottom: 4 }}>
                    💬 Challenges / Notes
                  </div>
                  <textarea
                    value={fuChecks.challenges}
                    onChange={(e) => setFuChecks((p) => ({ ...p, challenges: e.target.value }))}
                    placeholder="Patient reports: difficulty with morning meds, sugar cravings at night, new numbness in feet..."
                    rows={2}
                    style={{
                      width: "100%",
                      fontSize: 14,
                      padding: 12,
                      border: "2px solid #e2e8f0",
                      borderRadius: 8,
                      resize: "vertical",
                      boxSizing: "border-box",
                      lineHeight: 1.5,
                    }}
                  />
                </div>
              </div>
            </div>
          );
        })()}

      {/* Chief Complaints */}
      <div className="intake__section">
        <div className="intake__section-title">🗣️ Chief Complaints</div>
        <div className="intake__chips">
          {COMPLAINT_CHIPS.map((c) => (
            <button
              key={c}
              onClick={() => toggleChip(complaints, setComplaints, c)}
              className="intake__chip"
              style={{
                border: `1.5px solid ${complaints.includes(c) ? "#2563eb" : "#e2e8f0"}`,
                background: complaints.includes(c) ? "#eff6ff" : "white",
                color: complaints.includes(c) ? "#2563eb" : "#64748b",
              }}
            >
              {c}
            </button>
          ))}
        </div>
        <div className="intake__add-row">
          <input
            value={complaintText}
            onChange={(e) => setComplaintText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && complaintText.trim()) {
                setComplaints([...complaints, complaintText.trim()]);
                setComplaintText("");
              }
            }}
            placeholder="Other complaint + Enter"
            style={{
              flex: 1,
              padding: "8px 10px",
              border: "1px solid #e2e8f0",
              borderRadius: 6,
              fontSize: 12,
              boxSizing: "border-box",
            }}
          />
          <AudioInput
            label="🎤"
            dgKey={dgKey}
            whisperKey={whisperKey}
            color="#059669"
            compact
            onTranscript={(t) => {
              if (t.trim()) setComplaints([...complaints, t.trim()]);
            }}
          />
        </div>
        {complaints.length > 0 && (
          <div style={{ marginTop: 4, display: "flex", flexWrap: "wrap", gap: 3 }}>
            {complaints.map((c, i) => (
              <span
                key={i}
                style={{
                  padding: "3px 8px",
                  background: "#2563eb",
                  color: "white",
                  borderRadius: 5,
                  fontSize: 10,
                  fontWeight: 600,
                  display: "flex",
                  alignItems: "center",
                  gap: 4,
                }}
              >
                {c}
                <button
                  onClick={() => setComplaints(complaints.filter((_, j) => j !== i))}
                  style={{
                    background: "none",
                    border: "none",
                    color: "white",
                    cursor: "pointer",
                    fontSize: 10,
                    padding: 0,
                  }}
                >
                  ✕
                </button>
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Vitals (same as existing vitals section) */}
      <div className="intake__section">
        <div className="intake__section-title">💓 Vitals</div>
        <AudioInput
          label="Say vitals: BP 140/90, weight 80kg"
          dgKey={dgKey}
          whisperKey={whisperKey}
          color="#ea580c"
          compact
          onTranscript={voiceFillVitals}
        />
        {loading.vv && (
          <div style={{ textAlign: "center", padding: 3, fontSize: 10, color: "#ea580c" }}>
            🔬 Filling...
          </div>
        )}
        <Err msg={errors.vv} onDismiss={() => clearErr("vv")} />
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 5, marginTop: 4 }}>
          {[
            { k: "bp_sys", l: "BP Sys" },
            { k: "bp_dia", l: "BP Dia" },
            { k: "pulse", l: "Pulse" },
            { k: "temp", l: "Temp °F" },
            { k: "spo2", l: "SpO2 %" },
            { k: "weight", l: "Wt kg" },
            { k: "height", l: "Ht cm" },
            { k: "bmi", l: "BMI", disabled: true },
            { k: "waist", l: "Waist cm" },
            { k: "body_fat", l: "Body Fat %" },
            { k: "muscle_mass", l: "Muscle kg" },
          ].map((v) => (
            <div key={v.k}>
              <label style={{ fontSize: 9, fontWeight: 600, color: "#64748b" }}>{v.l}</label>
              <input
                type="number"
                value={vitals[v.k]}
                onChange={(e) => updateVital(v.k, e.target.value)}
                disabled={v.disabled}
                style={{
                  width: "100%",
                  padding: "4px 6px",
                  border: "1px solid #e2e8f0",
                  borderRadius: 4,
                  fontSize: 14,
                  fontWeight: 600,
                  boxSizing: "border-box",
                  background: v.disabled ? "#f0fdf4" : "white",
                }}
              />
            </div>
          ))}
        </div>
      </div>

      {/* Lab Upload — MULTIPLE REPORTS */}
      <div className="intake__section">
        <div className="intake__section-title intake__section-title--purple">🔬 Upload Reports</div>
        <div style={{ display: "flex", gap: 4, marginBottom: 6 }}>
          <div
            onClick={() => intakeReportRef.current?.click()}
            style={{
              flex: 1,
              border: "2px dashed #c4b5fd",
              borderRadius: 8,
              padding: 10,
              textAlign: "center",
              cursor: "pointer",
              background: "#faf5ff",
            }}
          >
            <input
              ref={intakeReportRef}
              type="file"
              accept="image/*,.pdf,.heic,.heif"
              multiple
              onChange={(e) => {
                Array.from(e.target.files).forEach((file) => {
                  const reader = new FileReader();
                  reader.onload = (ev) => {
                    const base64 = ev.target.result.split(",")[1];
                    const mediaType = file.type || "image/jpeg";
                    setIntakeReports((prev) => [
                      ...prev,
                      {
                        id: "rpt_" + Date.now() + Math.random(),
                        type: "lab",
                        base64,
                        mediaType,
                        fileName: file.name,
                        data: null,
                        extracting: false,
                        error: null,
                      },
                    ]);
                  };
                  reader.readAsDataURL(file);
                });
                e.target.value = "";
              }}
              style={{ display: "none" }}
            />
            <div style={{ fontSize: 18 }}>📋</div>
            <div style={{ fontWeight: 600, color: "#7c3aed", fontSize: 11 }}>
              Upload Lab / Imaging Reports
            </div>
            <div style={{ fontSize: 9, color: "#94a3b8" }}>Multiple files supported</div>
          </div>
          {/* Also keep old single upload for backward compat */}
          {labImageData && !labData && (
            <button
              onClick={processLab}
              disabled={loading.lab}
              style={{
                alignSelf: "stretch",
                background: loading.lab ? "#94a3b8" : "#7c3aed",
                color: "white",
                border: "none",
                padding: "10px 14px",
                borderRadius: 8,
                fontSize: 12,
                fontWeight: 700,
                cursor: loading.lab ? "wait" : "pointer",
              }}
            >
              {loading.lab ? "🔬 Extracting..." : "🔬 Extract"}
            </button>
          )}
        </div>

        {/* Report type selector + extract */}
        {intakeReports.length > 0 && (
          <div style={{ marginBottom: 6 }}>
            {intakeReports.map((rpt) => (
              <div
                key={rpt.id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "6px 8px",
                  marginBottom: 3,
                  borderRadius: 6,
                  background: rpt.saved
                    ? "#f0fdf4"
                    : rpt.saveError
                      ? "#fef2f2"
                      : rpt.data
                        ? "#faf5ff"
                        : rpt.error
                          ? "#fef2f2"
                          : "#f8fafc",
                  border: `1px solid ${rpt.saved ? "#bbf7d0" : rpt.saveError ? "#fecaca" : rpt.data ? "#c4b5fd" : rpt.error ? "#fecaca" : "#e2e8f0"}`,
                }}
              >
                <span style={{ fontSize: 12 }}>
                  {rpt.saved
                    ? "✅"
                    : rpt.type === "lab"
                      ? "🔬"
                      : rpt.type === "imaging"
                        ? "📡"
                        : "📋"}
                </span>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 11, fontWeight: 700 }}>{rpt.fileName}</div>
                  {rpt.data && (
                    <div style={{ fontSize: 9, color: "#059669" }}>
                      {rpt.data.panels?.reduce((a, p) => a + p.tests.length, 0) || 0} tests
                      {rpt.data.lab_name && (
                        <span style={{ color: "#7c3aed" }}> • {rpt.data.lab_name}</span>
                      )}
                      {rpt.data.report_date && (
                        <span style={{ color: "#2563eb" }}> • {rpt.data.report_date}</span>
                      )}
                      {!rpt.data.report_date && (
                        <span style={{ color: "#dc2626" }}> • ⚠️ No date found</span>
                      )}
                    </div>
                  )}
                  {rpt.saved && (
                    <div style={{ fontSize: 9, color: "#059669", fontWeight: 700 }}>
                      💾 Saved to patient record
                    </div>
                  )}
                  {rpt.saving && <div style={{ fontSize: 9, color: "#7c3aed" }}>⏳ Saving...</div>}
                  {rpt.saveError && (
                    <div style={{ fontSize: 9, color: "#dc2626" }}>
                      ❌ Save failed: {rpt.saveError}
                    </div>
                  )}
                  {rpt.error && <div style={{ fontSize: 9, color: "#dc2626" }}>❌ {rpt.error}</div>}
                </div>
                <select
                  value={rpt.type}
                  onChange={(e) =>
                    setIntakeReports((prev) =>
                      prev.map((r) => (r.id === rpt.id ? { ...r, type: e.target.value } : r)),
                    )
                  }
                  style={{
                    padding: "3px 6px",
                    border: "1px solid #e2e8f0",
                    borderRadius: 4,
                    fontSize: 10,
                  }}
                >
                  <option value="lab">Lab Report</option>
                  <option value="imaging">Imaging (X-Ray/MRI/USG)</option>
                  <option value="prescription">Prescription</option>
                  <option value="other">Other</option>
                </select>
                {!rpt.data && !rpt.extracting && (
                  <button
                    onClick={async () => {
                      setIntakeReports((prev) =>
                        prev.map((r) => (r.id === rpt.id ? { ...r, extracting: true } : r)),
                      );
                      try {
                        const extFn = rpt.type === "imaging" ? extractImaging : extractLab;
                        const { data, error } = await extFn(rpt.base64, rpt.mediaType);
                        if (data) {
                          setIntakeReports((prev) =>
                            prev.map((r) =>
                              r.id === rpt.id ? { ...r, data, extracting: false } : r,
                            ),
                          );
                          if (rpt.type === "lab" && data.panels) {
                            // Tag panels with their report date + lab name
                            const taggedPanels = (data.panels || []).map((p) => ({
                              ...p,
                              report_date: data.report_date,
                              lab_name: data.lab_name,
                            }));
                            {
                              const prev = useLabStore.getState().labData;
                              if (!prev) setLabData({ ...data, panels: taggedPanels });
                              else
                                setLabData({
                                  ...prev,
                                  panels: [...(prev.panels || []), ...taggedPanels],
                                });
                            }
                          }
                          // Auto-save to DB (like v19 lab portal) + refresh patient data
                          if (dbPatientId) {
                            try {
                              const ok = await saveIntakeReportToDB(rpt, data);
                              console.log(
                                `${ok ? "✅" : "❌"} Auto-saved intake report: ${rpt.fileName}`,
                              );
                              if (ok) {
                                const resp = await api.get(`/api/patients/${dbPatientId}`);
                                const pd = resp.data;
                                if (pd.id) setPatientFullData(pd);
                              }
                            } catch (e) {
                              console.error("Auto-save failed:", e);
                            }
                          }
                          setTimeout(() => autoDetectDiagnoses(), 500);
                        } else {
                          setIntakeReports((prev) =>
                            prev.map((r) =>
                              r.id === rpt.id
                                ? { ...r, error: error || "No data", extracting: false }
                                : r,
                            ),
                          );
                        }
                      } catch (e) {
                        setIntakeReports((prev) =>
                          prev.map((r) =>
                            r.id === rpt.id ? { ...r, error: e.message, extracting: false } : r,
                          ),
                        );
                      }
                    }}
                    style={{
                      padding: "3px 10px",
                      background: "#7c3aed",
                      color: "white",
                      border: "none",
                      borderRadius: 4,
                      fontSize: 10,
                      fontWeight: 700,
                      cursor: "pointer",
                    }}
                  >
                    🔬 Extract
                  </button>
                )}
                {rpt.extracting && <span style={{ fontSize: 10, color: "#7c3aed" }}>⏳</span>}
                <button
                  onClick={() => setIntakeReports((prev) => prev.filter((r) => r.id !== rpt.id))}
                  style={{
                    background: "#fee2e2",
                    border: "none",
                    borderRadius: 3,
                    padding: "2px 6px",
                    fontSize: 9,
                    cursor: "pointer",
                    color: "#dc2626",
                    fontWeight: 700,
                  }}
                >
                  ✕
                </button>
              </div>
            ))}
            {intakeReports.some((r) => !r.data && !r.extracting) && (
              <button
                onClick={async () => {
                  for (const rpt of intakeReports.filter((r) => !r.data && !r.extracting)) {
                    setIntakeReports((prev) =>
                      prev.map((r) => (r.id === rpt.id ? { ...r, extracting: true } : r)),
                    );
                    try {
                      const extFn = rpt.type === "imaging" ? extractImaging : extractLab;
                      const { data, error } = await extFn(rpt.base64, rpt.mediaType);
                      if (data) {
                        setIntakeReports((prev) =>
                          prev.map((r) =>
                            r.id === rpt.id ? { ...r, data, extracting: false } : r,
                          ),
                        );
                        if (rpt.type === "lab" && data.panels) {
                          const taggedPanels = (data.panels || []).map((p) => ({
                            ...p,
                            report_date: data.report_date,
                            lab_name: data.lab_name,
                          }));
                          {
                            const prev = useLabStore.getState().labData;
                            setLabData(
                              prev
                                ? { ...prev, panels: [...(prev.panels || []), ...taggedPanels] }
                                : { ...data, panels: taggedPanels },
                            );
                          }
                        }
                        // Auto-save to DB
                        if (dbPatientId) {
                          try {
                            const ok = await saveIntakeReportToDB(rpt, data);
                            console.log(`${ok ? "✅" : "❌"} Auto-saved: ${rpt.fileName}`);
                          } catch (e) {
                            console.error("Auto-save failed:", e);
                          }
                        }
                      } else {
                        setIntakeReports((prev) =>
                          prev.map((r) =>
                            r.id === rpt.id
                              ? { ...r, error: error || "No data", extracting: false }
                              : r,
                          ),
                        );
                      }
                    } catch (e) {
                      setIntakeReports((prev) =>
                        prev.map((r) =>
                          r.id === rpt.id ? { ...r, error: e.message, extracting: false } : r,
                        ),
                      );
                    }
                  }
                  // Refresh patient data so new docs/labs appear
                  if (dbPatientId) {
                    try {
                      const resp = await api.get(`/api/patients/${dbPatientId}`);
                      if (resp.data.id) setPatientFullData(resp.data);
                    } catch (e) {}
                  }
                  setTimeout(() => autoDetectDiagnoses(), 500);
                }}
                style={{
                  width: "100%",
                  padding: "8px",
                  background: "#7c3aed",
                  color: "white",
                  border: "none",
                  borderRadius: 6,
                  fontSize: 12,
                  fontWeight: 700,
                  cursor: "pointer",
                  marginTop: 4,
                }}
              >
                🔬 Extract All ({intakeReports.filter((r) => !r.data && !r.extracting).length})
              </button>
            )}
            {/* Save All to DB button */}
            {intakeReports.some((r) => r.data && !r.saved) && dbPatientId && (
              <button
                onClick={saveAllIntakeReports}
                disabled={intakeReports.some((r) => r.saving)}
                style={{
                  width: "100%",
                  padding: "10px",
                  background: intakeReports.some((r) => r.saving)
                    ? "#94a3b8"
                    : "linear-gradient(135deg,#059669,#10b981)",
                  color: "white",
                  border: "none",
                  borderRadius: 6,
                  fontSize: 13,
                  fontWeight: 800,
                  cursor: intakeReports.some((r) => r.saving) ? "wait" : "pointer",
                  marginTop: 6,
                }}
              >
                {intakeReports.some((r) => r.saving)
                  ? `⏳ Saving ${intakeReports.filter((r) => r.saving).length}...`
                  : `💾 Save ${intakeReports.filter((r) => r.data && !r.saved).length} Reports to Patient Record`}
              </button>
            )}
            {intakeReports.some((r) => r.data && !r.saved) && !dbPatientId && (
              <div
                style={{
                  marginTop: 6,
                  padding: 8,
                  background: "#fef3c7",
                  border: "1px solid #fde68a",
                  borderRadius: 6,
                  fontSize: 11,
                  color: "#92400e",
                  fontWeight: 600,
                  textAlign: "center",
                }}
              >
                ⚠️ Search or create patient first to save reports to their record
              </div>
            )}
            {intakeReports.length > 0 && intakeReports.every((r) => r.saved) && (
              <div
                style={{
                  marginTop: 6,
                  padding: 8,
                  background: "#f0fdf4",
                  border: "1px solid #bbf7d0",
                  borderRadius: 6,
                  fontSize: 11,
                  color: "#059669",
                  fontWeight: 700,
                  textAlign: "center",
                }}
              >
                ✅ All {intakeReports.length} reports saved to patient record
              </div>
            )}
          </div>
        )}

        <Err msg={errors.lab} onDismiss={() => clearErr("lab")} />
        {/* Show extracted lab summary */}
        {labData &&
          (labData.panels || []).map((panel, pi) => (
            <div
              key={pi}
              style={{
                marginTop: 4,
                border: "1px solid #e2e8f0",
                borderRadius: 6,
                overflow: "hidden",
              }}
            >
              <div
                style={{
                  background: "#7c3aed",
                  color: "white",
                  padding: "3px 8px",
                  fontSize: 10,
                  fontWeight: 700,
                }}
              >
                {panel.panel_name}
              </div>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 10 }}>
                <tbody>
                  {panel.tests.map((t, ti) => (
                    <tr
                      key={ti}
                      style={{
                        background:
                          t.flag === "H"
                            ? "#fef2f2"
                            : t.flag === "L"
                              ? "#eff6ff"
                              : ti % 2
                                ? "#fafafa"
                                : "white",
                      }}
                    >
                      <td style={{ padding: "2px 6px" }}>{t.test_name}</td>
                      <td
                        style={{
                          padding: "2px 6px",
                          textAlign: "right",
                          fontWeight: 700,
                          color:
                            t.flag === "H" ? "#dc2626" : t.flag === "L" ? "#2563eb" : "#1e293b",
                        }}
                      >
                        {t.result_text || t.result} {t.unit}
                      </td>
                      <td style={{ padding: "2px 6px", textAlign: "center", fontSize: 8 }}>
                        {t.flag === "H" ? "↑" : t.flag === "L" ? "↓" : "✓"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}

        {/* AI Suggested Diagnoses from labs */}
        {aiDxSuggestions.length > 0 && (
          <div
            style={{
              marginTop: 8,
              padding: 8,
              background: "linear-gradient(135deg,#faf5ff,#f0f9ff)",
              border: "2px solid #c4b5fd",
              borderRadius: 8,
            }}
          >
            <div style={{ fontSize: 11, fontWeight: 800, color: "#7c3aed", marginBottom: 4 }}>
              🤖 AI Detected from Reports
            </div>
            {aiDxSuggestions.map((s, i) => (
              <div
                key={i}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "4px 0",
                  borderBottom: i < aiDxSuggestions.length - 1 ? "1px solid #f1f5f9" : "none",
                }}
              >
                <span style={{ fontSize: 12 }}>{CONDITIONS[s.name]?.icon || "📋"}</span>
                <div style={{ flex: 1 }}>
                  <span style={{ fontSize: 11, fontWeight: 700 }}>{s.name}</span>
                  <span style={{ fontSize: 9, color: "#64748b", marginLeft: 6 }}>{s.reason}</span>
                </div>
                <button
                  onClick={() => {
                    if (!hxConditions.includes(s.name)) toggleHxCond(s.name);
                  }}
                  style={{
                    fontSize: 9,
                    background: hxConditions.includes(s.name) ? "#059669" : "#2563eb",
                    color: "white",
                    border: "none",
                    padding: "3px 8px",
                    borderRadius: 4,
                    fontWeight: 700,
                    cursor: "pointer",
                  }}
                >
                  {hxConditions.includes(s.name) ? "✓ Added" : "+ Add"}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <button onClick={() => navigate("/history-clinical")} className="intake__next-btn">
        Next: Clinical History →
      </button>
    </div>
  );
}
