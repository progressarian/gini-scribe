import { count, money } from "../dashboard/dashboardText";

const NON_CASH = ["card", "upi_bharatpe", "upi_paytm", "upi_other", "upi_unknown", "neft"];
const IN_HEALTHRAY = ["healthray", "prepaid"];

const sumOf = (amounts = {}, keys) => keys.reduce((sum, key) => sum + (amounts[key] ?? 0), 0);
const cleared = (row) => Object.values(row.cleared ?? {}).reduce((sum, value) => sum + value, 0);
const amount = (value) => (value ? money(value) : "—");

function splitText(row, columns) {
  return columns
    .filter((col) => NON_CASH.includes(col.key) && row.taken?.[col.key])
    .map((col) => `${col.label}: ${money(row.taken[col.key])}`)
    .join("\n");
}

function CashCheck({ person }) {
  if (!person.short && !person.over) return "—";
  return (
    <>
      {person.short ? (
        <span className="sd-short">−{money(Math.abs(person.short))} short</span>
      ) : null}
      {person.short && person.over ? <br /> : null}
      {person.over ? <span>+{money(person.over)} over</span> : null}
    </>
  );
}

export default function StaffTable({ data, onPick, picked }) {
  const people = data.staff;
  const columns = data.columns.all_money;
  if (!people.length) {
    return (
      <section className="flow-card bdash-card" aria-labelledby="sd-staff">
        <h2 id="sd-staff" className="flow-sec-title">
          By staff
        </h2>
        <div className="bdash-empty">
          Nobody took a payment, finalised a bill or checked a patient in during these dates.
        </div>
      </section>
    );
  }
  const total = data.total;
  const show = {
    nonCash: sumOf(total.taken, NON_CASH) !== 0,
    healthray: sumOf(total.taken, IN_HEALTHRAY) !== 0,
    cleared: cleared(total) !== 0,
    cashCheck: people.some((person) => person.short || person.over),
    discounts: total.manual_discounts > 0,
    closedByCancel: total.closed_by_cancel > 0,
  };
  return (
    <section className="flow-card bdash-card" aria-labelledby="sd-staff">
      <div className="fset__cardhead">
        <h2 id="sd-staff" className="flow-sec-title">
          By staff
        </h2>
        <span className="fset__count">{people.length}</span>
      </div>
      <div className="fset__cardsub">
        What each login took, by how it was paid. Collected = cash + card/UPI/NEFT + marked paid in
        HealthRay − refunds paid back. Click a name to see only that person.
      </div>
      <div className="fset__scroll">
        <table
          className="flow-table brep-table bdash-small sd-staff bdash-mis"
          aria-label="By staff"
        >
          <thead>
            <tr>
              <th scope="col" className="bdash-sticky">
                Staff
              </th>
              <th scope="col" className="brep-num">
                Patients
              </th>
              <th scope="col" className="brep-num">
                Bills finalised
              </th>
              {show.closedByCancel ? (
                <th
                  scope="col"
                  className="brep-num"
                  title="Bills made final automatically because this person cancelled an already-paid test on the floor; the test was refunded."
                >
                  Closed by test cancel
                </th>
              ) : null}
              <th scope="col" className="brep-num">
                Cash
              </th>
              {show.nonCash ? (
                <th scope="col" className="brep-num" title="Hover a figure to see each app">
                  Card / UPI / NEFT
                </th>
              ) : null}
              <th scope="col" className="brep-num">
                Refunds paid back
              </th>
              {show.healthray ? (
                <th scope="col" className="brep-num">
                  Marked paid in HealthRay
                </th>
              ) : null}
              <th scope="col" className="brep-num sd-col-key">
                Collected
              </th>
              {show.cleared ? (
                <th
                  scope="col"
                  className="brep-num"
                  title="Cleared on the Payments tab or as a fee change. Taken in HealthRay — not in Collected or any drawer."
                >
                  Cleared in HealthRay
                </th>
              ) : null}
              {show.cashCheck ? (
                <th scope="col" className="brep-num">
                  Cash short / over
                </th>
              ) : null}
              {show.discounts ? (
                <th scope="col" className="brep-num">
                  Manual discounts
                </th>
              ) : null}
            </tr>
          </thead>
          <tbody>
            {people.map((person) => {
              const split = splitText(person, columns);
              return (
                <tr
                  key={person.id ?? "none"}
                  aria-current={picked === person.id ? "true" : undefined}
                >
                  <th scope="row" className="bdash-sticky">
                    {person.id ? (
                      <button
                        type="button"
                        className="sd-name"
                        aria-label={`Show only ${person.name}`}
                        onClick={() => onPick(person.id)}
                      >
                        {person.name}
                      </button>
                    ) : (
                      person.name
                    )}
                    {person.open_shifts ? (
                      <span className="bill-status bdash-cash bdash-cash--open">shift open</span>
                    ) : null}
                  </th>
                  <td className="brep-num">{count(person.patients)}</td>
                  <td className="brep-num">{count(person.finalised)}</td>
                  {show.closedByCancel ? (
                    <td className="brep-num">
                      {person.closed_by_cancel ? count(person.closed_by_cancel) : "—"}
                    </td>
                  ) : null}
                  <td className="brep-num">{amount(person.taken?.cash)}</td>
                  {show.nonCash ? (
                    <td className="brep-num" title={split || undefined}>
                      {amount(sumOf(person.taken, NON_CASH))}
                    </td>
                  ) : null}
                  <td className="brep-num">
                    {person.refunded ? `−${money(person.refunded)}` : "—"}
                    {person.refunds ? (
                      <span className="bdash-muted"> ({person.refunds})</span>
                    ) : null}
                  </td>
                  {show.healthray ? (
                    <td className="brep-num">{amount(sumOf(person.taken, IN_HEALTHRAY))}</td>
                  ) : null}
                  <td className="brep-num sd-col-key">
                    <strong>{money(person.collected)}</strong>
                  </td>
                  {show.cleared ? <td className="brep-num">{amount(cleared(person))}</td> : null}
                  {show.cashCheck ? (
                    <td className="brep-num">
                      <CashCheck person={person} />
                    </td>
                  ) : null}
                  {show.discounts ? (
                    <td className="brep-num">
                      {person.manual_discounts
                        ? `${money(person.manual_discount_amount)} (${person.manual_discounts})`
                        : "—"}
                    </td>
                  ) : null}
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr className="brep-total">
              <th scope="row" className="bdash-sticky">
                Total
              </th>
              <td className="brep-num">{count(total.patients)}</td>
              <td className="brep-num">{count(total.finalised)}</td>
              {show.closedByCancel ? (
                <td className="brep-num">{count(total.closed_by_cancel)}</td>
              ) : null}
              <td className="brep-num">{money(total.taken?.cash ?? 0)}</td>
              {show.nonCash ? (
                <td className="brep-num" title={splitText(total, columns) || undefined}>
                  {money(sumOf(total.taken, NON_CASH))}
                </td>
              ) : null}
              <td className="brep-num">{total.refunded ? `−${money(total.refunded)}` : "—"}</td>
              {show.healthray ? (
                <td className="brep-num">{money(sumOf(total.taken, IN_HEALTHRAY))}</td>
              ) : null}
              <td className="brep-num sd-col-key">
                <strong>{money(total.collected)}</strong>
              </td>
              {show.cleared ? <td className="brep-num">{money(cleared(total))}</td> : null}
              {show.cashCheck ? <td className="brep-num" /> : null}
              {show.discounts ? (
                <td className="brep-num">
                  {total.manual_discounts ? money(total.manual_discount_amount) : "—"}
                </td>
              ) : null}
            </tr>
          </tfoot>
        </table>
      </div>
      <p className="bdash-foot">
        Figures are per login: if two people share one login, their money shows as one person.
        Patients counts different patients who paid that person.
      </p>
    </section>
  );
}
