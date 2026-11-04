import { useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  LabelList,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { SERIES } from "../../crm/progress/progressText";
import { compactMoney, money } from "./dashboardText";
import ReportLink from "./ReportLink";

const AXIS = { fontSize: 12, fill: "#475569" };
const ROW_HEIGHT = 30;

const SPLITS = [
  { key: "groups", label: "Service group", report: "revenue_items", title: "Revenue by service" },
  {
    key: "categories",
    label: "Category",
    report: "revenue_categories",
    title: "Revenue by category",
  },
  {
    key: "consultants",
    label: "Consultant",
    report: "revenue_consultants",
    title: "Revenue by consultant",
  },
];

function NetTip({ active, payload }) {
  if (!active || !payload?.length) return null;
  const row = payload[0].payload;
  return (
    <div className="bdash-tip">
      <div className="bdash-tip__title">{row.label}</div>
      <div className="bdash-tip__row">
        <strong>{money(row.net)}</strong>
        {row.count ? ` across ${row.count} more` : ""}
      </div>
    </div>
  );
}

function HorizontalBars({ rows, title, valueLabel }) {
  if (!rows.length) return <div className="bill-allclear">Nothing in this range.</div>;
  return (
    <>
      <div className="bdash-chart">
        <ResponsiveContainer width="100%" height={Math.max(120, rows.length * ROW_HEIGHT + 40)}>
          <BarChart
            data={rows}
            layout="vertical"
            margin={{ top: 4, right: 72, bottom: 4, left: 8 }}
          >
            <CartesianGrid stroke="#e2e8f0" horizontal={false} />
            <XAxis
              type="number"
              tick={AXIS}
              tickLine={false}
              axisLine={false}
              tickFormatter={compactMoney}
            />
            <YAxis
              type="category"
              dataKey="label"
              tick={AXIS}
              tickLine={false}
              axisLine={{ stroke: "#cbd5e1" }}
              width={150}
              interval={0}
              tickFormatter={(name) => (name.length > 22 ? `${name.slice(0, 21)}…` : name)}
            />
            <Tooltip content={<NetTip />} cursor={{ fill: "rgba(148, 163, 184, 0.15)" }} />
            <Bar
              dataKey="net"
              name={valueLabel}
              fill={SERIES[0]}
              radius={[0, 4, 4, 0]}
              maxBarSize={18}
              isAnimationActive={false}
            >
              <LabelList
                dataKey="net"
                position="right"
                formatter={compactMoney}
                style={{ fontSize: 12, fill: "#334155" }}
              />
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
      <details className="bdash-table-toggle">
        <summary>Show as table</summary>
        <div className="fset__scroll">
          <table className="flow-table brep-table" aria-label={title}>
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col" className="brep-num">
                  {valueLabel}
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={`${row.key}`}>
                  <th scope="row">{row.label}</th>
                  <td className="brep-num">{money(row.net)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </>
  );
}

export function RevenueMix({ data }) {
  const [split, setSplit] = useState("groups");
  const chosen = SPLITS.find((option) => option.key === split);
  const rows = data.mix[split].filter((row) => row.net !== 0);
  return (
    <section className="flow-card bdash-card" aria-labelledby="bdash-mix">
      <div className="fset__cardhead">
        <h2 id="bdash-mix" className="flow-sec-title">
          Revenue by {chosen.label.toLowerCase()}
        </h2>
        <div className="bdash-seg" role="group" aria-label="Split revenue by">
          {SPLITS.map((option) => (
            <button
              key={option.key}
              type="button"
              className={`flow-btn flow-btn-mini ${split === option.key ? "flow-btn-primary" : "flow-btn-ghost"}`}
              aria-pressed={split === option.key}
              onClick={() => setSplit(option.key)}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>
      <div className="fset__cardsub">
        Charges less discounts on billed visits, before tax.{" "}
        <ReportLink report={chosen.report} title={chosen.title} filters={data.filters} />
      </div>
      <HorizontalBars
        rows={rows}
        title={`Revenue by ${chosen.label.toLowerCase()}`}
        valueLabel="Revenue"
      />
    </section>
  );
}

export function PaymentModes({ data }) {
  const rows = data.columns.money
    .map((column) => ({
      key: column.key,
      label: column.label,
      net: data.total.money[column.key] ?? 0,
    }))
    .filter((row) => row.net !== 0);
  return (
    <section className="flow-card bdash-card" aria-labelledby="bdash-modes">
      <div className="fset__cardhead">
        <h2 id="bdash-modes" className="flow-sec-title">
          Collected by payment mode
        </h2>
      </div>
      <div className="fset__cardsub">
        Money taken less refunds paid back. HealthRay payments count under the mode they were paid
        by, when it was recorded.{" "}
        <ReportLink report="collections" title="Collections" filters={data.filters} />
      </div>
      <HorizontalBars rows={rows} title="Collected by payment mode" valueLabel="Collected" />
    </section>
  );
}
