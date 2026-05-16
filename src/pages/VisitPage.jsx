import "./VisitPage.css";
import { Fragment, useState, useEffect, useRef, useCallback, useMemo } from "react";
import { createPortal } from "react-dom";
import { useNavigate, useSearchParams } from "react-router-dom";
import { makeNavClick } from "../lib/navClick";
import { useQueryClient } from "@tanstack/react-query";
import api from "../services/api";
import { usePatientSummary } from "../queries/hooks/usePatientSummary.js";
import { useVisit } from "../queries/hooks/useVisit";
import { qk } from "../queries/keys";
import usePatientStore from "../stores/patientStore";
import useAuthStore from "../stores/authStore";
import useVisitStore from "../stores/visitStore";
import useClinicalStore from "../stores/clinicalStore";
import { toast } from "../stores/uiStore";
import {
  findLab,
  getLabVal,
  getLabHist,
  computeFlags,
  fmtDate,
  fmtDateShort,
  isSameDate,
} from "../components/visit/helpers";
import { extractLab } from "../services/extraction";
import { normalizeTestName } from "../config/labNormalization";
import { EXAM_SECTIONS } from "../config/exam.js";
import VisitTopbar from "../components/visit/VisitTopbar";
import VisitStrip from "../components/visit/VisitStrip";
import VisitSidebar from "../components/visit/VisitSidebar";
import VisitBiomarkers from "../components/visit/VisitBiomarkers";
import ChangesPopover from "../components/visit/ChangesPopover";
// import VitalsTrendChart from "../components/visit/VitalsTrendChart";
import VisitDiagnoses from "../components/visit/VisitDiagnoses";
import VisitMedications from "../components/visit/VisitMedications";
import VisitPlan from "../components/visit/VisitPlan";
import VisitLabsPanel from "../components/visit/VisitLabsPanel";
import VisitHistoryPanel from "../components/visit/VisitHistoryPanel";
import VisitDocsPanel from "../components/visit/VisitDocsPanel";
import VisitMedCard from "../components/visit/VisitMedCard";
import VisitLoggedData from "../components/visit/VisitLoggedData";
import VisitAIPanel from "../components/visit/VisitAIPanel";
import VisitEndModal from "../components/visit/VisitEndModal";
import VisitSummaryPanel from "../components/visit/VisitSummaryPanel";
import VisitBrief from "../components/visit/VisitBrief";
import VisitPreVisitSymptoms from "../components/visit/VisitPreVisitSymptoms";
import VisitPreVisitCompliance from "../components/visit/VisitPreVisitCompliance";
import VisitDoseChangeRequests from "../components/visit/VisitDoseChangeRequests";
import DoctorSummarySection from "../components/visit/DoctorSummarySection";
import PatientSummarySection from "../components/visit/PatientSummarySection";
import RxPdfModal from "../components/visit/RxPdfModal";
import VisitCoordPrep from "../components/visit/VisitCoordPrep";
import SyncStatusBanner from "../components/visit/SyncStatusBanner";
import {
  AddLabModal,
  AddSymptomModal,
  AddDiagnosisModal,
  DiagnosisNoteModal,
  AddMedicationModal,
  EditMedicationModal,
  StopMedicationModal,
  RestartMedicationModal,
  DeleteMedicationModal,
  AddReferralModal,
  UploadReportModal,
  ChangeFollowUpModal,
  TemplateModal,
  LabExtractionReviewModal,
  PasteBiomarkersModal,
  ClinicalExtractionReviewModal,
} from "../components/visit/modals";
import { useVisitMutations } from "../hooks/useVisitMutations";
import { printMedCard } from "../components/visit/medCardPrint";

// ── Tab definitions ──
const SY_STATUS_OPTS = [
  "Mild",
  "Improving",
  "Still present",
  "Resolved ✓",
  "Controlled",
  "Got worse",
];
const syDotColor = (s) => {
  if (!s) return "var(--t3)";
  const v = s.toLowerCase();
  if (v.includes("resolved") || v === "controlled") return "var(--green)";
  return "var(--amber)";
};
const sySelStyle = (s) => {
  if (!s) return {};
  const v = s.toLowerCase();
  if (v.includes("resolved") || v === "controlled")
    return { color: "var(--green)", borderColor: "var(--grn-bd)" };
  if (v === "improving") return { color: "var(--primary)", borderColor: "var(--primary)" };
  if (v === "got worse") return { color: "var(--red)", borderColor: "var(--red)" };
  return {};
};

// Derive the pill's visible status. Priority order:
//   1. HbA1c (any patient with a reading)
//   2. TSH — non-diabetic patient with a thyroid condition
//   3. Blood Pressure — non-diabetic, non-thyroid patient with hypertension
//   4. FBS — everyone else
//   5. Blood Pressure — final fallback when nothing else is on file
//
// Returns one of four labels: Uncontrolled / Stabilize / Controlled /
// Continuous. "Continuous" = latest reading is controlled AND at least the
// two most recent readings were both controlled (long-term control).
function deriveBiomarkerStatus({ activeDx, labResults, labHistory, vitals }) {
  const dxText = (activeDx || [])
    .filter((d) => d && d.is_active !== false)
    .map((d) => `${d.diagnosis_id || ""} ${d.label || ""}`.toLowerCase())
    .join(" | ");
  const hasDiabetes = /diabetes|dm1|dm2|t1dm|t2dm|\bdm\b|hyperglyc/.test(dxText);
  const hasThyroid = /thyroid|hypothyroid|hyperthyroid|hashimoto|graves|goiter/.test(dxText);
  const hasHypertension = /hypertension|\bhtn\b|high.?blood.?pressure/.test(dxText);

  const num = (v) => {
    if (v == null || v === "") return NaN;
    const n = typeof v === "number" ? v : parseFloat(String(v).match(/-?\d+(\.\d+)?/)?.[0]);
    return Number.isFinite(n) ? n : NaN;
  };

  // Returns a chronological array of numeric values for a lab alias.
  const labSeries = (alias) => {
    const h = getLabHist(labHistory, alias) || [];
    return h
      .map((r) => ({ val: num(r?.result), date: r?.date }))
      .filter((r) => Number.isFinite(r.val));
  };

  // Try each marker in order until one yields a value.
  let marker = null;
  let value = NaN;
  let history = []; // chronological list of classifications for streak calc

  // 1) HbA1c
  {
    const series = labSeries("HbA1c");
    const latestVal = num(getLabVal(labResults, "HbA1c")?.result);
    const v = Number.isFinite(latestVal)
      ? latestVal
      : series.length
        ? series[series.length - 1].val
        : NaN;
    if (Number.isFinite(v)) {
      marker = "HbA1c";
      value = v;
      history = series.map((s) => s.val);
      if (!history.length || history[history.length - 1] !== v) history.push(v);
    }
  }

  // 2) TSH — only when no HbA1c AND patient is non-diabetic AND has thyroid
  if (!marker && !hasDiabetes && hasThyroid) {
    const series = labSeries("TSH");
    const latestVal = num(getLabVal(labResults, "TSH")?.result);
    const v = Number.isFinite(latestVal)
      ? latestVal
      : series.length
        ? series[series.length - 1].val
        : NaN;
    if (Number.isFinite(v)) {
      marker = "TSH";
      value = v;
      history = series.map((s) => s.val);
      if (!history.length || history[history.length - 1] !== v) history.push(v);
    }
  }

  // BP picker (used in both the hypertension slot and as a final fallback).
  const pickBP = () => {
    if (!Array.isArray(vitals) || !vitals.length) return false;
    const bpRows = vitals
      .map((v) => ({
        sys: num(v?.bp_sys),
        dia: num(v?.bp_dia),
        date: v?.recorded_at || v?.recorded_date || null,
      }))
      .filter((r) => Number.isFinite(r.sys) && Number.isFinite(r.dia))
      .sort((a, b) => new Date(a.date || 0) - new Date(b.date || 0));
    if (!bpRows.length) return false;
    marker = "BP";
    const last = bpRows[bpRows.length - 1];
    value = { sys: last.sys, dia: last.dia };
    history = bpRows.map((r) => ({ sys: r.sys, dia: r.dia }));
    return true;
  };

  // 3) Blood Pressure — when patient is non-diabetic, non-thyroid and has
  //    a hypertension diagnosis.
  if (!marker && !hasDiabetes && !hasThyroid && hasHypertension) pickBP();

  // 4) FBS — also picks up patient-app fasting finger-sticks via labHistory
  if (!marker) {
    const series = labSeries("FBS");
    let latestVal = num(getLabVal(labResults, "FBS")?.result);
    if (!Number.isFinite(latestVal) && series.length) latestVal = series[series.length - 1].val;
    if (Number.isFinite(latestVal)) {
      marker = "FBS";
      value = latestVal;
      history = series.map((s) => s.val);
      if (!history.length || history[history.length - 1] !== latestVal) history.push(latestVal);
    }
  }

  // 5) BP fallback — if nothing else is on file but we have vitals.
  if (!marker) pickBP();

  if (!marker) return null;

  // Classify a single value into controlled/borderline/uncontrolled.
  const classify = (val) => {
    if (marker === "HbA1c")
      return val <= 7 ? "controlled" : val <= 8 ? "borderline" : "uncontrolled";
    if (marker === "TSH")
      return val >= 0.5 && val <= 4.5
        ? "controlled"
        : val < 0.5 || val <= 6
          ? "borderline"
          : "uncontrolled";
    if (marker === "FBS")
      return val <= 100 ? "controlled" : val <= 126 ? "borderline" : "uncontrolled";
    // BP: object { sys, dia }
    const sys = val?.sys;
    const dia = val?.dia;
    if (sys >= 140 || dia >= 90) return "uncontrolled";
    if (sys >= 130 || dia >= 80) return "borderline";
    return "controlled";
  };

  const status = classify(value);

  // Promote to "continuous" when the latest is controlled AND the previous
  // reading was also controlled (≥ 2 consecutive controlled readings).
  let label;
  if (status === "uncontrolled") label = "Uncontrolled";
  else if (status === "borderline") label = "Stabilize";
  else {
    const last2 = history.slice(-2);
    const allControlled = last2.length >= 2 && last2.every((v) => classify(v) === "controlled");
    label = allControlled ? "Continuous" : "Controlled";
  }

  const palette =
    label === "Controlled" || label === "Continuous"
      ? { fg: "var(--green)", bg: "var(--grn-lt)", bd: "var(--grn-bd)" }
      : label === "Stabilize"
        ? { fg: "var(--amber)", bg: "var(--amb-lt, #fff7ed)", bd: "var(--amb-bd, #fed7aa)" }
        : { fg: "var(--red)", bg: "var(--red-lt, #fdecec)", bd: "var(--red-bd, #f5c6cb)" };

  const target =
    marker === "HbA1c"
      ? "≤ 7"
      : marker === "TSH"
        ? "0.5–4.5"
        : marker === "FBS"
          ? "≤ 100"
          : "< 130/80";
  const unit =
    marker === "HbA1c" ? "%" : marker === "TSH" ? "µIU/mL" : marker === "FBS" ? "mg/dL" : "mmHg";
  return { label, palette, marker, value, status, target, unit };
}

function CarePhasePill({ summary, activeDx, labResults, labHistory, vitals }) {
  const triggerRef = useRef(null);
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState({ top: 0, left: 0 });

  const updateCoords = useCallback(() => {
    const el = triggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setCoords({ top: r.bottom + 6, left: r.right });
  }, []);

  useEffect(() => {
    if (!open) return;
    updateCoords();
    window.addEventListener("scroll", updateCoords, true);
    window.addEventListener("resize", updateCoords);
    return () => {
      window.removeEventListener("scroll", updateCoords, true);
      window.removeEventListener("resize", updateCoords);
    };
  }, [open, updateCoords]);

  // Only four allowed pill labels.
  const phaseName = String(summary.carePhase || "");
  // Map server phase strings (Phase 1 · Uncontrolled / Phase 2 · Controlled
  // / Phase 3 · Sustain / Phase 4 · Maintain) onto our 4-word vocabulary.
  const fallbackWord = /Uncontrolled/i.test(phaseName)
    ? "Uncontrolled"
    : /Stabilize|Borderline/i.test(phaseName)
      ? "Stabilize"
      : /Sustain|Maintain|Continuous/i.test(phaseName)
        ? "Continuous"
        : /Controlled/i.test(phaseName)
          ? "Controlled"
          : null;
  const paletteFor = (word) =>
    word === "Uncontrolled"
      ? { fg: "var(--red)", bg: "var(--red-lt, #fdecec)", bd: "var(--red-bd, #f5c6cb)" }
      : word === "Stabilize"
        ? { fg: "var(--amber)", bg: "var(--amb-lt, #fff7ed)", bd: "var(--amb-bd, #fed7aa)" }
        : word === "Controlled" || word === "Continuous"
          ? { fg: "var(--green)", bg: "var(--grn-lt)", bd: "var(--grn-bd)" }
          : { fg: "var(--t2)", bg: "var(--bg2, #f4f4f5)", bd: "var(--bd, #e5e7eb)" };

  // Biomarker priority read (HbA1c → TSH → FBS → BP) overrides the
  // server-side care-phase whenever a relevant value is on file.
  const bioStatus = deriveBiomarkerStatus({ activeDx, labResults, labHistory, vitals });
  const statusWord = bioStatus ? bioStatus.label : fallbackWord || "No value";
  const palette = bioStatus ? bioStatus.palette : paletteFor(statusWord);
  const displayLabel = statusWord;
  const effectiveCarePhase = displayLabel;

  const basis = summary.carePhaseBasis;
  const params = summary.carePhaseParameters || [];
  const drivers = new Set(summary.carePhaseDrivers || []);
  const category = summary.carePhaseCategory;
  const categoryLabel =
    category === "diabetes"
      ? "Diabetes targets"
      : category === "prediabetes"
        ? "Prediabetes targets"
        : null;

  const statusStyle = (s) =>
    s === "controlled"
      ? { color: "var(--green)", label: "✓ Controlled" }
      : s === "borderline"
        ? { color: "var(--amber)", label: "● Stabilize" }
        : { color: "var(--red)", label: "✕ Uncontrolled" };

  const trendIcon = (t) =>
    t === "improving" ? "↓" : t === "worsening" ? "↑" : t === "stable" ? "→" : "—";

  // With a single reading we still classify and show a phase — only fall back
  // to the "no readings" copy when truly nothing is on file (no bioStatus
  // priority marker AND no parameters from the multi-parameter compute).
  const phaseReason =
    basis === "clinical"
      ? drivers.size
        ? `Driven by: ${[...drivers].join(", ")}`
        : "All parameters in target"
      : bioStatus
        ? `Driven by latest ${bioStatus.marker} reading.`
        : "No HbA1c, TSH, FBS or BP reading on file yet — add a lab or vitals entry to compute a phase.";

  return (
    <>
      <span
        ref={triggerRef}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        tabIndex={0}
        style={{
          fontSize: 10,
          fontWeight: 700,
          color: palette.fg,
          background: palette.bg,
          padding: "3px 10px",
          borderRadius: 20,
          border: `1px solid ${palette.bd}`,
          cursor: "help",
        }}
      >
        {displayLabel}
      </span>
      {open &&
        createPortal(
          <div
            onMouseEnter={() => setOpen(true)}
            onMouseLeave={() => setOpen(false)}
            style={{
              position: "fixed",
              top: coords.top,
              left: coords.left,
              transform: "translateX(-100%)",
              zIndex: 99999,
              minWidth: 320,
              maxWidth: 380,
              padding: "10px 12px",
              background: "var(--bg1, #fff)",
              border: "1px solid var(--bd, #e5e7eb)",
              borderRadius: 8,
              boxShadow: "0 4px 16px rgba(0,0,0,0.12)",
              fontSize: 11,
              lineHeight: 1.5,
              color: "var(--t1)",
              textAlign: "left",
            }}
          >
            <div style={{ fontWeight: 700, marginBottom: 6 }}>
              Why {effectiveCarePhase || displayLabel}?
            </div>
            {(effectiveCarePhase || displayLabel) && (
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  marginBottom: 6,
                  flexWrap: "wrap",
                }}
              >
                <span
                  style={{
                    fontSize: 10,
                    fontWeight: 700,
                    color: palette.fg,
                    background: palette.bg,
                    padding: "2px 8px",
                    borderRadius: 20,
                    border: `1px solid ${palette.bd}`,
                  }}
                >
                  {effectiveCarePhase || displayLabel}
                </span>
              </div>
            )}
            {bioStatus && (
              <div
                style={{
                  marginBottom: 6,
                  padding: "6px 8px",
                  background: "var(--bg2, #f4f4f5)",
                  borderRadius: 6,
                  fontSize: 10,
                  color: "var(--t2)",
                }}
              >
                <div style={{ fontWeight: 700, color: "var(--t1)", marginBottom: 2 }}>
                  Considered for phase
                </div>
                <div>
                  <strong>{bioStatus.marker}</strong> = {bioStatus.value}
                  {bioStatus.unit ? ` ${bioStatus.unit}` : ""} (target {bioStatus.target}
                  {bioStatus.unit ? ` ${bioStatus.unit}` : ""}) →{" "}
                  <span style={{ color: palette.fg, fontWeight: 700 }}>{bioStatus.label}</span>
                </div>
                <div style={{ color: "var(--t3)", marginTop: 2 }}>
                  Priority: HbA1c (diabetes) → TSH (thyroid) → FBS (otherwise).
                </div>
              </div>
            )}
            <div style={{ marginBottom: 6, color: "var(--t2)" }}>{phaseReason}</div>

            {params.length > 0 ? (
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr auto auto auto",
                  columnGap: 10,
                  rowGap: 4,
                  marginTop: 6,
                  paddingTop: 6,
                  borderTop: "1px solid var(--bd, #eee)",
                }}
              >
                <div style={{ fontWeight: 700, color: "var(--t3)" }}>Parameter</div>
                <div style={{ fontWeight: 700, color: "var(--t3)" }}>Latest</div>
                <div style={{ fontWeight: 700, color: "var(--t3)" }}>Target</div>
                <div style={{ fontWeight: 700, color: "var(--t3)" }}>Status</div>
                {params.map((p) => {
                  const st = statusStyle(p.status);
                  const isDriver = drivers.has(p.key);
                  return (
                    <Fragment key={p.key}>
                      <div
                        style={{
                          fontWeight: isDriver ? 700 : 500,
                          color: isDriver ? "var(--t1)" : "var(--t2)",
                        }}
                        title={
                          p.prev != null
                            ? `Prev: ${p.prev} ${p.unit || ""} · ${
                                p.prevDate ? fmtDateShort(p.prevDate) : ""
                              }`
                            : ""
                        }
                      >
                        {p.label}
                      </div>
                      <div style={{ color: "var(--t1)", whiteSpace: "nowrap" }}>
                        {trendIcon(p.trend)} {p.latest}
                        {p.unit ? ` ${p.unit}` : ""}
                      </div>
                      <div style={{ color: "var(--t3)", whiteSpace: "nowrap" }}>
                        {p.target || "—"}
                      </div>
                      <div style={{ color: st.color, whiteSpace: "nowrap" }}>{st.label}</div>
                    </Fragment>
                  );
                })}
              </div>
            ) : bioStatus ? null : (
              <div style={{ color: "var(--t3)", marginTop: 4 }}>
                No HbA1c / TSH / FBS / BP / lipid / BMI readings yet.
              </div>
            )}

            <div
              style={{
                marginTop: 8,
                paddingTop: 6,
                borderTop: "1px solid var(--bd, #eee)",
                color: "var(--t3)",
                fontSize: 10,
              }}
            >
              Worst-controlled parameter sets the phase. Trend = net direction across all parameters
              with a prior reading.
              {categoryLabel ? ` ${categoryLabel} applied (HbA1c / LDL).` : ""}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}

function VisitSymptomsSection({ symptoms = [], onAddSymptom, onStatusChange }) {
  const symptomSummary = useMemo(() => {
    if (!symptoms.length) return null;

    const latest = symptoms.reduce((max, sy) => {
      const d = sy.updated_at || sy.created_at;
      return d && d > (max || "") ? d : max;
    }, null);
    if (!latest) return null;

    const onDate = symptoms.filter((sy) => {
      const d = sy.updated_at || sy.created_at;
      return d && isSameDate(d, latest);
    });

    const added = onDate.filter((sy) => isSameDate(sy.created_at, latest));
    const modified = onDate.filter((sy) => !isSameDate(sy.created_at, latest));

    const parts = [];
    if (added.length === 1) {
      parts.push(`${added[0].label} added`);
    } else if (added.length > 1) {
      parts.push(`${added.length} symptoms added`);
    }
    if (modified.length === 1) {
      const sy = modified[0];
      parts.push(
        sy.prev_status
          ? `${sy.label} ${sy.prev_status} → ${sy.status || "Active"}`
          : `${sy.label} → ${sy.status || "Active"}`,
      );
    } else if (modified.length > 1) {
      parts.push(`${modified.length} statuses updated`);
    }

    const text = parts.length > 0 ? parts.join(", ") : "Updated";

    const addedDetails = added.map((sy) => ({
      name: sy.label,
      diff: [sy.status || "Active"],
    }));
    const changedDetails = modified.map((sy) => ({
      name: sy.label,
      diff: [`${sy.prev_status || "—"} → ${sy.status || "Active"}`],
    }));

    return { text, date: latest, added: addedDetails, changed: changedDetails };
  }, [symptoms]);

  return (
    <div className="sc" id="symptoms">
      <div className="sch">
        <div className="sct">
          <div className="sci ic-a">🩹</div>Symptoms &amp; Concerns
          {symptomSummary && (
            <ChangesPopover
              date={symptomSummary.date}
              label={`${symptomSummary.text} — ${fmtDateShort(symptomSummary.date)}`}
              added={symptomSummary.added}
              changed={symptomSummary.changed}
            />
          )}
        </div>
        <button className="bx bx-p" onClick={onAddSymptom}>
          + Add Symptom
        </button>
      </div>
      <div className="scb">
        {symptoms.length > 0 ? (
          <>
            <div className="subsec">Active / Historical — Update Status</div>
            <div className="syg">
              {symptoms.map((sy) => {
                const meta = [sy.related_to, sy.since_date ? `Since ${sy.since_date}` : ""]
                  .filter(Boolean)
                  .join(" · ");
                return (
                  <div key={sy.id} className="syi">
                    <div className="sy-dot" style={{ background: syDotColor(sy.status) }} />
                    <div style={{ flex: 1 }}>
                      <div className="sy-nm">{sy.label}</div>
                      {meta && <div className="sy-meta">{meta}</div>}
                    </div>
                    <select
                      className="sy-sel"
                      value={sy.status}
                      style={sySelStyle(sy.status)}
                      onChange={(e) => onStatusChange(sy.id, e.target.value)}
                    >
                      {SY_STATUS_OPTS.map((o) => (
                        <option key={o}>{o}</option>
                      ))}
                    </select>
                  </div>
                );
              })}
            </div>
          </>
        ) : (
          <div style={{ fontSize: 13, color: "var(--t3)", padding: 16, textAlign: "center" }}>
            No symptoms or concerns recorded for this visit
          </div>
        )}
        <div className="addr" onClick={onAddSymptom}>
          <span style={{ fontSize: 16, color: "var(--t3)" }}>+</span>
          <span className="addr-lbl">Add new symptom or concern for this visit</span>
        </div>
      </div>
    </div>
  );
}

const TABS = [
  { id: "visit", label: "📋 Visit" },
  { id: "labs", label: "🧪 Labs", badgeKey: "labs" },
  { id: "exam", label: "🩺 Exam" },
  { id: "history", label: "📅 History" },
  // { id: "messages", label: "💬 Messages", badgeKey: "messages", badgeCls: "am" },
  { id: "docs", label: "📁 Docs", badgeKey: "docs" },
  { id: "medcard", label: "💊 Med Card" },
  { id: "logdata", label: "📊 Logged Data" },
];

const JUMP_SECTIONS = [
  { id: "biomarkers", label: "📊 Biomarkers" },
  { id: "symptoms", label: "🩹 Symptoms" },
  { id: "diagnoses", label: "🏷 Diagnoses" },
  { id: "medications", label: "💊 Medications" },
  { id: "plan", label: "📝 Plan" },
  { id: "summary", label: "📄 Summary" },
  { id: "summary-doctor", label: "📝 Doctor Summary" },
];

// Transform raw exam_data from DB into display-ready array
function buildExamFindings(rawExam) {
  if (!rawExam?.findings || typeof rawExam.findings !== "object") return null;
  const result = [];
  Object.values(EXAM_SECTIONS).forEach((sections) => {
    sections.forEach((s) => {
      const vals = rawExam.findings[s.id + "_v"] || [];
      const nad = rawExam.findings[s.id + "_n"];
      if (vals.length > 0) result.push({ icon: s.ic, system: s.l, findings: vals.join(", ") });
      else if (nad) result.push({ icon: s.ic, system: s.l, findings: "NAD" });
    });
  });
  return result.length ? result : null;
}

export default function VisitPage() {
  const navigate = useNavigate();
  const navClick = makeNavClick(navigate);
  const qc = useQueryClient();
  const dbPatientId = usePatientStore((s) => s.dbPatientId);
  const restorePatient = usePatientStore((s) => s.restorePatient);
  const doctor = useAuthStore((s) => s.currentDoctor);
  const patientSummaryQ = usePatientSummary(dbPatientId);
  const endVisitAction = useVisitStore((s) => s.endVisit);
  const conData = useClinicalStore((s) => s.conData);
  const setConData = useClinicalStore((s) => s.setConData);

  // ── OPD appointment sync ──
  // The URL `?patient=&appt=` is set by Ctrl/Cmd-click "Open Scribe"
  // (sessionStorage is per-tab). The apptId is only valid for the patient
  // it was opened for — otherwise switching patients in the same tab would
  // carry the previous patient's apptId forward and we'd serve the wrong
  // cached summary.
  // We read the URL via react-router so this memo re-runs on every
  // navigation, and we ALWAYS validate against the current dbPatientId.
  const [_searchParamsForOpd] = useSearchParams();
  const opdApptId = useMemo(() => {
    if (!dbPatientId) return null;
    const urlAppt = _searchParamsForOpd.get("appt");
    const urlPatient = _searchParamsForOpd.get("patient");
    // Only trust the URL apptId when its companion `?patient=` matches the
    // patient currently loaded in state. Without that, we cannot tell which
    // patient the apptId was meant for.
    if (urlAppt && urlPatient && Number(urlPatient) === Number(dbPatientId)) {
      sessionStorage.setItem("gini_opd_appt_id", String(urlAppt));
      sessionStorage.setItem("gini_opd_patient_id", String(urlPatient));
      return Number(urlAppt);
    }
    // Fall back to sessionStorage, but only when its stored patient matches.
    const storedAppt = sessionStorage.getItem("gini_opd_appt_id");
    const storedPid = sessionStorage.getItem("gini_opd_patient_id");
    if (!storedAppt || !storedPid) return null;
    if (Number(storedPid) !== Number(dbPatientId)) return null;
    return Number(storedAppt);
  }, [_searchParamsForOpd, dbPatientId]);
  const [visitStart, setVisitStart] = useState(
    () => sessionStorage.getItem("gini_visit_start") || null,
  );
  const hasActiveVisit = !!opdApptId;

  // ── UI state ──
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = searchParams.get("tab") || "visit";
  const setTab = (t) => {
    setSearchParams(
      (prev) => {
        prev.set("tab", t);
        return prev;
      },
      { replace: true },
    );
  };
  const [jumpTarget, setJumpTarget] = useState("biomarkers");
  const [aiOpen, setAiOpen] = useState(false);
  const [showEndModal, setShowEndModal] = useState(false);
  const [doctorNote, setDoctorNote] = useState("");
  const [modal, setModal] = useState(null); // { type, data? }
  const [labExtractSaving, setLabExtractSaving] = useState(false);
  const [clinicalExtractSaving, setClinicalExtractSaving] = useState(false);
  // Non-blocking save-status chip shown after the doctor hits Save in the
  // paste-text review modal. The modal closes immediately so the doctor can
  // keep working; this chip is the only persistent UI signal that the bulk
  // save is still running / has finished / has errored.
  // shape: { phase: 'saving'|'saved'|'failed', label: string }
  const [bulkSaveStatus, setBulkSaveStatus] = useState(null);
  const [extracting, setExtracting] = useState(false);
  const scrollRef = useRef(null);
  const noteTimerRef = useRef(null);

  const saveDoctorNote = useCallback(
    (note) => {
      clearTimeout(noteTimerRef.current);
      noteTimerRef.current = setTimeout(async () => {
        try {
          await api.patch(`/api/visit/${dbPatientId}/doctor-note`, {
            note,
            appointment_id: opdApptId || null,
          });
        } catch {
          // silent fail — note will retry on next keystroke
        }
      }, 1200);
    },
    [dbPatientId, opdApptId],
  );

  const handleDoctorNoteChange = useCallback(
    (val) => {
      setDoctorNote(val);
      saveDoctorNote(val);
    },
    [saveDoctorNote],
  );

  const handleChangeFollowUpWith = useCallback(
    async (text) => {
      if (!dbPatientId) return;
      try {
        await api.patch(`/api/visit/${dbPatientId}/follow-up-with`, { text });
        await visitQuery.refetch();
      } catch (e) {
        console.warn("[VisitPage] follow_up_with save failed:", e?.message);
      }
    },
    // visitQuery is stable from react-query
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [dbPatientId],
  );

  // ── Hydrate patient context from URL ?patient=&appt= for new-tab opens ──
  // SessionStorage is per-tab, so a Ctrl/Cmd-click new tab won't have the
  // active patient. We read it from the URL, persist it, then restore.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const urlPatient = params.get("patient");
    const savedId = sessionStorage.getItem("gini_active_patient");
    if (urlPatient && !savedId) {
      sessionStorage.setItem("gini_active_patient", String(urlPatient));
    }
    const effectiveId = urlPatient || savedId;
    if (!dbPatientId && effectiveId) {
      restorePatient();
      return;
    }
    if (!dbPatientId && !effectiveId) navigate("/");
  }, [dbPatientId, navigate, restorePatient]);

  // Strip the patient/appt query params from the URL once hydrated so the
  // address bar stays clean and bookmarks don't pin a stale appointment.
  useEffect(() => {
    if (!dbPatientId) return;
    const params = new URLSearchParams(window.location.search);
    if (params.has("patient") || params.has("appt")) {
      params.delete("patient");
      params.delete("appt");
      const next = params.toString();
      const url = window.location.pathname + (next ? `?${next}` : "");
      window.history.replaceState({}, "", url);
    }
  }, [dbPatientId]);

  // ── React Query owns the visit fetch ──
  // - Auto-refetches on mount (staleTime: 0) and on window focus.
  // - Mutations elsewhere (saveConsultation, biomarkers, compliance) invalidate
  //   this key and trigger a background refetch without any manual refreshData call.
  const visitQuery = useVisit(dbPatientId, opdApptId);

  // Appointment ID used to key cached AI summaries. Prefers the active OPD
  // slot when the doctor came in via the OPD list; otherwise falls back to
  // the patient's latest appointment (returned by the visit GET) so summary
  // calls always carry an apptId and the server-side cache is hit.
  const effectiveApptId = opdApptId || visitQuery.data?.latestAppointmentId || null;

  // Run the one-time medication reconcile after the first successful load.
  // If any rows are stopped, invalidate the visit cache so it refetches with
  // the new state. The reconcile call is non-critical — silent on error.
  const reconciledOnceRef = useRef(null);
  useEffect(() => {
    if (!visitQuery.data || !dbPatientId) return;
    if (reconciledOnceRef.current === dbPatientId) return;
    reconciledOnceRef.current = dbPatientId;
    (async () => {
      try {
        const rec = await api.patch(`/api/visit/${dbPatientId}/medications/reconcile`);
        if (rec.data?.stopped > 0) {
          visitQuery.refetch();
        }
      } catch {
        // non-critical
      }
    })();
  }, [dbPatientId, visitQuery.data, visitQuery.refetch]);

  // Sync query data → local `data` state so the existing transforms
  // (examFindings, doctorNote seed) keep working unchanged. When the query
  // updates (refetch / invalidation), this effect re-runs and `setData` is
  // called with the freshest payload.
  useEffect(() => {
    const d = visitQuery.data;
    if (!d) return;
    setData({ ...d, examFindings: buildExamFindings(d.consultations?.[0]?.exam_data) });
    if (d.appt_doctor_note) {
      setDoctorNote(d.appt_doctor_note);
    } else if (d.consultations?.[0]?.con_data?.assessment_summary) {
      setDoctorNote(d.consultations[0].con_data.assessment_summary);
    }
  }, [visitQuery.data]);

  useEffect(() => {
    setLoading(visitQuery.isPending);
  }, [visitQuery.isPending]);

  useEffect(() => {
    if (visitQuery.isError) toast("Failed to load visit data", "error");
  }, [visitQuery.isError]);

  // ── Refresh data after mutations — delegate to React Query ──
  const refreshData = useCallback(async () => {
    await visitQuery.refetch();
  }, [visitQuery]);

  // ── Poll for new lab data (background sync) and auto-refresh biomarkers ──
  const labCountRef = useRef(null);
  useEffect(() => {
    if (!dbPatientId) return;
    // Seed the ref from currently loaded data
    labCountRef.current = data?.labResults?.length ?? null;

    const interval = setInterval(async () => {
      try {
        const { data: counts } = await api.get(`/api/visit/${dbPatientId}/lab-count`);
        if (labCountRef.current !== null && counts.total > labCountRef.current) {
          console.log("[LabPoll] New lab data detected, refreshing...");
          await refreshData();
          labCountRef.current = counts.total;
        } else if (labCountRef.current === null) {
          labCountRef.current = counts.total;
        }
      } catch {
        // silent — polling is non-critical
      }
    }, 120_000);

    return () => clearInterval(interval);
  }, [dbPatientId, refreshData, data?.labResults?.length]);

  const mutations = useVisitMutations(dbPatientId, refreshData, opdApptId);
  const closeModal = useCallback(() => setModal(null), []);

  // ── Derived data (memoized) ──
  const derived = useMemo(() => {
    if (!data) return null;
    console.log("data", data);
    const { vitals, diagnoses, labResults, labHistory } = data;
    // The vitals array now includes both clinic rows (full panel) and Genie
    // app self-logs (sparse — usually only one of BP / weight / rbs filled).
    // If we naively take vitals[0], a BP-only app row hides the weight from
    // the older clinic row. Instead, coalesce field-wise: for each field,
    // pick the most recent non-null across all rows (already sorted desc by
    // recorded_at on the server). prevV is the second most recent per field.
    const VITAL_FIELDS = [
      "bp_sys",
      "bp_dia",
      "pulse",
      "temp",
      "spo2",
      "weight",
      "height",
      "bmi",
      "rbs",
      "waist",
      "body_fat",
      "muscle_mass",
      "meal_type",
      "reading_time",
    ];
    const buildCoalesced = (rows, depth) => {
      if (!rows || rows.length === 0) return null;
      // Anchor identity to the truly latest row (rows are sorted DESC by
      // recorded_at on the server). If that row is patient-app sourced,
      // updateVitals routes the edit to the app-vitals PATCH endpoint so the
      // doctor edits the latest value in place regardless of who logged it.
      const anchor = rows[0];
      const out = {
        id: anchor.id,
        recorded_at: anchor.recorded_at,
        consultation_id: anchor.consultation_id,
        source: anchor.source,
      };
      for (const f of VITAL_FIELDS) {
        let hits = 0;
        for (const r of rows) {
          if (r[f] != null && r[f] !== "") {
            if (hits === depth) {
              out[f] = r[f];
              break;
            }
            hits += 1;
          }
        }
        if (out[f] == null) out[f] = null;
      }
      return out;
    };
    const latestV = buildCoalesced(vitals, 0);
    const prevV = buildCoalesced(vitals, 1);
    const activeDx = diagnoses.filter((d) => d.is_active !== false);
    const flags = computeFlags(data);

    // Deduplicate meds by name (same med can appear from multiple visits).
    // Children (parent_medication_id != null) are excluded from the dedup map
    // and appended verbatim — collapsing a child against an unrelated parent
    // by name would orphan it on the print path.
    const dedupMeds = (meds) => {
      const grouped = {};
      const children = [];
      (meds || []).forEach((m) => {
        if (m.parent_medication_id) {
          children.push({ ...m });
          return;
        }
        const key = (m.pharmacy_match || m.name || "").toUpperCase();
        if (!key) return;
        if (!grouped[key]) {
          grouped[key] = { ...m };
        } else if (
          m.prescribed_date &&
          (!grouped[key].prescribed_date || m.prescribed_date > grouped[key].prescribed_date)
        ) {
          // Take the newer row whole — including its id. Pinning the older
          // row's id made the delete button target a stale record.
          grouped[key] = { ...m };
        }
      });
      return [...Object.values(grouped), ...children];
    };
    const uniqueActiveMeds = dedupMeds(data.activeMeds);
    const uniqueStoppedMeds = dedupMeds(data.stoppedMeds);

    // Sidebar shows ALL active meds the patient is currently on, including
    // ones carried over from previous visits (still is_active=true even if
    // not re-prescribed today). Previously this was pinned to the latest
    // last_prescribed_date — that hid carry-over meds (e.g. Pregabalin /
    // Amlong 5) and made the patient app's count diverge from clinical
    // reality. We still drop visit_status='previous' rows so the sidebar
    // matches the main Medications panel (those rows live under the
    // "Prev Visit" expander, not in the active list).
    const latestVisitMeds = uniqueActiveMeds
      .filter((m) => m.is_active !== false)
      .filter((m) => m.visit_status !== "previous");

    // HbA1c trend for the summary strip
    const hba1cH = getLabHist(labHistory, "HbA1c");
    const hba1cFirst = hba1cH.length > 0 ? hba1cH[0] : null;
    const hba1cCurr = getLabVal(labResults, "HbA1c");

    // AI context string
    const aiContext = `Patient: ${data.patient?.name}. Context: ${JSON.stringify({
      diagnoses: activeDx.map((d) => d.label),
      meds: data.activeMeds?.map((m) => m.name),
      vitals: latestV,
    })}`;

    // AI initial summary
    const aiParts = [`Visit #${data.summary.totalVisits} — ${data.patient.name} Summary`];
    const hba1cLab = findLab(labResults, "HbA1c");
    if (hba1cLab)
      aiParts.push(`\nHbA1c: ${hba1cLab.result}${hba1cLab.unit ? ` ${hba1cLab.unit}` : "%"}`);
    const fbsLab = findLab(labResults, "FBS");
    if (fbsLab) aiParts.push(`FPG: ${fbsLab.result} ${fbsLab.unit || "mg/dL"}`);
    flags.forEach((f) => aiParts.push(`\n${f.icon} ${f.text}`));
    const aiInitialMsg = aiParts.join("\n");

    // Anthropometry: merge clinic vitals + Genie app vitals
    const genieVitals = data.loggedData?.vitals || [];
    const genieByDate = {};
    genieVitals.forEach((g) => {
      const d = String(g.recorded_date).slice(0, 10);
      if (!genieByDate[d]) genieByDate[d] = g;
    });
    const anthropoRows = [
      ...vitals.map((v) => {
        const d = String(v.recorded_at).slice(0, 10);
        const g = genieByDate[d] || {};
        return {
          date: v.recorded_at,
          weight: v.weight || g.weight_kg || null,
          bmi: v.bmi || g.bmi || null,
          waist: v.waist || g.waist || null,
          body_fat: v.body_fat || g.body_fat || null,
          muscle_mass: v.muscle_mass || g.muscle_mass || null,
          bp_sys: v.bp_sys || g.bp_systolic || null,
          bp_dia: v.bp_dia || g.bp_diastolic || null,
        };
      }),
    ];
    const clinicDates = new Set(vitals.map((v) => String(v.recorded_at).slice(0, 10)));
    genieVitals.forEach((g) => {
      const d = String(g.recorded_date).slice(0, 10);
      if (!clinicDates.has(d) && (g.waist || g.body_fat || g.muscle_mass || g.weight_kg)) {
        anthropoRows.push({
          date: g.recorded_date,
          weight: g.weight_kg || null,
          bmi: g.bmi || null,
          waist: g.waist || null,
          body_fat: g.body_fat || null,
          muscle_mass: g.muscle_mass || null,
          bp_sys: g.bp_systolic || null,
          bp_dia: g.bp_diastolic || null,
        });
      }
    });
    anthropoRows.sort((a, b) => new Date(b.date) - new Date(a.date));
    const topRows = anthropoRows.slice(0, 6);

    const withWaist = anthropoRows
      .filter((r) => r.waist)
      .sort((a, b) => new Date(a.date) - new Date(b.date));
    const withFat = anthropoRows
      .filter((r) => r.body_fat)
      .sort((a, b) => new Date(a.date) - new Date(b.date));
    const trendParts = [];
    if (withWaist.length >= 2) {
      const diff = (withWaist[0].waist - withWaist[withWaist.length - 1].waist).toFixed(1);
      if (Math.abs(diff) >= 1)
        trendParts.push(`${Math.abs(diff)} cm ${diff > 0 ? "reduction" : "increase"} in waist`);
    }
    if (withFat.length >= 2) {
      const diff = (withFat[0].body_fat - withFat[withFat.length - 1].body_fat).toFixed(1);
      if (Math.abs(diff) >= 0.5)
        trendParts.push(`${Math.abs(diff)}% body fat ${diff > 0 ? "reduction" : "increase"}`);
    }
    const anthropoTrend = trendParts.length ? trendParts.join(" and ") : null;

    return {
      latestV,
      prevV,
      activeDx,
      flags,
      hba1cCurr,
      hba1cFirst,
      aiContext,
      aiInitialMsg,
      uniqueActiveMeds,
      uniqueStoppedMeds,
      latestVisitMeds,
      anthropoRows: topRows,
      anthropoTrend,
    };
  }, [data]);

  // ── Callbacks (stable references) ──
  const handleJump = useCallback((id) => {
    setJumpTarget(id);
    const el = document.getElementById(id);
    const scrl = scrollRef.current;
    if (el && scrl) {
      const scrollTop =
        el.getBoundingClientRect().top - scrl.getBoundingClientRect().top + scrl.scrollTop - 16;
      scrl.scrollTo({ top: scrollTop, behavior: "smooth" });
    }
  }, []);

  const toggleAI = useCallback(() => setAiOpen((o) => !o), []);
  const openEndModal = useCallback(() => setShowEndModal(true), []);
  const closeEndModal = useCallback(() => setShowEndModal(false), []);
  // Visit payload — used by both AI summary generation and PDF print.
  // Filters out tracking-only / stopped meds.
  const visitPayload = useMemo(() => {
    if (!data?.patient) return null;
    // Use raw activeMeds (not the deduped list) so children stay linked to
    // their parents. The prescription template builds its own parent/child
    // map; passing the deduped list would orphan children whose parent row
    // collided on name dedup.
    const activeOnly = (data.activeMeds || []).filter((m) => {
      if (m.is_active === false) return false;
      if (m.visit_status === "previous") return false;
      if (typeof m.id === "string" && m.id.startsWith("genie:")) return false;
      if (m.source === "manual" && !m.consultation_id) return false;
      return true;
    });
    // Prefer the doctor assigned to this OPD appointment (what the patient
    // booked) over the logged-in user — the printed Rx should attribute meds
    // to the consulting doctor, not whoever happens to be at the workstation.
    const apptDoctorName = data.appt_doctor_name;
    const rxDoctor = apptDoctorName ? { ...(doctor || {}), name: apptDoctorName } : doctor;
    return {
      patient: data.patient,
      doctor: rxDoctor,
      summary: data.summary,
      activeDx: derived?.activeDx || [],
      activeMeds: activeOnly,
      latestVitals: derived?.latestV || null,
      prevVitals: derived?.prevV || null,
      vitalsHistory: data.vitals || [],
      labResults: data.labResults || [],
      labHistory: data.labHistory || {},
      consultations: data.consultations || [],
      goals: data.goals || [],
      appt_plan: data.appt_plan || null,
    };
  }, [data, derived, doctor]);

  const [printingRx, setPrintingRx] = useState(false);
  const [rxModal, setRxModal] = useState({
    open: false,
    loading: false,
    status: "",
    blobUrl: null,
    error: null,
  });
  const rxBlobRef = useRef(null);

  const closeRxModal = useCallback(() => {
    setRxModal({ open: false, loading: false, status: "", blobUrl: null, error: null });
    if (rxBlobRef.current) {
      try {
        URL.revokeObjectURL(rxBlobRef.current);
      } catch {
        // ignore
      }
      rxBlobRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => {
      if (rxBlobRef.current) {
        try {
          URL.revokeObjectURL(rxBlobRef.current);
        } catch {
          // ignore
        }
        rxBlobRef.current = null;
      }
    };
  }, []);

  // Pick the patient-facing summary text the prescription should print.
  // Scoping rules:
  //   1. If we have a current appointment id and a saved version matches it,
  //      use that version (the visit's own summary).
  //   2. If we have a current appointment id but no version matches, return
  //      "" — the caller will auto-generate one for this visit. We never
  //      reuse an OLDER visit's summary on a new visit (would be stale).
  //   3. If there's no current appointment id at all (opened outside an OPD
  //      flow), fall back to the latest saved version OR any version with a
  //      null appointment_id, so manually-saved summaries still print.
  const pickVisitSummaryText = useCallback(() => {
    const versions = patientSummaryQ.data?.versions || [];
    if (versions.length === 0) return "";
    if (opdApptId) {
      const forAppt = versions.find((v) => Number(v.appointment_id) === Number(opdApptId));
      return forAppt?.content || "";
    }
    const noAppt = versions.find((v) => v.appointment_id == null);
    return noAppt?.content || versions[0]?.content || "";
  }, [patientSummaryQ.data, opdApptId]);

  // On print: if this visit already has a saved summary, reuse it. Otherwise
  // generate one once (tied to this appointment_id) and save it — subsequent
  // prints will reuse it without hitting the AI again. The doctor can still
  // regenerate / edit manually from the Patient Summary card.
  const resolveVisitSummaryText = useCallback(async () => {
    const existing = pickVisitSummaryText();
    if (existing) return existing;
    if (!visitPayload || !dbPatientId) return "";

    setRxModal((m) => ({ ...m, status: "Generating patient summary…" }));
    try {
      const { data: gen } = await api.post(`/api/visit/${dbPatientId}/patient-summary/generate`, {
        ...visitPayload,
        appointment_id: opdApptId || null,
      });
      await patientSummaryQ.refetch();
      return gen?.version?.content || "";
    } catch (err) {
      console.warn("[Visit] Patient summary generation failed:", err.message);
      return "";
    }
  }, [pickVisitSummaryText, visitPayload, dbPatientId, opdApptId, patientSummaryQ]);

  const handlePrint = useCallback(async () => {
    if (!visitPayload) return;
    if (printingRx) return;
    setPrintingRx(true);
    setRxModal({
      open: true,
      loading: true,
      status: "Preparing prescription…",
      blobUrl: null,
      error: null,
    });
    try {
      const visitSummaryText = await resolveVisitSummaryText();
      setRxModal((m) => ({ ...m, status: "Generating PDF…" }));
      const payload = { ...visitPayload, visitSummaryText };
      const res = await api.post(
        `/api/visit/${dbPatientId || data.patient.id}/prescription.pdf`,
        payload,
        { responseType: "blob" },
      );
      const pdfBlob =
        res.data instanceof Blob && res.data.type === "application/pdf"
          ? res.data
          : new Blob([res.data], { type: "application/pdf" });
      const url = URL.createObjectURL(pdfBlob);
      rxBlobRef.current = url;
      setRxModal({
        open: true,
        loading: false,
        status: "",
        blobUrl: url,
        error: null,
      });
    } catch (err) {
      console.error("[Visit] Print Rx failed:", err);
      const msg = err?.response?.data?.error || err.message || "Unknown error";
      setRxModal({
        open: true,
        loading: false,
        status: "",
        blobUrl: null,
        error: msg,
      });
      toast(`Could not generate prescription: ${msg}`, "error");
    } finally {
      setPrintingRx(false);
    }
  }, [visitPayload, dbPatientId, data, resolveVisitSummaryText, printingRx]);

  const handleSaveRx = useCallback(async () => {
    const pid = dbPatientId || data?.patient?.id;
    if (!pid) throw new Error("No patient ID");
    await api.post(`/api/visit/${pid}/prescription/regenerate`, {
      appointmentId: opdApptId || undefined,
    });
    await refreshData();
  }, [dbPatientId, data, opdApptId, refreshData]);

  const handlePrintMedCard = useCallback(() => {
    const patient = data?.patient;
    const activeMeds = (derived?.uniqueActiveMeds || []).filter(
      (m) => m.visit_status !== "previous",
    );
    if (!patient) return;
    printMedCard(patient, activeMeds);
  }, [data, derived]);
  const handlePrintBoth = useCallback(() => {
    const patient = data?.patient;
    const activeMeds = (derived?.uniqueActiveMeds || []).filter(
      (m) => m.visit_status !== "previous",
    );
    if (patient) printMedCard(patient, activeMeds, 700);
    handlePrint();
  }, [data, derived, handlePrint]);
  const handlePasteNotes = useCallback(() => setModal({ type: "pasteText" }), []);

  // ── Scroll spy: update jumpTarget based on scroll position ──
  useEffect(() => {
    const scrl = scrollRef.current;
    if (!scrl) return;
    const onScroll = () => {
      const containerTop = scrl.getBoundingClientRect().top;
      let current = JUMP_SECTIONS[0].id;
      for (const sec of JUMP_SECTIONS) {
        const el = document.getElementById(sec.id);
        if (el) {
          const elTop = el.getBoundingClientRect().top - containerTop;
          if (elTop <= 60) current = sec.id;
        }
      }
      setJumpTarget(current);
    };
    scrl.addEventListener("scroll", onScroll, { passive: true });
    return () => scrl.removeEventListener("scroll", onScroll);
  }, [data]);

  const handleEndVisit = useCallback(async () => {
    // Generate + save the prescription PDF as a patient document before
    // wrapping up. If this fails the visit still completes — the doctor
    // can re-print/save manually.
    if (visitPayload && (dbPatientId || data?.patient?.id)) {
      try {
        const visitSummaryText = pickVisitSummaryText();
        const { data: saved } = await api.post(
          `/api/visit/${dbPatientId || data.patient.id}/complete`,
          { ...visitPayload, visitSummaryText },
        );
        toast(`Prescription saved: ${saved?.file_name || "PDF"}`, "success");
      } catch (e) {
        console.warn("[Visit] Save prescription on complete failed:", e?.message);
        toast("Couldn't save prescription PDF — visit still completed.", "warn");
      }
    }

    // Mark appointment as "seen" in OPD (creates consultation record)
    const apptId = sessionStorage.getItem("gini_opd_appt_id");
    if (apptId) {
      try {
        await api.patch(`/api/appointments/${apptId}`, { status: "seen" });
      } catch {
        // non-critical — OPD will still show correct state on refresh
      }
      sessionStorage.removeItem("gini_opd_appt_id");
      sessionStorage.removeItem("gini_visit_start");
    }
    endVisitAction(true);
    toast("Visit completed", "success");
    navigate("/opd");
  }, [endVisitAction, navigate, visitPayload, dbPatientId, data, pickVisitSummaryText]);

  // ── Tab badge counts (memoized) ──
  const tabBadges = useMemo(() => {
    if (!data) return {};
    const visibleDocs = data.documents.filter(
      (d) => d.storage_path || d.file_url || d.source === "healthray",
    );
    // Mirror VisitLabsPanel: every uploaded doc except prescriptions and
    // radiology sub-categories is shown under the Labs tab.
    const RADIOLOGY_DOC_TYPES = new Set([
      "imaging",
      "radiology",
      "xray",
      "usg",
      "mri",
      "dexa",
      "ecg",
      "ncs",
      "eye",
    ]);
    return {
      labs:
        visibleDocs.filter(
          (d) => d.doc_type !== "prescription" && !RADIOLOGY_DOC_TYPES.has(d.doc_type),
        ).length || null,
      docs: visibleDocs.length || null,
      messages: null, // populated when messaging is wired up
    };
  }, [data]);

  // ── Loading / empty states ──
  if (loading) {
    return (
      <div className="visit-page">
        <div className="vp-loading">
          <div className="vp-spin" /> Loading visit data...
        </div>
      </div>
    );
  }

  if (!data || !derived) {
    return (
      <div className="visit-page">
        <div className="vp-loading">
          No visit data found.{" "}
          <button className="btn" onClick={navClick("/")}>
            Go Home
          </button>
        </div>
      </div>
    );
  }

  const {
    patient,
    activeMeds,
    stoppedMeds,
    labResults,
    labHistory,
    consultations,
    documents,
    referrals,
    goals,
    loggedData,
    summary,
    vitals,
    appt_plan,
  } = data;
  const {
    latestV,
    prevV,
    activeDx,
    flags,
    hba1cCurr,
    hba1cFirst,
    aiContext,
    aiInitialMsg,
    uniqueActiveMeds,
    uniqueStoppedMeds,
    latestVisitMeds,
    anthropoRows,
    anthropoTrend,
  } = derived;

  return (
    <div className="visit-page">
      <VisitTopbar
        patient={patient}
        doctor={data.appt_doctor_name ? { ...(doctor || {}), name: data.appt_doctor_name } : doctor}
        summary={summary}
        latestVitals={latestV}
        appointment={data.latestAppointment}
        onToggleAI={toggleAI}
        onEndVisit={hasActiveVisit ? openEndModal : null}
        onPasteNotes={handlePasteNotes}
        onPrintRx={handlePrint}
        onPrintMedCard={handlePrintMedCard}
        onPrintBoth={handlePrintBoth}
        visitStart={visitStart}
        hasActiveVisit={hasActiveVisit}
      />

      <VisitStrip
        summary={summary}
        hba1cCurr={hba1cCurr}
        hba1cFirst={hba1cFirst}
        latestVitals={latestV}
        prevVitals={prevV}
        activeMeds={uniqueActiveMeds}
        labStatus={data.labStatus}
        tab={tab}
      />

      {/* Bulk-save status chip — fixed bottom-right, non-blocking. Shows
          while the paste-text review save runs in the background so the
          doctor knows their click is still persisting data. */}
      {bulkSaveStatus && (
        <div
          role="status"
          aria-live="polite"
          style={{
            position: "fixed",
            right: 16,
            bottom: 16,
            zIndex: 9000,
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "10px 14px",
            borderRadius: 8,
            fontSize: 13,
            fontWeight: 500,
            boxShadow: "0 4px 14px rgba(0,0,0,0.18)",
            border: "1px solid",
            background:
              bulkSaveStatus.phase === "failed"
                ? "#fee2e2"
                : bulkSaveStatus.phase === "saved"
                  ? "#dcfce7"
                  : "#fff7ed",
            borderColor:
              bulkSaveStatus.phase === "failed"
                ? "#fca5a5"
                : bulkSaveStatus.phase === "saved"
                  ? "#86efac"
                  : "#fed7aa",
            color:
              bulkSaveStatus.phase === "failed"
                ? "#7f1d1d"
                : bulkSaveStatus.phase === "saved"
                  ? "#14532d"
                  : "#7c2d12",
            maxWidth: 420,
          }}
        >
          {bulkSaveStatus.phase === "saving" && (
            <span
              aria-hidden
              style={{
                display: "inline-block",
                width: 14,
                height: 14,
                border: "2px solid #fb923c",
                borderTopColor: "transparent",
                borderRadius: "50%",
                animation: "visit-save-spin 0.8s linear infinite",
              }}
            />
          )}
          {bulkSaveStatus.phase === "saved" && <span aria-hidden>✅</span>}
          {bulkSaveStatus.phase === "failed" && <span aria-hidden>⚠️</span>}
          <span style={{ flex: 1, lineHeight: 1.35 }}>{bulkSaveStatus.label}</span>
          {bulkSaveStatus.phase !== "saving" && (
            <button
              type="button"
              onClick={() => setBulkSaveStatus(null)}
              aria-label="Dismiss"
              style={{
                background: "transparent",
                border: "none",
                fontSize: 16,
                cursor: "pointer",
                color: "inherit",
                padding: "0 2px",
                lineHeight: 1,
              }}
            >
              ×
            </button>
          )}
          <style>{`@keyframes visit-save-spin { to { transform: rotate(360deg); } }`}</style>
        </div>
      )}

      {/* Extraction in progress modal overlay */}
      {extracting && (
        <div
          style={{
            position: "fixed",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: "rgba(0, 0, 0, 0.5)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 9999,
          }}
        >
          <div
            style={{
              background: "#ffffff",
              borderRadius: 12,
              padding: "32px",
              textAlign: "center",
              boxShadow: "0 20px 60px rgba(0, 0, 0, 0.3)",
              maxWidth: 320,
            }}
          >
            <div style={{ fontSize: 48, marginBottom: 16, animation: "spin 2s linear infinite" }}>
              ⏳
            </div>
            <div style={{ fontSize: 16, fontWeight: 600, color: "#1a1f2e", marginBottom: 8 }}>
              Extracting Lab Values
            </div>
            <div style={{ fontSize: 13, color: "#6b7280" }}>
              Please wait while we extract the lab results from your report...
            </div>
          </div>
        </div>
      )}

      <div className="bodywrap">
        <VisitSidebar
          summary={summary}
          latestVitals={latestV}
          activeDx={activeDx}
          activeMeds={latestVisitMeds}
          flags={flags}
          labResults={labResults}
          vitals={vitals}
          onSaveVitals={(data) => mutations.updateVitals(data, latestV)}
          onSaveLab={(data) => mutations.addLab(data)}
        />

        <div className="main">
          {/* ── Tabs ── */}
          <div className="stabs">
            {TABS.map((t) => (
              <button
                key={t.id}
                className={`stab ${tab === t.id ? "on" : ""}`}
                onClick={() => setTab(t.id)}
              >
                {t.label}
                {t.badgeKey && tabBadges[t.badgeKey] > 0 && (
                  <span className={`tbadge${t.badgeCls ? ` ${t.badgeCls}` : ""}`}>
                    {tabBadges[t.badgeKey]}
                  </span>
                )}
              </button>
            ))}
            <div className="stabs-r">
              <CarePhasePill
                summary={summary}
                activeDx={activeDx}
                labResults={labResults}
                labHistory={labHistory}
                vitals={data.vitals}
              />
            </div>
          </div>

          {/* ═══ VISIT PANEL ═══ */}
          <div className={`panel ${tab === "visit" ? "on" : ""}`}>
            <div className="jnav">
              <span className="jlbl">Jump to</span>
              {JUMP_SECTIONS.map((j) => (
                <button
                  key={j.id}
                  className={`jbtn ${jumpTarget === j.id ? "on" : ""}`}
                  onClick={() => handleJump(j.id)}
                >
                  {j.label}
                </button>
              ))}
              <div className="jdiv" />
              <button
                className="jbtn"
                onClick={() => handleJump("changes")}
                style={{ color: "var(--green)" }}
              >
                ✏️ This Visit
              </button>
              <button className="ai-btn" onClick={toggleAI}>
                ✦ Gini AI
              </button>
            </div>
            <div className="scrl" ref={scrollRef}>
              <SyncStatusBanner syncStatus={data.syncStatus} />
              <VisitBrief
                patientId={dbPatientId}
                appointmentId={effectiveApptId}
                patient={patient}
                doctor={doctor}
              />
              <VisitPreVisitSymptoms appointmentId={effectiveApptId} />
              <VisitPreVisitCompliance appointmentId={effectiveApptId} />
              <VisitDoseChangeRequests patientId={dbPatientId} />
              <VisitSummaryPanel patientId={dbPatientId} appointmentId={effectiveApptId} />
              <VisitBiomarkers
                labResults={labResults}
                labLatest={data.labLatest}
                labHistory={labHistory}
                vitals={vitals}
                activeDx={activeDx}
                flags={flags}
                onOpenAI={() => setAiOpen(true)}
                onAddLab={() => setModal({ type: "addLab" })}
                onEditLab={(lab) => setModal({ type: "addLab", data: lab })}
              />
              {/* <VitalsTrendChart vitals={vitals} /> */}
              {/* <VisitCoordPrep prep={data.prep} /> */}
              <VisitSymptomsSection
                symptoms={data.symptoms || []}
                onAddSymptom={() => setModal({ type: "addSymptom" })}
                onStatusChange={(id, status) => mutations.updateSymptomStatus(id, status)}
              />
              <VisitDiagnoses
                activeDx={activeDx}
                healthrayDiagnoses={data.healthrayDiagnoses}
                labResults={data.labResults}
                vitals={data.vitals}
                onAddDiagnosis={() => setModal({ type: "addDiagnosis" })}
                onDiagnosisNote={(dx) => setModal({ type: "diagnosisNote", data: dx })}
                onUpdateDiagnosis={(id, d) => mutations.updateDiagnosis(id, d)}
              />
              <VisitMedications
                activeMeds={uniqueActiveMeds}
                stoppedMeds={uniqueStoppedMeds}
                onAddMed={() => setModal({ type: "addMed" })}
                onAddSubMed={(parent) => setModal({ type: "addMed", data: { parentMed: parent } })}
                onEditMed={(m) => setModal({ type: "editMed", data: m })}
                onStopMed={(m) => setModal({ type: "stopMed", data: m })}
                onMoveToActive={(m) => mutations.moveMedToActive(m.id)}
                onDeleteMed={(m) => setModal({ type: "deleteMed", data: m })}
                onRestartMed={(m) => {
                  const hasStoppedChildren = (uniqueStoppedMeds || []).some(
                    (c) => c.parent_medication_id === m.id,
                  );
                  const isOrphanSubMed =
                    !!m.parent_medication_id &&
                    !(uniqueActiveMeds || []).some((p) => p.id === m.parent_medication_id);
                  if (hasStoppedChildren || isOrphanSubMed) {
                    setModal({ type: "restartMed", data: m });
                    return;
                  }
                  return mutations.restartMedication(m.id);
                }}
              />
              <PatientSummarySection
                patientId={dbPatientId}
                appointmentId={effectiveApptId}
                visitPayload={visitPayload}
              />
              <DoctorSummarySection patientId={dbPatientId} appointmentId={effectiveApptId} />
              <VisitPlan
                consultations={consultations}
                apptPlan={appt_plan}
                goals={goals}
                doctorNote={doctorNote}
                onDoctorNoteChange={handleDoctorNoteChange}
                patient={patient}
                doctor={doctor}
                activeDx={activeDx}
                activeMeds={uniqueActiveMeds}
                stoppedMeds={uniqueStoppedMeds}
                latestVitals={latestV}
                summary={summary}
                labResults={labResults}
                symptoms={data.symptoms || []}
                onEndVisit={hasActiveVisit ? openEndModal : null}
                referrals={referrals || []}
                onAddReferral={() => setModal({ type: "addReferral" })}
                onChangeFollowUp={() => setModal({ type: "changeFollowUp" })}
                onChangeFollowUpWith={handleChangeFollowUpWith}
                onOpenTemplate={(tpl) => setModal({ type: "template", data: tpl })}
                onMedCardTab={() => setTab("medcard")}
                conData={conData}
                setConData={setConData}
                onPrintRx={handlePrint}
                printingRx={printingRx}
              />
              <div style={{ height: 28 }} />
            </div>
          </div>

          {/* ═══ OTHER PANELS ═══ */}
          <div className={`panel ${tab === "labs" ? "on" : ""}`}>
            <VisitLabsPanel
              documents={documents}
              patientId={patient?.id}
              labResults={labResults}
              labLatest={data.labLatest}
              labOrders={data.labOrders}
              onUploadReport={() => setModal({ type: "uploadReport" })}
            />
          </div>
          <div className={`panel ${tab === "exam" ? "on" : ""}`}>
            <div className="panel-body">
              <div className="sc">
                <div className="sch">
                  <div className="sct">
                    <div className="sci ic-g">🩺</div>Physical Exam · Visit #{summary.totalVisits}
                  </div>
                  <button className="bx bx-p" onClick={navClick("/exam")}>
                    + Record Exam
                  </button>
                </div>
                <div className="scb">
                  {data.examFindings ? (
                    <div className="visit-exam-grid">
                      {data.examFindings.map((ef, i) => (
                        <div
                          key={i}
                          style={{
                            border: "1px solid var(--border)",
                            borderRadius: "var(--rs)",
                            padding: 12,
                          }}
                        >
                          <div
                            style={{
                              fontSize: 11,
                              fontWeight: 700,
                              color: "var(--text)",
                              marginBottom: 8,
                            }}
                          >
                            {ef.icon || ""} {ef.system}
                          </div>
                          <div style={{ fontSize: 12, color: "var(--t2)", lineHeight: 2 }}>
                            {ef.findings}
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="visit-exam-grid">
                      <div
                        style={{
                          border: "1px solid var(--border)",
                          borderRadius: "var(--rs)",
                          padding: 12,
                        }}
                      >
                        <div
                          style={{
                            fontSize: 11,
                            fontWeight: 700,
                            color: "var(--text)",
                            marginBottom: 8,
                          }}
                        >
                          ❤️ Cardiovascular
                        </div>
                        <div style={{ fontSize: 12, color: "var(--t3)", lineHeight: 2 }}>
                          No exam recorded
                        </div>
                      </div>
                      <div
                        style={{
                          border: "1px solid var(--border)",
                          borderRadius: "var(--rs)",
                          padding: 12,
                        }}
                      >
                        <div
                          style={{
                            fontSize: 11,
                            fontWeight: 700,
                            color: "var(--text)",
                            marginBottom: 8,
                          }}
                        >
                          🫁 Respiratory
                        </div>
                        <div style={{ fontSize: 12, color: "var(--t3)", lineHeight: 2 }}>
                          No exam recorded
                        </div>
                      </div>
                      <div
                        style={{
                          border: "1px solid var(--border)",
                          borderRadius: "var(--rs)",
                          padding: 12,
                        }}
                      >
                        <div
                          style={{
                            fontSize: 11,
                            fontWeight: 700,
                            color: "var(--text)",
                            marginBottom: 8,
                          }}
                        >
                          🫃 Abdomen
                        </div>
                        <div style={{ fontSize: 12, color: "var(--t3)", lineHeight: 2 }}>
                          No exam recorded
                        </div>
                      </div>
                      <div
                        style={{
                          border: "1px solid var(--border)",
                          borderRadius: "var(--rs)",
                          padding: 12,
                        }}
                      >
                        <div
                          style={{
                            fontSize: 11,
                            fontWeight: 700,
                            color: "var(--text)",
                            marginBottom: 8,
                          }}
                        >
                          🦶 Diabetic Foot
                        </div>
                        <div style={{ fontSize: 12, color: "var(--t3)", lineHeight: 2 }}>
                          No exam recorded
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              </div>
              {/* Anthropometry History */}
              {anthropoRows.length > 0 && (
                <div className="sc">
                  <div className="sch">
                    <div className="sct">
                      <div className="sci ic-a">📏</div>Anthropometry History
                    </div>
                  </div>
                  <div className="scb">
                    <div style={{ overflowX: "auto" }}>
                      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                        <thead>
                          <tr style={{ background: "var(--bg)" }}>
                            {[
                              "Date",
                              "Weight",
                              "BMI",
                              "Waist",
                              "Body Fat %",
                              "Muscle Mass",
                              "BP",
                            ].map((h) => (
                              <th
                                key={h}
                                style={{
                                  padding: "7px 12px",
                                  textAlign: h === "Date" ? "left" : "center",
                                  fontSize: 9,
                                  fontWeight: 700,
                                  color: "var(--t4)",
                                  textTransform: "uppercase",
                                  letterSpacing: ".5px",
                                }}
                              >
                                {h}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {anthropoRows.map((v, i) => (
                            <tr key={i} style={{ borderBottom: "1px solid var(--border)" }}>
                              <td
                                style={{
                                  padding: "7px 12px",
                                  fontWeight: i === 0 ? 700 : 400,
                                  color: i === 0 ? "var(--primary)" : "var(--text)",
                                }}
                              >
                                {fmtDate(v.date)}
                              </td>
                              <td style={{ padding: "7px 12px", textAlign: "center" }}>
                                {v.weight ? `${v.weight} kg` : "—"}
                              </td>
                              <td style={{ padding: "7px 12px", textAlign: "center" }}>
                                {v.bmi || "—"}
                              </td>
                              <td style={{ padding: "7px 12px", textAlign: "center" }}>
                                {v.waist ? `${v.waist} cm` : "—"}
                              </td>
                              <td style={{ padding: "7px 12px", textAlign: "center" }}>
                                {v.body_fat ? `${v.body_fat}%` : "—"}
                              </td>
                              <td style={{ padding: "7px 12px", textAlign: "center" }}>
                                {v.muscle_mass ? `${v.muscle_mass} kg` : "—"}
                              </td>
                              <td style={{ padding: "7px 12px", textAlign: "center" }}>
                                {v.bp_sys && v.bp_dia ? `${v.bp_sys}/${v.bp_dia}` : "—"}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    {anthropoTrend && (
                      <div className="noticebar grn" style={{ marginTop: 10 }}>
                        <span>✓</span>
                        <span className="ni grn">{anthropoTrend} since earliest record.</span>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
          <div className={`panel ${tab === "history" ? "on" : ""}`}>
            <VisitHistoryPanel consultations={consultations} />
          </div>
          <div className={`panel ${tab === "messages" ? "on" : ""}`}>
            <div className="panel-body">
              <div className="sc">
                <div className="sch">
                  <div className="sct">
                    <div className="sci ic-p">💬</div>Messages &amp; WhatsApp Logs
                  </div>
                  <button className="bx bx-p">Log Call</button>
                </div>
                <div className="scb" style={{ maxWidth: 600 }}>
                  {data.messages?.length > 0 ? (
                    <>
                      {data.messages.map((msg, i) => {
                        const isTeam = msg.sender === "team" || msg.sender === "doctor";
                        const isUnread = msg.is_unread;
                        return (
                          <div key={msg.id || i}>
                            {(i === 0 || msg.date_label) && (
                              <div
                                style={{
                                  fontSize: 10,
                                  fontWeight: 700,
                                  color: "var(--t4)",
                                  letterSpacing: ".5px",
                                  textTransform: "uppercase",
                                  margin: i > 0 ? "12px 0 10px" : "0 0 10px",
                                }}
                              >
                                {msg.date_label || fmtDate(msg.sent_at)}
                                {isUnread ? " — UNREAD ⚠" : ""}
                              </div>
                            )}
                            <div
                              className={`msg-bubble ${isUnread ? "unread" : isTeam ? "team" : "patient"}`}
                            >
                              {!isTeam && <strong>{msg.sender_name || patient.name}</strong>}
                              {!isTeam && <br />}
                              {msg.text || msg.message}
                              <div className={`msg-meta ${isTeam ? "team" : "patient"}`}>
                                {msg.channel || "WhatsApp"} · {fmtDate(msg.sent_at)}
                                {isUnread ? " · UNREAD" : ""}
                              </div>
                            </div>
                          </div>
                        );
                      })}
                      <div style={{ marginTop: 12, display: "flex", gap: 7 }}>
                        <input
                          className="mi"
                          style={{ flex: 1, height: 36 }}
                          placeholder="Type reply..."
                        />
                        <button className="btn-p" style={{ height: 36 }}>
                          Send via WhatsApp
                        </button>
                      </div>
                    </>
                  ) : (
                    <>
                      <div
                        style={{
                          fontSize: 13,
                          color: "var(--t3)",
                          padding: 20,
                          textAlign: "center",
                        }}
                      >
                        No messages yet
                      </div>
                      <div style={{ marginTop: 12, display: "flex", gap: 7 }}>
                        <input
                          className="mi"
                          style={{ flex: 1, height: 36 }}
                          placeholder="Type message..."
                        />
                        <button className="btn-p" style={{ height: 36 }}>
                          Send via WhatsApp
                        </button>
                      </div>
                    </>
                  )}
                </div>
              </div>
            </div>
          </div>
          <div className={`panel ${tab === "docs" ? "on" : ""}`}>
            <VisitDocsPanel
              documents={documents}
              patientId={patient?.id}
              onUploadReport={() => setModal({ type: "uploadReport" })}
              onRefresh={refreshData}
            />
          </div>
          <div className={`panel ${tab === "medcard" ? "on" : ""}`}>
            <VisitMedCard patient={patient} activeMeds={uniqueActiveMeds} />
          </div>
          <div className={`panel ${tab === "logdata" ? "on" : ""}`}>
            <VisitLoggedData loggedData={loggedData} />
          </div>
        </div>
      </div>

      {/* ── AI Panel ── */}
      <VisitAIPanel
        open={aiOpen}
        onClose={() => setAiOpen(false)}
        patientContext={aiContext}
        initialMessage={aiInitialMsg}
      />

      {/* ── Prescription PDF Modal ── */}
      <RxPdfModal
        open={rxModal.open}
        loading={rxModal.loading}
        status={rxModal.status}
        blobUrl={rxModal.blobUrl}
        error={rxModal.error}
        onClose={closeRxModal}
        onRetry={handlePrint}
        onSave={handleSaveRx}
      />

      {/* ── End Visit Modal ── */}
      {showEndModal && (
        <VisitEndModal
          patient={patient}
          summary={summary}
          onClose={closeEndModal}
          onConfirm={handleEndVisit}
        />
      )}

      {/* ── Action Modals ── */}
      {modal?.type === "addSymptom" && (
        <AddSymptomModal
          activeDx={activeDx}
          activeMeds={uniqueActiveMeds}
          onClose={closeModal}
          onSubmit={async (d) => {
            const r = await mutations.addSymptom(d);
            if (r.success) closeModal();
          }}
        />
      )}
      {modal?.type === "addLab" && (
        <AddLabModal
          onClose={closeModal}
          existingLab={modal.data || null}
          onSubmit={async (d, existing) => {
            const r = existing?.id
              ? await mutations.editLab(existing.id, d)
              : await mutations.addLab(d);
            if (r.success) closeModal();
          }}
        />
      )}
      {modal?.type === "addDiagnosis" && (
        <AddDiagnosisModal
          onClose={closeModal}
          onSubmit={async (d) => {
            const r = await mutations.addDiagnosis(d);
            if (r.success) closeModal();
          }}
        />
      )}
      {modal?.type === "diagnosisNote" && (
        <DiagnosisNoteModal
          diagnosis={modal.data}
          onClose={closeModal}
          onSubmit={async (d) => {
            const r = await mutations.updateDiagnosis(modal.data.id, d);
            if (r.success) closeModal();
          }}
        />
      )}
      {modal?.type === "addMed" && (
        <AddMedicationModal
          diagnoses={activeDx}
          patient={data.patient}
          labResults={data.labResults}
          activeMeds={derived.uniqueActiveMeds}
          parentMed={modal.data?.parentMed}
          onClose={closeModal}
          onSubmit={async (d) => {
            const r = await mutations.addMedication(d);
            if (r.success) closeModal();
          }}
        />
      )}
      {modal?.type === "editMed" && (
        <EditMedicationModal
          medication={modal.data}
          diagnoses={activeDx}
          patient={data.patient}
          activeMeds={derived.uniqueActiveMeds}
          onClose={closeModal}
          onSubmit={async (d) => {
            const r = await mutations.editMedication(modal.data.id, d);
            if (r.success) closeModal();
          }}
        />
      )}
      {modal?.type === "stopMed" && (
        <StopMedicationModal
          medication={modal.data}
          activeMeds={derived.uniqueActiveMeds}
          onClose={closeModal}
          onSubmit={async (d) => {
            const r = await mutations.stopMedication(modal.data.id, d);
            if (r.success) closeModal();
          }}
        />
      )}
      {modal?.type === "restartMed" && (
        <RestartMedicationModal
          medication={modal.data}
          activeMeds={derived.uniqueActiveMeds}
          stoppedMeds={derived.uniqueStoppedMeds}
          onClose={closeModal}
          onSubmit={async (d) => {
            const r = await mutations.restartMedication(modal.data.id, d);
            if (r.success) closeModal();
          }}
        />
      )}
      {modal?.type === "deleteMed" && (
        <DeleteMedicationModal
          medication={modal.data}
          onClose={closeModal}
          onSubmit={async (id) => {
            const r = await mutations.deleteMedication(id);
            if (r.success) closeModal();
          }}
        />
      )}
      {modal?.type === "addReferral" && (
        <AddReferralModal
          onClose={closeModal}
          onSubmit={async (d) => {
            const r = await mutations.addReferral(d);
            if (r.success) closeModal();
          }}
        />
      )}
      {modal?.type === "uploadReport" && (
        <UploadReportModal
          onClose={closeModal}
          onSubmit={async (d) => {
            const r = await mutations.uploadDocument(d);
            if (!r.success) return;
            closeModal();
            // For lab reports with a file, extract and show review modal
            if (d.doc_type === "lab_report" && d.base64) {
              setExtracting(true);
              try {
                const mediaType = d.fileName?.match(/\.pdf$/i)
                  ? "application/pdf"
                  : d.fileName?.match(/\.png$/i)
                    ? "image/png"
                    : "image/jpeg";
                console.log("[LabExtract] Starting extraction", {
                  fileName: d.fileName,
                  mediaType,
                });
                const { data: extracted, error } = await extractLab(d.base64, mediaType);
                console.log("[LabExtract] Result:", { extracted, error });
                setExtracting(false);
                if (error) {
                  toast(`Extraction error: ${error}`, "warn");
                } else if (!extracted?.panels?.length) {
                  toast("No lab values found in report", "warn");
                } else {
                  // PATCH document with extracted_data to trigger backend sync (labs + vitals + biomarkers)
                  if (r.docId) {
                    api
                      .patch(`/api/documents/${r.docId}`, { extracted_data: extracted })
                      .catch(() => {});
                  }
                  setModal({ type: "labReview", data: { extracted, doc_date: d.doc_date } });
                }
              } catch (e) {
                console.error("[LabExtract] Exception:", e);
                setExtracting(false);
                toast(`Lab extraction failed: ${e.message}`, "warn");
              }
            } else if (d.doc_type === "lab_report" && !d.base64) {
              toast("No file attached — attach a file to extract lab values", "warn");
            }
          }}
        />
      )}
      {modal?.type === "pasteText" && (
        <PasteBiomarkersModal
          patientId={dbPatientId}
          onClose={closeModal}
          onExtracted={({ extracted, doc_date, raw_text }) => {
            closeModal();
            setModal({
              type: "clinicalReview",
              data: { extracted, doc_date, raw_text },
            });
          }}
        />
      )}
      {modal?.type === "labReview" && (
        <LabExtractionReviewModal
          extracted={modal.data.extracted}
          doc_date={modal.data.doc_date}
          saving={labExtractSaving}
          onClose={closeModal}
          onSave={async (tests, doc_date, vitals = []) => {
            setLabExtractSaving(true);
            const source = modal.data.source || "lab";
            let savedLabs = 0;
            let savedVitals = 0;
            for (const test of tests) {
              try {
                await api.post(`/api/patients/${dbPatientId}/labs`, {
                  test_name: normalizeTestName(test.test_name),
                  result: String(test.result_text || test.result),
                  unit: test.unit || "",
                  flag: test.flag || "N",
                  ref_range: test.ref_range || "",
                  test_date: test.test_date || doc_date || null,
                  source,
                });
                savedLabs++;
              } catch (e) {
                console.error("Failed to save lab:", e.message);
              }
            }
            for (const v of vitals) {
              try {
                await api.post(`/api/visit/${dbPatientId}/vitals`, {
                  bp_sys: v.bpSys ?? null,
                  bp_dia: v.bpDia ?? null,
                  weight: v.weight ?? null,
                  height: v.height ?? null,
                  bmi: v.bmi ?? null,
                  waist: v.waist ?? null,
                  body_fat: v.bodyFat ?? null,
                  recorded_at: v.date || doc_date || null,
                });
                savedVitals++;
              } catch (e) {
                console.error("Failed to save vitals:", e.message);
              }
            }
            // Refresh the OPD biomarker chip strip from the new lab_results
            // so /opd reflects the latest values alongside /visit and /outcomes.
            if (savedLabs > 0) {
              try {
                await api.post(`/api/visit/${dbPatientId}/biomarkers/refresh`);
              } catch (e) {
                console.error("Biomarker refresh failed:", e.message);
              }
            }
            // Refresh data and wait a moment for state to update
            await refreshData();
            // Invalidate OPD appointments cache so the chip strip repaints when
            // the user navigates there. Outcomes page refetches on mount (no
            // cache invalidation needed there).
            qc.invalidateQueries({ queryKey: qk.opd.all });
            await new Promise((r) => setTimeout(r, 500));
            setLabExtractSaving(false);
            closeModal();
            const parts = [];
            if (savedLabs > 0) parts.push(`${savedLabs} lab${savedLabs !== 1 ? "s" : ""}`);
            if (savedVitals > 0)
              parts.push(`${savedVitals} vitals reading${savedVitals !== 1 ? "s" : ""}`);
            toast(parts.length ? `${parts.join(" + ")} saved` : "Nothing saved", "success");
            // Delayed second refresh to catch async backend autoExtractLab results
            setTimeout(() => refreshData(), 3000);
          }}
        />
      )}
      {modal?.type === "clinicalReview" && (
        <ClinicalExtractionReviewModal
          extracted={modal.data.extracted}
          doc_date={modal.data.doc_date}
          currentSymptoms={data.symptoms || []}
          currentDiagnoses={activeDx}
          currentMedications={uniqueActiveMeds}
          saving={clinicalExtractSaving}
          onClose={closeModal}
          onSave={(picked) => {
            // Close immediately + run the save in the background via the
            // single /clinical-bulk endpoint (one HTTP request instead of
            // ~7 per-section calls). Toast reports counts/failures from the
            // server, then refreshData() + cache invalidation paint the
            // new state.
            const docDate = modal.data.doc_date;
            const rawText = modal.data.raw_text || "";
            closeModal();
            const followUpWithText =
              typeof picked.follow_up_with === "string" ? picked.follow_up_with.trim() : "";
            const totalPickedItems =
              picked.symptoms.length +
              picked.diagnoses.length +
              picked.medications.length +
              picked.stopMeds.length +
              picked.labs.length +
              picked.vitals.length +
              picked.investigations.length +
              (followUpWithText ? 1 : 0);
            if (totalPickedItems > 0) {
              toast(`Saving ${totalPickedItems} item${totalPickedItems !== 1 ? "s" : ""}…`, "info");
              setBulkSaveStatus({
                phase: "saving",
                label: `Saving ${totalPickedItems} item${totalPickedItems !== 1 ? "s" : ""}…`,
              });
            }

            const runSave = async () => {
              setClinicalExtractSaving(true);
              let counts = { sx: 0, dx: 0, meds: 0, stop: 0, labs: 0, vit: 0, inv: 0, fuw: 0 };
              let failed = [];
              try {
                const { data } = await api.post(`/api/visit/${dbPatientId}/clinical-bulk`, {
                  symptoms: picked.symptoms,
                  diagnoses: picked.diagnoses.map((d) => ({
                    name: d.name,
                    status: d.status === "Absent" ? "Resolved" : "Newly Diagnosed",
                    category: "primary",
                    notes: [d.details, d.since ? `Since ${d.since}` : null]
                      .filter(Boolean)
                      .join(" · "),
                  })),
                  medications: picked.medications.map((m) => ({
                    name: m.name,
                    dose: m.dose || "",
                    frequency: m.frequency || "OD",
                    timing: m.timing || "",
                    when_to_take: Array.isArray(m.when_to_take)
                      ? m.when_to_take
                      : m.when_to_take
                        ? String(m.when_to_take)
                            .split(",")
                            .map((s) => s.trim())
                            .filter(Boolean)
                        : null,
                    route: m.route || "Oral",
                    days_of_week:
                      Array.isArray(m.days_of_week) && m.days_of_week.length
                        ? m.days_of_week
                        : null,
                    started_date: docDate || null,
                  })),
                  stopMeds: picked.stopMeds,
                  labs: picked.labs.map((l) => ({
                    test_name: normalizeTestName(l.test_name),
                    result: String(l.result_text || l.result),
                    unit: l.unit || "",
                    flag: l.flag || "N",
                    ref_range: l.ref_range || "",
                    test_date: l.test_date || docDate || null,
                    source: "report_extract",
                  })),
                  vitals: picked.vitals,
                  investigations: picked.investigations,
                  follow_up_with: followUpWithText || null,
                  doc_date: docDate || null,
                  raw_text: rawText,
                  patient,
                  doctor,
                });
                counts = data?.counts || counts;
                failed = Array.isArray(data?.failed) ? data.failed : [];
              } catch (e) {
                console.error("Bulk clinical save failed:", e?.message);
                failed = ["entire batch — network error"];
              }

              if (counts.labs > 0) {
                try {
                  await api.post(`/api/visit/${dbPatientId}/biomarkers/refresh`);
                } catch (e) {
                  console.error("Biomarker refresh failed:", e.message);
                }
              }

              await refreshData();
              qc.invalidateQueries({ queryKey: qk.opd.all });
              setClinicalExtractSaving(false);

              const parts = [];
              if (counts.sx) parts.push(`${counts.sx} symptom${counts.sx !== 1 ? "s" : ""}`);
              if (counts.dx) parts.push(`${counts.dx} diagnos${counts.dx !== 1 ? "es" : "is"}`);
              if (counts.meds) parts.push(`${counts.meds} med${counts.meds !== 1 ? "s" : ""}`);
              if (counts.stop) parts.push(`${counts.stop} stopped`);
              if (counts.labs) parts.push(`${counts.labs} lab${counts.labs !== 1 ? "s" : ""}`);
              if (counts.vit) parts.push(`${counts.vit} vitals`);
              if (counts.inv) parts.push(`${counts.inv} test${counts.inv !== 1 ? "s" : ""}`);
              if (counts.fuw) parts.push("follow-up prep");
              if (failed.length > 0) {
                const savedMsg = parts.length ? `Saved ${parts.join(", ")}. ` : "";
                toast(`${savedMsg}Failed: ${failed.join(", ")}`, "error");
                setBulkSaveStatus({
                  phase: "failed",
                  label: `${savedMsg}Failed: ${failed.join(", ")}`,
                });
              } else {
                toast(parts.length ? `Saved: ${parts.join(", ")}` : "Nothing saved", "success");
                setBulkSaveStatus({
                  phase: "saved",
                  label: parts.length ? `Saved ${parts.join(", ")}` : "Nothing saved",
                });
                // Auto-dismiss the success chip after a few seconds; failure
                // stays sticky until the doctor acknowledges it (clicks ✕).
                setTimeout(() => setBulkSaveStatus(null), 5000);
              }
              setTimeout(() => refreshData(), 3000);
            };
            // Fire-and-forget — the modal is already closed; any error inside
            // runSave is surfaced via toast / console / chip from within.
            runSave().catch((e) => {
              console.error("Background clinical save failed:", e.message);
              setClinicalExtractSaving(false);
              toast(`Save failed: ${e.message}`, "error");
              setBulkSaveStatus({ phase: "failed", label: `Save failed: ${e.message}` });
            });
          }}
        />
      )}
      {modal?.type === "changeFollowUp" && (
        <ChangeFollowUpModal
          currentDate={consultations[0]?.con_data?.follow_up?.date || ""}
          onClose={closeModal}
          onSubmit={async (d) => {
            const r = await mutations.updateFollowUp(d);

            if (r.success) closeModal();
          }}
        />
      )}
      {modal?.type === "template" && (
        <TemplateModal templateKey={modal.data} patient={patient} onClose={closeModal} />
      )}
    </div>
  );
}
