import { useEffect } from "react";
import "./OutcomesPage.css";
import usePatientStore from "../stores/patientStore";
import useClinicalStore from "../stores/clinicalStore";
import useVisitStore from "../stores/visitStore";
import useReportsStore from "../stores/reportsStore";
import Shimmer from "../components/Shimmer.jsx";
import Sparkline from "../components/Sparkline.jsx";
import { fmtDate } from "../utils/helpers.js";
import { fmtLabVal } from "../components/visit/helpers";
import { DRUG_BIOMARKER_MAP, getMedsForBiomarker } from "../config/constants.js";

const fmtCompliance = (c) => {
  if (!c) return "";
  if (typeof c === "string") return c;
  if (typeof c === "object") {
    const pct = c.medPct != null ? c.medPct : null;
    if (pct !== null) return pct >= 90 ? "Good" : pct >= 70 ? "Moderate" : "Poor";
    return "";
  }
  return String(c);
};

export default function OutcomesPage() {
  const patient = usePatientStore((s) => s.patient);
  const dbPatientId = usePatientStore((s) => s.dbPatientId);
  const pfd = usePatientStore((s) => s.getPfd());
  const moData = useClinicalStore((s) => s.moData);
  const complaints = useVisitStore((s) => s.complaints);
  const outcomesData = useReportsStore((s) => s.outcomesData);
  const outcomesLoading = useReportsStore((s) => s.outcomesLoading);
  const outcomePeriod = useReportsStore((s) => s.outcomePeriod);
  const setOutcomePeriod = useReportsStore((s) => s.setOutcomePeriod);
  const expandedBiomarker = useReportsStore((s) => s.expandedBiomarker);
  const setExpandedBiomarker = useReportsStore((s) => s.setExpandedBiomarker);
  const timelineFilter = useReportsStore((s) => s.timelineFilter);
  const setTimelineFilter = useReportsStore((s) => s.setTimelineFilter);
  const timelineDoctor = useReportsStore((s) => s.timelineDoctor);
  const setTimelineDoctor = useReportsStore((s) => s.setTimelineDoctor);
  const expandedDiagnosis = useReportsStore((s) => s.expandedDiagnosis);
  const setExpandedDiagnosis = useReportsStore((s) => s.setExpandedDiagnosis);
  const expandedPrescription = useReportsStore((s) => s.expandedPrescription);
  const setExpandedPrescription = useReportsStore((s) => s.setExpandedPrescription);
  const healthSummary = useReportsStore((s) => s.healthSummary);
  const summaryLoading = useReportsStore((s) => s.summaryLoading);
  const fetchOutcomes = useReportsStore((s) => s.fetchOutcomes);
  const generateHealthSummary = useReportsStore((s) => s.generateHealthSummary);

  useEffect(() => {
    if (dbPatientId) fetchOutcomes(dbPatientId, outcomePeriod);
  }, [dbPatientId, fetchOutcomes, outcomePeriod]);

  return (
    <div style={{ maxWidth: 920, margin: "0 auto" }}>
      {!dbPatientId ? (
        <div style={{ textAlign: "center", padding: 50, color: "#94a3b8" }}>
          <div style={{ fontSize: 40, marginBottom: 12 }}>📊</div>
          <div style={{ fontSize: 15, fontWeight: 600, color: "#64748b" }}>
            Load a patient first
          </div>
          <div style={{ fontSize: 12, color: "#cbd5e1", marginTop: 6 }}>
            Use 🔍 Find to search existing patients
          </div>
        </div>
      ) : outcomesLoading ? (
        <div style={{ padding: 20, display: "flex", flexDirection: "column", gap: 16 }}>
          <Shimmer type="stats" count={3} />
          <Shimmer type="cards" count={4} />
        </div>
      ) : (
        <div>
          {/* ── HEADER ── */}
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              marginBottom: 16,
            }}
          >
            <div>
              <div
                style={{ fontSize: 20, fontWeight: 800, color: "#0f172a", letterSpacing: "-0.5px" }}
              >
                Health Dashboard
              </div>
              <div style={{ fontSize: 12, color: "#64748b", marginTop: 2 }}>
                {patient.name}
                {patient.age ? ` · ${patient.age}y` : ""}
                {patient.sex ? ` · ${patient.sex}` : ""}
              </div>
            </div>
            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <div
                style={{
                  display: "flex",
                  borderRadius: 8,
                  overflow: "hidden",
                  border: "1px solid #e2e8f0",
                }}
              >
                {[
                  ["3m", "3M"],
                  ["6m", "6M"],
                  ["1y", "1Y"],
                  ["all", "All"],
                ].map(([v, l]) => (
                  <button
                    key={v}
                    onClick={() => {
                      setOutcomePeriod(v);
                      fetchOutcomes(dbPatientId, v);
                    }}
                    style={{
                      padding: "5px 12px",
                      fontSize: 11,
                      fontWeight: 700,
                      border: "none",
                      cursor: "pointer",
                      background: outcomePeriod === v ? "#0f172a" : "white",
                      color: outcomePeriod === v ? "white" : "#64748b",
                      transition: "all 0.15s",
                    }}
                  >
                    {l}
                  </button>
                ))}
              </div>
              <button
                onClick={() => fetchOutcomes(dbPatientId)}
                title="Refresh"
                style={{
                  fontSize: 14,
                  padding: "4px 8px",
                  border: "1px solid #e2e8f0",
                  borderRadius: 8,
                  cursor: "pointer",
                  background: "white",
                  color: "#64748b",
                }}
              >
                ↻
              </button>
            </div>
          </div>

          {/* ── SUMMARY CARDS ── */}
          {pfd && (
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr 1fr 1fr",
                gap: 10,
                marginBottom: 20,
              }}
            >
              {[
                {
                  label: "Visits",
                  value: pfd.consultations?.length || 0,
                  icon: "📋",
                  bg: "linear-gradient(135deg,#eff6ff,#dbeafe)",
                  color: "#1d4ed8",
                },
                {
                  label: "Active Meds",
                  value: (() => {
                    const seen = new Set();
                    return (pfd.medications || []).filter((m) => {
                      if (!m.is_active) return false;
                      const k = (m.name || "").toUpperCase();
                      if (seen.has(k)) return false;
                      seen.add(k);
                      return true;
                    }).length;
                  })(),
                  icon: "💊",
                  bg: "linear-gradient(135deg,#f0fdf4,#dcfce7)",
                  color: "#059669",
                },
                {
                  label: "Diagnoses",
                  value: (() => {
                    const seen = new Set();
                    return (pfd.diagnoses || []).filter((d) => {
                      const k = d.diagnosis_id || d.label;
                      if (seen.has(k)) return false;
                      seen.add(k);
                      return true;
                    }).length;
                  })(),
                  icon: "🩺",
                  bg: "linear-gradient(135deg,#fffbeb,#fef3c7)",
                  color: "#d97706",
                },
                {
                  label: "Lab Tests",
                  value: pfd.lab_results?.length || 0,
                  icon: "🧪",
                  bg: "linear-gradient(135deg,#fdf2f8,#fce7f3)",
                  color: "#db2777",
                },
              ].map((c, i) => (
                <div
                  key={i}
                  style={{
                    background: c.bg,
                    borderRadius: 14,
                    padding: "12px 14px",
                    textAlign: "center",
                  }}
                >
                  <div
                    style={{
                      fontSize: 9,
                      color: "#64748b",
                      fontWeight: 700,
                      textTransform: "uppercase",
                      letterSpacing: "0.6px",
                    }}
                  >
                    {c.icon} {c.label}
                  </div>
                  <div style={{ fontSize: 24, fontWeight: 900, color: c.color, marginTop: 3 }}>
                    {c.value}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* ── AI HEALTH SUMMARY ── */}
          <div
            style={{
              background: "linear-gradient(135deg,#f0f9ff,#e0f2fe)",
              borderRadius: 16,
              padding: 16,
              marginBottom: 20,
              border: "1px solid #bae6fd",
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                marginBottom: healthSummary ? 10 : 0,
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ fontSize: 16 }}>🤖</span>
                <span style={{ fontSize: 13, fontWeight: 700, color: "#0c4a6e" }}>
                  AI Health Summary
                </span>
              </div>
              <button
                onClick={() => generateHealthSummary(patient, pfd)}
                disabled={summaryLoading}
                style={{
                  fontSize: 11,
                  padding: "5px 14px",
                  border: "none",
                  borderRadius: 8,
                  cursor: summaryLoading ? "wait" : "pointer",
                  background: summaryLoading ? "#94a3b8" : "#0369a1",
                  color: "white",
                  fontWeight: 700,
                }}
              >
                {summaryLoading
                  ? "⏳ Analyzing..."
                  : healthSummary
                    ? "↻ Regenerate"
                    : "✨ Generate Summary"}
              </button>
            </div>
            {healthSummary && (
              <div
                style={{
                  fontSize: 13,
                  lineHeight: "1.7",
                  color: "#0c4a6e",
                  marginTop: 6,
                  background: "white",
                  borderRadius: 10,
                  padding: 12,
                }}
              >
                {healthSummary}
              </div>
            )}
          </div>

          {/* ── BIOMARKER CHARTS (Clickable, Filtered Meds) ── */}
          {outcomesData &&
            (() => {
              // Build per-visit context for drill-down
              const visitCtxByDate = {};
              (outcomesData.visits || []).forEach((v) => {
                const d = (v.visit_date || "").split("T")[0];
                visitCtxByDate[d] = {
                  lifestyle: v.lifestyle || [],
                  compliance: fmtCompliance(v.compliance),
                  symptoms: (v.symptoms || v.chief_complaints || []).filter(
                    (s) =>
                      ![
                        "no gmi",
                        "no hypoglycemia",
                        "no hypoglycaemia",
                        "routine follow-up",
                        "follow-up visit",
                        "no complaints",
                      ].some((x) => String(s).toLowerCase().includes(x)),
                  ),
                  summary: v.summary || "",
                  doctor: v.con_name || v.mo_name || "",
                  meds_confirmed: v.medications_confirmed || [],
                };
              });
              // Per-visit all meds (from med_timeline)
              const allMedsByDate = {};
              (outcomesData.med_timeline || []).forEach((m) => {
                const d = (m.visit_date || "").split("T")[0];
                if (!allMedsByDate[d]) allMedsByDate[d] = [];
                allMedsByDate[d].push(m);
              });

              // Helper: find nearest visit date for context
              const visitDates = Object.keys(visitCtxByDate).sort();
              const medDates = Object.keys(allMedsByDate).sort();
              const findNearest = (dateKey, dates) => {
                if (!dateKey || dates.length === 0) return null;
                let best = dates[0],
                  bestDiff = Math.abs(new Date(dateKey) - new Date(dates[0]));
                for (const d of dates) {
                  const diff = Math.abs(new Date(dateKey) - new Date(d));
                  if (diff < bestDiff) {
                    best = d;
                    bestDiff = diff;
                  }
                }
                return bestDiff <= 60 * 86400000 ? best : null;
              };

              const renderSection = (title, icon, color, charts) => {
                const hasData = charts.some((c) => c.data?.length > 0);
                if (!hasData) return null;
                return (
                  <div key={title} style={{ marginBottom: 20 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8 }}>
                      <span style={{ fontSize: 14 }}>{icon}</span>
                      <span
                        style={{
                          fontSize: 12,
                          fontWeight: 800,
                          color,
                          textTransform: "uppercase",
                          letterSpacing: "0.5px",
                        }}
                      >
                        {title}
                      </span>
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                      {charts.map((c, ci) => {
                        if (!c.data?.length) return null;
                        const bioKey =
                          c.biomarkerKey || c.label.toLowerCase().replace(/[^a-z]/g, "");
                        const isExpanded = expandedBiomarker === `${title}-${ci}`;
                        return (
                          <div
                            key={ci}
                            style={{
                              gridColumn: isExpanded ? "1 / -1" : "auto",
                              background: "white",
                              borderRadius: 14,
                              border: isExpanded ? "2px solid " + c.color : "1px solid #f1f5f9",
                              boxShadow: isExpanded
                                ? "0 4px 12px rgba(0,0,0,0.08)"
                                : "0 1px 3px rgba(0,0,0,0.04)",
                              overflow: "hidden",
                              cursor: "pointer",
                              transition: "all 0.2s",
                            }}
                            onClick={() =>
                              setExpandedBiomarker(isExpanded ? null : `${title}-${ci}`)
                            }
                          >
                            <div style={{ padding: isExpanded ? 14 : 0 }}>
                              <Sparkline
                                data={c.data}
                                label={c.label}
                                unit={c.unit}
                                color={c.color}
                                target={c.target}
                                valueKey={c.valueKey}
                                lowerBetter={c.lowerBetter}
                              />
                            </div>
                            {/* Expanded: filtered context per reading */}
                            {isExpanded && (
                              <div
                                style={{
                                  borderTop: "1px solid #f1f5f9",
                                  padding: 14,
                                  background: "#fafbfc",
                                }}
                                onClick={(e) => e.stopPropagation()}
                              >
                                <div
                                  style={{
                                    fontSize: 11,
                                    fontWeight: 700,
                                    color: "#475569",
                                    marginBottom: 10,
                                  }}
                                >
                                  📋 What was happening at each reading:
                                </div>
                                {c.data
                                  .slice()
                                  .reverse()
                                  .map((dp, di) => {
                                    const dateKey = (dp.test_date || dp.date || "").split("T")[0];
                                    const ctx =
                                      visitCtxByDate[dateKey] ||
                                      visitCtxByDate[findNearest(dateKey, visitDates)] ||
                                      {};
                                    const nearestMedDate =
                                      findNearest(dateKey, medDates) || dateKey;
                                    const allMeds =
                                      allMedsByDate[dateKey] || allMedsByDate[nearestMedDate] || [];
                                    // Filter to RELEVANT meds only
                                    const relevantMeds = getMedsForBiomarker(
                                      bioKey,
                                      allMeds.map((m) => m.pharmacy_match || m.name),
                                    );
                                    // Filter lifestyle by helps array matching biomarker
                                    const relevantLifestyle = (
                                      Array.isArray(ctx.lifestyle) ? ctx.lifestyle : []
                                    ).filter((l) => {
                                      if (typeof l === "object" && l.helps) {
                                        const helpSet = (l.helps || []).join(",").toLowerCase();
                                        if (bioKey === "hba1c" || bioKey === "fpg")
                                          return helpSet.includes("dm");
                                        if (bioKey === "bp") return helpSet.includes("htn");
                                        if (
                                          bioKey === "ldl" ||
                                          bioKey === "triglycerides" ||
                                          bioKey === "hdl"
                                        )
                                          return (
                                            helpSet.includes("dyslipidemia") ||
                                            helpSet.includes("lipid")
                                          );
                                        if (bioKey === "weight")
                                          return (
                                            helpSet.includes("obesity") || helpSet.includes("dm")
                                          );
                                        if (bioKey === "tsh") return helpSet.includes("hypo");
                                      }
                                      return true;
                                    });
                                    const val = fmtLabVal(null, dp[c.valueKey || "result"]);
                                    const s = String(dateKey || "");
                                    const fd =
                                      s.length >= 10
                                        ? new Date(s.slice(0, 10) + "T12:00:00")
                                        : new Date(s);
                                    const months = [
                                      "Jan",
                                      "Feb",
                                      "Mar",
                                      "Apr",
                                      "May",
                                      "Jun",
                                      "Jul",
                                      "Aug",
                                      "Sep",
                                      "Oct",
                                      "Nov",
                                      "Dec",
                                    ];
                                    const dateStr = dateKey
                                      ? `${fd.getDate()} ${months[fd.getMonth()]} ${fd.getFullYear()}`
                                      : "";
                                    return (
                                      <div
                                        key={di}
                                        style={{
                                          padding: "10px 0",
                                          borderBottom:
                                            di < c.data.length - 1 ? "1px solid #f1f5f9" : "none",
                                        }}
                                      >
                                        <div
                                          style={{
                                            display: "flex",
                                            justifyContent: "space-between",
                                            alignItems: "center",
                                            marginBottom: 6,
                                          }}
                                        >
                                          <div
                                            style={{
                                              display: "flex",
                                              alignItems: "baseline",
                                              gap: 6,
                                            }}
                                          >
                                            <span
                                              style={{
                                                fontSize: 18,
                                                fontWeight: 800,
                                                color: c.color,
                                              }}
                                            >
                                              {val}
                                              {c.unit}
                                            </span>
                                            {ctx.doctor && (
                                              <span style={{ fontSize: 10, color: "#94a3b8" }}>
                                                👨‍⚕️{" "}
                                                {ctx.doctor.startsWith("Dr")
                                                  ? ctx.doctor
                                                  : "Dr. " + ctx.doctor}
                                              </span>
                                            )}
                                          </div>
                                          <span
                                            style={{
                                              fontSize: 12,
                                              color: "#475569",
                                              fontWeight: 700,
                                              background: "#f1f5f9",
                                              padding: "3px 10px",
                                              borderRadius: 8,
                                            }}
                                          >
                                            {dateStr}
                                          </span>
                                        </div>
                                        {ctx.compliance && (
                                          <div style={{ marginBottom: 4 }}>
                                            <span
                                              style={{
                                                padding: "2px 8px",
                                                borderRadius: 10,
                                                fontWeight: 700,
                                                fontSize: 9,
                                                background: (ctx.compliance + "").startsWith("Good")
                                                  ? "#dcfce7"
                                                  : (ctx.compliance + "").startsWith("Poor")
                                                    ? "#fef2f2"
                                                    : "#fef3c7",
                                                color: (ctx.compliance + "").startsWith("Good")
                                                  ? "#059669"
                                                  : (ctx.compliance + "").startsWith("Poor")
                                                    ? "#dc2626"
                                                    : "#d97706",
                                              }}
                                            >
                                              {ctx.compliance}
                                            </span>
                                          </div>
                                        )}
                                        {relevantMeds.length > 0 && (
                                          <div style={{ marginBottom: 4 }}>
                                            <div
                                              style={{
                                                fontSize: 9,
                                                color: "#94a3b8",
                                                fontWeight: 600,
                                                marginBottom: 2,
                                              }}
                                            >
                                              PROTOCOL:
                                            </div>
                                            <div
                                              style={{ display: "flex", flexWrap: "wrap", gap: 3 }}
                                            >
                                              {relevantMeds.map((m, mi) => (
                                                <span
                                                  key={mi}
                                                  style={{
                                                    fontSize: 9,
                                                    padding: "2px 6px",
                                                    borderRadius: 8,
                                                    background: "#f0fdf4",
                                                    color: "#059669",
                                                    border: "1px solid #bbf7d0",
                                                    fontWeight: 600,
                                                  }}
                                                >
                                                  💊 {m}
                                                </span>
                                              ))}
                                            </div>
                                          </div>
                                        )}
                                        {relevantLifestyle.length > 0 && (
                                          <div
                                            style={{
                                              display: "flex",
                                              flexWrap: "wrap",
                                              gap: 3,
                                              marginBottom: 3,
                                            }}
                                          >
                                            {relevantLifestyle.map((l, li) => (
                                              <span
                                                key={li}
                                                style={{
                                                  fontSize: 9,
                                                  padding: "2px 6px",
                                                  borderRadius: 8,
                                                  background: "#eff6ff",
                                                  color: "#2563eb",
                                                  fontWeight: 600,
                                                }}
                                              >
                                                {typeof l === "object" ? l.advice : l}
                                              </span>
                                            ))}
                                          </div>
                                        )}
                                        {(ctx.symptoms || []).length > 0 && (
                                          <div
                                            style={{ display: "flex", flexWrap: "wrap", gap: 3 }}
                                          >
                                            {ctx.symptoms.map((s, si) => (
                                              <span
                                                key={si}
                                                style={{
                                                  fontSize: 9,
                                                  padding: "2px 6px",
                                                  borderRadius: 8,
                                                  background: "#fef2f2",
                                                  color: "#dc2626",
                                                  fontWeight: 600,
                                                }}
                                              >
                                                ⚠️ {s}
                                              </span>
                                            ))}
                                          </div>
                                        )}
                                      </div>
                                    );
                                  })}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              };

              return (
                <>
                  {/* Sections ordered per canonical lab order
                      (see src/config/labOrder.js + labOrder.md):
                      Diabetes → Renal → Lipids → Liver → Thyroid → Vitamins/Inflammation → Body */}
                  {renderSection("Diabetes & Glycaemic Control", "🩸", "#b91c1c", [
                    {
                      data: outcomesData.hba1c,
                      label: "HbA1c",
                      unit: "%",
                      color: "#dc2626",
                      target: 6.5,
                      biomarkerKey: "hba1c",
                    },
                    {
                      data: outcomesData.fpg,
                      label: "Fasting Glucose",
                      unit: " mg/dl",
                      color: "#ea580c",
                      target: 100,
                      biomarkerKey: "fpg",
                    },
                    {
                      data: outcomesData.ppg,
                      label: "Post-Prandial",
                      unit: " mg/dl",
                      color: "#f97316",
                      target: 180,
                      biomarkerKey: "ppg",
                    },
                    {
                      data: outcomesData.bp,
                      label: "BP (Systolic)",
                      unit: " mmHg",
                      color: "#7c3aed",
                      target: 130,
                      valueKey: "bp_sys",
                      biomarkerKey: "bp",
                    },
                    {
                      data: outcomesData.weight,
                      label: "Weight",
                      unit: " kg",
                      color: "#2563eb",
                      valueKey: "weight",
                      biomarkerKey: "weight",
                    },
                    {
                      data: outcomesData.heart_rate,
                      label: "Heart Rate",
                      unit: " bpm",
                      color: "#e11d48",
                      valueKey: "pulse",
                      biomarkerKey: "hr",
                    },
                  ])}
                  {renderSection("Renal Function (RFT + UACR)", "💧", "#0d9488", [
                    {
                      data: outcomesData.creatinine,
                      label: "Creatinine",
                      unit: " mg/dl",
                      color: "#6366f1",
                      target: 1.2,
                      biomarkerKey: "creatinine",
                    },
                    {
                      data: outcomesData.egfr,
                      label: "eGFR",
                      unit: " ml/min",
                      color: "#0d9488",
                      target: 60,
                      lowerBetter: false,
                      biomarkerKey: "egfr",
                    },
                    {
                      data: outcomesData.uacr,
                      label: "UACR",
                      unit: " mg/g",
                      color: "#be185d",
                      target: 30,
                      biomarkerKey: "uacr",
                    },
                  ])}
                  {renderSection("Lipid Profile", "🧈", "#1d4ed8", [
                    {
                      data: outcomesData.ldl,
                      label: "LDL",
                      unit: " mg/dl",
                      color: "#d97706",
                      target: 100,
                      biomarkerKey: "ldl",
                    },
                    {
                      data: outcomesData.triglycerides,
                      label: "Triglycerides",
                      unit: " mg/dl",
                      color: "#b45309",
                      target: 150,
                      biomarkerKey: "triglycerides",
                    },
                    {
                      data: outcomesData.hdl,
                      label: "HDL",
                      unit: " mg/dl",
                      color: "#059669",
                      target: 40,
                      lowerBetter: false,
                      biomarkerKey: "hdl",
                    },
                    {
                      data: outcomesData.nonhdl,
                      label: "Non-HDL",
                      unit: " mg/dl",
                      color: "#a16207",
                      target: 130,
                      biomarkerKey: "nonhdl",
                    },
                  ])}
                  {renderSection("Liver Function (LFT)", "🫁", "#92400e", [
                    {
                      data: outcomesData.alt,
                      label: "ALT (SGPT)",
                      unit: " U/L",
                      color: "#dc2626",
                      target: 40,
                      biomarkerKey: "alt",
                    },
                    {
                      data: outcomesData.ast,
                      label: "AST (SGOT)",
                      unit: " U/L",
                      color: "#ea580c",
                      target: 40,
                      biomarkerKey: "ast",
                    },
                    {
                      data: outcomesData.alp,
                      label: "ALP",
                      unit: " U/L",
                      color: "#d97706",
                      target: 120,
                      biomarkerKey: "alp",
                    },
                  ])}
                  {renderSection("Thyroid", "🦋", "#0891b2", [
                    {
                      data: outcomesData.tsh,
                      label: "TSH",
                      unit: " mIU/L",
                      color: "#0891b2",
                      biomarkerKey: "tsh",
                    },
                  ])}
                  {renderSection("Vitamins & Inflammation", "💊", "#7c3aed", [
                    {
                      data: outcomesData.vitamin_d,
                      label: "Vitamin D",
                      unit: " ng/ml",
                      color: "#7c3aed",
                      target: 30,
                      lowerBetter: false,
                      biomarkerKey: "vitamind",
                    },
                    {
                      data: outcomesData.vitamin_b12,
                      label: "Vitamin B12",
                      unit: " pg/ml",
                      color: "#6366f1",
                      target: 200,
                      lowerBetter: false,
                      biomarkerKey: "vitaminb12",
                    },
                    {
                      data: outcomesData.ferritin,
                      label: "Ferritin",
                      unit: " ng/ml",
                      color: "#b45309",
                      biomarkerKey: "ferritin",
                    },
                    {
                      data: outcomesData.crp,
                      label: "CRP",
                      unit: " mg/L",
                      color: "#dc2626",
                      target: 3,
                      biomarkerKey: "crp",
                    },
                  ])}
                  {renderSection("Body Composition", "🏋️", "#059669", [
                    {
                      data: outcomesData.bmi,
                      label: "BMI",
                      unit: " kg/m²",
                      color: "#0d9488",
                      target: 25,
                      valueKey: "bmi",
                      biomarkerKey: "bmi",
                    },
                    {
                      data: outcomesData.waist,
                      label: "Waist",
                      unit: " cm",
                      color: "#059669",
                      valueKey: "waist",
                      biomarkerKey: "waist",
                    },
                    {
                      data: outcomesData.body_fat,
                      label: "Body Fat",
                      unit: "%",
                      color: "#d97706",
                      valueKey: "body_fat",
                      biomarkerKey: "body_fat",
                    },
                    {
                      data: outcomesData.muscle_mass,
                      label: "Muscle Mass",
                      unit: " kg",
                      color: "#2563eb",
                      lowerBetter: false,
                      valueKey: "muscle_mass",
                      biomarkerKey: "muscle_mass",
                    },
                  ])}

                  {/* ── SYMPTOMS TRACKER ── */}
                  {(() => {
                    const symptomsByVisit = [];
                    const seenDates = new Set();
                    (outcomesData.visits || []).forEach((v) => {
                      const dateKey = (v.visit_date || "").split("T")[0];
                      if (seenDates.has(dateKey)) return;
                      const syms = [...(v.symptoms || []), ...(v.chief_complaints || [])].filter(
                        (s) =>
                          s &&
                          ![
                            "no gmi",
                            "no hypoglycemia",
                            "no hypoglycaemia",
                            "routine follow-up",
                            "follow-up visit",
                            "no complaints",
                            "routine",
                            "regular follow-up",
                          ].some((x) => String(s).toLowerCase().includes(x)),
                      );
                      if (syms.length === 0) return;
                      seenDates.add(dateKey);
                      symptomsByVisit.push({
                        date: dateKey,
                        doctor: v.con_name || v.mo_name || "",
                        symptoms: [...new Set(syms)],
                      });
                    });

                    if (symptomsByVisit.length === 0) return null;

                    const allSymptoms = {};
                    symptomsByVisit.forEach((v) => {
                      v.symptoms.forEach((s) => {
                        const key = String(s).toLowerCase().trim();
                        if (!allSymptoms[key]) allSymptoms[key] = { label: s, dates: new Set() };
                        allSymptoms[key].dates.add(v.date);
                      });
                    });

                    const sortedSymptoms = Object.values(allSymptoms)
                      .map((s) => ({ ...s, count: s.dates.size, dates: [...s.dates].sort() }))
                      .sort((a, b) => b.count - a.count);

                    const recurring = sortedSymptoms.filter((s) => s.count >= 2);

                    return (
                      <div style={{ marginBottom: 20 }}>
                        <div
                          style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8 }}
                        >
                          <span style={{ fontSize: 14 }}>🩺</span>
                          <span
                            style={{
                              fontSize: 12,
                              fontWeight: 800,
                              color: "#7c2d12",
                              textTransform: "uppercase",
                              letterSpacing: "0.5px",
                            }}
                          >
                            Symptoms Tracker
                          </span>
                        </div>

                        {recurring.length > 0 && (
                          <div
                            style={{
                              background: "linear-gradient(135deg,#fef2f2,#fff1f2)",
                              border: "1px solid #fecaca",
                              borderRadius: 12,
                              padding: 12,
                              marginBottom: 10,
                            }}
                          >
                            <div
                              style={{
                                fontSize: 10,
                                fontWeight: 700,
                                color: "#991b1b",
                                marginBottom: 8,
                                textTransform: "uppercase",
                                letterSpacing: "0.5px",
                              }}
                            >
                              ⚠️ Recurring Symptoms
                            </div>
                            {recurring.map((s, i) => {
                              const isRecent = s.dates.some(
                                (d) =>
                                  (Date.now() - new Date(d).getTime()) / (1000 * 60 * 60 * 24) < 30,
                              );
                              const duration =
                                s.dates.length >= 2
                                  ? (() => {
                                      const first = new Date(s.dates[0]);
                                      const last = new Date(s.dates[s.dates.length - 1]);
                                      const days = Math.round(
                                        (last - first) / (1000 * 60 * 60 * 24),
                                      );
                                      return days > 365
                                        ? `${Math.round(days / 365)}y`
                                        : days > 30
                                          ? `${Math.round(days / 30)}mo`
                                          : `${days}d`;
                                    })()
                                  : "";
                              return (
                                <div
                                  key={i}
                                  style={{
                                    display: "flex",
                                    alignItems: "center",
                                    gap: 8,
                                    padding: "6px 0",
                                    borderBottom:
                                      i < recurring.length - 1 ? "1px solid #fecaca" : "none",
                                  }}
                                >
                                  <div
                                    style={{
                                      width: 32,
                                      height: 32,
                                      borderRadius: "50%",
                                      background: "#dc2626",
                                      color: "white",
                                      display: "flex",
                                      alignItems: "center",
                                      justifyContent: "center",
                                      fontSize: 13,
                                      fontWeight: 800,
                                      flexShrink: 0,
                                    }}
                                  >
                                    {s.count}
                                  </div>
                                  <div style={{ flex: 1 }}>
                                    <div
                                      style={{ fontSize: 12, fontWeight: 700, color: "#1e293b" }}
                                    >
                                      {s.label}
                                    </div>
                                    <div style={{ fontSize: 9, color: "#64748b", marginTop: 1 }}>
                                      {s.count} visits over {duration}
                                      {isRecent && (
                                        <span
                                          style={{
                                            marginLeft: 6,
                                            color: "#dc2626",
                                            fontWeight: 700,
                                          }}
                                        >
                                          ● Still active
                                        </span>
                                      )}
                                      {!isRecent && (
                                        <span
                                          style={{
                                            marginLeft: 6,
                                            color: "#059669",
                                            fontWeight: 700,
                                          }}
                                        >
                                          ● Resolved
                                        </span>
                                      )}
                                    </div>
                                  </div>
                                  <div style={{ display: "flex", gap: 2, flexShrink: 0 }}>
                                    {s.dates.slice(-6).map((d, di) => (
                                      <div
                                        key={di}
                                        style={{
                                          width: 6,
                                          height: 6,
                                          borderRadius: "50%",
                                          background:
                                            (Date.now() - new Date(d).getTime()) /
                                              (1000 * 60 * 60 * 24) <
                                            30
                                              ? "#dc2626"
                                              : "#fca5a5",
                                        }}
                                        title={d}
                                      />
                                    ))}
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        )}

                        <div
                          style={{
                            background: "white",
                            borderRadius: 10,
                            border: "1px solid #f1f5f9",
                            overflow: "hidden",
                          }}
                        >
                          <div
                            style={{
                              padding: "6px 12px",
                              background: "#f8fafc",
                              fontSize: 9,
                              fontWeight: 700,
                              color: "#64748b",
                              textTransform: "uppercase",
                            }}
                          >
                            Visit Timeline
                          </div>
                          {symptomsByVisit.slice(0, 10).map((v, i) => {
                            const s = String(v.date || "");
                            const fd =
                              s.length >= 10 ? new Date(s.slice(0, 10) + "T12:00:00") : new Date(s);
                            const months = [
                              "Jan",
                              "Feb",
                              "Mar",
                              "Apr",
                              "May",
                              "Jun",
                              "Jul",
                              "Aug",
                              "Sep",
                              "Oct",
                              "Nov",
                              "Dec",
                            ];
                            const dateStr = v.date
                              ? `${fd.getDate()} ${months[fd.getMonth()]} ${fd.getFullYear()}`
                              : "";
                            return (
                              <div
                                key={i}
                                style={{
                                  padding: "6px 12px",
                                  borderBottom:
                                    i < symptomsByVisit.length - 1 ? "1px solid #f1f5f9" : "none",
                                  display: "flex",
                                  gap: 10,
                                  alignItems: "flex-start",
                                }}
                              >
                                <div style={{ minWidth: 70, flexShrink: 0 }}>
                                  <div style={{ fontSize: 10, fontWeight: 700, color: "#475569" }}>
                                    {dateStr}
                                  </div>
                                  {v.doctor && (
                                    <div style={{ fontSize: 8, color: "#94a3b8" }}>{v.doctor}</div>
                                  )}
                                </div>
                                <div style={{ display: "flex", flexWrap: "wrap", gap: 3 }}>
                                  {v.symptoms.map((sym, si) => {
                                    const symKey = String(sym).toLowerCase().trim();
                                    const isRecurring =
                                      sortedSymptoms.find((x) => x.label.toLowerCase() === symKey)
                                        ?.count >= 2;
                                    return (
                                      <span
                                        key={si}
                                        style={{
                                          fontSize: 10,
                                          padding: "2px 8px",
                                          borderRadius: 6,
                                          background: isRecurring ? "#fef2f2" : "#f8fafc",
                                          color: isRecurring ? "#dc2626" : "#475569",
                                          fontWeight: isRecurring ? 700 : 400,
                                          border: `1px solid ${isRecurring ? "#fecaca" : "#e2e8f0"}`,
                                        }}
                                      >
                                        {sym}
                                      </span>
                                    );
                                  })}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })()}
                  {(() => {
                    const missing = [];
                    if (!outcomesData.hba1c?.length) missing.push("HbA1c");
                    if (!outcomesData.fpg?.length) missing.push("Fasting Glucose");
                    if (!outcomesData.ldl?.length) missing.push("LDL");
                    if (!outcomesData.egfr?.length) missing.push("eGFR");
                    return missing.length > 0 ? (
                      <div
                        style={{
                          background: "#fffbeb",
                          borderRadius: 12,
                          padding: "10px 14px",
                          border: "1px solid #fde68a",
                          marginBottom: 20,
                        }}
                      >
                        <div style={{ fontSize: 11, fontWeight: 700, color: "#92400e" }}>
                          ⚠️ Missing: {missing.join(", ")}
                        </div>
                        <div style={{ fontSize: 10, color: "#b45309", marginTop: 3 }}>
                          Add via 📜 Hx tab → Reports to see trends
                        </div>
                      </div>
                    ) : null;
                  })()}
                </>
              );
            })()}

          {/* ── HEALTH STORY (Date on TOP, filters, doctor) ── */}
          {outcomesData &&
            (() => {
              const events = [];
              const visitDiagChanges = {};
              (outcomesData.diagnosis_journey || []).forEach((d) => {
                const key = (d.visit_date || "").split("T")[0];
                if (!visitDiagChanges[key]) visitDiagChanges[key] = [];
                const exists = visitDiagChanges[key].find(
                  (x) => x.label === d.label && x.status === d.status,
                );
                if (!exists) visitDiagChanges[key].push({ label: d.label, status: d.status });
              });
              const visitNewMeds = {};
              const visitAllMeds = {};
              (outcomesData.med_timeline || []).forEach((m) => {
                const key = (m.visit_date || "").split("T")[0];
                const name = m.pharmacy_match || m.name;
                // Track all meds per visit
                if (!visitAllMeds[key]) visitAllMeds[key] = [];
                if (!visitAllMeds[key].includes(name)) visitAllMeds[key].push(name);
                // Track new meds separately
                if (!m.is_new) return;
                if (!visitNewMeds[key]) visitNewMeds[key] = [];
                if (!visitNewMeds[key].includes(name)) visitNewMeds[key].push(name);
              });

              const allDoctors = new Set();
              (outcomesData.visits || []).forEach((v) => {
                if (v.con_name) allDoctors.add(v.con_name);
                if (v.mo_name) allDoctors.add(v.mo_name);
                if (!v.visit_date) return;
                const dateKey = v.visit_date.split("T")[0];
                // Merge diagChanges from diagnosis_journey + OPD visit mo_data diagnoses
                const diagsFromVisit = (v.diagnoses || []).map((d) => ({
                  label: d.label,
                  status: d.status,
                }));
                const allDiagChanges = [...(visitDiagChanges[dateKey] || [])];
                for (const d of diagsFromVisit) {
                  if (!allDiagChanges.find((x) => x.label === d.label)) allDiagChanges.push(d);
                }

                // Collect meds: from med_timeline (all meds, not just new), then fallback to medications_confirmed JSON
                let visitMedNames = (visitAllMeds[dateKey] || []).slice(0);
                if (visitMedNames.length === 0 && v.medications_confirmed) {
                  for (const m of v.medications_confirmed) {
                    const name = m.pharmacy_match || m.name;
                    if (name && !visitMedNames.includes(name)) visitMedNames.push(name);
                  }
                }

                events.push({
                  date: dateKey,
                  type: "visit",
                  icon: "📋",
                  label: `${v.status === "historical" ? "Historical " : ""}${v.visit_type || "OPD"} Visit`,
                  doctor: v.con_name || v.mo_name || "",
                  summary: v.summary || "",
                  diagChanges: allDiagChanges,
                  newMeds: visitMedNames.slice(0, 8),
                  stoppedMeds: (v.stopped_medications || []).map((m) => m.name).filter(Boolean),
                  lifestyle: v.lifestyle || [],
                  compliance: fmtCompliance(v.compliance),
                  symptoms: (v.symptoms || v.chief_complaints || []).filter(
                    (s) =>
                      ![
                        "no gmi",
                        "no hypoglycemia",
                        "no hypoglycaemia",
                        "routine follow-up",
                        "follow-up visit",
                        "no complaints",
                      ].some((x) => String(s).toLowerCase().includes(x)),
                  ),
                  con_transcript: v.con_transcript || "",
                  visit_id: v.id,
                  color: "#0369a1",
                  bg: "#f0f9ff",
                });
              });

              const diagGrouped = {};
              (outcomesData.diagnosis_journey || []).forEach((d) => {
                if (!diagGrouped[d.diagnosis_id]) diagGrouped[d.diagnosis_id] = { label: d.label };
                diagGrouped[d.diagnosis_id].label = d.label;
              });
              Object.entries(diagGrouped).forEach(([id, info]) => {
                const match = info.label.match(/\((?:since\s+)?(\d+)\s*(?:years?|yrs?)\)/i);
                if (match) {
                  const onsetYear = new Date().getFullYear() - parseInt(match[1]);
                  events.push({
                    date: `${onsetYear}-06-01`,
                    type: "diagnosis",
                    icon: "🩺",
                    label: info.label.replace(/\s*\(.*?\)/, ""),
                    detail: `Estimated onset ~${onsetYear}`,
                    color: "#dc2626",
                    bg: "#fef2f2",
                  });
                }
              });

              (moData?.complications || []).forEach((c) => {
                if (c?.name)
                  events.push({
                    date: null,
                    type: "complication",
                    icon: "⚠️",
                    label: c.name,
                    detail: `${c.status}${c.detail ? ` — ${c.detail}` : ""}`,
                    color: "#dc2626",
                    bg: "#fef2f2",
                  });
              });
              if (moData?.history?.past_medical_surgical) {
                const pms = moData.history.past_medical_surgical;
                if (pms && pms !== "NIL" && pms.length > 3) {
                  pms.split(/[,;]/).forEach((item) => {
                    const trimmed = item.trim();
                    if (trimmed.length > 2) {
                      const yearMatch = trimmed.match(/(19|20)\d{2}/);
                      events.push({
                        date: yearMatch ? `${yearMatch[0]}-06-01` : null,
                        type: "history",
                        icon: "🏥",
                        label: trimmed,
                        detail: "Past medical/surgical",
                        color: "#7c3aed",
                        bg: "#faf5ff",
                      });
                    }
                  });
                }
              }
              (outcomesData.visits || []).forEach((v) => {
                if (v.complications && Array.isArray(v.complications)) {
                  v.complications.forEach((c) => {
                    if (
                      c?.name &&
                      !events.find((e) => e.label === c.name && e.type === "complication")
                    ) {
                      events.push({
                        date: null,
                        type: "complication",
                        icon: "⚠️",
                        label: c.name,
                        detail: `${c.status || ""}${c.detail ? ` — ${c.detail}` : ""}`,
                        color: "#dc2626",
                        bg: "#fef2f2",
                      });
                    }
                  });
                }
                if (v.history?.past_medical_surgical) {
                  const pms = v.history.past_medical_surgical;
                  if (pms && pms !== "NIL" && pms.length > 3) {
                    pms.split(/[,;]/).forEach((item) => {
                      const trimmed = item.trim();
                      if (
                        trimmed.length > 2 &&
                        !events.find((e) => e.label === trimmed && e.type === "history")
                      ) {
                        const yearMatch = trimmed.match(/(19|20)\d{2}/);
                        events.push({
                          date: yearMatch ? `${yearMatch[0]}-06-01` : null,
                          type: "history",
                          icon: "🏥",
                          label: trimmed,
                          detail: "Past medical/surgical",
                          color: "#7c3aed",
                          bg: "#faf5ff",
                        });
                      }
                    });
                  }
                }
              });

              if (patient.dob) {
                events.push({
                  date: patient.dob,
                  type: "life",
                  icon: "👶",
                  label: "Born",
                  detail: fmtDate(patient.dob),
                  color: "#6366f1",
                  bg: "#eef2ff",
                });
              } else if (patient.age) {
                const birthYear = new Date().getFullYear() - parseInt(patient.age);
                events.push({
                  date: `${birthYear}-01-01`,
                  type: "life",
                  icon: "👶",
                  label: "Born",
                  detail: `~${birthYear} (age ${patient.age})`,
                  color: "#6366f1",
                  bg: "#eef2ff",
                });
              }

              events.sort((a, b) => {
                if (a.type === "life") return 1;
                if (b.type === "life") return -1;
                if (!a.date && !b.date) return 0;
                if (!a.date) return 1;
                if (!b.date) return -1;
                return new Date(b.date) - new Date(a.date);
              });

              const seen = new Set();
              const unique = events.filter((e) => {
                const k = `${e.label}|${(e.date || "").split("T")[0]}`;
                if (seen.has(k)) return false;
                seen.add(k);
                return true;
              });

              if (unique.length === 0) return null;

              const filters = ["All", "Visits", "Diagnosis", "Meds", "Symptoms", "History"];
              const doctorList = [...allDoctors];
              const applyTypeFilter = (e, f) => {
                if (f === "All") return true;
                if (f === "Visits") return e.type === "visit";
                if (f === "Diagnosis")
                  return (
                    e.type === "diagnosis" || (e.type === "visit" && e.diagChanges?.length > 0)
                  );
                if (f === "Meds") return e.type === "visit" && e.newMeds?.length > 0;
                if (f === "Symptoms")
                  return (
                    (e.type === "visit" && e.symptoms?.length > 0) || e.type === "complication"
                  );
                if (f === "History")
                  return e.type === "history" || e.type === "complication" || e.type === "life";
                return true;
              };
              const filtered = unique.filter((e) => {
                if (!applyTypeFilter(e, timelineFilter)) return false;
                if (timelineDoctor && e.doctor && e.doctor !== timelineDoctor) return false;
                return true;
              });

              const fmtDateNice = (dateStr) => {
                if (!dateStr) return "—";
                const s = String(dateStr);
                const d = s.length === 10 ? new Date(s + "T12:00:00") : new Date(s);
                const months = [
                  "Jan",
                  "Feb",
                  "Mar",
                  "Apr",
                  "May",
                  "Jun",
                  "Jul",
                  "Aug",
                  "Sep",
                  "Oct",
                  "Nov",
                  "Dec",
                ];
                return `${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()}`;
              };

              return (
                <div
                  style={{
                    background: "white",
                    borderRadius: 16,
                    padding: 18,
                    border: "1px solid #f1f5f9",
                    marginBottom: 20,
                    boxShadow: "0 1px 4px rgba(0,0,0,0.04)",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                    <span style={{ fontSize: 18 }}>📖</span>
                    <span style={{ fontSize: 15, fontWeight: 800, color: "#0f172a" }}>
                      Health Story
                    </span>
                  </div>

                  <div
                    style={{
                      display: "flex",
                      gap: 4,
                      marginBottom: 6,
                      flexWrap: "wrap",
                      alignItems: "center",
                    }}
                  >
                    {filters.map((f) => {
                      const count = unique.filter((e) => applyTypeFilter(e, f)).length;
                      return (
                        <button
                          key={f}
                          onClick={() => setTimelineFilter(f)}
                          style={{
                            padding: "4px 10px",
                            fontSize: 10,
                            fontWeight: 700,
                            borderRadius: 20,
                            cursor: "pointer",
                            border: timelineFilter === f ? "none" : "1px solid #e2e8f0",
                            background: timelineFilter === f ? "#0f172a" : "white",
                            color: timelineFilter === f ? "white" : "#64748b",
                          }}
                        >
                          {f}
                          {f !== "All" ? ` (${count})` : ""}
                        </button>
                      );
                    })}
                  </div>
                  {doctorList.length > 0 && (
                    <div
                      style={{ display: "flex", gap: 3, marginBottom: 12, alignItems: "center" }}
                    >
                      <span style={{ fontSize: 9, color: "#94a3b8", fontWeight: 600 }}>
                        Doctor:
                      </span>
                      <button
                        onClick={() => setTimelineDoctor("")}
                        style={{
                          padding: "2px 8px",
                          fontSize: 9,
                          fontWeight: 600,
                          borderRadius: 12,
                          cursor: "pointer",
                          border: !timelineDoctor ? "none" : "1px solid #e2e8f0",
                          background: !timelineDoctor ? "#475569" : "white",
                          color: !timelineDoctor ? "white" : "#64748b",
                        }}
                      >
                        All
                      </button>
                      {doctorList.map((d) => (
                        <button
                          key={d}
                          onClick={() => setTimelineDoctor(timelineDoctor === d ? "" : d)}
                          style={{
                            padding: "2px 8px",
                            fontSize: 9,
                            fontWeight: 600,
                            borderRadius: 12,
                            cursor: "pointer",
                            border: timelineDoctor === d ? "none" : "1px solid #e2e8f0",
                            background: timelineDoctor === d ? "#475569" : "white",
                            color: timelineDoctor === d ? "white" : "#64748b",
                          }}
                        >
                          {d.startsWith("Dr") ? d : "Dr. " + d}
                        </button>
                      ))}
                    </div>
                  )}

                  <div style={{ position: "relative", paddingLeft: 34 }}>
                    <div
                      style={{
                        position: "absolute",
                        left: 13,
                        top: 8,
                        bottom: 8,
                        width: 2,
                        background: "linear-gradient(to bottom, #0ea5e9, #e2e8f0, #c4b5fd)",
                        borderRadius: 2,
                      }}
                    />

                    {filtered.map((ev, i) => {
                      const isVisit = ev.type === "visit";
                      return (
                        <div
                          key={i}
                          style={{
                            position: "relative",
                            marginBottom: i < filtered.length - 1 ? (isVisit ? 18 : 12) : 0,
                          }}
                        >
                          <div
                            style={{
                              position: "absolute",
                              left: -28,
                              top: 3,
                              width: 24,
                              height: 24,
                              borderRadius: "50%",
                              display: "flex",
                              alignItems: "center",
                              justifyContent: "center",
                              fontSize: 12,
                              background: ev.bg || "#f8fafc",
                              border: `2px solid ${ev.color || "#94a3b8"}`,
                              boxShadow: "0 1px 3px rgba(0,0,0,0.08)",
                              zIndex: 1,
                            }}
                          >
                            {ev.icon}
                          </div>

                          <div
                            style={{
                              background: isVisit ? "#f8fafc" : "transparent",
                              borderRadius: 12,
                              padding: isVisit ? "12px 14px" : "4px 0",
                              marginLeft: 6,
                              border: isVisit ? "1px solid #e2e8f0" : "none",
                            }}
                          >
                            <div
                              style={{
                                fontSize: 11,
                                fontWeight: 700,
                                color: "#475569",
                                marginBottom: 4,
                                background: isVisit ? "#e2e8f0" : "#f1f5f9",
                                display: "inline-block",
                                padding: "2px 10px",
                                borderRadius: 8,
                              }}
                            >
                              {fmtDateNice(ev.date)}
                            </div>

                            <div style={{ fontSize: 14, fontWeight: 700, color: "#0f172a" }}>
                              {ev.label}
                            </div>
                            {ev.doctor && (
                              <div style={{ fontSize: 10, color: "#64748b", marginTop: 1 }}>
                                👨‍⚕️ {ev.doctor.startsWith("Dr") ? ev.doctor : "Dr. " + ev.doctor}
                              </div>
                            )}

                            {isVisit && ev.summary && (
                              <div
                                style={{
                                  fontSize: 11,
                                  color: "#475569",
                                  marginTop: 6,
                                  lineHeight: "1.5",
                                  fontStyle: "italic",
                                  background: "white",
                                  borderRadius: 8,
                                  padding: "6px 10px",
                                  border: "1px solid #f1f5f9",
                                }}
                              >
                                {typeof ev.summary === "string"
                                  ? ev.summary.slice(0, 200) +
                                    (ev.summary.length > 200 ? "..." : "")
                                  : ""}
                              </div>
                            )}

                            {!isVisit && ev.detail && (
                              <div style={{ fontSize: 11, color: "#475569", marginTop: 3 }}>
                                {ev.detail}
                              </div>
                            )}

                            {isVisit && ev.compliance && (
                              <div style={{ marginTop: 6 }}>
                                <span
                                  style={{
                                    fontSize: 9,
                                    fontWeight: 700,
                                    padding: "2px 8px",
                                    borderRadius: 10,
                                    background: (ev.compliance + "").startsWith("Good")
                                      ? "#dcfce7"
                                      : (ev.compliance + "").startsWith("Poor")
                                        ? "#fef2f2"
                                        : "#fef3c7",
                                    color: (ev.compliance + "").startsWith("Good")
                                      ? "#059669"
                                      : (ev.compliance + "").startsWith("Poor")
                                        ? "#dc2626"
                                        : "#d97706",
                                  }}
                                >
                                  {ev.compliance}
                                </span>
                              </div>
                            )}

                            {isVisit && ev.diagChanges?.length > 0 && (
                              <div
                                style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 6 }}
                              >
                                {ev.diagChanges.map((d, di) => (
                                  <span
                                    key={di}
                                    style={{
                                      fontSize: 10,
                                      fontWeight: 600,
                                      padding: "2px 8px",
                                      borderRadius: 20,
                                      background:
                                        d.status === "Controlled"
                                          ? "#dcfce7"
                                          : d.status === "Uncontrolled"
                                            ? "#fef2f2"
                                            : "#dbeafe",
                                      color:
                                        d.status === "Controlled"
                                          ? "#059669"
                                          : d.status === "Uncontrolled"
                                            ? "#dc2626"
                                            : "#2563eb",
                                    }}
                                  >
                                    {(d.label || "").replace(/\s*\(.*?\)/, "")} — {d.status}
                                  </span>
                                ))}
                              </div>
                            )}

                            {isVisit && ev.symptoms?.length > 0 && (
                              <div
                                style={{ display: "flex", flexWrap: "wrap", gap: 3, marginTop: 4 }}
                              >
                                {ev.symptoms.map((s, si) => (
                                  <span
                                    key={si}
                                    style={{
                                      fontSize: 9,
                                      fontWeight: 600,
                                      padding: "2px 6px",
                                      borderRadius: 8,
                                      background: "#fef2f2",
                                      color: "#dc2626",
                                      border: "1px solid #fecaca",
                                    }}
                                  >
                                    ⚠️ {s}
                                  </span>
                                ))}
                              </div>
                            )}

                            {isVisit && ev.lifestyle?.length > 0 && (
                              <div
                                style={{ display: "flex", flexWrap: "wrap", gap: 3, marginTop: 4 }}
                              >
                                {(Array.isArray(ev.lifestyle) ? ev.lifestyle : [])
                                  .slice(0, 5)
                                  .map((l, li) => (
                                    <span
                                      key={li}
                                      style={{
                                        fontSize: 9,
                                        fontWeight: 600,
                                        padding: "2px 6px",
                                        borderRadius: 8,
                                        background: "#f0fdf4",
                                        color: "#059669",
                                        border: "1px solid #bbf7d0",
                                      }}
                                    >
                                      {typeof l === "object" ? l.advice : l}
                                    </span>
                                  ))}
                              </div>
                            )}

                            {isVisit && ev.newMeds?.length > 0 && (
                              <div
                                style={{ display: "flex", flexWrap: "wrap", gap: 3, marginTop: 4 }}
                              >
                                {ev.newMeds.map((m, mi) => (
                                  <span
                                    key={mi}
                                    style={{
                                      fontSize: 9,
                                      fontWeight: 600,
                                      padding: "2px 6px",
                                      borderRadius: 8,
                                      background: "#faf5ff",
                                      color: "#7c3aed",
                                      border: "1px solid #e9d5ff",
                                    }}
                                  >
                                    💊 {m}
                                  </span>
                                ))}
                              </div>
                            )}

                            {isVisit && ev.stoppedMeds?.length > 0 && (
                              <div
                                style={{ display: "flex", flexWrap: "wrap", gap: 3, marginTop: 4 }}
                              >
                                {ev.stoppedMeds.map((m, mi) => (
                                  <span
                                    key={mi}
                                    style={{
                                      fontSize: 9,
                                      fontWeight: 600,
                                      padding: "2px 6px",
                                      borderRadius: 8,
                                      background: "#fef2f2",
                                      color: "#dc2626",
                                      border: "1px solid #fecaca",
                                      textDecoration: "line-through",
                                    }}
                                  >
                                    🚫 {m}
                                  </span>
                                ))}
                              </div>
                            )}

                            {isVisit &&
                              ev.con_transcript &&
                              ev.con_transcript.trim().length > 20 && (
                                <div style={{ marginTop: 8 }}>
                                  <button
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      setExpandedPrescription(
                                        expandedPrescription === ev.visit_id ? null : ev.visit_id,
                                      );
                                    }}
                                    style={{
                                      fontSize: 10,
                                      fontWeight: 700,
                                      padding: "4px 12px",
                                      borderRadius: 8,
                                      cursor: "pointer",
                                      border:
                                        expandedPrescription === ev.visit_id
                                          ? "1px solid #0369a1"
                                          : "1px solid #e2e8f0",
                                      background:
                                        expandedPrescription === ev.visit_id ? "#f0f9ff" : "white",
                                      color:
                                        expandedPrescription === ev.visit_id
                                          ? "#0369a1"
                                          : "#64748b",
                                    }}
                                  >
                                    {expandedPrescription === ev.visit_id
                                      ? "▼ Hide Prescription"
                                      : "📄 View Prescription"}
                                  </button>
                                  {expandedPrescription === ev.visit_id && (
                                    <div
                                      style={{
                                        marginTop: 8,
                                        background: "white",
                                        border: "1px solid #e2e8f0",
                                        borderRadius: 10,
                                        padding: 14,
                                        maxHeight: 400,
                                        overflowY: "auto",
                                        fontSize: 11,
                                        lineHeight: "1.6",
                                        color: "#334155",
                                        fontFamily: "'SF Mono', 'Menlo', 'Monaco', monospace",
                                        whiteSpace: "pre-wrap",
                                        boxShadow: "inset 0 1px 3px rgba(0,0,0,0.06)",
                                      }}
                                    >
                                      {ev.con_transcript}
                                    </div>
                                  )}
                                </div>
                              )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })()}

          {/* ── DIAGNOSIS JOURNEY ── */}
          {outcomesData?.diagnosis_journey?.length > 0 &&
            (() => {
              const grouped = {};
              outcomesData.diagnosis_journey.forEach((d) => {
                if (!grouped[d.diagnosis_id])
                  grouped[d.diagnosis_id] = { label: d.label, history: [] };
                const dateKey = (d.visit_date || "").split("T")[0];
                if (
                  !grouped[d.diagnosis_id].history.find(
                    (h) => h.date.split("T")[0] === dateKey && h.status === d.status,
                  )
                ) {
                  grouped[d.diagnosis_id].history.push({
                    status: d.status,
                    date: d.visit_date,
                    doctor: d.con_name || d.mo_name,
                  });
                }
                grouped[d.diagnosis_id].label = d.label;
              });

              return (
                <div
                  style={{
                    background: "white",
                    borderRadius: 16,
                    padding: 16,
                    border: "1px solid #f1f5f9",
                    marginBottom: 20,
                    boxShadow: "0 1px 3px rgba(0,0,0,0.04)",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
                    <span style={{ fontSize: 16 }}>📈</span>
                    <span style={{ fontSize: 14, fontWeight: 800, color: "#0f172a" }}>
                      Diagnosis Journey
                    </span>
                    <span style={{ fontSize: 10, color: "#94a3b8", marginLeft: "auto" }}>
                      Click to expand
                    </span>
                  </div>
                  {Object.entries(grouped).map(([id, info], gi) => {
                    const latest = info.history[info.history.length - 1];
                    const sc =
                      latest.status === "Controlled"
                        ? "#059669"
                        : latest.status === "Uncontrolled"
                          ? "#dc2626"
                          : "#d97706";
                    const sb =
                      latest.status === "Controlled"
                        ? "#f0fdf4"
                        : latest.status === "Uncontrolled"
                          ? "#fef2f2"
                          : "#fffbeb";
                    const isExpanded = expandedDiagnosis === id;

                    const diagBiomarkers = {
                      dm2: ["hba1c", "fpg"],
                      dm1: ["hba1c", "fpg"],
                      htn: ["bp"],
                      hypo: ["tsh"],
                      dyslipidemia: ["ldl", "triglycerides", "hdl"],
                      ckd: ["egfr", "creatinine", "uacr"],
                      nephropathy: ["egfr", "creatinine", "uacr"],
                      obesity: ["weight"],
                    };
                    const relevantKeys = diagBiomarkers[id] || [];
                    const relevantData = relevantKeys
                      .map((k) => {
                        const d = outcomesData[k];
                        if (!d || !d.length) return null;
                        const latest = d[d.length - 1];
                        const first = d[0];
                        const val = latest.result || latest.bp_sys || latest.weight || latest[k];
                        const firstVal = first.result || first.bp_sys || first.weight || first[k];
                        return {
                          key: k,
                          label: k.toUpperCase().replace("_", " "),
                          latest: val,
                          first: firstVal,
                          count: d.length,
                        };
                      })
                      .filter(Boolean);

                    return (
                      <div
                        key={id}
                        style={{
                          padding: "10px 0",
                          borderBottom:
                            gi < Object.keys(grouped).length - 1 ? "1px solid #f1f5f9" : "none",
                          cursor: "pointer",
                        }}
                        onClick={() => setExpandedDiagnosis(isExpanded ? null : id)}
                      >
                        <div
                          style={{
                            display: "flex",
                            justifyContent: "space-between",
                            alignItems: "center",
                          }}
                        >
                          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                            <span style={{ fontSize: 13, fontWeight: 700, color: "#1e293b" }}>
                              {info.label}
                            </span>
                            <span style={{ fontSize: 10, color: "#94a3b8" }}>
                              {isExpanded ? "▼" : "▶"}
                            </span>
                          </div>
                          <span
                            style={{
                              fontSize: 11,
                              fontWeight: 700,
                              color: sc,
                              background: sb,
                              padding: "3px 12px",
                              borderRadius: 20,
                            }}
                          >
                            {latest.status}
                          </span>
                        </div>
                        <div
                          style={{
                            display: "flex",
                            gap: 6,
                            marginTop: 8,
                            flexWrap: "wrap",
                            alignItems: "center",
                          }}
                        >
                          {info.history.map((h, i) => {
                            const hs = String(h.date || "");
                            const hd =
                              hs.length >= 10
                                ? new Date(hs.slice(0, 10) + "T12:00:00")
                                : new Date(hs);
                            const months = [
                              "Jan",
                              "Feb",
                              "Mar",
                              "Apr",
                              "May",
                              "Jun",
                              "Jul",
                              "Aug",
                              "Sep",
                              "Oct",
                              "Nov",
                              "Dec",
                            ];
                            return (
                              <div
                                key={i}
                                style={{ display: "flex", alignItems: "center", gap: 4 }}
                              >
                                <div style={{ textAlign: "center" }}>
                                  <div
                                    style={{
                                      fontSize: 11,
                                      fontWeight: 700,
                                      padding: "3px 10px",
                                      borderRadius: 14,
                                      background:
                                        h.status === "Controlled"
                                          ? "#dcfce7"
                                          : h.status === "Uncontrolled"
                                            ? "#fef2f2"
                                            : "#fef3c7",
                                      color:
                                        h.status === "Controlled"
                                          ? "#059669"
                                          : h.status === "Uncontrolled"
                                            ? "#dc2626"
                                            : "#d97706",
                                    }}
                                  >
                                    {h.status === "Controlled"
                                      ? "C"
                                      : h.status === "Uncontrolled"
                                        ? "U"
                                        : "N"}
                                  </div>
                                  <div
                                    style={{
                                      fontSize: 10,
                                      color: "#64748b",
                                      marginTop: 2,
                                      fontWeight: 600,
                                    }}
                                  >
                                    {hd.getDate()} {months[hd.getMonth()]}{" "}
                                    {String(hd.getFullYear()).slice(2)}
                                  </div>
                                </div>
                                {i < info.history.length - 1 && (
                                  <span style={{ fontSize: 14, color: "#cbd5e1" }}>→</span>
                                )}
                              </div>
                            );
                          })}
                        </div>

                        {isExpanded && (
                          <div
                            style={{
                              marginTop: 10,
                              padding: 12,
                              background: "#fafbfc",
                              borderRadius: 10,
                              border: "1px solid #f1f5f9",
                            }}
                            onClick={(e) => e.stopPropagation()}
                          >
                            {relevantData.length > 0 && (
                              <div style={{ marginBottom: 8 }}>
                                <div
                                  style={{
                                    fontSize: 10,
                                    fontWeight: 700,
                                    color: "#475569",
                                    marginBottom: 6,
                                  }}
                                >
                                  📊 Key Biomarkers:
                                </div>
                                <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                                  {relevantData.map((rd, ri) => {
                                    const improving =
                                      rd.key === "egfr" || rd.key === "hdl"
                                        ? rd.latest > rd.first
                                        : rd.latest < rd.first;
                                    return (
                                      <div
                                        key={ri}
                                        style={{
                                          background: "white",
                                          borderRadius: 10,
                                          padding: "8px 12px",
                                          border: "1px solid #f1f5f9",
                                          minWidth: 110,
                                        }}
                                      >
                                        <div
                                          style={{ fontSize: 9, color: "#94a3b8", fontWeight: 600 }}
                                        >
                                          {rd.label}
                                        </div>
                                        <div
                                          style={{
                                            fontSize: 16,
                                            fontWeight: 800,
                                            color: improving ? "#059669" : "#dc2626",
                                          }}
                                        >
                                          {rd.latest}
                                        </div>
                                        {rd.count > 1 && (
                                          <div
                                            style={{
                                              fontSize: 9,
                                              color: improving ? "#059669" : "#dc2626",
                                            }}
                                          >
                                            {improving ? "↓" : "↑"} from {rd.first} ({rd.count}{" "}
                                            readings)
                                          </div>
                                        )}
                                      </div>
                                    );
                                  })}
                                </div>
                              </div>
                            )}
                            {(() => {
                              const diagMeds = (outcomesData.med_timeline || []).filter((m) => {
                                const name = (m.pharmacy_match || m.name || "").toString();
                                for (const [cls, info] of Object.entries(DRUG_BIOMARKER_MAP)) {
                                  if (
                                    relevantKeys.some((k) => info.biomarkers.includes(k)) &&
                                    info.patterns.test(name)
                                  )
                                    return true;
                                }
                                return false;
                              });
                              const uniqueMeds = {};
                              diagMeds.forEach((m) => {
                                const k = (m.pharmacy_match || m.name).toUpperCase();
                                if (!uniqueMeds[k]) uniqueMeds[k] = m;
                                else if (m.is_active) uniqueMeds[k] = m;
                              });
                              const medList = Object.values(uniqueMeds);
                              if (medList.length === 0) return null;
                              return (
                                <div>
                                  <div
                                    style={{
                                      fontSize: 10,
                                      fontWeight: 700,
                                      color: "#475569",
                                      marginBottom: 4,
                                    }}
                                  >
                                    💊 Current Protocol:
                                  </div>
                                  <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                                    {medList.map((m, mi) => (
                                      <span
                                        key={mi}
                                        style={{
                                          fontSize: 9,
                                          padding: "2px 8px",
                                          borderRadius: 8,
                                          background: m.is_active ? "#f0fdf4" : "#f8fafc",
                                          color: m.is_active ? "#059669" : "#94a3b8",
                                          border: `1px solid ${m.is_active ? "#bbf7d0" : "#e2e8f0"}`,
                                          fontWeight: 600,
                                          textDecoration: m.is_active ? "none" : "line-through",
                                        }}
                                      >
                                        {m.pharmacy_match || m.name} {m.dose} {m.frequency}
                                      </span>
                                    ))}
                                  </div>
                                </div>
                              );
                            })()}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              );
            })()}

          {/* ── MEDICATIONS ── */}
          {outcomesData?.med_timeline?.length > 0 &&
            (() => {
              const grouped = {};
              outcomesData.med_timeline.forEach((m) => {
                const key = (m.pharmacy_match || m.name).toUpperCase();
                if (!grouped[key]) grouped[key] = { name: m.pharmacy_match || m.name, entries: [] };
                grouped[key].entries.push(m);
              });
              Object.values(grouped).forEach((g) => {
                const seen = new Set();
                g.entries = g.entries.filter((e) => {
                  const k = `${e.dose}|${e.frequency}|${e.visit_date}`;
                  if (seen.has(k)) return false;
                  seen.add(k);
                  return true;
                });
              });
              const activeMeds = Object.values(grouped).filter(
                (m) => m.entries[m.entries.length - 1]?.is_active,
              );
              const stoppedMeds = Object.values(grouped).filter(
                (m) => !m.entries[m.entries.length - 1]?.is_active,
              );
              const fmtD = (d) => {
                if (!d) return "";
                const s = String(d);
                const x = s.length === 10 ? new Date(s + "T12:00:00") : new Date(s);
                const m = [
                  "Jan",
                  "Feb",
                  "Mar",
                  "Apr",
                  "May",
                  "Jun",
                  "Jul",
                  "Aug",
                  "Sep",
                  "Oct",
                  "Nov",
                  "Dec",
                ];
                return `${x.getDate()} ${m[x.getMonth()]} ${x.getFullYear()}`;
              };
              return (
                <div
                  style={{
                    background: "white",
                    borderRadius: 16,
                    padding: 16,
                    border: "1px solid #f1f5f9",
                    marginBottom: 20,
                    boxShadow: "0 1px 3px rgba(0,0,0,0.04)",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
                    <span style={{ fontSize: 16 }}>💊</span>
                    <span style={{ fontSize: 14, fontWeight: 800, color: "#0f172a" }}>
                      Medications
                    </span>
                    <span style={{ fontSize: 10, color: "#94a3b8", marginLeft: "auto" }}>
                      {activeMeds.length} active
                      {stoppedMeds.length > 0 ? ` · ${stoppedMeds.length} stopped` : ""}
                    </span>
                  </div>
                  {activeMeds.map((med, mi) => {
                    const latest = med.entries[med.entries.length - 1];
                    const first = med.entries[0];
                    const doseChanged = latest.dose !== first.dose && med.entries.length > 1;
                    return (
                      <div
                        key={mi}
                        style={{
                          display: "flex",
                          gap: 10,
                          padding: "8px 0",
                          borderBottom: mi < activeMeds.length - 1 ? "1px solid #f8fafc" : "none",
                          alignItems: "center",
                        }}
                      >
                        <div
                          style={{
                            width: 4,
                            height: 28,
                            borderRadius: 2,
                            background: "#059669",
                            flexShrink: 0,
                          }}
                        />
                        <div style={{ flex: 1 }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                            <span style={{ fontSize: 12, fontWeight: 700, color: "#1e293b" }}>
                              {med.name}
                            </span>
                            {doseChanged && (
                              <span
                                style={{
                                  fontSize: 8,
                                  padding: "1px 6px",
                                  background: "#fef3c7",
                                  color: "#d97706",
                                  borderRadius: 10,
                                  fontWeight: 700,
                                }}
                              >
                                dose changed
                              </span>
                            )}
                          </div>
                          <div style={{ fontSize: 10, color: "#64748b", marginTop: 1 }}>
                            {latest.dose} · {latest.frequency}
                            {latest.timing ? ` · ${latest.timing}` : ""} ·{" "}
                            <span style={{ color: "#94a3b8" }}>
                              since {fmtD(first.started_date || first.visit_date)}
                            </span>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                  {stoppedMeds.length > 0 && (
                    <div style={{ marginTop: 8, paddingTop: 8, borderTop: "1px dashed #e2e8f0" }}>
                      <div
                        style={{
                          fontSize: 10,
                          color: "#94a3b8",
                          fontWeight: 700,
                          marginBottom: 4,
                          textTransform: "uppercase",
                          letterSpacing: "0.5px",
                        }}
                      >
                        Stopped
                      </div>
                      {stoppedMeds.map((med, mi) => (
                        <div
                          key={mi}
                          style={{
                            display: "flex",
                            gap: 10,
                            padding: "4px 0",
                            alignItems: "center",
                          }}
                        >
                          <div
                            style={{
                              width: 4,
                              height: 20,
                              borderRadius: 2,
                              background: "#e2e8f0",
                              flexShrink: 0,
                            }}
                          />
                          <span
                            style={{
                              fontSize: 11,
                              color: "#94a3b8",
                              textDecoration: "line-through",
                            }}
                          >
                            {med.name}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })()}

          {/* ── RECENT LABS ── */}
          {pfd?.lab_results?.length > 0 && (
            <div
              style={{
                background: "white",
                borderRadius: 16,
                padding: 16,
                border: "1px solid #f1f5f9",
                boxShadow: "0 1px 3px rgba(0,0,0,0.04)",
                marginBottom: 20,
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
                <span style={{ fontSize: 16 }}>🧪</span>
                <span style={{ fontSize: 14, fontWeight: 800, color: "#0f172a" }}>
                  Recent Lab Results
                </span>
              </div>
              {(() => {
                const labs = pfd.lab_results || [];
                const months = [
                  "Jan",
                  "Feb",
                  "Mar",
                  "Apr",
                  "May",
                  "Jun",
                  "Jul",
                  "Aug",
                  "Sep",
                  "Oct",
                  "Nov",
                  "Dec",
                ];
                const fmtD = (dt) => {
                  const s = String(dt || "");
                  const d = s.length >= 10 ? new Date(s.slice(0, 10) + "T12:00:00") : new Date(s);
                  return `${d.getDate()} ${months[d.getMonth()]} ${String(d.getFullYear()).slice(2)}`;
                };
                const dateKey = (dt) => String(dt || "").slice(0, 10);
                const allDates = [...new Set(labs.map((l) => dateKey(l.test_date)))]
                  .filter(Boolean)
                  .sort();
                const seen = new Set();
                const testNames = [];
                labs.forEach((l) => {
                  if (!seen.has(l.test_name)) {
                    seen.add(l.test_name);
                    testNames.push(l.test_name);
                  }
                });
                const lookup = {};
                labs.forEach((l) => {
                  if (!lookup[l.test_name]) lookup[l.test_name] = {};
                  lookup[l.test_name][dateKey(l.test_date)] = l;
                });
                const showDates = allDates.slice(-6);
                return (
                  <div style={{ overflowX: "auto" }}>
                    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
                      <thead>
                        <tr style={{ borderBottom: "2px solid #e2e8f0" }}>
                          <th
                            style={{
                              textAlign: "left",
                              padding: "6px 8px",
                              fontSize: 10,
                              color: "#94a3b8",
                              fontWeight: 700,
                              position: "sticky",
                              left: 0,
                              background: "white",
                              minWidth: 100,
                            }}
                          >
                            Test
                          </th>
                          <th
                            style={{
                              padding: "6px 4px",
                              fontSize: 9,
                              color: "#94a3b8",
                              fontWeight: 600,
                              minWidth: 40,
                            }}
                          >
                            Ref
                          </th>
                          {showDates.map((dt) => (
                            <th
                              key={dt}
                              style={{
                                padding: "6px 6px",
                                fontSize: 9,
                                color: "#475569",
                                fontWeight: 700,
                                minWidth: 55,
                                textAlign: "center",
                              }}
                            >
                              {fmtD(dt)}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {testNames.map((tn, i) => (
                          <tr
                            key={tn}
                            style={{
                              borderBottom: "1px solid #f1f5f9",
                              background: i % 2 ? "#fafbfc" : "white",
                            }}
                          >
                            <td
                              style={{
                                padding: "5px 8px",
                                fontWeight: 600,
                                color: "#334155",
                                position: "sticky",
                                left: 0,
                                background: i % 2 ? "#fafbfc" : "white",
                              }}
                            >
                              {tn}
                            </td>
                            <td
                              style={{
                                padding: "5px 4px",
                                fontSize: 9,
                                color: "#94a3b8",
                                textAlign: "center",
                              }}
                            >
                              {lookup[tn][Object.keys(lookup[tn])[0]]?.ref_range || ""}
                            </td>
                            {showDates.map((dt) => {
                              const v = lookup[tn]?.[dt];
                              return (
                                <td
                                  key={dt}
                                  style={{
                                    padding: "5px 6px",
                                    textAlign: "center",
                                    fontWeight: v ? 700 : 400,
                                    color: !v
                                      ? "#e2e8f0"
                                      : v.flag === "H" || v.flag === "HIGH"
                                        ? "#dc2626"
                                        : v.flag === "L" || v.flag === "LOW"
                                          ? "#2563eb"
                                          : "#374151",
                                  }}
                                >
                                  {v ? (
                                    <>
                                      {fmtLabVal(null, v.result)}
                                      <span
                                        style={{
                                          fontSize: 8,
                                          fontWeight: 400,
                                          color: "#94a3b8",
                                          marginLeft: 1,
                                        }}
                                      >
                                        {v.unit}
                                      </span>
                                    </>
                                  ) : (
                                    "—"
                                  )}
                                </td>
                              );
                            })}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                );
              })()}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
