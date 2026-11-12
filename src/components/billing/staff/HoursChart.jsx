import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { SERIES } from "../../crm/progress/progressText";
import { count, money } from "../dashboard/dashboardText";

const AXIS = { fontSize: 12, fill: "#475569" };
const hourLabel = (hour) => `${hour % 12 || 12}${hour < 12 ? "am" : "pm"}`;

function HourTip({ active, payload }) {
  if (!active || !payload?.length) return null;
  const row = payload[0].payload;
  return (
    <div className="bdash-tip">
      <div className="bdash-tip__title">
        {hourLabel(row.hour)}–{hourLabel(row.hour + 1)}
      </div>
      <div className="bdash-tip__row">
        Payments <strong>{count(row.payments)}</strong>
      </div>
      <div className="bdash-tip__row">
        Amount <strong>{money(row.amount)}</strong>
      </div>
    </div>
  );
}

export default function HoursChart({ hours }) {
  if (!hours.length) return null;
  const first = Math.min(8, ...hours.map((row) => row.hour));
  const last = Math.max(19, ...hours.map((row) => row.hour));
  const rows = [];
  for (let hour = first; hour <= last; hour += 1) {
    const found = hours.find((row) => row.hour === hour);
    rows.push({
      hour,
      label: hourLabel(hour),
      payments: found?.payments ?? 0,
      amount: found?.amount ?? 0,
    });
  }
  return (
    <section className="flow-card bdash-card" aria-labelledby="sd-hours">
      <div className="fset__cardhead">
        <h2 id="sd-hours" className="flow-sec-title">
          Payments by hour of day
        </h2>
      </div>
      <div className="bdash-chart">
        <ResponsiveContainer width="100%" height={200}>
          <BarChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid stroke="#e2e8f0" vertical={false} />
            <XAxis dataKey="label" tick={AXIS} tickLine={false} axisLine={{ stroke: "#cbd5e1" }} />
            <YAxis tick={AXIS} tickLine={false} axisLine={false} width={36} allowDecimals={false} />
            <Tooltip content={<HourTip />} cursor={{ fill: "rgba(148, 163, 184, 0.15)" }} />
            <Bar
              dataKey="payments"
              fill={SERIES[0]}
              radius={[4, 4, 0, 0]}
              maxBarSize={28}
              isAnimationActive={false}
            />
          </BarChart>
        </ResponsiveContainer>
      </div>
      <details className="bdash-table-toggle">
        <summary>Show as table</summary>
        <div className="fset__scroll">
          <table className="flow-table brep-table bdash-small" aria-label="Payments by hour">
            <thead>
              <tr>
                <th scope="col">Hour</th>
                <th scope="col" className="brep-num">
                  Payments
                </th>
                <th scope="col" className="brep-num">
                  Amount
                </th>
              </tr>
            </thead>
            <tbody>
              {rows
                .filter((row) => row.payments)
                .map((row) => (
                  <tr key={row.hour}>
                    <th scope="row">
                      {hourLabel(row.hour)}–{hourLabel(row.hour + 1)}
                    </th>
                    <td className="brep-num">{count(row.payments)}</td>
                    <td className="brep-num">{money(row.amount)}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </details>
    </section>
  );
}
