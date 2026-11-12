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
import { useIsMobile } from "../../../hooks/useIsMobile";
import { HEALTHRAY_MODE } from "../../../../shared/billingVocab.js";
import { compactMoney, money, shareOf } from "./dashboardText";
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

function BarTag({ x, y, width, height, value }) {
  return (
    <text
      x={x + Math.max(width, 0) + 6}
      y={y + height / 2}
      dominantBaseline="central"
      fontSize={12}
      fill="#334155"
    >
      {value}
    </text>
  );
}

function HorizontalBars({ rows, title, valueLabel }) {
  const narrow = useIsMobile(640);
  const nameMax = narrow ? 14 : 28;
  if (!rows.length) return <div className="bill-allclear">Nothing in this range.</div>;
  return (
    <>
      <div className="bdash-chart">
        <ResponsiveContainer width="100%" height={Math.max(120, rows.length * ROW_HEIGHT + 40)}>
          <BarChart
            data={rows}
            layout="vertical"
            margin={{ top: 4, right: narrow ? 92 : 120, bottom: 4, left: narrow ? 0 : 8 }}
          >
            <CartesianGrid stroke="#cbd5e1" horizontal={false} />
            <XAxis
              hide={narrow}
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
              axisLine={{ stroke: "#64748b" }}
              width={narrow ? 104 : 190}
              interval={0}
              tickFormatter={(name) =>
                name.length > nameMax ? `${name.slice(0, nameMax - 1)}…` : name
              }
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
              <LabelList dataKey="tag" content={BarTag} />
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
  const shown = data.mix[split].filter((row) => row.net !== 0);
  const whole = shown.reduce((sum, row) => sum + row.net, 0);
  const rows = shown.map((row) => ({
    ...row,
    tag: `${compactMoney(row.net)} · ${shareOf(row.net, whole)}`,
  }));
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

const UNKNOWN_SHADES = { upi_unknown: "#cbd5e1", [HEALTHRAY_MODE]: "#94a3b8" };

export function PaymentModes({ data }) {
  const known = data.columns.money.filter((column) => !UNKNOWN_SHADES[column.key]);
  const colorOf = (key) =>
    UNKNOWN_SHADES[key] ?? SERIES[known.findIndex((column) => column.key === key) % SERIES.length];
  const parts = data.columns.money
    .map((column) => ({
      key: column.key,
      label: column.label,
      net: data.total.money[column.key] ?? 0,
      color: colorOf(column.key),
    }))
    .filter((part) => part.net !== 0);
  const positive = parts.filter((part) => part.net > 0);
  const whole = positive.reduce((sum, part) => sum + part.net, 0);
  const summary = positive.map((part) => `${part.label} ${shareOf(part.net, whole)}`).join(", ");
  return (
    <section className="flow-card bdash-card" aria-labelledby="bdash-modes">
      <div className="fset__cardhead">
        <h2 id="bdash-modes" className="flow-sec-title">
          Collected by payment mode
        </h2>
        <ReportLink report="collections" title="Collections" filters={data.filters} />
      </div>
      {!parts.length ? (
        <div className="bill-allclear">Nothing collected in this range.</div>
      ) : (
        <>
          <div className="bdash-segbar" role="img" aria-label={`Share of collections: ${summary}`}>
            {positive.map((part) => (
              <span
                key={part.key}
                className="bdash-segbar__part"
                style={{ flexGrow: part.net, background: part.color }}
                title={`${part.label}: ${money(part.net)} (${shareOf(part.net, whole)})`}
              />
            ))}
          </div>
          <ul className="bdash-segbar__legend">
            {parts.map((part) => (
              <li key={part.key}>
                <span className="bdash-key" style={{ background: part.color }} aria-hidden="true" />
                <span className="bdash-segbar__name">{part.label}</span>
                <strong>{money(part.net)}</strong>
                <span className="bdash-muted">
                  {part.net > 0 ? shareOf(part.net, whole) : "refunds"}
                </span>
              </li>
            ))}
            <li className="bdash-segbar__total">
              <span className="bdash-segbar__name">Total collected</span>
              <strong>{money(data.total.collected)}</strong>
            </li>
          </ul>
        </>
      )}
    </section>
  );
}
