import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { SERIES } from "../../crm/progress/progressText";
import { bucketLabel, compactMoney, money, PERIOD_LABELS } from "./dashboardText";
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
  const pick = (entry) => entry?.payload && period !== "day" && onPick(entry.payload);
  return (
    <section className="flow-card bdash-card" aria-labelledby="bdash-trend">
      <div className="fset__cardhead">
        <h2 id="bdash-trend" className="flow-sec-title">
          Revenue and collections by {PERIOD_LABELS[period].toLowerCase()}
        </h2>
        <ReportLink report="collections" title="Collections" filters={data.filters} />
      </div>
      <div className="fset__cardsub">
        Revenue counts on the bill date; collections on the day the money was taken, so a due paid
        later shows up on the later day.
      </div>
      {empty ? (
        <div className="bill-allclear">No revenue or collections in this range.</div>
      ) : (
        <div className="bdash-chart">
          <ResponsiveContainer width="100%" height={280}>
            <BarChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: 8 }} barGap={2}>
              <CartesianGrid stroke="#e2e8f0" vertical={false} />
              <XAxis
                dataKey="label"
                tick={AXIS}
                tickLine={false}
                axisLine={{ stroke: "#cbd5e1" }}
                minTickGap={12}
              />
              <YAxis
                tick={AXIS}
                tickLine={false}
                axisLine={false}
                width={56}
                tickFormatter={compactMoney}
              />
              <Tooltip content={<TrendTip />} cursor={{ fill: "rgba(148, 163, 184, 0.15)" }} />
              <Legend
                wrapperStyle={{ fontSize: 12 }}
                formatter={(name) => <span className="bdash-legend">{name}</span>}
              />
              {SERIES_OF.map((series) => (
                <Bar
                  key={series.key}
                  dataKey={series.key}
                  name={series.label}
                  fill={series.color}
                  radius={[4, 4, 0, 0]}
                  maxBarSize={28}
                  isAnimationActive={false}
                  cursor={period !== "day" ? "pointer" : undefined}
                  onClick={pick}
                />
              ))}
            </BarChart>
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
