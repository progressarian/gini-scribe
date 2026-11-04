import { count, money } from "../dashboard/dashboardText";

const signed = (value) => (value ? `${value > 0 ? "+" : "−"}${money(Math.abs(value))}` : "—");

export default function StaffTable({ data, onPick, picked }) {
  const moneyCols = data.columns.money;
  const clearedCols = data.columns.cleared;
  const people = data.staff;
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
  return (
    <section className="flow-card bdash-card" aria-labelledby="sd-staff">
      <div className="fset__cardhead">
        <h2 id="sd-staff" className="flow-sec-title">
          By staff
        </h2>
        <span className="fset__count">{people.length}</span>
      </div>
      <div className="fset__cardsub">
        Money by payment mode, less refunds, for each login that took it. Cash goes into that
        person&apos;s drawer; HealthRay columns are money taken in HealthRay and are never in a
        drawer. Pick a name to see only their shifts.
      </div>
      <div className="fset__scroll">
        <table className="flow-table brep-table bdash-small sd-staff" aria-label="By staff">
          <thead>
            <tr>
              <th scope="col">Staff</th>
              <th scope="col" className="brep-num">
                Patients
              </th>
              <th scope="col" className="brep-num">
                Check-ins
              </th>
              <th scope="col" className="brep-num">
                Bills finalised
              </th>
              {moneyCols.map((col) => (
                <th key={col.key} scope="col" className="brep-num">
                  {col.label}
                </th>
              ))}
              <th scope="col" className="brep-num">
                Refunds paid back
              </th>
              <th scope="col" className="brep-num">
                Net collected
              </th>
              {clearedCols.map((col) => (
                <th key={col.key} scope="col" className="brep-num">
                  {col.label}
                </th>
              ))}
              <th scope="col" className="brep-num">
                Cash short / over
              </th>
              <th scope="col" className="brep-num">
                Manual discounts
              </th>
            </tr>
          </thead>
          <tbody>
            {people.map((person) => (
              <tr
                key={person.id ?? "none"}
                aria-current={picked === person.id ? "true" : undefined}
              >
                <th scope="row" className="bdash-wrap">
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
                    <span className="bill-status bdash-cash bdash-cash--open">
                      {person.open_shifts} open
                    </span>
                  ) : null}
                </th>
                <td className="brep-num">{count(person.patients)}</td>
                <td className="brep-num">{count(person.check_ins)}</td>
                <td className="brep-num">{count(person.finalised)}</td>
                {moneyCols.map((col) => (
                  <td key={col.key} className="brep-num">
                    {person.money[col.key] ? money(person.money[col.key]) : "—"}
                  </td>
                ))}
                <td className="brep-num">
                  {person.refunded ? `−${money(person.refunded)}` : "—"}
                  {person.refunds ? <span className="bdash-muted"> ({person.refunds})</span> : null}
                </td>
                <td className="brep-num">
                  <strong>{money(person.collected)}</strong>
                </td>
                {clearedCols.map((col) => (
                  <td key={col.key} className="brep-num">
                    {person.cleared[col.key] ? money(person.cleared[col.key]) : "—"}
                  </td>
                ))}
                <td className="brep-num">
                  {person.short ? (
                    <span className="sd-short">{signed(person.short)} short</span>
                  ) : null}
                  {person.short && person.over ? <br /> : null}
                  {person.over ? <span>{signed(person.over)} over</span> : null}
                  {!person.short && !person.over ? "—" : null}
                </td>
                <td className="brep-num">
                  {person.manual_discounts
                    ? `${money(person.manual_discount_amount)} (${person.manual_discounts})`
                    : "—"}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="brep-total">
              <th scope="row">Total</th>
              <td className="brep-num">{count(total.patients)}</td>
              <td className="brep-num">{count(total.check_ins)}</td>
              <td className="brep-num">{count(total.finalised)}</td>
              {moneyCols.map((col) => (
                <td key={col.key} className="brep-num">
                  {money(total.money[col.key])}
                </td>
              ))}
              <td className="brep-num">{total.refunded ? `−${money(total.refunded)}` : "—"}</td>
              <td className="brep-num">
                <strong>{money(total.collected)}</strong>
              </td>
              {clearedCols.map((col) => (
                <td key={col.key} className="brep-num">
                  {money(total.cleared[col.key])}
                </td>
              ))}
              <td className="brep-num" />
              <td className="brep-num">
                {total.manual_discounts ? money(total.manual_discount_amount) : "—"}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
      <p className="bdash-foot">
        Figures are per login: if two people share one login, their money shows as one person.
        &ldquo;Patients&rdquo; counts different patients who paid that person.
      </p>
    </section>
  );
}
