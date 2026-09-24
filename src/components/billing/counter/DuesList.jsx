import { useDues } from "../../../queries/hooks/useBilling";
import { errorOf, fromPaise } from "../format";
import { dueAgeText } from "./lineText";

export default function DuesList({ onTakePayment }) {
  const { data, isLoading, error } = useDues();
  const rows = data || [];

  return (
    <section className="bc-card" aria-label="Dues">
      <h3 className="bc-card__title">Unpaid balances</h3>
      {isLoading && <div className="empty-note">Loading…</div>}
      {error && <div className="bc-err">{errorOf(error, "The dues could not be read")}</div>}
      {!isLoading && !error && !rows.length && (
        <div className="empty-note">Nothing is left to collect.</div>
      )}
      {!!rows.length && (
        <div className="ltablewrap">
          <table className="ltable" aria-label="Unpaid balances">
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
                  <td>
                    {row.patient.name}
                    <span className="bc-head__meta"> · {row.patient.file_no || "—"}</span>
                  </td>
                  <td>
                    {row.bill_no}
                    {row.pay_later && <span className="bc-chip bc-chip--auto">Pay later</span>}
                  </td>
                  <td>{row.bill_date}</td>
                  <td>{dueAgeText(row.days)}</td>
                  <td>{fromPaise(row.payable)}</td>
                  <td>{fromPaise(row.paid)}</td>
                  <td>{fromPaise(row.outstanding)}</td>
                  <td>
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
