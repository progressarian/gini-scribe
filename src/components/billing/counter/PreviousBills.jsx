import { billPdfHref } from "../../../queries/hooks/useBilling";
import { fromPaise } from "../format";
import { billStatusText } from "./lineText";

export default function PreviousBills({ bills }) {
  if (!bills.length) return null;

  return (
    <section className="bc-card" aria-label="Earlier bills on this visit">
      <h3 className="bc-card__title">Earlier bills on this visit</h3>
      <div className="ltablewrap bc-stack">
        <table className="ltable" aria-label="Earlier bills">
          <thead>
            <tr>
              <th>Bill</th>
              <th>Status</th>
              <th>Actual</th>
              <th>Discount</th>
              <th>Patient pays</th>
              <th>Paid</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {bills.map((b) => (
              <tr key={b.id}>
                <td data-label="Bill">{b.bill_no || "Not numbered"}</td>
                <td data-label="Status">{billStatusText(b.status)}</td>
                <td data-label="Actual">{fromPaise(b.totals.actual)}</td>
                <td data-label="Discount">{fromPaise(b.totals.discount)}</td>
                <td data-label="Patient pays">{fromPaise(b.totals.payable)}</td>
                <td data-label="Paid">{fromPaise(b.totals.paid)}</td>
                <td data-label="" className="bc-cell-actions">
                  <a
                    className="st-btn"
                    href={billPdfHref(b.id)}
                    target="_blank"
                    rel="noreferrer"
                    aria-label={`Print bill ${b.bill_no || "draft"}`}
                  >
                    Print
                  </a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
