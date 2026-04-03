import { memo } from "react";

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
  Uncontrolled: "rev",
  Review: "rev",
  "Review ⚠": "rev",
  New: "new",
  Monitoring: "mon",
  Stable: "mon",
  Resolved: "ctrl",
};

export const statusClass = (s) => `sp-${STATUS_MAP[s] || "mon"}`;

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
  return `${MON[dt.getMonth()]} ${String(dt.getFullYear()).slice(2)}`;
};

// ── Sparkline SVG — shows all data points with values & dates ──
export const Sparkline = memo(function Sparkline({ values, color = "#12b981" }) {
  if (!values || values.length === 0) return null;
  const items = values.map((v) => (typeof v === "object" ? v : { result: v }));
  const nums = items.map((v) => parseFloat(v.result)).filter((n) => !isNaN(n));
  if (nums.length === 0) return null;

  const W = 200,
    H = 56,
    PAD_T = 14,
    PAD_B = 12,
    PAD_L = 4,
    PAD_R = 4;
  const plotH = H - PAD_T - PAD_B;
  const min = Math.min(...nums);
  const max = Math.max(...nums);
  const range = max - min || 1;
  const getX = (i) =>
    PAD_L +
    (nums.length === 1 ? (W - PAD_L - PAD_R) / 2 : (i / (nums.length - 1)) * (W - PAD_L - PAD_R));
  const getY = (v) => PAD_T + plotH - ((v - min) / range) * plotH;

  const pts = nums.map((v, i) => `${getX(i)},${getY(v)}`).join(" ");

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      fill="none"
      style={{ width: "100%", height: 60, margin: "3px 0 2px" }}
    >
      {/* grid line */}
      <line
        x1={PAD_L}
        y1={getY(min)}
        x2={W - PAD_R}
        y2={getY(min)}
        stroke="#e4e9f2"
        strokeWidth=".5"
        strokeDasharray="3,3"
      />
      {nums.length > 1 && (
        <line
          x1={PAD_L}
          y1={getY(max)}
          x2={W - PAD_R}
          y2={getY(max)}
          stroke="#e4e9f2"
          strokeWidth=".5"
          strokeDasharray="3,3"
        />
      )}
      {/* line */}
      {nums.length > 1 && (
        <polyline points={pts} stroke={color} strokeWidth="1.5" fill="none" opacity=".6" />
      )}
      {/* dots + value labels */}
      {nums.map((v, i) => {
        const x = getX(i);
        const y = getY(v);
        const isLast = i === nums.length - 1;
        const dt = items[i]?.date;
        return (
          <g key={i}>
            <circle
              cx={x}
              cy={y}
              r={isLast ? 3 : 2}
              fill={isLast ? color : color}
              opacity={isLast ? 1 : 0.7}
            />
            <text
              x={x}
              y={y - 4}
              textAnchor="middle"
              fontSize="7"
              fontWeight={isLast ? 700 : 500}
              fill={isLast ? color : "#6b7280"}
              fontFamily="DM Sans,sans-serif"
            >
              {v}
            </text>
            {dt && (
              <text
                x={x}
                y={H - 1}
                textAnchor="middle"
                fontSize="5.5"
                fill="#9ca3af"
                fontFamily="DM Sans,sans-serif"
              >
                {shortDate(dt)}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
});

// ── Biomarker Card ──
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
}) {
  const cls =
    trendDir === "good" ? "imp" : trendDir === "bad" ? "bad" : trendDir === "warn" ? "wrn" : "ok";
  const trendCls = trendDir === "good" ? "td" : trendDir === "bad" ? "tu" : "ts";
  const sparkColor =
    color || (trendDir === "good" ? "#12b981" : trendDir === "bad" ? "#ef4444" : "#f59e0b");
  const readingCount = history?.length || 0;
  return (
    <div className={`bmc ${cls}`}>
      <div
        className="bml"
        style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}
      >
        <span>{label}</span>
        {readingCount > 0 && (
          <span style={{ fontSize: 8, color: "var(--t4)", fontWeight: 500 }}>
            {readingCount} readings
          </span>
        )}
      </div>
      <div className="bmvr">
        <span
          className="bmv"
          style={
            valueColor
              ? { color: valueColor }
              : trendDir === "bad"
                ? { color: "var(--red)" }
                : undefined
          }
        >
          {value ?? "—"}
        </span>
        {unit && <span className="bmu">{unit}</span>}
      </div>
      {trend && <div className={`bmtr ${trendCls}`}>{trend}</div>}
      <Sparkline values={history} color={sparkColor} />
      {goal && (
        <div className="bmgr">
          <span className="bmgl">{goalLabel || "Goal"}</span>
          <span className="bmgv">{goal}</span>
        </div>
      )}
    </div>
  );
});
