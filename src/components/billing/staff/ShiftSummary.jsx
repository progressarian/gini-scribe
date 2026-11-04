import { NEFT_LABEL } from "../../../../shared/billingVocab.js";
import { count, money } from "../dashboard/dashboardText";
import CashBadge from "./CashBadge";

export function Handover({ shift }) {
  const takenCount = shift.payment_count + shift.deposits.count;
  return (
    <table className="bdash-bridge" aria-label="Cash handover">
      <tbody>
        <tr>
          <th scope="row">Opening cash</th>
          <td className="brep-num">{money(shift.opening_cash)}</td>
        </tr>
        <tr>
          <th scope="row">+ Cash taken</th>
          <td className="brep-num">{money(shift.collected.cash)}</td>
        </tr>
        <tr>
          <th scope="row">− Cash paid back</th>
          <td className="brep-num">
            {shift.refunded.cash ? `−${money(shift.refunded.cash)}` : money(0)}
          </td>
        </tr>
        <tr className="bdash-bridge__total">
          <th scope="row">= Expected in drawer</th>
          <td className="brep-num">{money(shift.expected_cash)}</td>
        </tr>
        <tr>
          <th scope="row">Counted</th>
          <td className="brep-num">
            {shift.counted_cash === null
              ? shift.is_open
                ? "Not closed yet"
                : "Not counted"
              : money(shift.counted_cash)}
          </td>
        </tr>
        <tr className="bdash-bridge__total">
          <th scope="row">Difference</th>
          <td className="brep-num">
            {shift.difference === null ? "—" : money(shift.difference)} <CashBadge shift={shift} />
          </td>
        </tr>
      </tbody>
      <caption className="sr-only">{count(takenCount)} payments and deposits in this shift</caption>
    </table>
  );
}

export function OtherMoney({ shift, cleared }) {
  const net = (mode) => (shift.collected[mode] ?? 0) - (shift.refunded[mode] ?? 0);
  const clearedTotal = cleared.reduce((sum, row) => sum + row.amount, 0);
  const rows = [
    ["Card", net("card")],
    ["UPI", net("upi")],
    [NEFT_LABEL, net("neft")],
    ["Deposits taken (in the modes above)", shift.deposits.received],
    ["Paid in HealthRay (marked here)", shift.healthray.collected - shift.healthray.refunded],
    ["Paid earlier / online", shift.prepaid.collected],
    ["Cleared on Payments tab / fee changes (taken in HealthRay)", clearedTotal],
  ].filter(([, value]) => value);
  if (!rows.length)
    return <p className="bdash-muted">No card, UPI or HealthRay money in this shift.</p>;
  return (
    <table className="bdash-bridge" aria-label="Other money">
      <tbody>
        {rows.map(([label, value]) => (
          <tr key={label}>
            <th scope="row">{label}</th>
            <td className="brep-num">{money(value)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
