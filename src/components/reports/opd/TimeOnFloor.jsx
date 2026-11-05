import { Link } from "react-router-dom";
import {
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import Shimmer from "../../Shimmer";
import { errorOf } from "../../billing/format";
import { SERIES } from "../../crm/progress/progressText";
import { bucketLabel, count, PERIOD_LABELS } from "../../billing/dashboard/dashboardText";
import { OPD_DEFINITIONS, OPD_STATION_MIN_CASES } from "../../../../shared/opdMetrics.js";

const AXIS = { fontSize: 12, fill: "#475569" };
const minutes = (value) => (value === null || value === undefined ? "—" : `${value} min`);
const percent = (value) => (value === null || value === undefined ? "—" : `${value}%`);

function TimeTip({ active, payload }) {
  if (!active || !payload?.length) return null;
  const row = payload[0].payload;
  return (
    <div className="bdash-tip">
      <div className="bdash-tip__title">
        {row.label}
        {row.partial ? " (part)" : ""}
      </div>
      <div className="bdash-tip__row">
        Typical visit length <strong>{minutes(row.visitLength)}</strong>
      </div>
      <div className="bdash-tip__row">
        Typical wait <strong>{minutes(row.waiting)}</strong>
      </div>
      <div className="bdash-tip__row">
        On time <strong>{percent(row.onTimePct)}</strong>
      </div>
      <div className="bdash-tip__row">
        Visits timed <strong>{count(row.timed)}</strong>
      </div>
    </div>
  );
}

function Stations({ stations }) {
  const judged = stations
    .filter((s) => s.total_count >= OPD_STATION_MIN_CASES)
    .map((s) => {
      const planned = Math.round(Number(s.avg_budget));
      const typical = Math.round(Number(s.median_actual ?? s.avg_actual));
      return { ...s, planned, typical, extra: typical - planned };
    })
    .sort((a, b) => b.extra - a.extra);
  const skipped = stations.length - judged.length;
  if (!judged.length) {
    return <div className="bdash-empty">Too few completed station steps to judge.</div>;
  }
  return (
    <>
      <ol className="opd-stations">
        {judged.map((s) => {
          const scale = Math.max(s.planned, s.typical, 1);
          return (
            <li key={s.station}>
              <div className="opd-station__head">
                <strong>{s.step_name}</strong>
                <span>
                  {s.extra > 0
                    ? `+${s.extra} min over`
                    : s.extra < 0
                      ? `${-s.extra} min under`
                      : "On plan"}
                  {" · "}
                  {count(s.exceeded_count)} of {count(s.total_count)} over
                </span>
              </div>
              <div className="opd-station__bar">
                <span>Planned {s.planned} min</span>
                <span className="opd-funnel__track">
                  <span
                    className="opd-funnel__bar"
                    style={{ width: `${(100 * s.planned) / scale}%`, background: "#94a3b8" }}
                  />
                </span>
              </div>
              <div className="opd-station__bar">
                <span>Typical {s.typical} min</span>
                <span className="opd-funnel__track">
                  <span
                    className="opd-funnel__bar"
                    style={{
                      width: `${(100 * s.typical) / scale}%`,
                      background: s.extra > 0 ? SERIES[1] : SERIES[0],
                    }}
                  />
                </span>
              </div>
            </li>
          );
        })}
      </ol>
      {skipped > 0 ? (
        <p className="bdash-foot">
          {count(skipped)} {skipped === 1 ? "station" : "stations"} not shown: fewer than{" "}
          {OPD_STATION_MIN_CASES} completed cases.
        </p>
      ) : null}
    </>
  );
}

export default function TimeOnFloor({ result, canOpenFlowReports }) {
  const data = result.data;
  const rows = (data?.trend ?? []).map((row) => ({
    ...row,
    label: bucketLabel(row, data.group),
  }));
  return (
    <section className="flow-card bdash-card" id="opd-times" aria-labelledby="opd-times-title">
      <div className="fset__cardhead">
        <h2 id="opd-times-title" className="flow-sec-title">
          Time on the floor
        </h2>
        {canOpenFlowReports ? (
          <Link className="flow-btn flow-btn-mini flow-btn-ghost" to="/giniflow/reports">
            Flow Reports
          </Link>
        ) : null}
      </div>
      {result.isError ? (
        <div className="brep-error" role="alert">
          {errorOf(result.error, "Could not load the floor times")}
          <button type="button" className="flow-btn flow-btn-mini" onClick={() => result.refetch()}>
            Try again
          </button>
        </div>
      ) : !data ? (
        <Shimmer type="stats" count={2} />
      ) : !data.enough ? (
        <div className="bdash-empty">
          Too few visits were tracked on the floor to show times: {count(data.timed)} of{" "}
          {count(data.visits)} had an exit recorded, and at least {data.minVisits} are needed.
          Visits closed automatically at midnight, tele and lab-only visits are not timed.
        </div>
      ) : (
        <>
          <div className="fset__cardsub">
            Timed {count(data.timed)} of {count(data.visits)} visits.
            {data.timed < data.visits
              ? " The rest had no exit recorded on Gini Flow, including visits closed automatically at midnight."
              : ""}{" "}
            Tele and lab-only visits are never timed. Typical means the middle visit.
          </div>
          <ul className="opd-sides">
            <li title={OPD_DEFINITIONS.visit_length}>
              <strong>{minutes(data.visitLength)}</strong> typical visit length
            </li>
            <li title={OPD_DEFINITIONS.waiting}>
              <strong>{minutes(data.waiting)}</strong> typical wait for the first consultation
            </li>
            <li title={OPD_DEFINITIONS.on_time}>
              <strong>{percent(data.onTimePct)}</strong> on time
              {data.target ? ` within ${data.target} min` : ""}
            </li>
          </ul>
          <div
            className="bdash-chart"
            role="img"
            aria-label="Typical visit length and wait over time, shown as a table below"
          >
            <ResponsiveContainer width="100%" height={240}>
              <ComposedChart data={rows} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
                <CartesianGrid stroke="#e2e8f0" vertical={false} />
                <XAxis
                  dataKey="label"
                  tick={AXIS}
                  tickLine={false}
                  axisLine={{ stroke: "#cbd5e1" }}
                  minTickGap={16}
                />
                <YAxis
                  tick={AXIS}
                  tickLine={false}
                  axisLine={false}
                  width={44}
                  allowDecimals={false}
                  unit="m"
                />
                <Tooltip content={<TimeTip />} />
                <Legend
                  wrapperStyle={{ fontSize: 12 }}
                  formatter={(name) => <span className="bdash-legend">{name}</span>}
                />
                {data.target ? (
                  <ReferenceLine y={data.target} stroke="#94a3b8" strokeDasharray="4 3" />
                ) : null}
                <Line
                  dataKey="visitLength"
                  name="Typical visit length"
                  stroke={SERIES[0]}
                  strokeWidth={2}
                  dot={rows.length <= 14}
                  connectNulls
                  isAnimationActive={false}
                />
                <Line
                  dataKey="waiting"
                  name="Typical wait"
                  stroke={SERIES[1]}
                  strokeWidth={2}
                  dot={rows.length <= 14}
                  connectNulls
                  isAnimationActive={false}
                />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
          <details className="bdash-table-toggle">
            <summary>Show as table</summary>
            <div className="fset__scroll">
              <table className="flow-table brep-table" aria-label="Floor times by period">
                <thead>
                  <tr>
                    <th scope="col">{PERIOD_LABELS[data.group]}</th>
                    <th scope="col" className="brep-num">
                      Visit length
                    </th>
                    <th scope="col" className="brep-num">
                      Wait
                    </th>
                    <th scope="col" className="brep-num">
                      On time
                    </th>
                    <th scope="col" className="brep-num">
                      Timed
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.bucket}>
                      <th scope="row">{row.label}</th>
                      <td className="brep-num">{minutes(row.visitLength)}</td>
                      <td className="brep-num">{minutes(row.waiting)}</td>
                      <td className="brep-num">{percent(row.onTimePct)}</td>
                      <td className="brep-num">{count(row.timed)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
          <h3 className="flow-sec-title opd-subhead">Where the time goes</h3>
          <div className="fset__cardsub">
            Planned against typical minutes at each station, longest overrun first. Plans come from
            Time budgets.
          </div>
          <Stations stations={data.stations} />
        </>
      )}
    </section>
  );
}
