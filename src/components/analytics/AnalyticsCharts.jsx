import "./AnalyticsCharts.css";

const fmt = (v) => (v == null || Number.isNaN(v) ? "—" : Number(v).toLocaleString());
const pctText = (v) => (v == null ? "—" : `${v}%`);

function niceMax(value) {
  if (!(value > 0)) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(value)));
  const norm = value / mag;
  const step = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
  return step * mag;
}

export function StatTile({ value, label, note, tone }) {
  return (
    <div className={`an-tile${tone ? ` an-tile--${tone}` : ""}`}>
      <span className="an-tile__v">{value}</span>
      <span className="an-tile__k">{label}</span>
      {note ? <span className="an-tile__n">{note}</span> : null}
    </div>
  );
}

export function StatRow({ children }) {
  return <div className="an-tiles">{children}</div>;
}

export function BarList({ rows, valueFormat = fmt, color = "var(--an-series-1)", max }) {
  if (!rows || !rows.length) return <p className="an-empty">No data.</p>;
  const top = max || niceMax(Math.max(...rows.map((r) => Math.abs(r.value) || 0)));
  return (
    <ul className="an-bars">
      {rows.map((r) => (
        <li key={r.label} className="an-bars__row">
          <span className="an-bars__label" title={r.label}>
            {r.label}
          </span>
          <span className="an-bars__track">
            <span
              className="an-bars__fill"
              style={{
                width: `${Math.max(1, (Math.abs(r.value) / top) * 100)}%`,
                background: r.color || color,
              }}
            />
          </span>
          <span className="an-bars__value">{valueFormat(r.value)}</span>
        </li>
      ))}
    </ul>
  );
}

export function StackedShare({ rows, segments }) {
  if (!rows || !rows.length) return <p className="an-empty">No data.</p>;
  return (
    <ul className="an-stack">
      {rows.map((row) => {
        const total = segments.reduce((sum, s) => sum + (Number(row[s.key]) || 0), 0);
        if (!total) return null;
        return (
          <li key={row.label} className="an-stack__row">
            <span className="an-stack__label" title={row.label}>
              {row.label}
            </span>
            <span className="an-stack__track">
              {segments.map((s) => {
                const v = Number(row[s.key]) || 0;
                if (!v) return null;
                const share = (v / total) * 100;
                return (
                  <span
                    key={s.key}
                    className="an-stack__seg"
                    style={{ width: `${share}%`, background: s.color }}
                    title={`${row.label} — ${s.label}: ${fmt(v)} (${share.toFixed(1)}%)`}
                  >
                    {share > 9 ? `${share.toFixed(0)}%` : ""}
                  </span>
                );
              })}
            </span>
            <span className="an-stack__n">n={fmt(total)}</span>
          </li>
        );
      })}
    </ul>
  );
}

export function Sparkline({
  points,
  labels,
  color = "var(--an-series-1)",
  height = 180,
  valueFormat = fmt,
}) {
  const values = (points || []).filter((v) => v != null);
  if (!values.length) return <p className="an-empty">No data.</p>;
  const width = 640;
  const padL = 46;
  const padB = 26;
  const padT = 10;
  const plotW = width - padL - 10;
  const plotH = height - padB - padT;
  const hi = niceMax(Math.max(...values));
  const lo = Math.min(0, Math.min(...values));
  const xAt = (i) => padL + (points.length <= 1 ? plotW / 2 : (i / (points.length - 1)) * plotW);
  const yAt = (v) => padT + plotH - ((v - lo) / (hi - lo || 1)) * plotH;
  const path = points
    .map((v, i) => (v == null ? null : `${xAt(i).toFixed(1)},${yAt(v).toFixed(1)}`))
    .filter(Boolean)
    .join(" ");

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="an-svg" role="img" aria-label="Trend">
      {[0, 1, 2, 3].map((i) => {
        const v = lo + ((hi - lo) / 3) * i;
        return (
          <g key={i}>
            <line
              x1={padL}
              y1={yAt(v)}
              x2={width - 10}
              y2={yAt(v)}
              stroke="var(--an-grid)"
              strokeWidth="1"
            />
            <text
              x={padL - 8}
              y={yAt(v)}
              textAnchor="end"
              dominantBaseline="central"
              fontSize="11"
              fill="var(--an-muted)"
            >
              {valueFormat(Math.round(v))}
            </text>
          </g>
        );
      })}
      <polyline
        points={path}
        fill="none"
        stroke={color}
        strokeWidth="2"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      {points.map((v, i) =>
        v == null ? null : (
          <circle key={i} cx={xAt(i)} cy={yAt(v)} r="8" fill="transparent">
            <title>{`${labels ? labels[i] : i}: ${valueFormat(v)}`}</title>
          </circle>
        ),
      )}
      {labels
        ? labels.map((l, i) => {
            const every = Math.ceil(labels.length / 6);
            const isLast = i === labels.length - 1;
            if (i % every !== 0 && !isLast) return null;
            return (
              <text
                key={l}
                x={isLast ? width - 10 : xAt(i)}
                y={height - 8}
                textAnchor={isLast ? "end" : i === 0 ? "start" : "middle"}
                fontSize="11"
                fill="var(--an-muted)"
              >
                {l}
              </text>
            );
          })
        : null}
    </svg>
  );
}

export function DataTable({ columns, rows, caption, maxRows }) {
  if (!rows || !rows.length) return <p className="an-empty">No rows.</p>;
  const shown = maxRows ? rows.slice(0, maxRows) : rows;
  return (
    <div className="an-tablewrap">
      <table className="an-table">
        {caption ? <caption>{caption}</caption> : null}
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.label} scope="col">
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {shown.map((r, i) => (
            <tr key={r.id || r.key || r.patient_id || i}>
              {columns.map((c) => (
                <td key={c.label} className={c.className ? c.className(r) : undefined}>
                  {c.get ? c.get(r) : (r[c.key] ?? "—")}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {maxRows && rows.length > maxRows ? (
        <p className="an-empty">
          Showing {maxRows} of {fmt(rows.length)} rows. Download the workbook for the full list.
        </p>
      ) : null}
    </div>
  );
}

export function Legend({ items }) {
  return (
    <div className="an-legend">
      {items.map((i) => (
        <span key={i.label}>
          <i style={{ background: i.color }} />
          {i.label}
        </span>
      ))}
    </div>
  );
}

export function Notes({ items, tone }) {
  if (!items || !items.length) return null;
  return (
    <div className={`an-notes${tone ? ` an-notes--${tone}` : ""}`}>
      <ul>
        {items.map((n) => (
          <li key={n}>{n}</li>
        ))}
      </ul>
    </div>
  );
}

export { fmt, pctText };
