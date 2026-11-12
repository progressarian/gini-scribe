import { Link } from "react-router-dom";
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
import { receptionBillHref } from "../counter/billHref";
import ReportLink from "./ReportLink";
import {
  bucketLabel,
  compactMoney,
  count,
  fullDayLabel,
  money,
  niceAxis,
  PERIOD_LABELS,
} from "./dashboardText";

const AXIS = { fontSize: 12, fill: "#475569" };
const pctText = (pct) => (pct === null || pct === undefined ? "—" : `${pct}%`);

function DiscountTip({ active, payload, methods }) {
  if (!active || !payload?.length) return null;
  const row = payload[0].payload;
  return (
    <div className="bdash-tip">
      <div className="bdash-tip__title">
        {row.label}
        {row.partial ? " (part)" : ""}
      </div>
      {methods.map((method) => (
        <div key={method.key} className="bdash-tip__row">
          <span className="bdash-key" style={{ background: method.color }} aria-hidden="true" />
          {method.label}
          <strong>{money(row[method.key])}</strong>
        </div>
      ))}
      <div className="bdash-tip__row">
        Total <strong>{money(row.given)}</strong>
      </div>
      <div className="bdash-tip__row">
        Of charges <strong>{pctText(row.pct)}</strong>
      </div>
    </div>
  );
}

function SmallTable({ title, rows, columns, empty = "No discounts in this range." }) {
  return (
    <div className="bdash-subcard">
      <h3 className="bdash-subtitle">{title}</h3>
      {rows.length ? (
        <div className="fset__scroll">
          <table className="flow-table brep-table bdash-small" aria-label={title}>
            <thead>
              <tr>
                {columns.map((column) => (
                  <th key={column.key} scope="col" className={column.num ? "brep-num" : undefined}>
                    {column.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={String(row.key)}>
                  {columns.map((column, index) =>
                    index === 0 ? (
                      <th key={column.key} scope="row" className="bdash-wrap">
                        {column.render(row)}
                      </th>
                    ) : (
                      <td key={column.key} className={column.num ? "brep-num" : undefined}>
                        {column.render(row)}
                      </td>
                    ),
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="bdash-muted bdash-small-empty">{empty}</div>
      )}
    </div>
  );
}

const amountColumns = [
  { key: "steps", label: "Times", num: true, render: (row) => count(row.steps) },
  { key: "amount", label: "Discount", num: true, render: (row) => money(row.amount) },
];

export default function DiscountPanel({ data }) {
  const period = data.filters.period;
  const block = data.discounts;
  const methods = block.methods.map((method, index) => ({ ...method, color: SERIES[index] }));
  const rows = block.rows.map((row) => ({ ...row, label: bucketLabel(row, period) }));
  const discountAxis = niceAxis(rows.map((row) => row.given));
  const empty = !block.total.given;
  const last = methods.length - 1;
  return (
    <section className="flow-card bdash-card" aria-labelledby="bdash-discounts">
      <div className="fset__cardhead">
        <h2 id="bdash-discounts" className="flow-sec-title">
          Discounts
        </h2>
        <ReportLink report="discounts" title="Discounts" filters={data.filters} />
      </div>
      <dl className="bdash-methods">
        {methods.map((method) => (
          <div key={method.key}>
            <dt>
              <span className="bdash-key" style={{ background: method.color }} aria-hidden="true" />
              {method.label}
            </dt>
            <dd>{money(block.total[method.key])}</dd>
          </div>
        ))}
      </dl>
      {empty ? (
        <div className="bill-allclear">No discounts given in this range.</div>
      ) : (
        <>
          <h3 className="bdash-subtitle">By {PERIOD_LABELS[period].toLowerCase()}</h3>
          <div className="bdash-chart">
            <ResponsiveContainer width="100%" height={240}>
              <BarChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: 8 }}>
                <CartesianGrid stroke="#cbd5e1" vertical={false} />
                <XAxis
                  dataKey="label"
                  tick={AXIS}
                  tickLine={false}
                  axisLine={{ stroke: "#64748b" }}
                  minTickGap={12}
                />
                <YAxis
                  tick={AXIS}
                  tickLine={false}
                  axisLine={false}
                  width={56}
                  domain={discountAxis.domain}
                  ticks={discountAxis.ticks}
                  tickFormatter={discountAxis.format}
                />
                <Tooltip
                  content={<DiscountTip methods={methods} />}
                  cursor={{ fill: "rgba(148, 163, 184, 0.15)" }}
                />
                <Legend
                  wrapperStyle={{ fontSize: 12 }}
                  formatter={(name) => <span className="bdash-legend">{name}</span>}
                />
                {methods.map((method, index) => (
                  <Bar
                    key={method.key}
                    dataKey={method.key}
                    name={method.label}
                    stackId="methods"
                    fill={method.color}
                    stroke="#fff"
                    strokeWidth={2}
                    radius={index === last ? [4, 4, 0, 0] : 0}
                    maxBarSize={32}
                    isAnimationActive={false}
                  />
                ))}
              </BarChart>
            </ResponsiveContainer>
          </div>
          <details className="bdash-table-toggle">
            <summary>Show as table</summary>
            <div className="fset__scroll">
              <table className="flow-table brep-table" aria-label="Discounts by period">
                <thead>
                  <tr>
                    <th scope="col">{PERIOD_LABELS[period]}</th>
                    {methods.map((method) => (
                      <th key={method.key} scope="col" className="brep-num">
                        {method.label}
                      </th>
                    ))}
                    <th scope="col" className="brep-num">
                      Total
                    </th>
                    <th scope="col" className="brep-num">
                      Charged
                    </th>
                    <th scope="col" className="brep-num">
                      % of charges
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
                      {methods.map((method) => (
                        <td key={method.key} className="brep-num">
                          {money(row[method.key])}
                        </td>
                      ))}
                      <td className="brep-num">{money(row.given)}</td>
                      <td className="brep-num">{money(row.charges)}</td>
                      <td className="brep-num">{pctText(row.pct)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
          <div className="bdash-grid bdash-grid--tight">
            <SmallTable
              title="By rule or code"
              rows={block.rules}
              columns={[
                {
                  key: "label",
                  label: "Rule",
                  render: (row) => (
                    <>
                      {row.label}
                      {row.code ? <span className="bdash-muted"> · {row.code}</span> : null}
                      {row.method ? <span className="bdash-muted"> · {row.method}</span> : null}
                    </>
                  ),
                },
                ...amountColumns,
              ]}
            />
            <SmallTable
              title="By service group"
              rows={block.groups}
              columns={[
                { key: "label", label: "Group", render: (row) => row.label },
                { key: "amount", label: "Discount", num: true, render: (row) => money(row.amount) },
                {
                  key: "charges",
                  label: "Charged",
                  num: true,
                  render: (row) => money(row.charges),
                },
                { key: "pct", label: "%", num: true, render: (row) => pctText(row.pct) },
              ]}
            />
            <SmallTable
              title="By staff who applied it (discount rules only)"
              rows={block.users}
              columns={[
                { key: "label", label: "Applied by", render: (row) => row.label },
                ...amountColumns,
              ]}
            />
            <SmallTable
              title="By consultant"
              rows={block.consultants}
              columns={[
                { key: "label", label: "Consultant", render: (row) => row.label },
                ...amountColumns,
              ]}
            />
          </div>
          <SmallTable
            title={`Biggest discounts — top ${block.top_bills.length} ${block.top_bills.length === 1 ? "bill" : "bills"}`}
            rows={block.top_bills.map((bill) => ({ ...bill, key: bill.bill_id }))}
            columns={[
              {
                key: "bill",
                label: "Bill",
                render: (row) => (
                  <>
                    {row.bill_no ?? "Not final yet"}
                    <span className="bdash-muted"> · {fullDayLabel(row.bill_date)}</span>
                  </>
                ),
              },
              { key: "category", label: "Category", render: (row) => row.category || "—" },
              {
                key: "patient",
                label: "Patient",
                render: (row) => (
                  <span className="bdash-wrap">
                    {row.patient_name}
                    <span className="bdash-muted">
                      {" "}
                      · {row.file_no || row.health_id || "No UHID"}
                    </span>
                  </span>
                ),
              },
              { key: "charges", label: "Charged", num: true, render: (row) => money(row.charges) },
              {
                key: "discount",
                label: "Discount",
                num: true,
                render: (row) => money(row.discount),
              },
              { key: "pct", label: "%", num: true, render: (row) => pctText(row.pct) },
              { key: "applied_by", label: "Applied by", render: (row) => row.applied_by || "—" },
              {
                key: "open",
                label: "Bill",
                render: (row) => (
                  <Link
                    className="brep-open"
                    to={receptionBillHref({ patient: row.patient_id, date: row.bill_date })}
                    aria-label={`Open bill ${row.bill_no ?? "(not final yet)"} for ${row.patient_name} at the counter`}
                  >
                    Open at counter
                  </Link>
                ),
              },
            ]}
          />
        </>
      )}
    </section>
  );
}
