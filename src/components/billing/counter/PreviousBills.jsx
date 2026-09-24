import { billPdfHref } from "../../../queries/hooks/useBilling";
import { fromPaise } from "../format";
import { billStatusText } from "./lineText";

export default function PreviousBills({ bills }) {
  if (!bills.length) return null;

  return (
    <section className="bc-card" aria-label="Earlier bills on this visit">
      <h3 className="bc-card__title">Earlier bills on this visit</h3>
      <div className="ltablewrap">
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
                <td>{b.bill_no || "Not numbered"}</td>
                <td>{billStatusText(b.status)}</td>
                <td>{fromPaise(b.totals.actual)}</td>
                <td>{fromPaise(b.totals.discount)}</td>
                <td>{fromPaise(b.totals.payable)}</td>
                <td>{fromPaise(b.totals.paid)}</td>
                <td>
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
