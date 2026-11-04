import { Link } from "react-router-dom";
import { receptionBillHref } from "../counter/billHref";
import { fullDayLabel, money } from "../dashboard/dashboardText";
import CashBadge from "./CashBadge";
import { clock, hoursOpen } from "./staffText";

const billHref = (row) =>
  receptionBillHref({
    ...(row.visit_id ? { visit: row.visit_id } : {}),
    ...(row.bill_id ? { bill: row.bill_id } : {}),
    ...(row.bill_date ? { date: row.bill_date } : {}),
  });

function Block({ title, children, empty }) {
  return (
    <div className="sd-exc">
      <h3 className="sd-exc__title">{title}</h3>
      {empty ? <p className="bdash-muted sd-exc__none">{empty}</p> : children}
    </div>
  );
}

export default function StaffExceptions({ data, onOpen }) {
  const ex = data.exceptions;
  const total =
    ex.left_open.length + ex.differences.length + ex.voided.length + ex.manual_discounts.length;
  return (
    <section className="flow-card bdash-card" aria-labelledby="sd-exceptions">
      <div className="fset__cardhead">
        <h2 id="sd-exceptions" className="flow-sec-title">
          Needs attention
        </h2>
        <span className="fset__count">{total}</span>
      </div>
      {!total ? (
        <div className="bill-allclear" role="status">
          Nothing needs attention in these dates: no shifts left open, no cash differences, no
          voided payments and no large manual discounts.
        </div>
      ) : (
        <div className="sd-exc-grid">
          <Block
            title="Shifts left open past their day"
            empty={ex.left_open.length ? null : "None."}
          >
            <ul className="sd-list">
              {ex.left_open.map((shift) => (
                <li key={shift.id}>
                  <span>
                    <strong>{shift.user.name}</strong> · open since {clock(shift.opened_at)} (
                    {hoursOpen(shift)}) · {money(shift.expected_cash)} expected in the drawer
                  </span>
                  <button type="button" className="brep-open" onClick={() => onOpen(shift.id)}>
                    Details
                  </button>
                </li>
              ))}
            </ul>
          </Block>
          <Block title="Cash differences" empty={ex.differences.length ? null : "None."}>
            <ul className="sd-list">
              {ex.differences.map((shift) => (
                <li key={shift.id}>
                  <span>
                    <strong>{shift.user.name}</strong> · closed {clock(shift.closed_at)} · expected{" "}
                    {money(shift.expected_cash)}, counted {money(shift.counted_cash)}{" "}
                    <CashBadge shift={shift} withAmount />
                  </span>
                  <button type="button" className="brep-open" onClick={() => onOpen(shift.id)}>
                    Details
                  </button>
                </li>
              ))}
            </ul>
          </Block>
          <Block title="Voided payments" empty={ex.voided.length ? null : "None."}>
            <ul className="sd-list">
              {ex.voided.map((row) => (
                <li key={row.id}>
                  <span>
                    <s>{money(row.amount)}</s> {row.mode} · {row.patient_name ?? "—"}
                    {row.file_no ? ` · ${row.file_no}` : ""} · taken by {row.received_by ?? "—"},
                    voided by {row.voided_by ?? "—"} on {clock(row.voided_at)}
                  </span>
                </li>
              ))}
            </ul>
          </Block>
          <Block
            title={`Manual discounts of ${money(ex.flag.amount)} or more, or ${Math.round(ex.flag.share * 100)}% of the item`}
            empty={ex.manual_discounts.length ? null : "None."}
          >
            <ul className="sd-list">
              {ex.manual_discounts.map((row) => (
                <li key={row.id}>
                  <span>
                    <strong>{money(row.amount)}</strong> off {row.item_name} · {row.patient_name}
                    {row.file_no ? ` · ${row.file_no}` : ""} · by {row.given_by ?? "—"}
                    {row.reason ? ` · “${row.reason}”` : ""}
                    {row.bill_date ? ` · ${fullDayLabel(row.bill_date)}` : ""}
                  </span>
                  <Link className="brep-open" to={billHref(row)}>
                    Open bill
                  </Link>
                </li>
              ))}
            </ul>
          </Block>
        </div>
      )}
    </section>
  );
}
