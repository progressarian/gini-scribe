import { useState } from "react";
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

const PREVIEW = 5;

function Block({ title, items, render }) {
  const [all, setAll] = useState(false);
  const shown = all ? items : items.slice(0, PREVIEW);
  return (
    <div className="sd-exc">
      <h3 className="sd-exc__title">
        {title} <span className="fset__count">{items.length}</span>
      </h3>
      <ul className="sd-list">{shown.map(render)}</ul>
      {items.length > PREVIEW ? (
        <button
          type="button"
          className="brep-open sd-more"
          aria-expanded={all}
          onClick={() => setAll(!all)}
        >
          {all ? "Show fewer" : `Show all ${items.length}`}
        </button>
      ) : null}
    </div>
  );
}

export default function StaffExceptions({ data, back }) {
  const ex = data.exceptions;
  const total =
    ex.left_open.length + ex.differences.length + ex.voided.length + ex.manual_discounts.length;
  const clear = [
    !ex.left_open.length && "shifts left open",
    !ex.differences.length && "cash differences",
    !ex.voided.length && "voided payments",
    !ex.manual_discounts.length && "large manual discounts",
  ].filter(Boolean);
  return (
    <section className="flow-card bdash-card" aria-labelledby="sd-exceptions">
      <div className="fset__cardhead">
        <h2 id="sd-exceptions" className="flow-sec-title">
          Needs attention
        </h2>
        <span className="fset__count">{total}</span>
      </div>
      {clear.length ? (
        <p className="bdash-muted sd-exc__none" role="status">
          No {clear.join(", no ")} in these dates.
        </p>
      ) : null}
      {ex.left_open.length ? (
        <Block
          title="Shifts left open past their day"
          items={ex.left_open}
          render={(shift) => (
            <li key={shift.id}>
              <span>
                <strong>{shift.user.name}</strong> · open since {clock(shift.opened_at)} (
                {hoursOpen(shift)}) · {money(shift.expected_cash)} expected in the drawer
              </span>
              <Link className="brep-open" to={`/billing/staff/shifts/${shift.id}`} state={{ back }}>
                Details
              </Link>
            </li>
          )}
        />
      ) : null}
      {ex.differences.length ? (
        <Block
          title="Cash differences"
          items={ex.differences}
          render={(shift) => (
            <li key={shift.id}>
              <span>
                <strong>{shift.user.name}</strong> · closed {clock(shift.closed_at)} · expected{" "}
                {money(shift.expected_cash)}, counted {money(shift.counted_cash)}{" "}
                <CashBadge shift={shift} withAmount />
              </span>
              <Link className="brep-open" to={`/billing/staff/shifts/${shift.id}`} state={{ back }}>
                Details
              </Link>
            </li>
          )}
        />
      ) : null}
      {ex.voided.length ? (
        <Block
          title="Voided payments"
          items={ex.voided}
          render={(row) => (
            <li key={row.id}>
              <span>
                <s>{money(row.amount)}</s> {row.mode} · {row.patient_name ?? "—"}
                {row.file_no ? ` · ${row.file_no}` : ""} · taken by {row.received_by ?? "—"}, voided
                by {row.voided_by ?? "—"} on {clock(row.voided_at)}
              </span>
            </li>
          )}
        />
      ) : null}
      {ex.manual_discounts.length ? (
        <Block
          title={`Large manual discounts (${money(ex.flag.amount)} or more, or ${Math.round(ex.flag.share * 100)}% of the item)`}
          items={ex.manual_discounts}
          render={(row) => (
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
          )}
        />
      ) : null}
    </section>
  );
}
