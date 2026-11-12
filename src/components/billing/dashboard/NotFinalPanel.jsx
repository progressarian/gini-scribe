import { Link } from "react-router-dom";
import { receptionBillHref } from "../counter/billHref";
import { count, fullDayLabel, money } from "./dashboardText";

export default function NotFinalPanel({ data }) {
  const block = data.not_final;
  if (!block?.bills?.length) return null;
  const total = block.bills.reduce((sum, bill) => sum + bill.payable, 0);
  return (
    <section className="flow-card bdash-card" aria-labelledby="bdash-not-final">
      <div className="fset__cardhead">
        <h2 id="bdash-not-final" className="flow-sec-title">
          Paid, not finalised
        </h2>
        <span className="fset__count">{count(block.bills.length)}</span>
      </div>
      <div className="fset__cardsub">
        {money(total)} paid but not finalised — open each at the counter and press Finalise.
        {block.truncated ? " Only the first 500 are listed; narrow the dates to see the rest." : ""}
      </div>
      <div className="fset__scroll fset__scroll--tall">
        <table className="flow-table brep-table bdash-small" aria-label="Paid, not finalised">
          <thead>
            <tr>
              <th scope="col">Bill date</th>
              <th scope="col">Patient</th>
              <th scope="col">Category</th>
              <th scope="col" className="brep-num">
                Paid
              </th>
              <th scope="col">
                <span className="sr-only">Action</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {block.bills.map((bill) => (
              <tr key={bill.bill_id}>
                <th scope="row">{fullDayLabel(bill.bill_date)}</th>
                <td className="bdash-wrap">
                  {bill.patient_name}
                  <span className="bdash-muted">
                    {" "}
                    · {bill.file_no || bill.health_id || "No UHID"}
                  </span>
                </td>
                <td>{bill.category || "—"}</td>
                <td className="brep-num">{money(bill.paid)}</td>
                <td>
                  <Link
                    className="brep-open"
                    to={receptionBillHref({ patient: bill.patient_id, date: bill.bill_date })}
                    aria-label={`Finalise the ${fullDayLabel(bill.bill_date)} bill for ${bill.patient_name} at the counter`}
                  >
                    Finalise at counter
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
