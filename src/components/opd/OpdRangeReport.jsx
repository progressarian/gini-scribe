import React, { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import * as XLSX from "xlsx";
import { useOpdAppointmentsRange } from "../../queries/hooks/useOpdAppointmentsRange.js";
import {
  BIO_TIER,
  classifyBiomarker,
  classifyComposite,
  targetStatus,
  CHIP_COLOURS,
} from "../../utils/biomarkerClassify.js";

// ─── Theme tokens (mirror LiveDashboard for visual consistency) ──────────────
const T = "#009e8c";
const TL = "#e6f6f4";
const BG = "#f0f4f7";
const WH = "#fff";
const INK = "#1a2332";
const INK2 = "#3d4f63";
const INK3 = "#6b7d90";
const BD = "#dde3ea";
const RE = "#d94f4f";
const REL = "#fdf0f0";
const AM = "#d97a0a";
const AML = "#fef6e6";
const GN = "#15803d";
const GNL = "#edfcf0";
const FB = "'Inter',system-ui,sans-serif";
const FM = "'DM Mono',monospace";
const SH = "0 1px 3px rgba(0,0,0,.08),0 1px 2px rgba(0,0,0,.05)";

const toIso = (d) => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const da = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${da}`;
};
const fmtDate = (iso) => {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    return d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
  } catch {
    return String(iso);
  }
};

// Biomarkers shown on the period report. `tier` drives composite classification:
//   1 = headline metric (HbA1c, SBP, TSH) — drives Better/Worse verdict
//   2 = supporting (FBS, LDL, TG, UACR, eGFR) — flips Better → Mixed on conflict
//   3 = monitored only (weight, BMI, DBP) — visible but not scored
//
// `headline` = the 4 signals the client doc says belong on the period-report
// "Getting better / worse" list (HbA1c + BP + FBS + LDL). Other markers stay
// visible in the expanded per-visit table but don't crowd the row chips.
const BIOMARKERS = [
  { key: "hba1c", label: "HbA1c", unit: "%", lowerBetter: true, tier: 1, headline: true },
  { key: "sbp", label: "SBP", unit: "mmHg", lowerBetter: true, tier: 1, headline: true },
  { key: "fg", label: "Fasting Glu", unit: "mg/dL", lowerBetter: true, tier: 2, headline: true },
  { key: "ldl", label: "LDL", unit: "mg/dL", lowerBetter: true, tier: 2, headline: true },
  { key: "ppbs", label: "PPBS", unit: "mg/dL", lowerBetter: true, tier: 2 },
  { key: "hdl", label: "HDL", unit: "mg/dL", lowerBetter: false, tier: 2 },
  { key: "tg", label: "Triglycerides", unit: "mg/dL", lowerBetter: true, tier: 2 },
  { key: "weight", label: "Weight", unit: "kg", lowerBetter: true, tier: 3 },
  { key: "bmi", label: "BMI", unit: "", lowerBetter: true, tier: 3 },
  { key: "dbp", label: "DBP", unit: "mmHg", lowerBetter: true, tier: 3 },
];

// Compute date ranges for the preset buttons.
const presetRanges = () => {
  const today = new Date();
  const y = today.getFullYear();
  const m = today.getMonth();
  const startMonth = new Date(y, m, 1);
  const endMonth = new Date(y, m + 1, 0);
  const startPrevMonth = new Date(y, m - 1, 1);
  const endPrevMonth = new Date(y, m, 0);
  const startYear = new Date(y, 0, 1);
  const endYear = new Date(y, 11, 31);
  const startPrevYear = new Date(y - 1, 0, 1);
  const endPrevYear = new Date(y - 1, 11, 31);
  const start7 = new Date(today);
  start7.setDate(start7.getDate() - 6);
  const start30 = new Date(today);
  start30.setDate(start30.getDate() - 29);
  return {
    "Last 7 days": [toIso(start7), toIso(today)],
    "Last 30 days": [toIso(start30), toIso(today)],
    "This month": [toIso(startMonth), toIso(endMonth)],
    "Last month": [toIso(startPrevMonth), toIso(endPrevMonth)],
    "This year": [toIso(startYear), toIso(endYear)],
    "Last year": [toIso(startPrevYear), toIso(endPrevYear)],
  };
};

// Group appointment rows by patient and project per-biomarker series in
// chronological order. First and last numeric values become the trend
// endpoints for the period.
function groupByPatient(rows) {
  const map = new Map();
  for (const r of rows || []) {
    const key = r.patient_id || `__file_${r.file_no || r.id}`;
    if (!map.has(key)) {
      map.set(key, {
        patientId: r.patient_id,
        name: r.patient_name || "—",
        fileNo: r.file_no || "",
        phone: r.phone || "",
        age: r.age || null,
        sex: r.sex || "",
        visits: [],
      });
    }
    map.get(key).visits.push(r);
  }
  for (const v of map.values()) {
    v.visits.sort((a, b) => {
      const da = `${a.appointment_date}T${a.time_slot || "00:00"}`;
      const db = `${b.appointment_date}T${b.time_slot || "00:00"}`;
      return da.localeCompare(db);
    });
    v.firstVisit = v.visits[0];
    v.lastVisit = v.visits[v.visits.length - 1];
    v.visitCount = v.visits.length;
    v.series = {};
    for (const bm of BIOMARKERS) {
      const points = [];
      for (const a of v.visits) {
        const bio = a.biomarkers || {};
        const raw = bio[bm.key];
        const num = raw == null ? null : Number(raw);
        if (num != null && !Number.isNaN(num)) {
          points.push({ date: a.appointment_date, value: num });
        }
      }
      if (points.length > 0) {
        const first = points[0];
        const last = points[points.length - 1];
        const delta = last.value - first.value;
        // Use shared absolute-threshold classifier (HbA1c ±0.3, SBP ±5, etc.)
        // so dashboard + period report agree on what counts as "stable".
        const trendStatus =
          points.length < 2 ? "single" : classifyBiomarker(bm.key, last.value, first.value);
        v.series[bm.key] = {
          points,
          first: first.value,
          last: last.value,
          firstDate: first.date,
          lastDate: last.date,
          delta,
          status: trendStatus,
          target: targetStatus(bm.key, last.value),
          count: points.length,
        };
      }
    }
  }
  return [...map.values()].sort((a, b) => (a.name || "").localeCompare(b.name || ""));
}

const fmt = (n, digits = 1) =>
  n == null || Number.isNaN(n) ? "—" : Number(n).toFixed(digits).replace(/\.0+$/, "");

// Classify a patient using the tiered composite rule (Tier-1 drives, Tier-2
// flips Better→Mixed on conflict). Memoised onto the patient object so we
// only run the rule once per patient regardless of how many places read it.
function classifyPatient(p) {
  if (p._composite) return p._composite;
  const per = {};
  for (const bm of BIOMARKERS) {
    if (BIO_TIER[bm.key] === 3) continue;
    const s = p.series[bm.key];
    if (!s) continue;
    per[bm.key] = {
      cur: s.last,
      prev: s.count >= 2 ? s.first : null,
      status: s.count >= 2 ? s.status : "unknown",
      target: s.target,
    };
  }
  const c = classifyComposite(per);
  // "single" stays a separate UI bucket: patient with readings but no trend.
  const anyTrend = Object.values(per).some((e) => e.status !== "unknown");
  const outcome = anyTrend ? c.outcome : "single";
  const result = { outcome, reasons: c.reasons, conflicts: c.conflicts };
  p._composite = result;
  return result;
}

function summarizePatients(patients) {
  const out = {
    total: patients.length,
    better: 0,
    worse: 0,
    stable: 0,
    mixed: 0,
    single: 0,
  };
  for (const p of patients) {
    const { outcome } = classifyPatient(p);
    if (out[outcome] != null) out[outcome] += 1;
    else out.single += 1;
  }
  return out;
}

export default function OpdRangeReport({ initialStart, initialEnd, onClose }) {
  const today = toIso(new Date());
  const presets = presetRanges();
  const defaultPreset = "This month";
  const [activePreset, setActivePreset] = useState(defaultPreset);
  const [start, setStart] = useState(initialStart || presets[defaultPreset][0]);
  const [end, setEnd] = useState(initialEnd || presets[defaultPreset][1]);
  const [includeBiomarker, setIncludeBiomarker] = useState("all"); // future filter
  const [filterDoctor, setFilterDoctor] = useState("all");
  const [filterSpecialty, setFilterSpecialty] = useState("all");

  // Modal state for "Generate Report" — mirrors the outside selection on open,
  // commits back to outside state on Apply.
  const [showModal, setShowModal] = useState(false);
  const [draftPreset, setDraftPreset] = useState(activePreset);
  const [draftStart, setDraftStart] = useState(start);
  const [draftEnd, setDraftEnd] = useState(end);
  const [draftBiomarker, setDraftBiomarker] = useState(includeBiomarker);
  const [draftDoctor, setDraftDoctor] = useState(filterDoctor);
  const [draftSpecialty, setDraftSpecialty] = useState(filterSpecialty);
  const [applying, setApplying] = useState(false);
  const sawFetchingRef = useRef(false);

  const setPreset = (label) => {
    setActivePreset(label);
    const [s, e] = presets[label];
    setStart(s);
    setEnd(e);
  };

  const onCustom = (which, val) => {
    setActivePreset("Custom");
    if (which === "start") setStart(val);
    else setEnd(val);
  };

  const openModal = () => {
    setDraftPreset(activePreset);
    setDraftStart(start);
    setDraftEnd(end);
    setDraftBiomarker(includeBiomarker);
    setDraftDoctor(filterDoctor);
    setDraftSpecialty(filterSpecialty);
    setShowModal(true);
  };

  const setDraftPresetLabel = (label) => {
    setDraftPreset(label);
    const [s, e] = presets[label];
    setDraftStart(s);
    setDraftEnd(e);
  };

  const onDraftCustom = (which, val) => {
    setDraftPreset("Custom");
    if (which === "start") setDraftStart(val);
    else setDraftEnd(val);
  };

  const applyModal = () => {
    setActivePreset(draftPreset);
    setStart(draftStart);
    setEnd(draftEnd);
    setIncludeBiomarker(draftBiomarker);
    setFilterDoctor(draftDoctor);
    setFilterSpecialty(draftSpecialty);
    sawFetchingRef.current = false;
    setApplying(true);
  };

  const q = useOpdAppointmentsRange(start, end);

  // Keep the modal open with a loading state until the new range query
  // settles, so the user gets feedback that "Generate" is doing work.
  useEffect(() => {
    if (!applying) return;
    if (q.isFetching) {
      sawFetchingRef.current = true;
      return;
    }
    const t = setTimeout(
      () => {
        setShowModal(false);
        setApplying(false);
        sawFetchingRef.current = false;
      },
      sawFetchingRef.current ? 0 : 150,
    );
    return () => clearTimeout(t);
  }, [applying, q.isFetching]);
  const allRows = q.data || [];

  // Build doctor + specialty option lists from in-period rows only — history
  // visits outside the window shouldn't surface unrelated doctors/specialties.
  const { doctorOptions, specialtyOptions } = useMemo(() => {
    const docs = new Set();
    const specs = new Set();
    for (const r of allRows) {
      if (!r.in_period) continue;
      if (r.doctor_name) docs.add(r.doctor_name);
      if (r.specialty) specs.add(r.specialty);
    }
    return {
      doctorOptions: [...docs].sort((a, b) => a.localeCompare(b)),
      specialtyOptions: [...specs].sort((a, b) => a.localeCompare(b)),
    };
  }, [allRows]);

  const patientKey = (r) => r.patient_id || `__file_${r.file_no || r.id}`;

  // Patient set is scoped to the selected period (with active filters), but
  // each qualifying patient brings their *full* visit history along — that's
  // how trends get computed across more than just the current window.
  const rows = useMemo(() => {
    const qualifying = new Set();
    for (const r of allRows) {
      if (!r.in_period) continue;
      const docOk = filterDoctor === "all" || r.doctor_name === filterDoctor;
      const specOk = filterSpecialty === "all" || r.specialty === filterSpecialty;
      if (docOk && specOk) qualifying.add(patientKey(r));
    }
    return allRows.filter((r) => qualifying.has(patientKey(r)));
  }, [allRows, filterDoctor, filterSpecialty]);

  const patients = useMemo(() => groupByPatient(rows), [rows]);
  const summary = useMemo(() => summarizePatients(patients), [patients]);

  const inPeriodRows = useMemo(() => rows.filter((r) => r.in_period), [rows]);
  const totalAppts = inPeriodRows.length;
  const repeatPatients = patients.filter(
    (p) => p.visits.filter((v) => v.in_period).length > 1,
  ).length;

  const visibleBio =
    includeBiomarker === "all" ? BIOMARKERS : BIOMARKERS.filter((b) => b.key === includeBiomarker);

  const onPrint = () => {
    if (typeof window !== "undefined") window.print();
  };

  // Group patients by classification for the collapsible sections.
  const grouped = useMemo(() => {
    const g = { worse: [], mixed: [], better: [], stable: [], single: [] };
    for (const p of patients) {
      const { outcome } = classifyPatient(p);
      (g[outcome] || g.single).push(p);
    }
    return g;
  }, [patients]);

  // Collapsible section state — sections open by default, except Single Visit.
  const [openSections, setOpenSections] = useState({
    worse: true,
    mixed: true,
    better: true,
    stable: true,
    single: false,
  });
  const toggleSection = (k) => setOpenSections((prev) => ({ ...prev, [k]: !prev[k] }));

  // Per-patient collapse state — closed by default; opening reveals visit table.
  const [openPatients, setOpenPatients] = useState({});
  const togglePatient = (id) => setOpenPatients((prev) => ({ ...prev, [id]: !prev[id] }));

  // Build a flat row-per-visit dataset for export — each row carries patient
  // details + every biomarker captured at that visit.
  const buildExportRows = () => {
    const rows = [];
    for (const p of patients) {
      const { outcome: cls } = classifyPatient(p);
      const clsLabel =
        cls === "better"
          ? "Getting Better"
          : cls === "worse"
            ? "Getting Worse"
            : cls === "mixed"
              ? "Flag for review"
              : cls === "stable"
                ? "Stable"
                : "Single Visit";
      for (const v of p.visits) {
        const bio = v.biomarkers || {};
        const row = {
          "Patient Name": p.name,
          "File No": p.fileNo,
          Phone: p.phone,
          Age: p.age ?? "",
          Sex: p.sex || "",
          "Overall Trend": clsLabel,
          "Total Visits": p.visitCount,
          "Visit Date": v.appointment_date || "",
          "Time Slot": v.time_slot || "",
          "In Period": v.in_period ? "Yes" : "No",
          Doctor: v.doctor_name || "",
          Specialty: v.specialty || "",
          Status: v.status || "",
        };
        for (const bm of BIOMARKERS) {
          const raw = bio[bm.key];
          row[`${bm.label}${bm.unit ? ` (${bm.unit})` : ""}`] =
            raw == null || raw === "" ? "" : Number(raw);
        }
        rows.push(row);
      }
    }
    return rows;
  };

  const downloadName = (ext) => `opd-period-report_${start}_to_${end}.${ext}`;

  const onDownloadXlsx = () => {
    const data = buildExportRows();
    if (data.length === 0) return;
    const ws = XLSX.utils.json_to_sheet(data);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Period Report");
    XLSX.writeFile(wb, downloadName("xlsx"));
  };

  const onDownloadCsv = () => {
    const data = buildExportRows();
    if (data.length === 0) return;
    const ws = XLSX.utils.json_to_sheet(data);
    const csv = XLSX.utils.sheet_to_csv(ws);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = downloadName("csv");
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const [showDownloadMenu, setShowDownloadMenu] = useState(false);

  return (
    <div
      style={{
        padding: 14,
        fontFamily: FB,
        color: INK,
        background: BG,
        borderRadius: 10,
        border: `1px solid ${BD}`,
        marginBottom: 14,
      }}
      className="opd-range-report"
    >
      <style>{`
        @media print {
          body * { visibility: hidden; }
          .opd-range-report, .opd-range-report * { visibility: visible; }
          .opd-range-report { position: absolute; left: 0; top: 0; width: 100%; padding: 12px; }
          .opd-range-report .no-print { display: none !important; }
        }
        @keyframes opdShimmer {
          0% { background-position: -400px 0; }
          100% { background-position: 400px 0; }
        }
        .opd-shimmer {
          background: linear-gradient(90deg, #eef1f5 0%, #f8fafb 50%, #eef1f5 100%);
          background-size: 800px 100%;
          animation: opdShimmer 1.2s ease-in-out infinite;
          border-radius: 6px;
        }
        @keyframes opdrr-spin {
          to { transform: rotate(360deg); }
        }
      `}</style>

      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 10,
          flexWrap: "wrap",
          gap: 8,
        }}
      >
        <div>
          <div style={{ fontSize: 13, fontWeight: 700, letterSpacing: ".04em", color: INK }}>
            📊 PERIOD REPORT
          </div>
          <div style={{ fontSize: 11, color: INK3, marginTop: 2 }}>
            {fmtDate(start)} → {fmtDate(end)} · {totalAppts} appointments · {repeatPatients} with
            multiple visits
          </div>
        </div>
        <div
          className="no-print"
          style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}
        >
          <div style={{ position: "relative" }}>
            <button
              onClick={() => setShowDownloadMenu((s) => !s)}
              disabled={patients.length === 0}
              style={{
                padding: "6px 12px",
                borderRadius: 6,
                border: `1px solid ${BD}`,
                background: WH,
                fontSize: 11,
                fontWeight: 600,
                cursor: patients.length === 0 ? "not-allowed" : "pointer",
                color: INK2,
                opacity: patients.length === 0 ? 0.6 : 1,
              }}
            >
              ⬇ Download ▾
            </button>
            {showDownloadMenu && patients.length > 0 && (
              <div
                style={{
                  position: "absolute",
                  top: "calc(100% + 4px)",
                  right: 0,
                  background: WH,
                  border: `1px solid ${BD}`,
                  borderRadius: 6,
                  boxShadow: "0 6px 18px rgba(0,0,0,.12)",
                  zIndex: 50,
                  minWidth: 140,
                  overflow: "hidden",
                }}
              >
                <button
                  onClick={() => {
                    setShowDownloadMenu(false);
                    onDownloadXlsx();
                  }}
                  style={{
                    display: "block",
                    width: "100%",
                    padding: "8px 12px",
                    border: "none",
                    background: WH,
                    textAlign: "left",
                    fontSize: 12,
                    fontWeight: 600,
                    color: INK2,
                    cursor: "pointer",
                  }}
                >
                  📊 Excel (.xlsx)
                </button>
                <button
                  onClick={() => {
                    setShowDownloadMenu(false);
                    onDownloadCsv();
                  }}
                  style={{
                    display: "block",
                    width: "100%",
                    padding: "8px 12px",
                    border: "none",
                    borderTop: `1px solid ${BD}`,
                    background: WH,
                    textAlign: "left",
                    fontSize: 12,
                    fontWeight: 600,
                    color: INK2,
                    cursor: "pointer",
                  }}
                >
                  📄 CSV (.csv)
                </button>
              </div>
            )}
          </div>
          <button
            onClick={() => q.refetch()}
            disabled={q.isFetching}
            style={{
              padding: "6px 12px",
              borderRadius: 6,
              border: `1px solid ${BD}`,
              background: WH,
              fontSize: 11,
              fontWeight: 600,
              cursor: q.isFetching ? "wait" : "pointer",
              color: INK2,
            }}
          >
            {q.isFetching ? "Loading…" : "↻ Refresh"}
          </button>
          <button
            onClick={openModal}
            style={{
              padding: "6px 12px",
              borderRadius: 6,
              border: `1px solid ${T}`,
              background: T,
              color: WH,
              fontSize: 11,
              fontWeight: 700,
              cursor: "pointer",
            }}
          >
            📝 Configure
          </button>
          {onClose && (
            <button
              onClick={onClose}
              style={{
                padding: "6px 10px",
                borderRadius: 6,
                border: `1px solid ${BD}`,
                background: WH,
                color: INK2,
                fontSize: 13,
                fontWeight: 700,
                cursor: "pointer",
                lineHeight: 1,
              }}
              title="Close report"
            >
              ✕
            </button>
          )}
        </div>
      </div>

      <div
        className="no-print"
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 6,
          marginBottom: 10,
          alignItems: "center",
        }}
      >
        {Object.keys(presets).map((label) => {
          const isActive = activePreset === label;
          return (
            <button
              key={label}
              onClick={() => setPreset(label)}
              style={{
                padding: "5px 10px",
                borderRadius: 6,
                border: `1px solid ${isActive ? T : BD}`,
                background: isActive ? TL : WH,
                color: isActive ? T : INK2,
                fontSize: 11,
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              {label}
            </button>
          );
        })}
        {activePreset === "Custom" && (
          <span style={{ fontSize: 11, color: INK3, fontFamily: FM }}>
            {fmtDate(start)} → {fmtDate(end)}
          </span>
        )}
        {filterDoctor !== "all" && (
          <button
            onClick={() => setFilterDoctor("all")}
            title="Clear doctor filter"
            style={{
              padding: "5px 10px",
              borderRadius: 6,
              border: `1px solid ${T}`,
              background: TL,
              color: T,
              fontSize: 11,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            👨‍⚕️ {filterDoctor} ✕
          </button>
        )}
        {filterSpecialty !== "all" && (
          <button
            onClick={() => setFilterSpecialty("all")}
            title="Clear specialty filter"
            style={{
              padding: "5px 10px",
              borderRadius: 6,
              border: `1px solid ${T}`,
              background: TL,
              color: T,
              fontSize: 11,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            🏷 {filterSpecialty} ✕
          </button>
        )}
      </div>

      {showModal && (
        <div
          className="no-print"
          onClick={() => setShowModal(false)}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,.45)",
            zIndex: 1000,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 16,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: WH,
              borderRadius: 10,
              border: `1px solid ${BD}`,
              boxShadow: "0 10px 30px rgba(0,0,0,.2)",
              width: "100%",
              maxWidth: 520,
              padding: 18,
              fontFamily: FB,
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                marginBottom: 12,
              }}
            >
              <div>
                <div style={{ fontSize: 14, fontWeight: 800, color: INK }}>📝 Generate Report</div>
                <div style={{ fontSize: 10, color: INK3, marginTop: 2 }}>
                  Tiered composite classifier · headline signals: HbA1c · BP · FBS · LDL
                </div>
              </div>
              <button
                onClick={() => setShowModal(false)}
                style={{
                  background: "none",
                  border: "none",
                  cursor: "pointer",
                  fontSize: 16,
                  color: INK3,
                }}
              >
                ✕
              </button>
            </div>

            <div
              style={{
                background: BG,
                border: `1px solid ${BD}`,
                borderRadius: 8,
                padding: "8px 10px",
                marginBottom: 12,
                fontSize: 10,
                color: INK2,
                lineHeight: 1.5,
              }}
            >
              <div style={{ fontWeight: 800, color: INK, marginBottom: 4, letterSpacing: ".03em" }}>
                What you'll get
              </div>
              <div>
                <span style={{ color: GN, fontWeight: 700 }}>Better</span> · Tier 1 improving and
                Tier 2 not worsening
              </div>
              <div>
                <span style={{ color: AM, fontWeight: 700 }}>⚠ Flag for review</span> · Tier 1
                improving but a Tier 2 marker conflicts (e.g. HbA1c ↓ but FBS ↑)
              </div>
              <div>
                <span style={{ color: RE, fontWeight: 700 }}>Worse</span> · Tier 1 worsening, or
                both Tier 1 and Tier 2 worsening
              </div>
              <div>
                <span style={{ color: INK3, fontWeight: 700 }}>Stable</span> · Tier 1 within ±0.3%
                (HbA1c) / ±5 mmHg (SBP) of last visit
              </div>
              <div style={{ marginTop: 4, color: INK3 }}>
                Each chip is colour-coded vs. clinical target — green at target, amber borderline,
                red outside. Trend arrow alone is not enough (e.g. 11% → 10.8% is still red).
              </div>
            </div>

            <div style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: INK2, marginBottom: 6 }}>
                Date Range
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {Object.keys(presets).map((label) => {
                  const isActive = draftPreset === label;
                  return (
                    <button
                      key={label}
                      onClick={() => setDraftPresetLabel(label)}
                      style={{
                        padding: "5px 10px",
                        borderRadius: 6,
                        border: `1px solid ${isActive ? T : BD}`,
                        background: isActive ? TL : WH,
                        color: isActive ? T : INK2,
                        fontSize: 11,
                        fontWeight: 600,
                        cursor: "pointer",
                      }}
                    >
                      {label}
                    </button>
                  );
                })}
              </div>
            </div>

            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                gap: 10,
                marginBottom: 12,
              }}
            >
              <div>
                <label
                  style={{
                    fontSize: 11,
                    color: INK2,
                    fontWeight: 700,
                    display: "block",
                    marginBottom: 4,
                  }}
                >
                  From
                </label>
                <input
                  type="date"
                  value={draftStart}
                  max={draftEnd || today}
                  onChange={(e) => onDraftCustom("start", e.target.value)}
                  style={{
                    width: "100%",
                    padding: "6px 8px",
                    borderRadius: 6,
                    border: `1px solid ${BD}`,
                    fontFamily: FM,
                    fontSize: 12,
                    boxSizing: "border-box",
                  }}
                />
              </div>
              <div>
                <label
                  style={{
                    fontSize: 11,
                    color: INK2,
                    fontWeight: 700,
                    display: "block",
                    marginBottom: 4,
                  }}
                >
                  To
                </label>
                <input
                  type="date"
                  value={draftEnd}
                  min={draftStart}
                  max={today}
                  onChange={(e) => onDraftCustom("end", e.target.value)}
                  style={{
                    width: "100%",
                    padding: "6px 8px",
                    borderRadius: 6,
                    border: `1px solid ${BD}`,
                    fontFamily: FM,
                    fontSize: 12,
                    boxSizing: "border-box",
                  }}
                />
              </div>
            </div>

            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                gap: 10,
                marginBottom: 12,
              }}
            >
              <div>
                <label
                  style={{
                    fontSize: 11,
                    color: INK2,
                    fontWeight: 700,
                    display: "block",
                    marginBottom: 4,
                  }}
                >
                  Doctor
                </label>
                <select
                  value={draftDoctor}
                  onChange={(e) => setDraftDoctor(e.target.value)}
                  style={{
                    width: "100%",
                    padding: "6px 8px",
                    borderRadius: 6,
                    border: `1px solid ${BD}`,
                    fontFamily: FB,
                    fontSize: 12,
                    boxSizing: "border-box",
                  }}
                >
                  <option value="all">All doctors</option>
                  {doctorOptions.map((d) => (
                    <option key={d} value={d}>
                      {d}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label
                  style={{
                    fontSize: 11,
                    color: INK2,
                    fontWeight: 700,
                    display: "block",
                    marginBottom: 4,
                  }}
                >
                  Specialty
                </label>
                <select
                  value={draftSpecialty}
                  onChange={(e) => setDraftSpecialty(e.target.value)}
                  style={{
                    width: "100%",
                    padding: "6px 8px",
                    borderRadius: 6,
                    border: `1px solid ${BD}`,
                    fontFamily: FB,
                    fontSize: 12,
                    boxSizing: "border-box",
                  }}
                >
                  <option value="all">All specialties</option>
                  {specialtyOptions.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div style={{ marginBottom: 14 }}>
              <label
                style={{
                  fontSize: 11,
                  color: INK2,
                  fontWeight: 700,
                  display: "block",
                  marginBottom: 4,
                }}
              >
                Biomarker (filter expanded table)
              </label>
              <select
                value={draftBiomarker}
                onChange={(e) => setDraftBiomarker(e.target.value)}
                style={{
                  width: "100%",
                  padding: "6px 8px",
                  borderRadius: 6,
                  border: `1px solid ${BD}`,
                  fontFamily: FB,
                  fontSize: 12,
                  boxSizing: "border-box",
                }}
              >
                <option value="all">All (HbA1c · BP · FBS · LDL · TG · HDL · UACR · weight)</option>
                {BIOMARKERS.map((b) => (
                  <option key={b.key} value={b.key}>
                    {b.label} · Tier {b.tier}
                    {b.headline ? " · headline" : ""}
                  </option>
                ))}
              </select>
            </div>

            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <button
                onClick={() => setShowModal(false)}
                disabled={applying}
                style={{
                  padding: "8px 14px",
                  borderRadius: 6,
                  border: `1px solid ${BD}`,
                  background: WH,
                  color: INK2,
                  fontSize: 12,
                  fontWeight: 600,
                  cursor: applying ? "not-allowed" : "pointer",
                  opacity: applying ? 0.6 : 1,
                }}
              >
                Cancel
              </button>
              <button
                onClick={applyModal}
                disabled={applying}
                style={{
                  padding: "8px 14px",
                  borderRadius: 6,
                  border: `1px solid ${T}`,
                  background: T,
                  color: WH,
                  fontSize: 12,
                  fontWeight: 700,
                  cursor: applying ? "default" : "pointer",
                  opacity: applying ? 0.85 : 1,
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 8,
                }}
              >
                {applying && (
                  <span
                    aria-hidden
                    style={{
                      width: 12,
                      height: 12,
                      border: "2px solid rgba(255,255,255,0.45)",
                      borderTopColor: WH,
                      borderRadius: "50%",
                      display: "inline-block",
                      animation: "opdrr-spin 0.7s linear infinite",
                    }}
                  />
                )}
                {applying ? "Generating…" : "Generate"}
              </button>
            </div>
          </div>
        </div>
      )}

      {q.isError && (
        <div
          style={{
            padding: 10,
            borderRadius: 6,
            background: REL,
            border: `1px solid ${RE}`,
            color: RE,
            fontSize: 12,
            marginBottom: 10,
          }}
        >
          Failed to load: {q.error?.message || "Unknown error"}
        </div>
      )}

      {/* Patient-level summary cards */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
          gap: 8,
          marginBottom: 14,
        }}
      >
        {[
          { label: "Total Appointments", value: totalAppts, color: INK, bg: WH, border: BD },
          { label: "Getting Better", value: summary.better, color: GN, bg: GNL, border: GN },
          { label: "Stable", value: summary.stable, color: INK3, bg: BG, border: BD },
          { label: "⚠ Flag for review", value: summary.mixed, color: AM, bg: AML, border: AM },
          { label: "Getting Worse", value: summary.worse, color: RE, bg: REL, border: RE },
          { label: "Single Visit", value: summary.single, color: INK3, bg: BG, border: BD },
        ].map((c) => (
          <div
            key={c.label}
            style={{
              background: c.bg,
              border: `1px solid ${c.border}`,
              borderRadius: 8,
              padding: 12,
              boxShadow: SH,
              textAlign: "center",
            }}
          >
            <div style={{ fontSize: 24, fontWeight: 800, color: c.color, fontFamily: FM }}>
              {c.value}
            </div>
            <div
              style={{
                fontSize: 10,
                fontWeight: 700,
                color: c.color,
                marginTop: 2,
                letterSpacing: ".04em",
                textTransform: "uppercase",
              }}
            >
              {c.label}
            </div>
          </div>
        ))}
      </div>

      {/* Per-patient detail — grouped by trend, collapsible at every level */}
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {q.isPending ? (
          <ShimmerList />
        ) : patients.length === 0 ? (
          <div
            style={{
              padding: 14,
              color: INK3,
              background: WH,
              border: `1px solid ${BD}`,
              borderRadius: 8,
            }}
          >
            No appointments in this period.
          </div>
        ) : (
          [
            { key: "worse", label: "Getting Worse", color: RE, bg: REL, icon: "📉" },
            { key: "mixed", label: "⚠ Flag for review", color: AM, bg: AML, icon: "⚠" },
            { key: "stable", label: "Stable", color: INK3, bg: BG, icon: "➖" },
            { key: "better", label: "Getting Better", color: GN, bg: GNL, icon: "📈" },
            { key: "single", label: "Single Visit", color: INK3, bg: BG, icon: "•" },
          ].map((sec) => {
            const list = grouped[sec.key] || [];
            // Single-visit (no trend) bucket is hidden when empty — it's noise.
            // The 4 outcome buckets always render so the report layout stays
            // consistent with the dashboard, even on quiet days.
            if (sec.key === "single" && list.length === 0) return null;
            const isOpen = !!openSections[sec.key];
            return (
              <div
                key={sec.key}
                style={{
                  background: WH,
                  border: `1px solid ${sec.color}`,
                  borderRadius: 8,
                  boxShadow: SH,
                  overflow: "hidden",
                }}
              >
                <button
                  onClick={() => toggleSection(sec.key)}
                  style={{
                    width: "100%",
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    padding: "10px 12px",
                    background: sec.bg,
                    border: "none",
                    borderBottom: isOpen ? `1px solid ${BD}` : "none",
                    cursor: "pointer",
                    textAlign: "left",
                  }}
                >
                  <span style={{ fontSize: 14 }}>{sec.icon}</span>
                  <span
                    style={{
                      fontSize: 12,
                      fontWeight: 800,
                      color: sec.color,
                      letterSpacing: ".04em",
                      textTransform: "uppercase",
                      flex: 1,
                    }}
                  >
                    {sec.label}
                  </span>
                  <span
                    style={{
                      padding: "2px 8px",
                      borderRadius: 10,
                      fontSize: 11,
                      fontWeight: 700,
                      background: WH,
                      color: sec.color,
                      border: `1px solid ${sec.color}`,
                      fontFamily: FM,
                    }}
                  >
                    {list.length}
                  </span>
                  <span style={{ fontSize: 12, color: sec.color, fontWeight: 700 }}>
                    {isOpen ? "▾" : "▸"}
                  </span>
                </button>
                {isOpen && list.length === 0 && (
                  <div
                    style={{
                      padding: "12px 14px",
                      fontSize: 11,
                      color: INK3,
                      background: WH,
                    }}
                  >
                    No patients in this state in this period.
                  </div>
                )}
                {isOpen && list.length > 0 && (
                  <div
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      gap: 0,
                      background: WH,
                    }}
                  >
                    {list.map((p, i) => {
                      const pid = p.patientId || `${sec.key}_${i}`;
                      const isPOpen = !!openPatients[pid];
                      return (
                        <PatientCard
                          key={pid}
                          p={p}
                          isOpen={isPOpen}
                          onToggle={() => togglePatient(pid)}
                          visibleBio={visibleBio}
                          sectionColor={sec.color}
                          sectionBg={sec.bg}
                          sectionLabel={sec.label}
                        />
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

// Shimmer placeholder shown while range data loads.
function ShimmerList() {
  return (
    <>
      {[0, 1, 2].map((i) => (
        <div
          key={i}
          style={{
            background: WH,
            border: `1px solid ${BD}`,
            borderRadius: 8,
            padding: 12,
            boxShadow: SH,
          }}
        >
          <div className="opd-shimmer" style={{ height: 14, width: "40%", marginBottom: 8 }} />
          <div className="opd-shimmer" style={{ height: 10, width: "70%", marginBottom: 14 }} />
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {[0, 1, 2, 3, 4].map((j) => (
              <div key={j} className="opd-shimmer" style={{ height: 22, width: 90 }} />
            ))}
          </div>
        </div>
      ))}
    </>
  );
}

// One patient row inside a section — collapsed shows trend chips, expanded
// shows the full visit table.
// Per-condition outcome — shows "Diabetes ✓ / BP ⚠ / Thyroid ✗" style chips
// so a doctor can see at-a-glance which condition is fine and which needs
// attention. We don't collapse to one verdict because Scenario 3 in the
// brief explicitly says "Cannot call this patient improving overall — show
// per-condition outcome".
function perConditionOutcomes(p) {
  const conditions = [
    { key: "dm", label: "Diabetes", t1: "hba1c", t2: ["fg", "ppbs"] },
    { key: "htn", label: "BP", t1: "sbp", t2: [] },
    { key: "thy", label: "Thyroid", t1: "tsh", t2: [] },
    { key: "lipid", label: "Lipids", t1: "ldl", t2: ["tg", "hdl"] },
    { key: "kidney", label: "Kidney", t1: "uacr", t2: ["egfr"] },
  ];
  const out = [];
  for (const c of conditions) {
    const t1Series = p.series[c.t1];
    if (!t1Series) continue; // condition not measured for this patient
    const per = {};
    per[c.t1] = {
      cur: t1Series.last,
      prev: t1Series.count >= 2 ? t1Series.first : null,
      status: t1Series.count >= 2 ? t1Series.status : "unknown",
      target: t1Series.target,
    };
    for (const k of c.t2) {
      const s = p.series[k];
      if (!s) continue;
      per[k] = {
        cur: s.last,
        prev: s.count >= 2 ? s.first : null,
        status: s.count >= 2 ? s.status : "unknown",
        target: s.target,
      };
    }
    const cls = classifyComposite(per);
    out.push({
      label: c.label,
      outcome: cls.outcome,
      reason: cls.reasons[0] || cls.conflicts[0] || "",
    });
  }
  return out;
}

function PatientCard({ p, isOpen, onToggle, visibleBio, sectionColor, sectionBg, sectionLabel }) {
  const navigate = useNavigate();
  const composite = useMemo(() => classifyPatient(p), [p]);
  const conditions = useMemo(() => perConditionOutcomes(p), [p]);
  // Build the /visit deep-link from the patient's most recent visit. Without
  // a patient_id there's no useful target, so the button stays disabled.
  const visitHref = p.patientId
    ? `/visit?patient=${encodeURIComponent(p.patientId)}${
        p.lastVisit?.id ? `&appt=${encodeURIComponent(p.lastVisit.id)}` : ""
      }`
    : null;
  const openVisit = (e) => {
    e.stopPropagation();
    if (!visitHref) {
      e.preventDefault();
      return;
    }
    // Cmd/Ctrl/Shift-click and middle-click → let the browser open a new tab.
    const newTab = e.metaKey || e.ctrlKey || e.shiftKey || e.button === 1;
    if (newTab) return;
    e.preventDefault();
    navigate(visitHref);
  };
  // Group chips by tier so the reader can see which markers are headline (T1)
  // vs supporting (T2) vs monitored (T3). Also collect "why" reasons —
  // every biomarker that drove the verdict, not just one.
  // Per the client brief: the period-report row only carries the four
  // headline signals (HbA1c + SBP + FBS + LDL). Anything else stays in the
  // expanded per-visit table so the row doesn't get noisy.
  const { tieredChips, whyReasons } = useMemo(() => {
    const tiered = { 1: [], 2: [], 3: [] };
    const why = [];
    for (const bm of BIOMARKERS) {
      if (!bm.headline) continue;
      const s = p.series[bm.key];
      if (!s) continue;
      const arrow =
        s.status === "better"
          ? "▼"
          : s.status === "worse"
            ? "▲"
            : s.status === "stable"
              ? "→"
              : "•";
      // Chip colour reflects clinical target (green=at target, amber=borderline,
      // red=outside) — trend arrow alone is misleading: 11%→10.8% is improving
      // but still critical, so the chip stays red.
      const tgt = s.target || "unknown";
      const palette = CHIP_COLOURS[tgt] || CHIP_COLOURS.unknown;
      const txt =
        s.count >= 2
          ? `${bm.label}: ${fmt(s.first)}→${fmt(s.last)} ${arrow}`
          : `${bm.label}: ${fmt(s.last)}`;
      const tier = bm.tier || BIO_TIER[bm.key] || 3;
      tiered[tier].push({
        key: bm.key,
        txt,
        color: palette.fg,
        bg: palette.bg,
        border: palette.border,
        tier,
      });
      // Build a per-marker "why" line for any non-stable Tier-1/Tier-2 marker
      // or any Tier-1/Tier-2 currently outside target.
      if (tier <= 2 && (s.status === "worse" || s.status === "better" || tgt === "bad")) {
        const verb =
          s.status === "worse" ? "rising" : s.status === "better" ? "improving" : "outside target";
        const tgtNote = tgt === "bad" ? " · outside target" : tgt === "warn" ? " · borderline" : "";
        why.push({
          tier,
          status: s.status,
          target: tgt,
          text:
            s.count >= 2
              ? `T${tier} · ${bm.label} ${verb} (${fmt(s.first)} → ${fmt(s.last)}${
                  bm.unit ? " " + bm.unit : ""
                })${tgtNote}`
              : `T${tier} · ${bm.label} ${fmt(s.last)}${bm.unit ? " " + bm.unit : ""}${tgtNote}`,
        });
      }
    }
    return { tieredChips: tiered, whyReasons: why };
  }, [p]);

  return (
    <div style={{ borderTop: `1px solid ${BD}` }}>
      <div
        role="button"
        tabIndex={0}
        onClick={onToggle}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onToggle?.();
          }
        }}
        style={{
          width: "100%",
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "10px 12px",
          background: WH,
          border: "none",
          borderBottom: isOpen ? `1px solid ${BD}` : "none",
          cursor: "pointer",
          textAlign: "left",
          flexWrap: "wrap",
          boxSizing: "border-box",
        }}
      >
        <div style={{ flex: 1, minWidth: 180 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: INK }}>{p.name}</div>
          <div style={{ fontSize: 10, color: INK3, marginTop: 2 }}>
            {p.fileNo ? `#${p.fileNo}` : ""}
            {p.age ? ` · ${p.age}${(p.sex || "").charAt(0).toUpperCase()}` : ""}
            {p.phone ? ` · ${p.phone}` : ""}
          </div>
        </div>
        <div style={{ fontSize: 10, color: INK3, fontFamily: FM }}>
          {p.visitCount} visit{p.visitCount === 1 ? "" : "s"}
          {(() => {
            const inP = p.visits.filter((v) => v.in_period).length;
            return inP && inP !== p.visitCount ? ` · ${inP} in period` : "";
          })()}{" "}
          · {fmtDate(p.firstVisit?.appointment_date)} → {fmtDate(p.lastVisit?.appointment_date)}
        </div>
        {visitHref && (
          <a
            href={visitHref}
            onClick={openVisit}
            onAuxClick={openVisit}
            title="Open patient visit (Ctrl/Cmd-click for new tab)"
            style={{
              fontSize: 10,
              fontWeight: 700,
              color: T,
              textDecoration: "none",
              padding: "4px 8px",
              borderRadius: 5,
              border: `1px solid ${T}`,
              background: TL,
              marginLeft: 4,
              fontFamily: FB,
              whiteSpace: "nowrap",
            }}
          >
            Open visit ↗
          </a>
        )}
        <span style={{ fontSize: 13, color: sectionColor, fontWeight: 700, marginLeft: 4 }}>
          {isOpen ? "▾" : "▸"}
        </span>
      </div>

      {/* Table renders before the chip summary when expanded so the operator
          scans full visit history first, then the headline trend below. */}
      {isOpen && (
        <div style={{ overflow: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
            <thead>
              <tr style={{ background: sectionBg, color: INK2, textAlign: "left" }}>
                <th style={{ padding: "6px 10px", fontWeight: 700, whiteSpace: "nowrap" }}>
                  Visit Date
                </th>
                {visibleBio.map((bm) => {
                  const tier = bm.tier || BIO_TIER[bm.key] || 3;
                  const tierBg = tier === 1 ? GNL : tier === 2 ? AML : BG;
                  const tierFg = tier === 1 ? GN : tier === 2 ? AM : INK3;
                  return (
                    <th
                      key={bm.key}
                      style={{ padding: "6px 6px", fontWeight: 700, textAlign: "center" }}
                    >
                      <div
                        style={{
                          display: "flex",
                          flexDirection: "column",
                          alignItems: "center",
                          gap: 2,
                        }}
                      >
                        <span>{bm.label}</span>
                        <span
                          style={{
                            fontSize: 8,
                            fontWeight: 800,
                            padding: "1px 5px",
                            borderRadius: 6,
                            background: tierBg,
                            color: tierFg,
                            border: `1px solid ${tierFg}`,
                            letterSpacing: ".04em",
                          }}
                        >
                          T{tier}
                        </span>
                        {bm.unit ? (
                          <span style={{ fontSize: 9, color: INK3, fontWeight: 500 }}>
                            {bm.unit}
                          </span>
                        ) : null}
                      </div>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {p.visits.map((v, vi) => {
                const bio = v.biomarkers || {};
                return (
                  <tr
                    key={v.id || vi}
                    style={{
                      borderTop: `1px solid ${BD}`,
                      background: vi % 2 ? BG : WH,
                      opacity: v.in_period ? 1 : 0.7,
                    }}
                  >
                    <td
                      style={{
                        padding: "6px 10px",
                        fontFamily: FM,
                        color: INK2,
                        whiteSpace: "nowrap",
                      }}
                    >
                      {fmtDate(v.appointment_date)}
                      {v.time_slot ? (
                        <span style={{ color: INK3, marginLeft: 4 }}>{v.time_slot}</span>
                      ) : null}
                      {v.in_period ? (
                        <span
                          style={{
                            marginLeft: 6,
                            padding: "1px 6px",
                            borderRadius: 8,
                            fontSize: 9,
                            fontWeight: 700,
                            background: sectionBg,
                            color: sectionColor,
                            border: `1px solid ${sectionColor}`,
                          }}
                        >
                          PERIOD
                        </span>
                      ) : null}
                    </td>
                    {visibleBio.map((bm) => {
                      const raw = bio[bm.key];
                      const num = raw == null ? null : Number(raw);
                      const has = num != null && !Number.isNaN(num);
                      return (
                        <td
                          key={bm.key}
                          style={{
                            padding: "6px 6px",
                            textAlign: "center",
                            fontFamily: FM,
                            color: has ? INK : INK3,
                          }}
                        >
                          {has ? fmt(num) : "—"}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {(tieredChips[1].length || tieredChips[2].length || tieredChips[3].length) > 0 && (
        <div
          style={{
            padding: "0 12px 10px",
            display: "flex",
            flexDirection: "column",
            gap: 6,
            background: WH,
          }}
        >
          {conditions.length > 0 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
              <span
                style={{
                  fontSize: 9,
                  fontWeight: 800,
                  color: INK3,
                  letterSpacing: ".05em",
                  textTransform: "uppercase",
                  minWidth: 92,
                }}
              >
                Per condition
              </span>
              {conditions.map((c) => {
                const palette =
                  c.outcome === "better"
                    ? { bg: GNL, fg: GN, sym: "✓" }
                    : c.outcome === "worse"
                      ? { bg: REL, fg: RE, sym: "✗" }
                      : c.outcome === "mixed"
                        ? { bg: AML, fg: AM, sym: "⚠" }
                        : c.outcome === "stable"
                          ? { bg: BG, fg: INK3, sym: "→" }
                          : { bg: BG, fg: INK3, sym: "•" };
                return (
                  <span
                    key={c.label}
                    title={c.reason}
                    style={{
                      padding: "3px 8px",
                      borderRadius: 12,
                      fontSize: 10,
                      fontWeight: 700,
                      background: palette.bg,
                      color: palette.fg,
                      border: `1px solid ${palette.fg}`,
                    }}
                  >
                    {c.label} {palette.sym}
                  </span>
                );
              })}
            </div>
          )}
          {[1, 2, 3].map((tier) => {
            const list = tieredChips[tier];
            if (!list.length) return null;
            const tierLabel =
              tier === 1
                ? "Tier 1 · Headline"
                : tier === 2
                  ? "Tier 2 · Supporting"
                  : "Tier 3 · Monitored";
            return (
              <div
                key={tier}
                style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}
              >
                <span
                  style={{
                    fontSize: 9,
                    fontWeight: 800,
                    color: INK3,
                    letterSpacing: ".05em",
                    textTransform: "uppercase",
                    minWidth: 92,
                  }}
                >
                  {tierLabel}
                </span>
                {list.map((c) => (
                  <span
                    key={c.key}
                    style={{
                      padding: "3px 8px",
                      borderRadius: 12,
                      fontSize: 10,
                      fontWeight: 700,
                      background: c.bg,
                      color: c.color,
                      border: `1px solid ${c.border}`,
                      fontFamily: FM,
                    }}
                  >
                    {c.txt}
                  </span>
                ))}
              </div>
            );
          })}
          {(composite.outcome === "mixed" || composite.outcome === "worse") && (
            <div
              style={{
                fontSize: 10,
                color: composite.outcome === "worse" ? RE : AM,
                fontWeight: 600,
                background: composite.outcome === "worse" ? REL : AML,
                padding: "6px 8px",
                borderRadius: 6,
                border: `1px solid ${composite.outcome === "worse" ? RE : AM}`,
                display: "flex",
                flexDirection: "column",
                gap: 3,
              }}
            >
              <div style={{ fontWeight: 800, letterSpacing: ".03em" }}>
                {composite.outcome === "mixed"
                  ? "⚠ Why mixed:"
                  : composite.outcome === "worse"
                    ? "Why getting worse:"
                    : "Why:"}
              </div>
              {whyReasons.map((r, i) => (
                <div key={i}>• {r.text}</div>
              ))}
              {composite.conflicts.map((c, i) => (
                <div key={`c${i}`} style={{ fontStyle: "italic", opacity: 0.85 }}>
                  ↳ {c}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
