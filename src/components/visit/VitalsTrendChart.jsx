import { useMemo, useState } from "react";

const METRICS = [
  { key: "weight", label: "Weight (kg)", unit: "kg", color: "#2563eb" },
  { key: "bmi", label: "BMI", unit: "kg/m²", color: "#059669" },
  { key: "waist", label: "Waist (cm)", unit: "cm", color: "#d97706" },
  { key: "body_fat", label: "Body Fat (%)", unit: "%", color: "#dc2626" },
  { key: "muscle_mass", label: "Muscle Mass (kg)", unit: "kg", color: "#7c3aed" },
  { key: "pulse", label: "Pulse (bpm)", unit: "bpm", color: "#db2777" },
];

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const shortDate = (d) => {
  if (!d) return "";
  const dt = new Date(d);
  if (isNaN(dt)) return String(d).slice(0, 10);
  return `${dt.getDate()} ${MON[dt.getMonth()]} ${String(dt.getFullYear()).slice(2)}`;
};

function VitalsSparkline({ data, lines, unit }) {
  const [hoverIdx, setHoverIdx] = useState(null);

  // Build series: dedupe by date (keep latest per date), then last 12
  const seen = new Set();
  const deduped = [];
  for (let i = data.length - 1; i >= 0; i--) {
    const key = (data[i].date || "").slice(0, 10);
    if (!seen.has(key)) {
      seen.add(key);
      deduped.unshift(data[i]);
    }
  }
  const items = deduped.slice(-12);
  if (items.length === 0) return null;

  const W = 260;
  const H = 120;

  // Collect all numeric values across all lines to build shared Y scale
  const allVals = [];
  for (const it of items) {
    for (const l of lines) {
      const n = Number(it[l.key]);
      if (Number.isFinite(n)) allVals.push(n);
    }
  }
  if (allVals.length === 0) return null;

  const rawMin = Math.min(...allVals);
  const rawMax = Math.max(...allVals);
  const span = rawMax - rawMin || Math.max(rawMax * 0.1, 1);
  const min = rawMin - span * 0.15;
  const max = rawMax + span * 0.15;
  const range = max - min || 1;

  const getX = (i) => (i / Math.max(items.length - 1, 1)) * W;
  const getY = (v) => H - ((v - min) / range) * H;

  const seriesPoints = lines.map((l) => {
    const pts = items.map((it, i) => {
      const n = Number(it[l.key]);
      return Number.isFinite(n) ? { x: getX(i), y: getY(n), v: n, i } : null;
    });
    return { line: l, pts };
  });

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      style={{ width: "100%", height: H, overflow: "visible", display: "block" }}
      onMouseLeave={() => setHoverIdx(null)}
    >
      {/* Fill area (only for single-line charts for clarity) */}
      {lines.length === 1 &&
        (() => {
          const pts = seriesPoints[0].pts.filter(Boolean);
          if (pts.length < 2) return null;
          const polyStr = pts.map((p) => `${p.x},${p.y}`).join(" ");
          return (
            <polygon
              points={`${pts[0].x},${H} ${polyStr} ${pts[pts.length - 1].x},${H}`}
              fill={`${lines[0].color}15`}
            />
          );
        })()}

      {/* Lines */}
      {seriesPoints.map(({ line, pts }) => {
        const valid = pts.filter(Boolean);
        if (valid.length < 2) return null;
        return (
          <polyline
            key={line.key}
            points={valid.map((p) => `${p.x},${p.y}`).join(" ")}
            fill="none"
            stroke={line.color}
            strokeWidth="2"
            strokeLinejoin="round"
          />
        );
      })}

      {/* Dots + hit areas */}
      {items.map((_, i) => {
        const isHovered = hoverIdx === i;
        return (
          <g key={i} onMouseEnter={() => setHoverIdx(i)} style={{ cursor: "crosshair" }}>
            {seriesPoints.map(({ line, pts }) => {
              const p = pts[i];
              if (!p) return null;
              return (
                <g key={line.key}>
                  {isHovered && <circle cx={p.x} cy={p.y} r="9" fill={line.color} opacity="0.15" />}
                  <circle
                    cx={p.x}
                    cy={p.y}
                    r={isHovered ? 6 : 3}
                    fill={isHovered ? line.color : "white"}
                    stroke={line.color}
                    strokeWidth={isHovered ? 2.5 : 1.8}
                  />
                </g>
              );
            })}
            {/* wide hit area over the column */}
            <rect x={getX(i) - 12} y={0} width={24} height={H} fill="transparent" />
          </g>
        );
      })}

      {/* Tooltip */}
      {hoverIdx != null &&
        (() => {
          const cx = getX(hoverIdx);
          const it = items[hoverIdx];
          const rows = lines
            .map((l) => {
              const n = Number(it[l.key]);
              return Number.isFinite(n) ? { line: l, v: n } : null;
            })
            .filter(Boolean);
          if (rows.length === 0) return null;

          const TW = lines.length > 1 ? 110 : 92;
          const TH = 24 + rows.length * 14;
          const tipX = Math.min(Math.max(cx - TW / 2, 0), W - TW);
          // anchor above topmost point in this column
          const topY = Math.min(
            ...seriesPoints.map(({ pts }) => (pts[hoverIdx] ? pts[hoverIdx].y : H)),
          );
          const tipY = topY - TH - 14;

          return (
            <g style={{ pointerEvents: "none" }}>
              <line
                x1={cx}
                y1={0}
                x2={cx}
                y2={H}
                stroke={rows[0].line.color}
                strokeWidth="1"
                strokeDasharray="3,3"
                opacity="0.5"
              />
              <rect
                x={tipX + 1}
                y={tipY + 1}
                width={TW}
                height={TH}
                rx="7"
                fill="rgba(0,0,0,0.15)"
              />
              <rect x={tipX} y={tipY} width={TW} height={TH} rx="7" fill="#1e293b" />
              {rows.map((r, idx) => (
                <text
                  key={r.line.key}
                  x={tipX + TW / 2}
                  y={tipY + 15 + idx * 14}
                  fill="white"
                  fontSize="11"
                  fontWeight="800"
                  textAnchor="middle"
                  fontFamily="DM Sans,sans-serif"
                >
                  {lines.length > 1 ? `${r.line.name}: ` : ""}
                  {r.v}
                  {unit ? ` ${unit}` : ""}
                </text>
              ))}
              <text
                x={tipX + TW / 2}
                y={tipY + 15 + rows.length * 14}
                fill="#94a3b8"
                fontSize="8.5"
                fontWeight="500"
                textAnchor="middle"
                fontFamily="DM Sans,sans-serif"
              >
                {shortDate(it.date)}
              </text>
            </g>
          );
        })()}
    </svg>
  );
}

function Chart({ title, data, lines, unit }) {
  const points = data.filter((d) => lines.some((l) => Number.isFinite(Number(d[l.key]))));
  if (points.length < 2) return null;
  return (
    <div
      style={{
        border: "1px solid var(--border)",
        borderRadius: "var(--rs)",
        padding: 12,
        background: "#fff",
        overflow: "visible",
      }}
    >
      <div
        style={{
          fontSize: 12,
          fontWeight: 700,
          color: "var(--text)",
          marginBottom: 8,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
        }}
      >
        <span>{title}</span>
        {lines.length > 1 && (
          <span style={{ display: "flex", gap: 10, fontSize: 10, fontWeight: 500 }}>
            {lines.map((l) => (
              <span key={l.key} style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                <span
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: "50%",
                    background: l.color,
                    display: "inline-block",
                  }}
                />
                {l.name}
              </span>
            ))}
          </span>
        )}
      </div>
      <VitalsSparkline data={points} lines={lines} unit={unit} />
    </div>
  );
}

export default function VitalsTrendChart({ vitals = [] }) {
  const series = useMemo(() => {
    const num = (x) => {
      if (x == null || x === "") return null;
      const n = Number(x);
      return Number.isFinite(n) && n > 0 ? n : null;
    };
    const rows = (vitals || [])
      .map((v) => ({
        date: v.recorded_at || v.recorded_date,
        weight: num(v.weight),
        bmi: num(v.bmi),
        waist: num(v.waist),
        body_fat: num(v.body_fat),
        muscle_mass: num(v.muscle_mass),
        pulse: num(v.pulse),
        bp_sys: num(v.bp_sys),
        bp_dia: num(v.bp_dia),
      }))
      .filter((r) => r.date)
      .sort((a, b) => new Date(a.date) - new Date(b.date));
    return rows;
  }, [vitals]);

  if (series.length < 2) return null;

  const hasBP = series.filter((r) => r.bp_sys != null || r.bp_dia != null).length >= 2;
  const singleCharts = METRICS.filter((m) => series.filter((r) => r[m.key] != null).length >= 2);

  if (!hasBP && singleCharts.length === 0) return null;

  return (
    <div className="sc" id="vitals-trends">
      <div className="sch">
        <div className="sct">
          <div className="sci ic-a">📈</div>Vitals Trends
        </div>
      </div>
      <div className="scb">
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
            gap: 12,
          }}
        >
          {hasBP && (
            <Chart
              title="Blood Pressure (mmHg)"
              data={series}
              unit="mmHg"
              lines={[
                { key: "bp_sys", name: "Systolic", color: "#dc2626" },
                { key: "bp_dia", name: "Diastolic", color: "#2563eb" },
              ]}
            />
          )}
          {singleCharts.map((m) => (
            <Chart
              key={m.key}
              title={m.label}
              data={series}
              unit={m.unit}
              lines={[{ key: m.key, name: m.label, color: m.color }]}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
