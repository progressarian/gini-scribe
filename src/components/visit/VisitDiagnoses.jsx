import { memo, useMemo } from "react";
import { DX_STATUS_STYLE, DX_STATUS_DEFAULT, getDxSuggestion } from "./helpers";
import { sortDiagnoses, detectDiagnosisCategory } from "../../server-utils/diagnosisSort";

const DX_STATUS_OPTS = [
  "Newly Diagnosed",
  "Active",
  "Controlled",
  "Improving",
  "Review",
  "Uncontrolled",
  "Worsening",
  "Stable",
  "Monitoring",
  "In Remission",
  "Resolved",
];

// Category section labels and left-border colors
const CATEGORY_CONFIG = {
  primary:     { label: "PRIMARY CONDITION",       borderDefault: "#E24B4A" },
  complication:{ label: "DIABETIC COMPLICATIONS",  borderDefault: "#EF9F27" },
  comorbidity: { label: "COMORBIDITIES",           borderDefault: "#888780" },
  external:    { label: "EXTERNAL / OTHER DOCTORS",borderDefault: "#378ADD" },
  monitoring:  { label: "UNDER MONITORING",        borderDefault: "#B4B2A9" },
};

// Border color overrides based on status
function getBorderColor(category, status) {
  const s = (status || "").toLowerCase();
  if (category === "primary") return "#E24B4A"; // always red
  if (category === "complication") {
    if (s === "uncontrolled" || s === "worsening") return "#E24B4A"; // red
    return "#EF9F27"; // amber for stable/improving/active
  }
  if (category === "external") return "#378ADD";
  if (category === "monitoring") return "#B4B2A9";
  return "#888780"; // comorbidity = gray
}

// Find all numeric results for a test (up to `limit` most recent), sorted newest-first
function findHistory(labResults, names, limit = 3) {
  if (!labResults?.length) return [];
  const matches = [];
  for (const l of labResults) {
    if (l.result == null) continue;
    const cn = (l.canonical_name || "").toLowerCase();
    const tn = (l.test_name || "").toLowerCase();
    if (names.some((n) => cn === n.toLowerCase() || tn === n.toLowerCase())) {
      const v = parseFloat(l.result);
      if (!isNaN(v)) matches.push({ value: v, date: l.test_date });
    }
    if (matches.length >= limit) break; // labResults already sorted DESC
  }
  return matches;
}

// Build a trend string like "5.9→6.3→6.9 ↑" from history array
// lowerIsBetter: true for HbA1c/LDL/BP/UACR, false for eGFR
function trendInfo(history, lowerIsBetter = true) {
  if (history.length < 2) return { arrow: "", trendText: "", trendColor: "#6b7280" };
  const current = history[0].value;
  const previous = history[1].value;
  const diff = current - previous;
  const pctChange = Math.abs(diff / (previous || 1)) * 100;

  // < 3% change = stable
  if (pctChange < 3) return { arrow: "→", trendText: "", trendColor: "#6b7280" };

  const improving = lowerIsBetter ? diff < 0 : diff > 0;
  const arrow = improving ? "↓" : "↑";
  const trendColor = improving ? "#16a34a" : "#dc2626";

  // Build trajectory string from oldest to newest (reverse the array)
  const vals = history.slice().reverse().map((h) => h.value);
  const trendText = vals.join("→");

  return { arrow, trendText, trendColor };
}

// Inline biomarker tag for a diagnosis — now with trend arrows
function getBiomarkerTag(dx, labResults, vitals) {
  const id = (dx.diagnosis_id || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const label = (dx.label || "").toLowerCase();
  const text = `${id} ${label}`;

  function makeTag(displayLabel, value, color, history, lowerIsBetter = true) {
    const { arrow, trendText, trendColor } = trendInfo(history, lowerIsBetter);
    const fullLabel = arrow && trendText
      ? `${displayLabel} ${arrow} (${trendText})`
      : `${displayLabel}`;
    return { label: fullLabel, color: arrow ? trendColor : color };
  }

  // Type 2 DM → HbA1c + FBS
  if (text.includes("dm2") || text.includes("dm1") || text.includes("diabetes")) {
    const hHist = findHistory(labResults, ["HbA1c", "Glycated Hemoglobin", "A1c", "HBA1C"]);
    const fHist = findHistory(labResults, ["FBS", "Fasting Glucose", "Fasting Blood Sugar", "FPG"]);
    if (hHist.length > 0) {
      const v = hHist[0].value;
      const color = v <= 7 ? "#16a34a" : v <= 9 ? "#d97706" : "#dc2626";
      const tags = [makeTag(`HbA1c ${v}%`, v, color, hHist, true)];
      if (fHist.length > 0) {
        const fv = fHist[0].value;
        tags.push(makeTag(`FBS ${fv}`, fv, fv <= 130 ? "#16a34a" : "#d97706", fHist, true));
      }
      return tags;
    }
  }

  // Nephropathy → UACR
  if (text.includes("nephropathy")) {
    const hist = findHistory(labResults, ["UACR", "Urine ACR", "Microalbumin"]);
    if (hist.length > 0) {
      const v = hist[0].value;
      const color = v > 60 ? "#dc2626" : v > 30 ? "#d97706" : "#16a34a";
      return [makeTag(`UACR ${v} mg/g`, v, color, hist, true)];
    }
  }

  // Hypertension → BP (vitals don't have history in the same format, show current only)
  if (text.includes("htn") || text.includes("hypertension")) {
    const sys = vitals?.bp_sys || vitals?.bpSys;
    const dia = vitals?.bp_dia || vitals?.bpDia;
    if (sys) {
      const v = parseFloat(sys);
      const color = v > 150 ? "#dc2626" : v > 130 ? "#d97706" : "#16a34a";
      return [{ label: `BP ${sys}/${dia || "?"}`, color }];
    }
  }

  // Dyslipidemia → LDL
  if (text.includes("lipid") || text.includes("dyslipid") || text.includes("cholesterol")) {
    const hist = findHistory(labResults, ["LDL", "LDL Cholesterol", "LDL-C", "LDL CHOLESTEROL-DIRECT"]);
    if (hist.length > 0) {
      const v = hist[0].value;
      const color = v > 130 ? "#dc2626" : v > 100 ? "#d97706" : "#16a34a";
      return [makeTag(`LDL ${v}`, v, color, hist, true)];
    }
  }

  // Hypothyroidism → TSH
  if (text.includes("thyroid") || text.includes("hypo")) {
    const hist = findHistory(labResults, ["TSH", "Thyroid Stimulating Hormone"]);
    if (hist.length > 0) {
      const v = hist[0].value;
      const color = v < 0.5 || v > 4.5 ? "#dc2626" : "#16a34a";
      // TSH: for hypothyroid patients, lower is better (they start high)
      return [makeTag(`TSH ${v}`, v, color, hist, true)];
    }
  }

  // Obesity → BMI + weight
  if (text.includes("obesity") || text.includes("adiposity") || text.includes("bmi")) {
    const bmi = vitals?.bmi;
    const wt = vitals?.weight;
    if (bmi || wt) {
      const tags = [];
      if (bmi) tags.push({ label: `BMI ${bmi}`, color: parseFloat(bmi) > 30 ? "#dc2626" : "#d97706" });
      if (wt) tags.push({ label: `${wt} kg`, color: "#6b7280" });
      return tags;
    }
  }

  // NAFLD/MASLD → ALT/AST
  if (text.includes("nafld") || text.includes("masld") || text.includes("fatty liver")) {
    const hist = findHistory(labResults, ["ALT", "SGPT", "Alanine Aminotransferase"]);
    if (hist.length > 0) {
      const v = hist[0].value;
      return [makeTag(`ALT ${v}`, v, v > 40 ? "#dc2626" : "#16a34a", hist, true)];
    }
    return [{ label: "No liver enzymes on file", color: "#9ca3af" }];
  }

  // CKD → eGFR + Creatinine
  if (text.includes("ckd") || (text.includes("kidney") && !text.includes("nephropathy"))) {
    const eHist = findHistory(labResults, ["eGFR", "GFR", "Estimated GFR"]);
    const cHist = findHistory(labResults, ["Creatinine", "S.Creatinine", "Serum Creatinine"]);
    const tags = [];
    if (eHist.length > 0) tags.push(makeTag(`eGFR ${eHist[0].value}`, eHist[0].value, eHist[0].value < 60 ? "#dc2626" : "#16a34a", eHist, false));
    if (cHist.length > 0) tags.push(makeTag(`Cr ${cHist[0].value}`, cHist[0].value, cHist[0].value > 1.2 ? "#dc2626" : "#16a34a", cHist, true));
    return tags.length > 0 ? tags : null;
  }

  return null;
}

// Extract clinical detail from notes like "healthray:234347328 - G2A1" to "G2A1"
function extractHRDetail(notes) {
  if (!notes) return null;
  const m = notes.match(/^healthray:\d+\s*[—–-]+\s*(.+)$/i);
  return m ? m[1].trim() : null;
}

function displayNote(notes) {
  if (!notes) return null;
  if (/^healthray:\d+$/.test(notes.trim())) return null;
  if (/^healthray:\d+\s*[—–-]+/.test(notes)) return null;
  return notes;
}

function normalizeLabel(label) {
  if (!label) return "";
  return label.toLowerCase().replace(/[^a-z0-9]/g, "").trim();
}

const VisitDiagnoses = memo(function VisitDiagnoses({
  activeDx,
  healthrayDiagnoses,
  labResults,
  vitals,
  onAddDiagnosis,
  onDiagnosisNote,
  onUpdateDiagnosis,
}) {
  // Deduplicate, sort, and group by category
  const { grouped, globalIndex } = useMemo(() => {
    if (!activeDx?.length) return { grouped: {}, globalIndex: new Map() };

    // Dedup by normalized label
    const seen = new Map();
    for (const dx of activeDx) {
      const key = normalizeLabel(dx.label || dx.diagnosis_id);
      if (!key) continue;
      if (!seen.has(key)) {
        seen.set(key, dx);
      } else {
        const existing = seen.get(key);
        if (dx.is_active && !existing.is_active) seen.set(key, dx);
        else if (dx.updated_at && (!existing.updated_at || dx.updated_at > existing.updated_at)) seen.set(key, dx);
      }
    }

    // Sort using clinical order
    const sorted = sortDiagnoses(Array.from(seen.values()));

    // Build global numbering
    const idxMap = new Map();
    sorted.forEach((dx, i) => idxMap.set(dx.id || i, i + 1));

    // Group by category
    const groups = {};
    for (const dx of sorted) {
      const cat = dx._category || detectDiagnosisCategory(dx);
      if (!groups[cat]) groups[cat] = [];
      groups[cat].push(dx);
    }

    return { grouped: groups, globalIndex: idxMap };
  }, [activeDx]);

  const absentFindings = useMemo(() => {
    if (!healthrayDiagnoses?.length) return [];
    const activeDxIds = new Set(
      Object.values(grouped).flat().map((d) => d.diagnosis_id),
    );
    return healthrayDiagnoses.filter((d) => {
      const status = (d.status || "").toLowerCase();
      if (status === "absent" || status === "ruled out") return true;
      if (!status && !activeDxIds.has(d.diagnosis_id)) return true;
      return false;
    });
  }, [healthrayDiagnoses, grouped]);

  const hasDiabetes = Object.values(grouped).flat().some((dx) => {
    const cat = dx._category || detectDiagnosisCategory(dx);
    return cat === "primary";
  });
  const hasComplications = (grouped.complication || []).length > 0;

  // Detect prediabetes → T2DM progression
  const prediabetesEntry = useMemo(() => {
    const allDx = Object.values(grouped).flat();
    return allDx.find((dx) => {
      const t = `${(dx.diagnosis_id || "")} ${(dx.label || "")}`.toLowerCase();
      return t.includes("prediabet") || t.includes("pre-diabet") || t.includes("pre_diabet");
    });
  }, [grouped]);

  const categoryOrder = ["primary", "complication", "comorbidity", "external", "monitoring"];

  return (
    <div className="sc" id="diagnoses">
      <div className="sch">
        <div className="sct">
          <div className="sci ic-p">🏷</div>Diagnoses
        </div>
        <button className="bx bx-p" onClick={onAddDiagnosis}>
          + Add Diagnosis
        </button>
      </div>
      <div className="scb">
        {categoryOrder.map((catKey) => {
          const items = grouped[catKey];
          const config = CATEGORY_CONFIG[catKey];

          // Show complications empty state for diabetic patients
          if (catKey === "complication" && !hasComplications && hasDiabetes) {
            return (
              <div key={catKey}>
                <div style={{ fontSize: 10, fontWeight: 600, color: "#9ca3af", textTransform: "uppercase", letterSpacing: "0.08em", padding: "12px 0 4px", marginTop: 4 }}>
                  {config.label}
                </div>
                <div
                  style={{
                    border: "1.5px dashed #d1d5db", borderRadius: 8, padding: "12px 16px",
                    display: "flex", alignItems: "center", justifyContent: "space-between",
                    color: "#9ca3af", fontSize: 12,
                  }}
                >
                  <span>No complications recorded. Add if nephropathy, neuropathy, retinopathy, or diabetic foot is present.</span>
                  <button className="bx bx-p" style={{ fontSize: 11 }} onClick={onAddDiagnosis}>+ Add</button>
                </div>
              </div>
            );
          }

          if (!items?.length) return null;

          // Hide prediabetes from monitoring when T2DM exists (shown as progression note on T2DM row)
          const filteredItems = (catKey === "monitoring" && hasDiabetes && prediabetesEntry)
            ? items.filter((dx) => dx.id !== prediabetesEntry.id)
            : items;
          if (!filteredItems.length) return null;

          return (
            <div key={catKey}>
              <div style={{ fontSize: 10, fontWeight: 600, color: "#9ca3af", textTransform: "uppercase", letterSpacing: "0.08em", padding: "12px 0 4px", marginTop: catKey === "primary" ? 0 : 4 }}>
                {config.label}
              </div>
              {filteredItems.map((dx) => {
                const num = globalIndex.get(dx.id) || 0;
                const suggestion = getDxSuggestion(dx.diagnosis_id, labResults, vitals);
                const effectiveStatus = suggestion?.status || dx.status;
                const st = DX_STATUS_STYLE[effectiveStatus] || DX_STATUS_DEFAULT;
                const isAutoSet = suggestion && !dx.status;
                const isManuallyOverridden = suggestion && suggestion.status !== dx.status && dx.status;
                const detail = extractHRDetail(dx.notes);
                const visibleNote = displayNote(dx.notes);
                const borderColor = getBorderColor(dx._category || catKey, effectiveStatus);
                const bioTags = getBiomarkerTag(dx, labResults, vitals);

                let statusLabel = effectiveStatus || "Active";
                if (dx.status === "Worsening" && dx.trend) statusLabel = `Worsening — ${dx.trend}`;
                if (dx.category === "external" && dx.external_doctor) statusLabel = `On Treatment — Dr. ${dx.external_doctor}`;

                return (
                  <div
                    key={dx.id || num}
                    className="dxi"
                    style={{ position: "relative", borderLeft: `3px solid ${borderColor}`, paddingLeft: 12, marginBottom: 2 }}
                  >
                    <div className="dxi-num" style={{ color: borderColor, fontWeight: 600 }}>{num}.</div>
                    <div style={{ flex: 1 }}>
                      <div className="dxi-ttl">
                        {dx.label || dx.diagnosis_id}
                        {dx.key_value && (
                          <span style={{ fontWeight: 400, color: "var(--t2)", marginLeft: 6 }}>— {dx.key_value}</span>
                        )}
                        {detail && !dx.key_value && (
                          <span style={{ fontWeight: 400, color: "var(--t3)", marginLeft: 4 }}>({detail})</span>
                        )}
                      </div>
                      <div className="dxi-sub" style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 4, marginTop: 2 }}>
                        {dx.since_year ? <span>Since {dx.since_year}</span> : null}
                        {dx.age_of_onset ? <span>· AOO: {dx.age_of_onset} yrs</span> : null}
                        {/* Prediabetes → T2DM progression note */}
                        {catKey === "primary" && prediabetesEntry && (dx._category || detectDiagnosisCategory(dx)) === "primary" && (
                          <span style={{ fontSize: 11, color: "#7c3aed", fontWeight: 500 }}>
                            · Previously: {prediabetesEntry.label || "Prediabetes"}
                            {prediabetesEntry.key_value ? ` (${prediabetesEntry.key_value})` : ""}
                            {prediabetesEntry.since_year ? ` since ${prediabetesEntry.since_year}` : ""}
                            {extractHRDetail(prediabetesEntry.notes) ? ` — ${extractHRDetail(prediabetesEntry.notes)}` : ""}
                          </span>
                        )}
                        {visibleNote ? <span>· {visibleNote}</span> : null}
                        {bioTags && bioTags.map((tag, ti) => (
                          <span
                            key={ti}
                            style={{
                              fontSize: 11, fontWeight: 600, padding: "1px 7px",
                              borderRadius: 4, marginLeft: ti === 0 ? 4 : 0,
                              background: `${tag.color}14`, color: tag.color,
                              border: `1px solid ${tag.color}33`,
                            }}
                          >
                            {tag.label}
                          </span>
                        ))}
                        {suggestion && !bioTags && (
                          <span
                            title={`Based on ${suggestion.biomarker}: ${suggestion.value} ${suggestion.unit} | Goal: ${suggestion.goal}`}
                            style={{ color: "var(--primary)", fontWeight: 500, marginLeft: 4 }}
                          >
                            {isAutoSet ? "✓" : "⚙️"} {suggestion.biomarker}: {suggestion.value}{suggestion.unit}
                          </span>
                        )}
                        {isManuallyOverridden && (
                          <span style={{ color: "var(--amber)", fontWeight: 600, fontSize: 11 }}>(overridden)</span>
                        )}
                      </div>
                    </div>
                    <span
                      className="dxi-status"
                      style={{
                        fontSize: 11, fontWeight: 600, padding: "3px 10px", borderRadius: 12,
                        background: st.bg, color: st.color, border: `1px solid ${st.border}`,
                        whiteSpace: "nowrap",
                      }}
                    >
                      {statusLabel}
                    </span>
                    <select
                      className="sy-sel"
                      value={effectiveStatus || ""}
                      style={{
                        fontSize: 12, height: 29, padding: "0 8px",
                        background: isManuallyOverridden ? "#fff8f0" : st.bg,
                        color: isManuallyOverridden ? "#b45309" : st.color,
                        borderColor: isManuallyOverridden ? "#fde68a" : st.border,
                        fontWeight: 600,
                        border: isManuallyOverridden ? "1.5px solid #fde68a" : undefined,
                        opacity: isAutoSet ? 0.7 : 1, marginLeft: 8,
                      }}
                      onChange={(e) => onUpdateDiagnosis?.(dx.id, { status: e.target.value })}
                      title={isAutoSet ? "Auto-set based on biomarkers. Change to override." : ""}
                    >
                      {DX_STATUS_OPTS.map((o) => (
                        <option key={o}>{o}</option>
                      ))}
                    </select>
                    {isManuallyOverridden && (
                      <button
                        className="bx" style={{ marginLeft: 5, background: "#10b981", color: "white", fontSize: 11, fontWeight: 600, padding: "0 8px", height: 29 }}
                        title="Reset to auto-calculated status"
                        onClick={() => onUpdateDiagnosis?.(dx.id, { status: "" })}
                      >Reset</button>
                    )}
                    <button className="bx bx-p" style={{ marginLeft: 5 }} onClick={() => onDiagnosisNote?.(dx)}>Note</button>
                  </div>
                );
              })}
            </div>
          );
        })}

        {Object.values(grouped).flat().length === 0 && (
          <div style={{ fontSize: 13, color: "var(--t3)", padding: 16, textAlign: "center" }}>
            No diagnoses recorded
          </div>
        )}

        {absentFindings.length > 0 && (
          <div style={{ marginTop: 8, paddingTop: 8, borderTop: "1px solid var(--border)" }}>
            <div style={{ fontSize: 10, fontWeight: 600, color: "#9ca3af", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 6 }}>
              Absent / Ruled Out
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {absentFindings.map((d, i) => {
                const label = (d.name || d.label || d.diagnosis_id || "").toUpperCase();
                const dtl = d.details || d.detail || null;
                return (
                  <span key={i} style={{ fontFamily: "monospace", fontSize: 12, background: "var(--tl)", color: "var(--t2)", border: "1px solid var(--border)", borderRadius: 4, padding: "2px 7px" }}>
                    {dtl ? `${label}(${dtl})(-)` : `${label}(-)`}
                  </span>
                );
              })}
            </div>
          </div>
        )}
        <div className="addr" onClick={onAddDiagnosis}>
          <span style={{ fontSize: 16, color: "var(--t3)" }}>+</span>
          <span className="addr-lbl">Add new diagnosis</span>
        </div>
      </div>
    </div>
  );
});

export default VisitDiagnoses;
