import { Link, useNavigate } from "react-router-dom";
import {
  Bar,
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
import {
  bucketLabel,
  count,
  PERIOD_LABELS,
  rangeLabel,
} from "../../billing/dashboard/dashboardText";
import { visitsHref } from "./opdFilters";

const AXIS = { fontSize: 12, fill: "#475569" };
const PARTS = [
  { key: "completed", label: "Completed", color: SERIES[0] },
  { key: "inProgress", label: "In progress", color: SERIES[2] },
  { key: "notClosed", label: "Not closed in HealthRay", color: "#94a3b8" },
  { key: "didNotCome", label: "Did not come", color: SERIES[1] },
  { key: "waiting", label: "Pending / not updated", color: "#cbd5e1" },
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
      {PARTS.map((part) => (
        <div key={part.key} className="bdash-tip__row">
          <span className="bdash-key" style={{ background: part.color }} aria-hidden="true" />
          {part.label}
          <strong>{count(row[part.key])}</strong>
        </div>
      ))}
      {row.previousCame !== null ? (
        <div className="bdash-tip__row">
          Visits in the earlier period <strong>{count(row.previousCame)}</strong>
        </div>
      ) : null}
      {row.booked ? <div className="bdash-tip__hint">Click to list these patients</div> : null}
    </div>
  );
}

export default function VisitTrend({ data, filters, back }) {
  const navigate = useNavigate();
  const group = data.group;
  const rows = data.trend.map((row) => ({
    ...row,
    label: bucketLabel(row, group),
    waiting: row.pending + row.notUpdated,
  }));
  const hrefOf = (row) => visitsHref(filters, { state: "booked", group, bucket_start: row.bucket });
  const pick = (state) => {
    const row = state?.activePayload?.[0]?.payload;
    if (row?.booked) navigate(hrefOf(row), { state: { back } });
  };
  return (
    <section className="flow-card bdash-card" aria-labelledby="opd-trend">
      <div className="fset__cardhead">
        <h2 id="opd-trend" className="flow-sec-title">
          Visits by {PERIOD_LABELS[group].toLowerCase()}
        </h2>
      </div>
      <div className="fset__cardsub">
        {count(data.totals.came)} visits for {rangeLabel(data.from, data.to)}. The line shows visits
        for {rangeLabel(data.compare.from, data.compare.to)}. Click a column to list its patients.
      </div>
      <div
        className="bdash-chart"
        role="img"
        aria-label={`Visits by ${group}, shown as a table below`}
      >
        <ResponsiveContainer width="100%" height={280}>
          <ComposedChart
            data={rows}
            margin={{ top: 8, right: 12, bottom: 0, left: 0 }}
            onClick={pick}
            style={{ cursor: "pointer" }}
          >
            <CartesianGrid stroke="#e2e8f0" vertical={false} />
            <XAxis
              dataKey="label"
              tick={AXIS}
              tickLine={false}
              axisLine={{ stroke: "#cbd5e1" }}
              minTickGap={16}
            />
            <YAxis tick={AXIS} tickLine={false} axisLine={false} width={40} allowDecimals={false} />
            <Tooltip content={<TrendTip />} cursor={{ fill: "rgba(148, 163, 184, 0.15)" }} />
            <Legend
              wrapperStyle={{ fontSize: 12 }}
              formatter={(name) => <span className="bdash-legend">{name}</span>}
            />
            {PARTS.map((part) => (
              <Bar
                key={part.key}
                dataKey={part.key}
                name={part.label}
                stackId="visits"
                fill={part.color}
                maxBarSize={36}
                isAnimationActive={false}
              />
            ))}
            <Line
              type="linear"
              dataKey="previousCame"
              name="Visits in the earlier period"
              stroke="#334155"
              strokeWidth={1.5}
              strokeDasharray="4 3"
              dot={rows.length <= 14 ? { r: 3 } : false}
              isAnimationActive={false}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <details className="bdash-table-toggle">
        <summary>Show as table</summary>
        <div className="fset__scroll">
          <table className="flow-table brep-table" aria-label="Visits by period">
            <thead>
              <tr>
                <th scope="col">{PERIOD_LABELS[group]}</th>
                <th scope="col" className="brep-num">
                  Visits
                </th>
                {PARTS.map((part) => (
                  <th key={part.key} scope="col" className="brep-num">
                    {part.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.bucket}>
                  <th scope="row">
                    {row.booked ? (
                      <Link to={hrefOf(row)} state={{ back }}>
                        {row.label}
                        {row.partial ? " (part)" : ""}
                      </Link>
                    ) : (
                      <>
                        {row.label}
                        {row.partial ? " (part)" : ""}
                      </>
                    )}
                  </th>
                  <td className="brep-num">{count(row.came)}</td>
                  {PARTS.map((part) => (
                    <td key={part.key} className="brep-num">
                      {count(row[part.key])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </section>
  );
}
