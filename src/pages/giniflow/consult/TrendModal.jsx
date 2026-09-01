import { useEffect } from "react";
import { useTrend } from "../../../queries/hooks/useGiniflowDoctor";

// The trend behind a tapped key-number tile — gini-doctor-final.html `gmod`.
//
// Inline SVG rather than a chart library: it is one line, and the station bundle
// is already lazy-loaded on a hospital connection.

const W = 520;
const H = 180;
const PAD = { l: 40, r: 14, t: 14, b: 26 };

export default function TrendModal({ visitId, marker, onClose }) {
  const { data, isLoading } = useTrend(visitId, marker?.key);

  useEffect(() => {
    const onKey = (e) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const series = data?.series || [];
  const values = series.map((p) => p.value);
  const min = values.length ? Math.min(...values) : 0;
  const max = values.length ? Math.max(...values) : 1;
  const span = max - min || 1;
  const x = (i) =>
    PAD.l + (series.length < 2 ? 0 : (i * (W - PAD.l - PAD.r)) / (series.length - 1));
  const y = (v) => PAD.t + (1 - (v - min) / span) * (H - PAD.t - PAD.b);
  const path = series.map((p, i) => `${i ? "L" : "M"}${x(i)},${y(p.value)}`).join(" ");

  return (
    <div className="tmodal open" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="tbox" role="dialog" aria-label={`${marker?.label} trend`}>
        <div className="tb-hd">
          <div>
            <div className="tb-name">{marker?.label}</div>
            <div className="tb-meta">
              {series.length
                ? `${series.length} readings · latest ${series[series.length - 1].value}${marker?.unit || ""}`
                : "no history"}
            </div>
          </div>
          <button className="tb-cls" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="tb-body">
          {isLoading && <div className="cn-empty">Loading…</div>}
          {!isLoading && series.length < 2 && (
            <div className="cn-empty">
              Not enough readings to draw a trend — one point is a value, not a direction.
            </div>
          )}
          {series.length >= 2 && (
            <div className="trend-wrap">
              <svg viewBox={`0 0 ${W} ${H}`} className="trend-svg" role="img">
                <line x1={PAD.l} y1={H - PAD.b} x2={W - PAD.r} y2={H - PAD.b} className="tr-axis" />
                <text x={4} y={PAD.t + 6} className="tr-tick">
                  {max}
                </text>
                <text x={4} y={H - PAD.b} className="tr-tick">
                  {min}
                </text>
                <path d={path} className="tr-line" />
                {series.map((p, i) => (
                  <circle key={p.date} cx={x(i)} cy={y(p.value)} r="3" className="tr-dot">
                    <title>{`${p.date}: ${p.value}${marker?.unit || ""}`}</title>
                  </circle>
                ))}
                <text x={PAD.l} y={H - 8} className="tr-tick">
                  {series[0].date}
                </text>
                <text x={W - PAD.r} y={H - 8} textAnchor="end" className="tr-tick">
                  {series[series.length - 1].date}
                </text>
              </svg>
            </div>
          )}
          {series.length >= 2 && (
            <div className="trend-meta">
              <span>
                first <strong>{series[0].value}</strong> {marker?.unit}
              </span>
              <span>
                latest <strong>{series[series.length - 1].value}</strong> {marker?.unit}
              </span>
              <span>
                range{" "}
                <strong>
                  {min}–{max}
                </strong>
              </span>
              <span>{series.length} readings</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
