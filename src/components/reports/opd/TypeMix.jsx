import { Link } from "react-router-dom";
import { Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { SERIES } from "../../crm/progress/progressText";
import { bucketLabel, count, shareOf } from "../../billing/dashboard/dashboardText";
import { visitsHref } from "./opdFilters";

const AXIS = { fontSize: 11, fill: "#475569" };

export default function TypeMix({ data, filters, back }) {
  const parts = data.types.map((type, index) => ({
    ...type,
    color: SERIES[index % SERIES.length],
  }));
  const shown = parts.filter((part) => part.came > 0);
  const whole = shown.reduce((sum, part) => sum + part.came, 0);
  const summary = shown.map((part) => `${part.label} ${shareOf(part.came, whole)}`).join(", ");
  const rows = data.trend.map((row) => ({ ...row, label: bucketLabel(row, data.group) }));
  const hasTrend = rows.length > 1 && rows.some((row) => row.new || row.followUp);
  return (
    <section className="flow-card bdash-card" aria-labelledby="opd-types">
      <div className="fset__cardhead">
        <h2 id="opd-types" className="flow-sec-title">
          Patient type
        </h2>
      </div>
      <div className="fset__cardsub">
        Visits by type. This chart always shows every type. Click a type to list its patients.
      </div>
      {!shown.length ? (
        <div className="bdash-empty">No visits of any type in these dates.</div>
      ) : (
        <>
          <div className="bdash-segbar" role="img" aria-label={`Share of visits: ${summary}`}>
            {shown.map((part) => (
              <span
                key={part.key}
                className="bdash-segbar__part"
                style={{ flexGrow: part.came, background: part.color }}
                title={`${part.label}: ${count(part.came)} (${shareOf(part.came, whole)})`}
              />
            ))}
          </div>
          <ul className="bdash-segbar__legend">
            {parts.map((part) => (
              <li key={part.key}>
                <span className="bdash-key" style={{ background: part.color }} aria-hidden="true" />
                <Link
                  className="bdash-segbar__name"
                  to={visitsHref(filters, { state: "came", type: part.key })}
                  state={{ back }}
                >
                  {part.label}
                  {part.selected && filters.type !== "all" && filters.type !== "opd"
                    ? " (selected)"
                    : ""}
                </Link>
                <strong>{count(part.came)}</strong>
                <span className="bdash-muted">{shareOf(part.came, whole)}</span>
              </li>
            ))}
          </ul>
          {hasTrend ? (
            <div className="opd-mini" role="img" aria-label="New and follow-up visits over time">
              <div className="opd-mini__title">New and follow-up over time</div>
              <ResponsiveContainer width="100%" height={110}>
                <LineChart data={rows} margin={{ top: 6, right: 8, bottom: 0, left: 0 }}>
                  <XAxis dataKey="label" tick={AXIS} tickLine={false} minTickGap={24} />
                  <YAxis
                    tick={AXIS}
                    tickLine={false}
                    axisLine={false}
                    width={32}
                    allowDecimals={false}
                  />
                  <Tooltip />
                  <Line
                    dataKey="new"
                    name="New"
                    stroke={SERIES[0]}
                    strokeWidth={2}
                    dot={false}
                    isAnimationActive={false}
                  />
                  <Line
                    dataKey="followUp"
                    name="Follow-up"
                    stroke={SERIES[1]}
                    strokeWidth={2}
                    dot={false}
                    isAnimationActive={false}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}
