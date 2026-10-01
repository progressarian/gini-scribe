import { useDuesToday } from "../../../queries/hooks/useBilling";
import { errorOf, fromPaise } from "../format";
import { dueAgeText } from "./lineText";

export default function DuesList({ onTakePayment }) {
  const { data, isLoading, error } = useDuesToday();
  const rows = data?.rows || [];
  const count = data?.totals.bills ?? 0;

  return (
    <section className="bc-card" aria-label="Dues">
      <h3 className="bc-card__title">Due today</h3>
      {data && (
        <p className="bc-head__meta" aria-live="polite" data-testid="dues-today-total">
          {count === 1 ? "1 bill" : `${count} bills`} · {fromPaise(data.totals.outstanding)} due
          today
        </p>
      )}
      {isLoading && <div className="empty-note">Loading…</div>}
      {error && <div className="bc-err">{errorOf(error, "The dues could not be read")}</div>}
      {!isLoading && !error && !rows.length && (
        <div className="empty-note">Nothing is left to collect from today&apos;s bills.</div>
      )}
      {!!rows.length && (
        <div className="ltablewrap bc-stack">
          <table className="ltable" aria-label="Due today">
            <thead>
              <tr>
                <th>Patient</th>
                <th>Bill</th>
                <th>Date</th>
                <th>Waiting</th>
                <th>Patient pays</th>
                <th>Paid</th>
                <th>Outstanding</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.bill_id}>
                  <td data-label="Patient">
                    {row.patient.name}
                    <span className="bc-head__meta"> · {row.patient.file_no || "—"}</span>
                  </td>
                  <td data-label="Bill">
                    {row.bill_no}
                    {row.pay_later && <span className="bc-chip bc-chip--auto">Pay later</span>}
                  </td>
                  <td data-label="Date">{row.bill_date}</td>
                  <td data-label="Waiting">{dueAgeText(row.days)}</td>
                  <td data-label="Patient pays">
                    {fromPaise(Math.max(0, row.payable - row.credited))}
                    {row.credited > 0 && (
                      <span className="bc-head__meta"> · {fromPaise(row.credited)} credited</span>
                    )}
                  </td>
                  <td data-label="Paid">{fromPaise(row.paid - row.refunded)}</td>
                  <td data-label="Outstanding">{fromPaise(row.outstanding)}</td>
                  <td data-label="" className="bc-cell-actions">
                    <button
                      type="button"
                      className="st-btn st-btn-grn"
                      aria-label={`Take payment on bill ${row.bill_no}`}
                      onClick={() => onTakePayment(row)}
                    >
                      Take payment
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
