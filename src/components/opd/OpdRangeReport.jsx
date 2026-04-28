import React, { useMemo, useState } from "react";
import * as XLSX from "xlsx";
import { useOpdAppointmentsRange } from "../../queries/hooks/useOpdAppointmentsRange.js";

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

// Each biomarker: lower-is-better flag and human label.
const BIOMARKERS = [
  { key: "hba1c", label: "HbA1c", unit: "%", lowerBetter: true },
  { key: "fg", label: "Fasting Glu", unit: "mg/dL", lowerBetter: true },
  { key: "ppbs", label: "PPBS", unit: "mg/dL", lowerBetter: true },
  { key: "ldl", label: "LDL", unit: "mg/dL", lowerBetter: true },
  { key: "hdl", label: "HDL", unit: "mg/dL", lowerBetter: false },
  { key: "tg", label: "Triglycerides", unit: "mg/dL", lowerBetter: true },
  { key: "weight", label: "Weight", unit: "kg", lowerBetter: true },
  { key: "bmi", label: "BMI", unit: "", lowerBetter: true },
  { key: "sbp", label: "SBP", unit: "mmHg", lowerBetter: true },
  { key: "dbp", label: "DBP", unit: "mmHg", lowerBetter: true },
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
        const better = bm.lowerBetter ? delta < 0 : delta > 0;
        const worse = bm.lowerBetter ? delta > 0 : delta < 0;
        v.series[bm.key] = {
          points,
          first: first.value,
          last: last.value,
          firstDate: first.date,
          lastDate: last.date,
          delta,
          status: points.length < 2 ? "single" : better ? "better" : worse ? "worse" : "stable",
          count: points.length,
        };
      }
    }
  }
  return [...map.values()].sort((a, b) => (a.name || "").localeCompare(b.name || ""));
}

const fmt = (n, digits = 1) =>
  n == null || Number.isNaN(n) ? "—" : Number(n).toFixed(digits).replace(/\.0+$/, "");

// Classify a patient overall by counting their biomarker trend statuses.
// "single" means the patient has no biomarker with ≥2 readings (cannot trend).
function classifyPatient(p) {
  let better = 0,
    worse = 0,
    stable = 0;
  for (const bm of BIOMARKERS) {
    const s = p.series[bm.key];
    if (!s || s.count < 2) continue;
    if (s.status === "better") better += 1;
    else if (s.status === "worse") worse += 1;
    else stable += 1;
  }
  if (better + worse + stable === 0) return "single";
  if (better > worse) return "better";
  if (worse > better) return "worse";
  return "stable";
}

function summarizePatients(patients) {
  const out = { total: patients.length, better: 0, worse: 0, stable: 0, single: 0 };
  for (const p of patients) {
    const k = classifyPatient(p);
    out[k] += 1;
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
    setShowModal(false);
  };

  const q = useOpdAppointmentsRange(start, end);
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
  const totalPatients = patients.length;
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
    const g = { worse: [], better: [], stable: [], single: [] };
    for (const p of patients) {
      const k = classifyPatient(p);
      g[k].push(p);
    }
    return g;
  }, [patients]);

  // Collapsible section state — sections open by default, except Single Visit.
  const [openSections, setOpenSections] = useState({
    worse: true,
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
      const cls = classifyPatient(p);
      const clsLabel =
        cls === "better"
          ? "Getting Better"
          : cls === "worse"
            ? "Getting Worse"
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
            {fmtDate(start)} → {fmtDate(end)} · {totalPatients} patients · {totalAppts} visits ·{" "}
            {repeatPatients} with multiple visits
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
              <div style={{ fontSize: 14, fontWeight: 800, color: INK }}>📝 Generate Report</div>
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
                Biomarker
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
                <option value="all">All</option>
                {BIOMARKERS.map((b) => (
                  <option key={b.key} value={b.key}>
                    {b.label}
                  </option>
                ))}
              </select>
            </div>

            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <button
                onClick={() => setShowModal(false)}
                style={{
                  padding: "8px 14px",
                  borderRadius: 6,
                  border: `1px solid ${BD}`,
                  background: WH,
                  color: INK2,
                  fontSize: 12,
                  fontWeight: 600,
                  cursor: "pointer",
                }}
              >
                Cancel
              </button>
              <button
                onClick={applyModal}
                style={{
                  padding: "8px 14px",
                  borderRadius: 6,
                  border: `1px solid ${T}`,
                  background: T,
                  color: WH,
                  fontSize: 12,
                  fontWeight: 700,
                  cursor: "pointer",
                }}
              >
                Generate
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
          { label: "Total Patients", value: summary.total, color: INK, bg: WH, border: BD },
          { label: "Getting Better", value: summary.better, color: GN, bg: GNL, border: GN },
          { label: "Stable", value: summary.stable, color: INK3, bg: BG, border: BD },
          { label: "Getting Worse", value: summary.worse, color: RE, bg: REL, border: RE },
          { label: "Single Visit", value: summary.single, color: AM, bg: AML, border: AM },
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
            { key: "better", label: "Getting Better", color: GN, bg: GNL, icon: "📈" },
            { key: "stable", label: "Stable", color: INK3, bg: BG, icon: "➖" },
            { key: "single", label: "Single Visit", color: AM, bg: AML, icon: "•" },
          ].map((sec) => {
            const list = grouped[sec.key];
            if (!list || list.length === 0) return null;
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
                {isOpen && (
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
function PatientCard({ p, isOpen, onToggle, visibleBio, sectionColor, sectionBg, sectionLabel }) {
  const trendChips = useMemo(() => {
    const chips = [];
    for (const bm of BIOMARKERS) {
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
      const color =
        s.status === "better" ? GN : s.status === "worse" ? RE : s.status === "stable" ? INK3 : AM;
      const bg =
        s.status === "better" ? GNL : s.status === "worse" ? REL : s.status === "stable" ? BG : AML;
      const txt =
        s.count >= 2
          ? `${bm.label}: ${fmt(s.first)}→${fmt(s.last)} ${arrow}`
          : `${bm.label}: ${fmt(s.last)}`;
      chips.push({ key: bm.key, txt, color, bg });
    }
    return chips;
  }, [p]);

  return (
    <div style={{ borderTop: `1px solid ${BD}` }}>
      <button
        onClick={onToggle}
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
        <span style={{ fontSize: 13, color: sectionColor, fontWeight: 700, marginLeft: 4 }}>
          {isOpen ? "▾" : "▸"}
        </span>
      </button>

      {!isOpen && trendChips.length > 0 && (
        <div
          style={{
            padding: "0 12px 10px",
            display: "flex",
            flexWrap: "wrap",
            gap: 6,
            background: WH,
          }}
        >
          {trendChips.map((c) => (
            <span
              key={c.key}
              style={{
                padding: "3px 8px",
                borderRadius: 12,
                fontSize: 10,
                fontWeight: 700,
                background: c.bg,
                color: c.color,
                border: `1px solid ${c.color}`,
                fontFamily: FM,
              }}
            >
              {c.txt}
            </span>
          ))}
        </div>
      )}

      {isOpen && (
        <div style={{ overflow: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
            <thead>
              <tr style={{ background: sectionBg, color: INK2, textAlign: "left" }}>
                <th style={{ padding: "6px 10px", fontWeight: 700, whiteSpace: "nowrap" }}>
                  Visit Date
                </th>
                {visibleBio.map((bm) => (
                  <th
                    key={bm.key}
                    style={{ padding: "6px 6px", fontWeight: 700, textAlign: "center" }}
                  >
                    {bm.label}
                    {bm.unit ? (
                      <div style={{ fontSize: 9, color: INK3, fontWeight: 500 }}>{bm.unit}</div>
                    ) : null}
                  </th>
                ))}
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
    </div>
  );
}
