import { memo, useState } from "react";

// ── Lab alias map for fuzzy-matching test names ──
export const LAB_ALIASES = {
  HbA1c: ["HbA1c", "Glycated Hemoglobin", "A1c", "Glycated Haemoglobin", "HBA1C"],
  FBS: [
    "FBS",
    "Fasting Glucose",
    "Fasting Blood Sugar",
    "FPG",
    "Fasting Plasma Glucose",
    "FASTING BLOOD SUGAR",
  ],
  LDL: ["LDL", "LDL Cholesterol", "LDL-C", "LDL CHOLESTEROL-DIRECT"],
  TG: ["TG", "Triglycerides", "TRIGLYCERIDES"],
  Creatinine: ["Creatinine", "S.Creatinine", "Serum Creatinine", "CREATININE"],
  eGFR: ["eGFR", "GFR", "Estimated GFR"],
  TSH: ["TSH", "Thyroid Stimulating Hormone", "THYROID STIMULATING HORMONE"],
  Haemoglobin: ["Haemoglobin", "Hemoglobin", "Hb", "HB", "HAEMOGLOBIN"],
  Weight: ["Weight"],
  "Body Fat": ["Body Fat", "Body Fat %"],
  Waist: ["Waist", "Waist Circumference"],
  "HOMA-IR": ["HOMA-IR", "HOMA IR", "Homeostatic Model Assessment"],
  Insulin: ["Insulin", "Fasting Insulin", "Serum Insulin"],
  UACR: ["UACR", "Urine ACR", "Microalbumin"],
  "Vitamin D": ["Vitamin D", "25-OH Vitamin D", "VIT D"],
  T3: ["T3", "Total T3", "TOTAL TRIIODOTHYRONINE"],
  T4: ["T4", "Total T4", "Free T4", "TOTAL THYROXINE"],
};

export const MED_COLORS = [
  "#7c3aed",
  "#4466f5",
  "#0ea5e9",
  "#12b981",
  "#f59e0b",
  "#f87171",
  "#a78bfa",
  "#fbbf24",
  "#ec4899",
  "#14b8a6",
];

const STATUS_MAP = {
  Controlled: "ctrl",
  Improving: "ctrl",
  "In Remission": "ctrl",
  Resolved: "ctrl",
  Uncontrolled: "rev",
  Review: "rev",
  "Review ⚠": "rev",
  Worsening: "rev",
  New: "new",
  "Newly Diagnosed": "new",
  Monitoring: "mon",
  "Under Monitoring": "mon",
  Stable: "mon",
  Active: "act",
};

export const statusClass = (s) => `sp-${STATUS_MAP[s] || "mon"}`;

// Diagnosis status options per clinical brief
export const DX_STATUS_OPTS = [
  "Uncontrolled",
  "Improving",
  "Controlled",
  "Newly Diagnosed",
  "Worsening",
  "Stable",
  "In Remission",
  "Resolved",
  "Under Monitoring",
];

// Diagnosis categories per clinical brief
export const DX_CATEGORIES = [
  {
    id: "primary",
    label: "Primary Diagnosis",
    description: "Main condition - reason for programme",
  },
  { id: "complication", label: "Diabetic Complication", description: "Caused by diabetes" },
  { id: "comorbidity", label: "Comorbidity", description: "Linked condition (HTN, lipids, etc.)" },
  { id: "external", label: "External Doctor", description: "Managed by another specialist" },
  { id: "monitoring", label: "Under Monitoring", description: "Watching but not treating" },
];

// Complication types for diabetic complications
export const COMPLICATION_TYPES = [
  { id: "nephropathy", label: "Nephropathy", severity: 1 },
  { id: "neuropathy", label: "Neuropathy", severity: 2 },
  { id: "retinopathy", label: "Retinopathy", severity: 3 },
  { id: "foot", label: "Diabetic Foot", severity: 4 },
  { id: "other", label: "Other", severity: 5 },
];

export const DX_STATUS_STYLE = {
  New: { dot: "#2563eb", bg: "#eff6ff", color: "#1d4ed8", border: "#bfdbfe" },
  "Newly Diagnosed": { dot: "#2563eb", bg: "#eff6ff", color: "#1d4ed8", border: "#bfdbfe" },
  Active: { dot: "#0891b2", bg: "#ecfeff", color: "#0e7490", border: "#a5f3fc" },
  Controlled: { dot: "#16a34a", bg: "#f0fdf4", color: "#15803d", border: "#bbf7d0" },
  Improving: { dot: "#16a34a", bg: "#f0fdf4", color: "#15803d", border: "#bbf7d0" },
  "In Remission": { dot: "#10b981", bg: "#ecfdf5", color: "#059669", border: "#a7f3d0" },
  Review: { dot: "#d97706", bg: "#fffbeb", color: "#b45309", border: "#fde68a" },
  Uncontrolled: { dot: "#dc2626", bg: "#fef2f2", color: "#b91c1c", border: "#fecaca" },
  Worsening: { dot: "#dc2626", bg: "#fef2f2", color: "#b91c1c", border: "#fecaca" },
  Monitoring: { dot: "#7c3aed", bg: "#f5f3ff", color: "#6d28d9", border: "#ddd6fe" },
  "Under Monitoring": { dot: "#7c3aed", bg: "#f5f3ff", color: "#6d28d9", border: "#ddd6fe" },
  Stable: { dot: "#6b7280", bg: "#f9fafb", color: "#4b5563", border: "#e5e7eb" },
  Resolved: { dot: "#94a3b8", bg: "#f8fafc", color: "#64748b", border: "#e2e8f0" },
};
export const DX_STATUS_DEFAULT = {
  dot: "#94a3b8",
  bg: "#f8fafc",
  color: "#64748b",
  border: "#e2e8f0",
};

// ── Find a lab result by alias ──
export const findLab = (labs, name) => {
  const aliases = LAB_ALIASES[name] || [name];
  return labs.find((l) =>
    aliases.some(
      (a) =>
        (l.canonical_name || "").toLowerCase() === a.toLowerCase() ||
        (l.test_name || "").toLowerCase() === a.toLowerCase(),
    ),
  );
};

// ── Find lab history array by alias ──
export const findLabHistory = (labHistory, name) => {
  const aliases = LAB_ALIASES[name] || [name];
  for (const a of aliases) {
    for (const key of Object.keys(labHistory)) {
      if (key.toLowerCase() === a.toLowerCase()) return labHistory[key];
    }
  }
  return [];
};

// ── Get latest lab value as { result, unit, flag, date } ──
export const getLabVal = (labResults, name) => {
  const r = findLab(labResults, name);
  return r ? { result: r.result, unit: r.unit || "", flag: r.flag, date: r.test_date } : null;
};

// ── Get lab history as reversed array (oldest-first for sparklines) ──
export const getLabHist = (labHistory, name) => {
  const h = findLabHistory(labHistory, name);
  return h ? h.slice().reverse() : [];
};

// ── Get HTN status from latest BP reading ──
export const getHtnStatusFromBP = (vitals) => {
  if (!vitals?.length) return null;
  const latest = vitals[0];
  if (!latest?.bp_sys || !latest?.bp_dia) return null;
  const sys = parseFloat(latest.bp_sys);
  const dia = parseFloat(latest.bp_dia);
  // Control: <140/90, Uncontrolled: >=140/90
  return sys >= 140 || dia >= 90 ? "Uncontrolled" : "Controlled";
};

// ── Compute diagnosis status from biomarker values (Controlled/Uncontrolled) ──
export const getDxStatusFromBiomarkers = (dxId, labResults, vitals) => {
  const normalizedId = dxId?.toLowerCase().replace(/\s+/g, "_");

  // Handle HTN separately from lab results
  if (normalizedId === "hypertension" || normalizedId === "htn") {
    return getHtnStatusFromBP(vitals);
  }

  if (!labResults?.length) return null;

  if (
    normalizedId === "type_2_dm" ||
    normalizedId === "dm2" ||
    normalizedId === "diabetes_mellitus"
  ) {
    const hba1c = getLabVal(labResults, "HbA1c");
    if (!hba1c?.result) return null;
    const val = parseFloat(hba1c.result);
    return val <= 7 ? "Controlled" : "Uncontrolled";
  } else if (normalizedId === "dyslipidemia" || normalizedId === "hyperlipidemia") {
    const ldl = getLabVal(labResults, "LDL");
    if (!ldl?.result) return null;
    const val = parseFloat(ldl.result);
    return val <= 100 ? "Controlled" : "Uncontrolled";
  } else if (
    normalizedId === "hypo" ||
    normalizedId === "hypothyroidism" ||
    normalizedId === "thyroid"
  ) {
    const tsh = getLabVal(labResults, "TSH");
    if (!tsh?.result) return null;
    const val = parseFloat(tsh.result);
    return val <= 4.5 ? "Controlled" : "Uncontrolled";
  } else if (normalizedId === "ckd" || normalizedId === "chronic_kidney_disease") {
    const cr = getLabVal(labResults, "Creatinine");
    if (!cr?.result) return null;
    const val = parseFloat(cr.result);
    return val <= 1.2 ? "Controlled" : "Uncontrolled";
  }

  return null;
};

// ── Get suggested diagnosis status with supporting biomarker details ──
export const getDxSuggestion = (dxId, labResults, vitals) => {
  let status = null;
  let biomarker = null;
  let value = null;
  let unit = null;
  let goal = null;

  // Normalize diagnosis_id to match database values
  const normalizedId = dxId?.toLowerCase().replace(/\s+/g, "_");

  if (normalizedId === "hypertension" || normalizedId === "htn") {
    if (!vitals?.length || !vitals[0].bp_sys || !vitals[0].bp_dia) return null;
    const sys = parseFloat(vitals[0].bp_sys);
    const dia = parseFloat(vitals[0].bp_dia);
    status = sys >= 140 || dia >= 90 ? "Uncontrolled" : "Controlled";
    biomarker = "BP";
    value = `${sys}/${dia}`;
    unit = "mmHg";
    goal = "<140/90";
  } else if (!labResults?.length) {
    return null;
  } else if (
    normalizedId === "type_2_dm" ||
    normalizedId === "dm2" ||
    normalizedId === "diabetes_mellitus"
  ) {
    const hba1c = getLabVal(labResults, "HbA1c");
    if (!hba1c?.result) return null;
    const val = parseFloat(hba1c.result);
    status = val <= 7 ? "Controlled" : "Uncontrolled";
    biomarker = "HbA1c";
    value = val;
    unit = "%";
    goal = "<7.0%";
  } else if (normalizedId === "dyslipidemia" || normalizedId === "hyperlipidemia") {
    const ldl = getLabVal(labResults, "LDL");
    if (!ldl?.result) return null;
    const val = parseFloat(ldl.result);
    status = val <= 100 ? "Controlled" : "Uncontrolled";
    biomarker = "LDL";
    value = val;
    unit = "mg/dL";
    goal = "<100";
  } else if (
    normalizedId === "hypo" ||
    normalizedId === "hypothyroidism" ||
    normalizedId === "thyroid"
  ) {
    const tsh = getLabVal(labResults, "TSH");
    if (!tsh?.result) return null;
    const val = parseFloat(tsh.result);
    status = val <= 4.5 ? "Controlled" : "Uncontrolled";
    biomarker = "TSH";
    value = val;
    unit = "µIU/mL";
    goal = "<4.5";
  } else if (normalizedId === "ckd" || normalizedId === "chronic_kidney_disease") {
    const cr = getLabVal(labResults, "Creatinine");
    if (!cr?.result) return null;
    const val = parseFloat(cr.result);
    status = val <= 1.2 ? "Controlled" : "Uncontrolled";
    biomarker = "Creatinine";
    value = val;
    unit = "mg/dL";
    goal = "<1.2";
  }

  return status ? { status, biomarker, value, unit, goal } : null;
};

// ── Date formatters ──
const MONTHS_S = [
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
const MONTHS_L = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
const DAYS_L = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

// Format a lab result value — rounds to max 2 decimal places (handles REAL
// float imprecision e.g. 3.30 stored as 3.2969), strips trailing zeros,
// passes through non-numeric strings (e.g. "Positive", "NORMAL") unchanged.
// Accepts result_text or result (whichever is available).
export const fmtLabVal = (resultText, result) => {
  const raw = resultText ?? result;
  if (raw == null || raw === "") return "";
  const n = parseFloat(raw);
  if (isNaN(n)) return raw; // non-numeric — return as-is
  return parseFloat(n.toFixed(2)); // round to 2dp, strip trailing zeros
};

export const fmtDate = (d) => {
  if (!d) return "";
  const dt = new Date(d);
  return `${dt.getDate()} ${MONTHS_S[dt.getMonth()]} ${dt.getFullYear()}`;
};

export const fmtDateLong = (d) => {
  if (!d) return "";
  const dt = new Date(d);
  return `${DAYS_L[dt.getDay()]}, ${dt.getDate()} ${MONTHS_L[dt.getMonth()]} ${dt.getFullYear()}`;
};

// ── Compute clinical flags from visit data ──
export const computeFlags = (data) => {
  if (!data) return [];
  const flags = [];
  const latestV = data.vitals?.[0];
  const tsh = findLab(data.labResults, "TSH");
  if (tsh?.result > 4.5)
    flags.push({
      icon: "⚠️",
      text: `TSH ${tsh.result} ${tsh.unit || "µIU/mL"} — Elevated`,
      type: "amber",
    });
  if (latestV?.pulse > 90)
    flags.push({ icon: "❗", text: `HR ${latestV.pulse} bpm — Elevated`, type: "red" });
  if (latestV?.bp_sys > 140)
    flags.push({
      icon: "⚠️",
      text: `BP ${latestV.bp_sys}/${latestV.bp_dia} — Elevated`,
      type: "amber",
    });
  const hb = findLab(data.labResults, "Haemoglobin");
  if (hb?.result && hb.result < 13)
    flags.push({ icon: "⚠️", text: `Hb ${hb.result} g/dL — Low`, type: "amber" });
  return flags;
};

// ── Short month name for chart labels ──
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const shortDate = (d) => {
  if (!d) return "";
  const dt = new Date(d);
  return `${dt.getDate()} ${MON[dt.getMonth()]} ${String(dt.getFullYear()).slice(2)}`;
};

// ── Biomarker Sparkline — OutcomesPage-style: fill area + hover tooltip ──
function BiomarkerSparkline({ data, color, unit, target }) {
  const [hoverIdx, setHoverIdx] = useState(null);
  if (!data || data.length === 0) return null;

  const W = 260,
    H = 52;
  const items = data.slice(-12);
  const values = items.map((d) => parseFloat(d.result ?? d.value ?? 0)).filter((n) => !isNaN(n));
  const dates = items.map((d) => d.date || d.test_date);
  if (values.length === 0) return null;

  const min = Math.min(...values) * 0.92;
  const max = Math.max(...values) * 1.08;
  const range = max - min || 1;
  const getX = (i) => (i / Math.max(values.length - 1, 1)) * W;
  const getY = (v) => H - ((v - min) / range) * H;
  const points = values.map((v, i) => `${getX(i)},${getY(v)}`).join(" ");
  const targetY = target != null ? getY(target) : null;

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      style={{ width: "100%", height: H, overflow: "visible", display: "block" }}
      onMouseLeave={() => setHoverIdx(null)}
    >
      {targetY != null && targetY >= 0 && targetY <= H && (
        <>
          <line
            x1="0"
            y1={targetY}
            x2={W}
            y2={targetY}
            stroke="#10b981"
            strokeDasharray="3,3"
            strokeWidth="0.8"
            opacity="0.5"
          />
          <text
            x={W - 2}
            y={targetY - 3}
            fill="#10b981"
            fontSize="6.5"
            textAnchor="end"
            opacity="0.7"
          >
            target {target}
          </text>
        </>
      )}
      <polygon points={`0,${H} ${points} ${W},${H}`} fill={`${color}15`} />
      {values.length > 1 && (
        <polyline
          points={points}
          fill="none"
          stroke={color}
          strokeWidth="2"
          strokeLinejoin="round"
        />
      )}
      {values.map((v, i) => {
        const cx = getX(i);
        const cy = getY(v);
        const isHovered = hoverIdx === i;
        return (
          <g key={i} onMouseEnter={() => setHoverIdx(i)} style={{ cursor: "crosshair" }}>
            {/* outer glow ring on hover */}
            {isHovered && <circle cx={cx} cy={cy} r="9" fill={color} opacity="0.15" />}
            <circle
              cx={cx}
              cy={cy}
              r={isHovered ? 6 : 3}
              fill={isHovered ? color : "white"}
              stroke={color}
              strokeWidth={isHovered ? 2.5 : 1.8}
            />
            {/* larger hit area */}
            <circle cx={cx} cy={cy} r="14" fill="transparent" />
          </g>
        );
      })}
      {hoverIdx != null &&
        (() => {
          const cx = getX(hoverIdx);
          const cy = getY(values[hoverIdx]);
          const TW = 76,
            TH = 34;
          // keep tooltip inside SVG bounds
          const tipX = Math.min(Math.max(cx - TW / 2, 0), W - TW);
          const tipY = cy > H / 2 ? Math.max(cy - TH - 10, 0) : cy + 14;
          return (
            <g style={{ pointerEvents: "none" }}>
              {/* vertical crosshair */}
              <line
                x1={cx}
                y1={0}
                x2={cx}
                y2={H}
                stroke={color}
                strokeWidth="1"
                strokeDasharray="3,3"
                opacity="0.5"
              />
              {/* tooltip shadow */}
              <rect
                x={tipX + 1}
                y={tipY + 1}
                width={TW}
                height={TH}
                rx="7"
                fill="rgba(0,0,0,0.15)"
              />
              {/* tooltip bg */}
              <rect x={tipX} y={tipY} width={TW} height={TH} rx="7" fill="#1e293b" />
              {/* value */}
              <text
                x={tipX + TW / 2}
                y={tipY + 14}
                fill="white"
                fontSize="11"
                fontWeight="800"
                textAnchor="middle"
                fontFamily="DM Sans,sans-serif"
              >
                {values[hoverIdx]}
                {unit}
              </text>
              {/* date */}
              <text
                x={tipX + TW / 2}
                y={tipY + 27}
                fill="#94a3b8"
                fontSize="8.5"
                fontWeight="500"
                textAnchor="middle"
                fontFamily="DM Sans,sans-serif"
              >
                {shortDate(dates[hoverIdx])}
              </text>
            </g>
          );
        })()}
    </svg>
  );
}

// ── Biomarker Card — OutcomesPage visual style ──
export const BiomarkerCard = memo(function BiomarkerCard({
  label,
  value,
  unit,
  trend,
  trendDir,
  goal,
  goalLabel,
  history,
  color,
  valueColor,
  valueDate,
  target,
}) {
  const stateColor =
    trendDir === "good"
      ? "#059669"
      : trendDir === "bad"
        ? "#dc2626"
        : trendDir === "warn"
          ? "#d97706"
          : "#64748b";
  const sparkColor = color || stateColor;

  const isNumeric = value != null && !isNaN(parseFloat(value));
  const chartData =
    history?.length > 0
      ? history
      : isNumeric
        ? [{ result: parseFloat(value), date: valueDate || new Date().toISOString() }]
        : [];

  const totalReadings = history?.length || 0;
  const latest = chartData.length > 0 ? chartData[chartData.length - 1] : null;
  const displayValue = latest?.result ?? value ?? "—";

  let trendArrow = null;
  if (chartData.length > 1) {
    const first = parseFloat(chartData[0].result);
    const last = parseFloat(chartData[chartData.length - 1].result);
    trendArrow = last < first ? "↓" : last > first ? "↑" : "→";
  }

  const firstDate = chartData[0]?.date || chartData[0]?.test_date;
  const lastDate =
    chartData[chartData.length - 1]?.date || chartData[chartData.length - 1]?.test_date;

  return (
    <div
      style={{
        background: "white",
        borderRadius: 12,
        border: "1px solid #f1f5f9",
        boxShadow: "0 1px 3px rgba(0,0,0,0.04)",
        overflow: "hidden",
      }}
    >
      {/* header */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          padding: "10px 14px 6px",
        }}
      >
        <div style={{ fontSize: 11, fontWeight: 700, color: "#475569" }}>{label}</div>
        <div style={{ display: "flex", alignItems: "baseline", gap: 3 }}>
          <span
            style={{
              fontSize: 16,
              fontWeight: 800,
              color: valueColor || stateColor,
              lineHeight: 1,
            }}
          >
            {displayValue}
          </span>
          {unit && <span style={{ fontSize: 10, color: "#94a3b8", fontWeight: 500 }}>{unit}</span>}
          {trendArrow && (
            <span style={{ fontSize: 12, fontWeight: 700, color: stateColor }}>{trendArrow}</span>
          )}
        </div>
      </div>

      {/* chart */}
      {chartData.length > 0 && (
        <div style={{ padding: "0 14px" }}>
          <BiomarkerSparkline data={chartData} color={sparkColor} unit={unit} target={target} />
        </div>
      )}

      {/* date range footer */}
      {chartData.length > 0 && (
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            padding: "3px 14px 6px",
            fontSize: 8,
            color: "#94a3b8",
          }}
        >
          <span>{shortDate(firstDate)}</span>
          {totalReadings > 1 && <span style={{ color: "#cbd5e1" }}>{totalReadings} readings</span>}
          <span>{shortDate(lastDate)}</span>
        </div>
      )}

      {/* trend text */}
      {trend && (
        <div
          style={{
            padding: "4px 14px 6px",
            fontSize: 10,
            fontWeight: 600,
            color: stateColor,
            borderTop: "1px solid #f8fafc",
          }}
        >
          {trend}
        </div>
      )}

      {/* goal row */}
      {goal && (
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            padding: "5px 14px 8px",
            borderTop: "1px solid #f8fafc",
            fontSize: 10,
          }}
        >
          <span style={{ color: "#94a3b8", fontWeight: 600 }}>{goalLabel || "Goal"}</span>
          <span style={{ fontWeight: 700, color: stateColor }}>{goal}</span>
        </div>
      )}
    </div>
  );
});
