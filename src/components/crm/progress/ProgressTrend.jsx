import { useState } from "react";
import {
  Bar,
  CartesianGrid,
  Cell,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { SERIES, daysText, offLabel } from "./progressText.js";

const AXIS = { fontSize: 12, fill: "#475569" };
const OFF_FILL = "#cbd5e1";

function tooltipLabel(label, payload) {
  const row = payload?.[0]?.payload;
  if (!row) return label;
  const off = offLabel(row.off);
  if (off) return `${label} · ${off}`;
  if (row.group === "day") return label;
  return `${label} · ${daysText(row.working_days)} ${row.team ? "staff " : ""}working days`;
}

export default function ProgressTrend({ trend, colorOf }) {
  const [split, setSplit] = useState(false);
  const canSplit = trend.reps.length > 1;
  const bySplit = split && canSplit;
  const rows = trend.buckets.map((b) => ({
    start: b.start,
    label: b.label,
    visits: b.visits,
    unique_doctors: b.unique_doctors,
    working_days: b.working_days,
    off: b.off,
    group: trend.group,
    team: trend.reps.length > 1,
    ...Object.fromEntries(trend.reps.map((r) => [r.id, b.by_rep[r.id] ?? 0])),
  }));
  const empty = trend.buckets.every((b) => b.visits === 0);
  const grouping = { day: "day", week: "week", month: "month" }[trend.group];

  return (
    <section className="prg__section" aria-labelledby="prg-trend">
      <div className="prg__section-head">
        <h2 id="prg-trend" className="prg__h2">
          Visits by {grouping}
        </h2>
        {canSplit && (
          <label className="prg__toggle">
            <input type="checkbox" checked={split} onChange={(e) => setSplit(e.target.checked)} />
            Split by staff
          </label>
        )}
      </div>
      {trend.group === "day" && !empty && (
        <p className="prg__hint">
          Sundays without visits are left out. Grey bars are Sundays, holidays or leave.
        </p>
      )}
      {empty ? (
        <p className="rep__empty">No visits logged in this period.</p>
      ) : (
        <div className="prg__chart">
          <ResponsiveContainer width="100%" height={260}>
            <ComposedChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: -16 }}>
              <CartesianGrid stroke="#e2e8f0" vertical={false} />
              <XAxis
                dataKey="label"
                tick={AXIS}
                tickLine={false}
                axisLine={{ stroke: "#cbd5e1" }}
                minTickGap={12}
              />
              <YAxis
                allowDecimals={false}
                tick={AXIS}
                tickLine={false}
                axisLine={false}
                width={44}
              />
              <Tooltip
                cursor={{ fill: "rgba(148, 163, 184, 0.15)" }}
                labelFormatter={tooltipLabel}
              />
              <Legend wrapperStyle={{ fontSize: 12, color: "#334155" }} />
              {bySplit ? (
                trend.reps.map((r) => (
                  <Bar
                    key={r.id}
                    dataKey={r.id}
                    name={r.full_name}
                    stackId="reps"
                    fill={colorOf(r.id)}
                    stroke="#fff"
                    strokeWidth={1}
                    maxBarSize={36}
                    isAnimationActive={false}
                  />
                ))
              ) : (
                <Bar
                  dataKey="visits"
                  name="Visits"
                  fill={SERIES[0]}
                  radius={[4, 4, 0, 0]}
                  maxBarSize={36}
                  isAnimationActive={false}
                >
                  {rows.map((row) => (
                    <Cell key={row.start} fill={row.off ? OFF_FILL : SERIES[0]} />
                  ))}
                </Bar>
              )}
              {!bySplit && (
                <Line
                  dataKey="unique_doctors"
                  name="Unique doctors"
                  stroke={SERIES[1]}
                  strokeWidth={2}
                  dot={
                    rows.length <= 14
                      ? { r: 4, fill: SERIES[1], stroke: "#fff", strokeWidth: 2 }
                      : false
                  }
                  activeDot={{ r: 5, fill: SERIES[1], stroke: "#fff", strokeWidth: 2 }}
                  type="monotone"
                  isAnimationActive={false}
                />
              )}
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      )}
      <details className="prg__table-toggle">
        <summary>Show as table</summary>
        <div className="prg__scroll">
          <table className="prg__table">
            <thead>
              <tr>
                <th scope="col">Period</th>
                <th scope="col">Visits</th>
                <th scope="col">Unique doctors</th>
                <th scope="col">Working days</th>
                {canSplit &&
                  trend.reps.map((r) => (
                    <th key={r.id} scope="col">
                      {r.full_name}
                    </th>
                  ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.start}>
                  <th scope="row">
                    {row.label}
                    {row.off && <span className="prg__off"> · {offLabel(row.off)}</span>}
                  </th>
                  <td>{row.visits}</td>
                  <td>{row.unique_doctors}</td>
                  <td>{daysText(row.working_days)}</td>
                  {canSplit && trend.reps.map((r) => <td key={r.id}>{row[r.id]}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </section>
  );
}
