import { Link } from "react-router-dom";
import { money } from "../dashboard/dashboardText";
import CashBadge from "./CashBadge";
import { clock, hoursOpen, nonCash } from "./staffText";

export default function ShiftsTable({ data, back }) {
  const shifts = data.shifts;
  return (
    <section className="flow-card bdash-card" aria-labelledby="sd-shifts">
      <div className="fset__cardhead">
        <h2 id="sd-shifts" className="flow-sec-title">
          Shifts and cash handover
        </h2>
        <span className="fset__count">{shifts.length}</span>
      </div>
      {!shifts.length ? (
        <div className="bdash-empty">
          No shift was open in these dates. Staff open a shift from the Shift tab at reception
          before taking cash.
        </div>
      ) : (
        <div className="fset__scroll">
          <table className="flow-table brep-table bdash-small bdash-mis" aria-label="Shifts">
            <thead>
              <tr>
                <th scope="col" className="bdash-sticky">
                  Staff
                </th>
                <th scope="col">Opened</th>
                <th scope="col">Closed</th>
                <th scope="col" className="brep-num">
                  Opening
                </th>
                <th scope="col" className="brep-num">
                  Cash in
                </th>
                <th scope="col" className="brep-num">
                  Cash out
                </th>
                <th scope="col" className="brep-num">
                  Expected
                </th>
                <th scope="col" className="brep-num">
                  Counted
                </th>
                <th scope="col">Cash</th>
                <th scope="col" className="brep-num">
                  Card / UPI / NEFT
                </th>
                <th scope="col">
                  <span className="sr-only">Action</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {shifts.map((shift) => (
                <tr key={shift.id}>
                  <th scope="row" className="bdash-sticky">
                    {shift.user.name ?? "—"}
                  </th>
                  <td>
                    {clock(shift.opened_at)}
                    {shift.crosses_midnight ? (
                      <span className="bdash-muted"> · crosses midnight</span>
                    ) : null}
                  </td>
                  <td>
                    {shift.is_open ? (
                      <span className="bdash-muted">Open {hoursOpen(shift)}</span>
                    ) : (
                      clock(shift.closed_at)
                    )}
                  </td>
                  <td className="brep-num">{money(shift.opening_cash)}</td>
                  <td className="brep-num">{money(shift.collected.cash)}</td>
                  <td className="brep-num">
                    {shift.refunded.cash ? `−${money(shift.refunded.cash)}` : "—"}
                  </td>
                  <td className="brep-num">{money(shift.expected_cash)}</td>
                  <td className="brep-num">
                    {shift.counted_cash === null ? "—" : money(shift.counted_cash)}
                  </td>
                  <td>
                    <CashBadge shift={shift} withAmount />
                  </td>
                  <td className="brep-num">{money(nonCash(shift))}</td>
                  <td>
                    <Link
                      className="brep-open"
                      to={`/billing/staff/shifts/${shift.id}`}
                      state={{ back }}
                      aria-label={`Open the shift of ${shift.user.name ?? "this desk"} opened ${clock(shift.opened_at)}`}
                    >
                      Details
                    </Link>
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
