import {
  bucketLabel,
  count,
  money,
  negativeMoney,
  pendingNote,
  PERIOD_LABELS,
} from "./dashboardText";
import { misLayout } from "../../../../shared/billingDashboardText.js";
import ReportLink from "./ReportLink";

function Pending({ row }) {
  const note = pendingNote(row);
  return (
    <span title={note || undefined}>
      {money(row.pending)}
      {note ? (
        <>
          <span aria-hidden="true" className="bdash-info">
            {" "}
            ⓘ
          </span>
          <span className="sr-only">. {note.replaceAll("\n", ". ")}</span>
        </>
      ) : null}
    </span>
  );
}

function Check({ row }) {
  if (row.check.ok) {
    return (
      <span className="bdash-ok" title="The bill lines add up to the bill totals">
        <span aria-hidden="true">✓</span>
        <span className="sr-only">Balanced</span>
      </span>
    );
  }
  return (
    <span
      className="bdash-off"
      title="Charges − discount + tax + round off − claim − adjustment don't equal net revenue"
    >
      <span aria-hidden="true">⚠ </span>Off by {money(row.check.difference)}
    </span>
  );
}

function Cells({ row, data, layout }) {
  return (
    <>
      <td className="brep-num bdash-strong">{money(row.net_revenue)}</td>
      {layout.moneyColumns.map((column) => (
        <td key={column.key} className="brep-num">
          {money(row.money[column.key] ?? 0)}
        </td>
      ))}
      <td className="brep-num">
        <Pending row={row} />
      </td>
      <td className="brep-num">
        {row.rev_per_patient === null ? "—" : money(row.rev_per_patient)}
      </td>
      {data.columns.charges.map((column) => (
        <td key={column.key} className="brep-num">
          {money(row.charges[column.key] ?? 0)}
        </td>
      ))}
      <td className="brep-num bdash-muted">—</td>
      <td className="brep-num">{negativeMoney(row.discount)}</td>
      <td className="brep-num">{negativeMoney(row.discount_consultation)}</td>
      <td className="brep-num">{negativeMoney(row.discount_tests)}</td>
      {layout.extras.map((column) => (
        <td key={column.key} className="brep-num">
          {money(row[column.key])}
        </td>
      ))}
      {layout.cashOut ? (
        <td className="brep-num">
          {row.cash_taken_out === null ? "—" : money(row.cash_taken_out)}
        </td>
      ) : null}
      <td className="brep-num">{count(row.bills)}</td>
      <td>
        <Check row={row} />
      </td>
    </>
  );
}

export default function MisTable({ data, onPick }) {
  const period = data.filters.period;
  const layout = misLayout(data);
  const charges = data.columns.charges;
  const collectionSpan = layout.moneyColumns.length + 3;
  const chargeSpan = charges.length + 1;
  const otherSpan = layout.extras.length + (layout.cashOut ? 1 : 0) + 2;
  return (
    <section className="flow-card bdash-card" aria-labelledby="bdash-mis">
      <div className="fset__cardhead">
        <h2 id="bdash-mis" className="flow-sec-title">
          {PERIOD_LABELS[period]} wise summary
        </h2>
        <span className="fset__count">{data.rows.length}</span>
        <ReportLink report="revenue_items" title="Revenue by service" filters={data.filters} />
      </div>
      <div className="fset__cardsub">
        Same layout as the MIS sheet. Charges are before discount; discounts are shown as minus.
        Pharmacy is billed in its own system, so it isn't in Scribe.
        {period !== "day" ? " Open a row to see it day by day." : ""}
      </div>
      <div className="fset__scroll fset__scroll--wide bdash-mis-scroll">
        <table
          className="flow-table brep-table bdash-mis"
          aria-label={`${PERIOD_LABELS[period]} wise summary`}
        >
          <thead>
            <tr className="bdash-mis__groups">
              <th scope="col" className="bdash-sticky" />
              <th scope="colgroup" colSpan={collectionSpan}>
                Collection
              </th>
              <th scope="colgroup" colSpan={chargeSpan}>
                Charges
              </th>
              <th scope="colgroup" colSpan={3}>
                Discounts
              </th>
              <th scope="colgroup" colSpan={otherSpan}>
                Checks
              </th>
            </tr>
            <tr>
              <th scope="col" className="bdash-sticky">
                {PERIOD_LABELS[period]}
              </th>
              <th scope="col" className="brep-num">
                Net Revenue
              </th>
              {layout.moneyColumns.map((column) => (
                <th key={column.key} scope="col" className="brep-num">
                  {column.label}
                </th>
              ))}
              <th scope="col" className="brep-num">
                Pending Payment
              </th>
              <th scope="col" className="brep-num">
                Rev/Pt
              </th>
              {charges.map((column) => (
                <th key={column.key} scope="col" className="brep-num">
                  {column.label}
                </th>
              ))}
              <th scope="col" className="brep-num" title={data.columns.pharmacy.note}>
                {data.columns.pharmacy.label}
                <span className="bdash-th-note">Not in Scribe</span>
              </th>
              <th scope="col" className="brep-num">
                Discount given
              </th>
              <th scope="col" className="brep-num">
                Discount on Consultation
              </th>
              <th scope="col" className="brep-num">
                Discount on Tests
              </th>
              {layout.extras.map((column) => (
                <th key={column.key} scope="col" className="brep-num">
                  {column.label}
                </th>
              ))}
              {layout.cashOut ? (
                <th
                  scope="col"
                  className="brep-num"
                  title="Cash counted when each shift was closed"
                >
                  Cash taken out
                </th>
              ) : null}
              <th scope="col" className="brep-num">
                Bills
              </th>
              <th scope="col">Lines = bill</th>
            </tr>
          </thead>
          <tbody>
            {data.rows.map((row) => {
              const label = `${bucketLabel(row, period)}${row.partial ? " (part)" : ""}`;
              return (
                <tr key={row.bucket}>
                  <th scope="row" className="bdash-sticky">
                    {period === "day" ? (
                      label
                    ) : (
                      <button
                        type="button"
                        className="bdash-link"
                        onClick={() => onPick(row)}
                        aria-label={`Open ${label} day by day`}
                      >
                        {label}
                      </button>
                    )}
                  </th>
                  <Cells row={row} data={data} layout={layout} />
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr className="brep-total">
              <th scope="row" className="bdash-sticky">
                Grand Total
              </th>
              <Cells row={data.total} data={data} layout={layout} />
            </tr>
          </tfoot>
        </table>
      </div>
    </section>
  );
}
