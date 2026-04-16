import { useState } from "react";
import { fmtDate } from "../utils/helpers";

export default function Sparkline({
  data,
  width = 200,
  height = 55,
  color = "#2563eb",
  label,
  unit,
  target,
  lowerBetter,
  valueKey,
}) {
  const [hoverIdx, setHoverIdx] = useState(null);

  if (!data || data.length === 0)
    return (
      <div
        style={{
          background: "white",
          borderRadius: 12,
          padding: "10px 14px",
          border: "1px solid #f1f5f9",
          boxShadow: "0 1px 2px rgba(0,0,0,0.03)",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: "#cbd5e1" }}>{label}</div>
          <div style={{ fontSize: 10, color: "#cbd5e1" }}>No data</div>
        </div>
      </div>
    );

  const vk = valueKey || "result";
  const values = data.map((d) =>
    parseFloat(
      d[vk] || d.result || d.bp_sys || d.weight || d.waist || d.body_fat || d.muscle_mass || 0,
    ),
  );
  const dates = data.map((d) => d.test_date || d.date);
  const min = Math.min(...values) * 0.92;
  const max = Math.max(...values) * 1.08;
  const range = max - min || 1;
  const points = values
    .map(
      (v, i) =>
        `${(i / Math.max(values.length - 1, 1)) * width},${height - ((v - min) / range) * height}`,
    )
    .join(" ");
  const latest = values[values.length - 1];
  const first = values[0];
  const trend = latest < first ? "↓" : latest > first ? "↑" : "→";

  let trendColor;
  if (target) {
    const inTarget = lowerBetter !== false ? latest <= target : latest >= target;
    const nearTarget = lowerBetter !== false ? latest <= target * 1.15 : latest >= target * 0.85;
    trendColor = inTarget ? "#059669" : nearTarget ? "#d97706" : "#dc2626";
  } else {
    const improving = lowerBetter !== false ? latest <= first : latest >= first;
    trendColor = improving ? "#059669" : "#dc2626";
  }

  const targetY = target ? height - ((target - min) / range) * height : null;

  return (
    <div
      style={{
        background: "white",
        borderRadius: 12,
        padding: "10px 14px",
        border: "1px solid #f1f5f9",
        boxShadow: "0 1px 3px rgba(0,0,0,0.04)",
        position: "relative",
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
        <div style={{ fontSize: 11, fontWeight: 700, color: "#475569" }}>{label}</div>
        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <span style={{ fontSize: 15, fontWeight: 800, color: trendColor }}>
            {latest}
            {unit}
          </span>
          <span style={{ fontSize: 12, color: trendColor, fontWeight: 700 }}>{trend}</span>
        </div>
      </div>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        style={{ width: "100%", height: height, overflow: "visible" }}
        onMouseLeave={() => setHoverIdx(null)}
      >
        {target && targetY >= 0 && targetY <= height && (
          <>
            <line
              x1="0"
              y1={targetY}
              x2={width}
              y2={targetY}
              stroke="#10b981"
              strokeDasharray="3,3"
              strokeWidth="0.8"
              opacity="0.5"
            />
            <text
              x={width - 2}
              y={targetY - 3}
              fill="#10b981"
              fontSize="7"
              textAnchor="end"
              opacity="0.7"
            >
              target {target}
            </text>
          </>
        )}
        <polygon points={`0,${height} ${points} ${width},${height}`} fill={`${color}10`} />
        <polyline
          points={points}
          fill="none"
          stroke={color}
          strokeWidth="2"
          strokeLinejoin="round"
        />
        {values.map((v, i) => {
          const cx = (i / Math.max(values.length - 1, 1)) * width;
          const cy = height - ((v - min) / range) * height;
          return (
            <g key={i} onMouseEnter={() => setHoverIdx(i)} style={{ cursor: "pointer" }}>
              <circle
                cx={cx}
                cy={cy}
                r={hoverIdx === i ? 5 : 3}
                fill={hoverIdx === i ? color : "white"}
                stroke={color}
                strokeWidth="2"
              />
              <circle cx={cx} cy={cy} r="12" fill="transparent" />
            </g>
          );
        })}
        {hoverIdx !== null &&
          (() => {
            const cx = (hoverIdx / Math.max(values.length - 1, 1)) * width;
            const cy = height - ((values[hoverIdx] - min) / range) * height;
            const TW = 74,
              TH = 28;
            const tooltipX = Math.min(Math.max(cx - TW / 2, 0), width - TW);
            const tooltipY = Math.max(cy - TH - 12, -TH - 2);
            return (
              <g style={{ pointerEvents: "none" }}>
                <line
                  x1={cx}
                  y1={0}
                  x2={cx}
                  y2={height}
                  stroke={color}
                  strokeWidth="0.5"
                  strokeDasharray="2,2"
                  opacity="0.4"
                />
                <rect
                  x={tooltipX + 1}
                  y={tooltipY + 1}
                  width={TW}
                  height={TH}
                  rx="5"
                  fill="rgba(0,0,0,0.12)"
                />
                <rect x={tooltipX} y={tooltipY} width={TW} height={TH} rx="5" fill="#1e293b" />
                <text
                  x={tooltipX + TW / 2}
                  y={tooltipY + 12}
                  fill="white"
                  fontSize="9"
                  fontWeight="700"
                  textAnchor="middle"
                >
                  {values[hoverIdx]} {unit}
                </text>
                <text
                  x={tooltipX + TW / 2}
                  y={tooltipY + 22}
                  fill="#94a3b8"
                  fontSize="7"
                  textAnchor="middle"
                >
                  {fmtDate(dates[hoverIdx])}
                </text>
              </g>
            );
          })()}
      </svg>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          fontSize: 8,
          color: "#94a3b8",
          marginTop: 4,
        }}
      >
        <span>{fmtDate(dates[0])}</span>
        <span style={{ color: "#cbd5e1" }}>
          {values.length} reading{values.length !== 1 ? "s" : ""}
        </span>
        <span>{fmtDate(dates[dates.length - 1])}</span>
      </div>
    </div>
  );
}
