import {
  Area,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { SERIES } from "../../crm/progress/progressText";
import { bucketLabel, compactMoney, money, niceAxis, PERIOD_LABELS } from "./dashboardText";
import ReportLink from "./ReportLink";

const AXIS = { fontSize: 12, fill: "#475569" };

const SERIES_OF = [
  { key: "net_revenue", label: "Net revenue (by bill date)", color: SERIES[0] },
  { key: "collected", label: "Collected (by payment date)", color: SERIES[1] },
];

function TrendTip({ active, payload }) {
  if (!active || !payload?.length) return null;
  const row = payload[0].payload;
  return (
    <div className="bdash-tip">
      <div className="bdash-tip__title">
        {row.label}
        {row.partial ? " (part)" : ""}
      </div>
      {SERIES_OF.map((series) => (
        <div key={series.key} className="bdash-tip__row">
          <span className="bdash-key" style={{ background: series.color }} aria-hidden="true" />
          {series.label}
          <strong>{money(row[series.key])}</strong>
        </div>
      ))}
      <div className="bdash-tip__row">
        Pending <strong>{money(row.pending)}</strong>
      </div>
      {row.drill ? <div className="bdash-tip__hint">Click to open this {row.unit}</div> : null}
    </div>
  );
}

export default function RevenueTrend({ data, onPick }) {
  const period = data.filters.period;
  const rows = data.rows.map((row) => ({
    ...row,
    label: bucketLabel(row, period),
    drill: period !== "day",
    unit: PERIOD_LABELS[period].toLowerCase(),
  }));
  const empty = rows.every((row) => !row.net_revenue && !row.collected);
  const axis = niceAxis(rows.flatMap((row) => [row.net_revenue, row.collected]));
  const dots = rows.length <= 14;
  const pick = (state) => {
    const row = state?.activePayload?.[0]?.payload;
    if (row && period !== "day") onPick(row);
  };
  return (
    <section className="flow-card bdash-card" aria-labelledby="bdash-trend">
      <div className="fset__cardhead">
        <h2 id="bdash-trend" className="flow-sec-title">
          Revenue and collections by {PERIOD_LABELS[period].toLowerCase()}
        </h2>
        <ReportLink report="collections" title="Collections" filters={data.filters} />
      </div>
      {empty ? (
        <div className="bill-allclear">No revenue or collections in this range.</div>
      ) : (
        <div className="bdash-chart">
          <ResponsiveContainer width="100%" height={260}>
            <ComposedChart
              data={rows}
              margin={{ top: 8, right: 12, bottom: 0, left: 8 }}
              onClick={pick}
              style={period !== "day" ? { cursor: "pointer" } : undefined}
            >
              <defs>
                <linearGradient id="bdash-revenue-fill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={SERIES[0]} stopOpacity={0.3} />
                  <stop offset="100%" stopColor={SERIES[0]} stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke="#cbd5e1" vertical={false} />
              <XAxis
                dataKey="label"
                tick={AXIS}
                tickLine={false}
                axisLine={{ stroke: "#64748b" }}
                minTickGap={16}
              />
              <YAxis
                tick={AXIS}
                tickLine={false}
                axisLine={false}
                width={56}
                domain={axis.domain}
                ticks={axis.ticks}
                tickFormatter={axis.format}
              />
              <Tooltip
                content={<TrendTip />}
                cursor={{ stroke: "#94a3b8", strokeDasharray: "3 3" }}
              />
              <Legend
                wrapperStyle={{ fontSize: 12 }}
                formatter={(name) => <span className="bdash-legend">{name}</span>}
              />
              <Area
                type="linear"
                dataKey="net_revenue"
                name={SERIES_OF[0].label}
                stroke={SERIES_OF[0].color}
                strokeWidth={3}
                fill="url(#bdash-revenue-fill)"
                dot={
                  dots
                    ? { r: 3, fill: SERIES_OF[0].color, stroke: "#fff", strokeWidth: 1.5 }
                    : false
                }
                activeDot={{ r: 5, fill: SERIES_OF[0].color, stroke: "#fff", strokeWidth: 2 }}
                isAnimationActive={false}
              />
              <Line
                type="linear"
                dataKey="collected"
                name={SERIES_OF[1].label}
                stroke={SERIES_OF[1].color}
                strokeWidth={3}
                dot={
                  dots
                    ? { r: 3, fill: SERIES_OF[1].color, stroke: "#fff", strokeWidth: 1.5 }
                    : false
                }
                activeDot={{ r: 5, fill: SERIES_OF[1].color, stroke: "#fff", strokeWidth: 2 }}
                isAnimationActive={false}
              />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      )}
      <details className="bdash-table-toggle">
        <summary>Show as table</summary>
        <div className="fset__scroll">
          <table className="flow-table brep-table" aria-label="Revenue and collections">
            <thead>
              <tr>
                <th scope="col">{PERIOD_LABELS[period]}</th>
                <th scope="col" className="brep-num">
                  Net revenue
                </th>
                <th scope="col" className="brep-num">
                  Collected
                </th>
                <th scope="col" className="brep-num">
                  Pending
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.bucket}>
                  <th scope="row">
                    {row.label}
                    {row.partial ? " (part)" : ""}
                  </th>
                  <td className="brep-num">{money(row.net_revenue)}</td>
                  <td className="brep-num">{money(row.collected)}</td>
                  <td className="brep-num">{money(row.pending)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </section>
  );
}
