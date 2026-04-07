import { useState } from "react";
import { useNavigate } from "react-router-dom";
import VisitSummaryPanel from "../components/visit/VisitSummaryPanel";
import useAuthStore from "../stores/authStore.js";
import usePatientStore from "../stores/patientStore.js";
import useLabStore from "../stores/labStore.js";
import useClinicalStore from "../stores/clinicalStore.js";
import useVisitStore from "../stores/visitStore.js";
import useUiStore from "../stores/uiStore.js";
import "./FUReviewPage.css";

export default function FUReviewPage() {
  const navigate = useNavigate();
  const [continuing, setContinuing] = useState(false);
  const { conName } = useAuthStore();
  const { patient, getPfd, dbPatientId } = usePatientStore();
  const { labData } = useLabStore();
  const { conData } = useClinicalStore();
  const {
    fuShowLastSummary,
    setFuShowLastSummary,
    fuAbnormalActions,
    setFuAbnormalActions,
    saveDraft,
  } = useVisitStore();

  const pfd = getPfd();

  return (
    <div>
      <div className="fu-review__header">
        <span className="fu-review__header-icon">📊</span>
        <div className="fu-review__header-info">
          <div className="fu-review__header-title">Review — What Changed?</div>
          <div className="fu-review__header-sub">
            Visit #{(pfd?.consultations?.length || 0) + 1} • {patient.name}
          </div>
        </div>
        <span className="fu-review__header-step">Step 2/5</span>
      </div>

      {pfd?.consultations?.length > 0 &&
        (() => {
          const lastCon = pfd.consultations[0];
          const lastDate = lastCon?.visit_date
            ? new Date(String(lastCon.visit_date).slice(0, 10) + "T12:00:00")
            : null;
          const daysSince = lastDate ? Math.round((Date.now() - lastDate) / 86400000) : null;
          const lastConData = conData || lastCon?.con_data || {};
          const lastGoals = lastConData.goals || [];
          const uniqueDx = [
            ...new Map((pfd.diagnoses || []).map((d) => [d.diagnosis_id || d.label, d])).values(),
          ];
          const activeMeds = (pfd.medications || []).filter((m) => m.is_active !== false);
          const uniqueMeds = [
            ...new Map(activeMeds.map((m) => [(m.name || "").toUpperCase(), m])).values(),
          ];

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
            CAD: { markers: ["LDL", "Triglycerides"], lower: true, targets: { LDL: "<70" } },
            MASLD: { markers: ["SGPT (ALT)", "SGOT (AST)", "GGT"], lower: true, targets: {} },
            "Vit D Deficiency": {
              markers: ["Vitamin D"],
              lower: false,
              targets: { "Vitamin D": ">30" },
            },
            Gout: { markers: ["Uric Acid"], lower: true, targets: { "Uric Acid": "<6" } },
          };
          const findBio = (label) =>
            DX_BIO[label] ||
            DX_BIO[
              Object.keys(DX_BIO).find((k) => label?.toLowerCase().includes(k.toLowerCase()))
            ] ||
            null;
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

          const allMarkers = new Map();
          uniqueDx.forEach((dx) => {
            const bio = findBio(dx.label);
            if (!bio) return;
            bio.markers.forEach((m) => {
              const t = getTrend(m);
              if (!t) return;
              if (!allMarkers.has(m)) {
                const goal = lastGoals.find((g) => g.marker === m);
                const target = goal?.target || bio.targets?.[m] || "";
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
              } else {
                allMarkers.get(m).dxLabels.push(dx.label);
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

          const otherDoctors = [
            ...new Set(
              (pfd.medications || [])
                .filter(
                  (m) =>
                    m.prescriber && m.prescriber !== "Dr. Bhansali" && m.prescriber !== conName,
                )
                .map((m) => m.prescriber),
            ),
          ];

          return (
            <div>
              {/* ── Clinical Summary Panel ── */}
              <VisitSummaryPanel patientId={dbPatientId} />

              {/* Last Visit Summary (expandable) */}
              {lastConData.assessment_summary && (
                <div className="fu-review__summary-card">
                  <button
                    onClick={() => setFuShowLastSummary(!fuShowLastSummary)}
                    className="fu-review__summary-toggle"
                  >
                    <span className="fu-review__summary-toggle-icon">📄</span>
                    <span className="fu-review__summary-toggle-text">
                      Last Visit Summary —{" "}
                      {lastDate
                        ? lastDate.toLocaleDateString("en-IN", {
                            day: "2-digit",
                            month: "short",
                            year: "numeric",
                          })
                        : ""}
                    </span>
                    <span className="fu-review__summary-toggle-arrow">
                      {fuShowLastSummary ? "▲" : "▼"}
                    </span>
                  </button>
                  {fuShowLastSummary && (
                    <div className="fu-review__summary-body">{lastConData.assessment_summary}</div>
                  )}
                </div>
              )}

              {/* AI Brief */}
              <div className="fu-review__brief">
                <div className="fu-review__brief-header">
                  <div className="fu-review__brief-title">🤖 AI Patient Brief</div>
                  <div className="fu-review__brief-sub">
                    {pfd.consultations.length} visits • {uniqueMeds.length} medications
                  </div>
                </div>
                <div className="fu-review__brief-body">
                  <div className="fu-review__brief-tags">
                    <span className="fu-review__brief-tag">
                      🏥 {pfd.consultations.length} visits
                    </span>
                    <span className="fu-review__brief-tag">💊 {uniqueMeds.length} medications</span>
                    {otherDoctors.slice(0, 3).map((d, i) => (
                      <span key={i} className="fu-review__brief-tag--doctor">
                        👨‍⚕️ {d}
                      </span>
                    ))}
                  </div>
                  {/* Conditions */}
                  <div className="fu-review__conditions">
                    {uniqueDx.map((d, i) => (
                      <span
                        key={i}
                        className="fu-review__condition"
                        style={{
                          background:
                            d.status === "Uncontrolled"
                              ? "#fef2f2"
                              : d.status === "Controlled"
                                ? "#f0fdf4"
                                : "#f8fafc",
                          color:
                            d.status === "Uncontrolled"
                              ? "#dc2626"
                              : d.status === "Controlled"
                                ? "#059669"
                                : "#64748b",
                          border: `1.5px solid ${d.status === "Uncontrolled" ? "#fecaca" : d.status === "Controlled" ? "#bbf7d0" : "#e2e8f0"}`,
                        }}
                      >
                        {d.label} • {d.status || "Active"}
                      </span>
                    ))}
                  </div>
                </div>
              </div>

              {/* Goal Trends */}
              {allMarkers.size > 0 && (
                <div className="fu-review__goals">
                  <div className="fu-review__goals-title">🎯 Goal Progress</div>
                  <div className="fu-review__goals-grid">
                    {[...allMarkers.values()].map((marker, i) => {
                      const st = getStatusBadge(marker);
                      const t = marker.trend;
                      return (
                        <div
                          key={i}
                          className="fu-review__goal-card"
                          style={{ border: `2px solid ${st.bg}22` }}
                        >
                          <div
                            className="fu-review__goal-header"
                            style={{ borderBottom: `1px solid ${st.bg}20` }}
                          >
                            <div className="fu-review__goal-info">
                              <div className="fu-review__goal-name">{marker.name}</div>
                              <div className="fu-review__goal-target">
                                Target: {marker.target || "—"}
                              </div>
                            </div>
                            <span className="fu-review__goal-badge" style={{ background: st.bg }}>
                              {st.icon} {st.label}
                            </span>
                          </div>
                          <div className="fu-review__goal-body">
                            {t.vals.length > 0 && (
                              <div className="fu-review__goal-bars">
                                {t.vals.map((v, vi) => {
                                  const nums = t.vals.map((x) => parseFloat(x.result) || 0);
                                  const max = Math.max(...nums) * 1.1 || 1,
                                    min = Math.min(...nums) * 0.9 || 0;
                                  const val = parseFloat(v.result) || 0;
                                  const h = ((val - min) / (max - min || 1)) * 30 + 6;
                                  return (
                                    <div key={vi} className="fu-review__goal-bar-item">
                                      <div
                                        className="fu-review__goal-bar-val"
                                        style={{
                                          color: v._isNew ? st.bg : "#94a3b8",
                                          fontWeight: v._isNew ? 800 : 600,
                                        }}
                                      >
                                        {v.result}
                                      </div>
                                      <div
                                        className="fu-review__goal-bar"
                                        style={{
                                          height: h,
                                          background: v._isNew ? st.bg : "#e2e8f0",
                                        }}
                                      />
                                      <div
                                        className="fu-review__goal-bar-date"
                                        style={{
                                          color: v._isNew ? st.bg : "#94a3b8",
                                          fontWeight: v._isNew ? 800 : 400,
                                        }}
                                      >
                                        {v._isNew ? "NOW" : v.test_date?.slice(5, 10) || ""}
                                      </div>
                                    </div>
                                  );
                                })}
                              </div>
                            )}
                            <div className="fu-review__goal-comparison">
                              {t.prev && (
                                <span>
                                  Was: <b>{t.prev}</b>
                                </span>
                              )}
                              {t.isNew && (
                                <span>
                                  {" "}
                                  → Now: <b style={{ color: st.bg, fontSize: 14 }}>{t.latest}</b>
                                </span>
                              )}
                              {!t.isNew && !t.prev && (
                                <span>
                                  Latest: <b>{t.latest}</b>
                                </span>
                              )}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* New Abnormal Findings */}
              {flaggedNew.length > 0 && (
                <div className="fu-review__abnormal">
                  <div className="fu-review__abnormal-title">
                    🚨 New Abnormal Findings — Action Required
                  </div>
                  {flaggedNew.map((ab, i) => (
                    <div key={i} className="fu-review__abnormal-card">
                      <div className="fu-review__abnormal-header">
                        <span
                          className="fu-review__abnormal-icon"
                          style={{ color: ab.flag === "H" ? "#dc2626" : "#2563eb" }}
                        >
                          {ab.flag === "H" ? "⬆" : "⬇"}
                        </span>
                        <div className="fu-review__abnormal-info">
                          <div className="fu-review__abnormal-name">
                            {ab.name}:{" "}
                            <span style={{ color: ab.flag === "H" ? "#dc2626" : "#2563eb" }}>
                              {ab.result} {ab.unit}
                            </span>
                          </div>
                          <div className="fu-review__abnormal-hint">
                            ⚠️ Not part of current diagnoses
                          </div>
                        </div>
                      </div>
                      <div className="fu-review__abnormal-actions">
                        {["🔍 Investigate", "💊 Treat Now", "📋 Add Diagnosis", "👀 Monitor"].map(
                          (action) => {
                            const active = fuAbnormalActions[ab.name] === action;
                            return (
                              <button
                                key={action}
                                onClick={() =>
                                  setFuAbnormalActions((p) => ({
                                    ...p,
                                    [ab.name]: active ? "" : action,
                                  }))
                                }
                                className="fu-review__abnormal-action-btn"
                                style={{
                                  border: `2px solid ${active ? "#7c3aed" : "#e2e8f0"}`,
                                  background: active ? "#7c3aed" : "white",
                                  color: active ? "white" : "#475569",
                                }}
                              >
                                {action}
                              </button>
                            );
                          },
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })()}

      <button
        disabled={continuing}
        onClick={async () => {
          setContinuing(true);
          try {
            await saveDraft();
          } catch {}
          setContinuing(false);
          navigate("/fu-edit");
        }}
        className="fu-review__next-btn"
      >
        {continuing ? "Saving..." : "Next: Edit Plan →"}
      </button>
    </div>
  );
}
