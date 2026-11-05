import { Link, useNavigate } from "react-router-dom";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { SERIES } from "../../crm/progress/progressText";
import { useIsMobile } from "../../../hooks/useIsMobile";
import { count } from "../../billing/dashboard/dashboardText";
import { visitsHref } from "./opdFilters";

const AXIS = { fontSize: 12, fill: "#475569" };
const ROW_HEIGHT = 30;
const PARTS = [
  { key: "completed", label: "Completed", color: SERIES[0] },
  { key: "open", label: "In progress / not closed", color: "#94a3b8" },
  { key: "didNotCome", label: "Did not come", color: SERIES[1] },
  { key: "waiting", label: "Pending / not updated", color: "#cbd5e1" },
];

function ConsultantTip({ active, payload }) {
  if (!active || !payload?.length) return null;
  const row = payload[0].payload;
  return (
    <div className="bdash-tip">
      <div className="bdash-tip__title">{row.label}</div>
      {PARTS.map((part) => (
        <div key={part.key} className="bdash-tip__row">
          <span className="bdash-key" style={{ background: part.color }} aria-hidden="true" />
          {part.label}
          <strong>{count(row[part.key])}</strong>
        </div>
      ))}
      {row.doctor ? <div className="bdash-tip__hint">Click to list these patients</div> : null}
    </div>
  );
}

export default function ConsultantBars({ data, filters, back }) {
  const navigate = useNavigate();
  const narrow = useIsMobile(640);
  const nameMax = narrow ? 14 : 28;
  const { shown, others } = data.consultants;
  const rows = [
    ...shown.map((c) => ({ ...c, label: c.doctor })),
    ...(others ? [{ ...others, doctor: null, label: `Others (${others.count})` }] : []),
  ].map((c) => ({
    ...c,
    open: c.inProgress + c.notClosed,
    waiting: c.pending + c.notUpdated,
  }));
  const hrefOf = (row) => visitsHref(filters, { state: "booked", doctors: [row.doctor] });
  const pick = (state) => {
    const row = state?.activePayload?.[0]?.payload;
    if (row?.doctor) navigate(hrefOf(row), { state: { back } });
  };
  return (
    <section className="flow-card bdash-card" aria-labelledby="opd-consultants">
      <div className="fset__cardhead">
        <h2 id="opd-consultants" className="flow-sec-title">
          By consultant
        </h2>
        <span className="fset__count">{shown.length + (others?.count ?? 0)}</span>
      </div>
      <div className="fset__cardsub">
        Busiest first, by the doctor named on the HealthRay appointment. Click a bar to list that
        consultant&apos;s patients.
      </div>
      {!rows.length ? (
        <div className="bdash-empty">No consultants had appointments in these dates.</div>
      ) : (
        <>
          <div
            className="bdash-chart"
            role="img"
            aria-label="Visits by consultant, shown as a table below"
          >
            <ResponsiveContainer width="100%" height={Math.max(120, rows.length * ROW_HEIGHT + 40)}>
              <BarChart
                data={rows}
                layout="vertical"
                margin={{ top: 4, right: 16, bottom: 4, left: narrow ? 0 : 8 }}
                onClick={pick}
                style={{ cursor: "pointer" }}
              >
                <CartesianGrid stroke="#e2e8f0" horizontal={false} />
                <XAxis
                  hide={narrow}
                  type="number"
                  tick={AXIS}
                  tickLine={false}
                  axisLine={false}
                  allowDecimals={false}
                />
                <YAxis
                  type="category"
                  dataKey="label"
                  tick={AXIS}
                  tickLine={false}
                  axisLine={{ stroke: "#cbd5e1" }}
                  width={narrow ? 104 : 190}
                  interval={0}
                  tickFormatter={(name) =>
                    name.length > nameMax ? `${name.slice(0, nameMax - 1)}…` : name
                  }
                />
                <Tooltip
                  content={<ConsultantTip />}
                  cursor={{ fill: "rgba(148, 163, 184, 0.15)" }}
                />
                {PARTS.map((part) => (
                  <Bar
                    key={part.key}
                    dataKey={part.key}
                    name={part.label}
                    stackId="c"
                    fill={part.color}
                    maxBarSize={18}
                    isAnimationActive={false}
                  />
                ))}
              </BarChart>
            </ResponsiveContainer>
          </div>
          <ul className="bdash-keys">
            {PARTS.map((part) => (
              <li key={part.key} className="bdash-keys__item">
                <span className="bdash-key" style={{ background: part.color }} aria-hidden="true" />
                {part.label}
              </li>
            ))}
          </ul>
          <details className="bdash-table-toggle">
            <summary>Show as table</summary>
            <div className="fset__scroll">
              <table className="flow-table brep-table" aria-label="Visits by consultant">
                <thead>
                  <tr>
                    <th scope="col">Consultant</th>
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
                    <tr key={row.label}>
                      <th scope="row">
                        {row.doctor ? (
                          <Link to={hrefOf(row)} state={{ back }}>
                            {row.label}
                          </Link>
                        ) : (
                          row.label
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
        </>
      )}
    </section>
  );
}
