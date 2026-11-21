import { money } from "../dashboard/dashboardText";
import { takenModeText } from "../counter/lineText";
import { NEFT_LABEL } from "../../../../shared/billingVocab.js";
import { cashStatus, clock, hoursOpen, SOURCE_LABEL } from "./staffText";

const NOTES = [500, 200, 100, 50, 20, 10];

function Row({ label, value, strong }) {
  return (
    <tr className={strong ? "slip-strong" : undefined}>
      <th scope="row">{label}</th>
      <td>{value}</td>
    </tr>
  );
}

function byModeAndApp(payments) {
  const sums = new Map();
  for (const row of payments) {
    if (row.voided_at || row.outside_shift || row.mode === "cash") continue;
    const key = takenModeText(row.mode, row.upi_app);
    const signedAmount = row.direction === "out" ? -row.amount : row.amount;
    const was = sums.get(key) ?? { amount: 0, count: 0 };
    sums.set(key, { amount: was.amount + signedAmount, count: was.count + 1 });
  }
  return [...sums.entries()];
}

function differenceText(difference, status) {
  if (difference === null)
    return status.key === "open" || status.key === "left_open" ? "Not counted yet" : "Not counted";
  if (difference < 0) return `Short by ${money(-difference)}`;
  if (difference > 0) return `Extra ${money(difference)}`;
  return "₹0 · Matches";
}

function resultText(status, difference) {
  if (status.key === "matches") return "Cash matches";
  if (status.key === "short") return `Cash short by ${money(-difference)}`;
  if (status.key === "over") return `Cash extra by ${money(difference)}`;
  if (status.key === "not_counted") return "Cash not counted";
  return "Shift still open";
}

const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;

export default function HandoverSlip({ data, level = 1 }) {
  const Title = `h${level}`;
  const Section = `h${level + 1}`;
  const { shift, payments, cleared } = data;
  const snap = shift.handover;
  const paidBack = snap?.refunded.cash ?? shift.refunded.cash;
  const pharmacy = snap?.pharmacy ?? shift.pharmacy;
  const healthrayFlow = snap?.healthray ?? shift.healthray;
  const healthrayCash = (healthrayFlow.cash_collected ?? 0) - (healthrayFlow.cash_refunded ?? 0);
  const healthrayOther = shift.healthray.collected - (shift.healthray.cash_collected ?? 0);
  const pharmacyCash = pharmacy ? pharmacy.cash_collected - pharmacy.cash_refunded : 0;
  const expected = snap?.expected_cash ?? shift.expected_cash;
  const counted = snap ? snap.counted_cash : shift.counted_cash;
  const difference = snap ? snap.difference : shift.difference;
  const changed = Boolean(snap) && snap.expected_cash !== shift.expected_cash;
  const status = cashStatus(shift);
  const otherModes = byModeAndApp(payments);
  const clearedTotal = cleared.reduce((sum, row) => sum + row.amount, 0);
  const denominations = shift.denominations;
  return (
    <article className="slip-body" aria-label="Cash handover slip">
      <header className="slip-head">
        {data.hospital ? <p className="slip-hospital">{data.hospital}</p> : null}
        <Title>Cash handover — {shift.is_open ? "shift still open" : "shift closed"}</Title>
        <dl className="slip-meta">
          <div>
            <dt>Staff</dt>
            <dd>{shift.user.name}</dd>
          </div>
          <div>
            <dt>Shift started</dt>
            <dd>{clock(shift.opened_at)}</dd>
          </div>
          <div>
            <dt>Shift closed</dt>
            <dd>
              {shift.closed_at ? clock(shift.closed_at) : "Still open"} ({hoursOpen(shift)})
            </dd>
          </div>
          <div>
            <dt>Result</dt>
            <dd>
              <strong>{resultText(status, difference)}</strong>
              {snap && !snap.closed_by_owner ? " · closed by an admin" : ""}
            </dd>
          </div>
          {shift.note ? (
            <div>
              <dt>Note</dt>
              <dd>“{shift.note}”</dd>
            </div>
          ) : null}
        </dl>
      </header>

      <section aria-labelledby="slip-cash">
        <Section id="slip-cash">Cash in the drawer</Section>
        <table className="slip-table">
          <tbody>
            <Row label="Cash at the start" value={money(shift.opening_cash)} />
            <Row
              label="Cash received from patients"
              value={`+${money(snap?.collected.cash ?? shift.collected.cash)}`}
            />
            <Row
              label="Cash refunded to patients"
              value={paidBack ? `−${money(paidBack)}` : money(0)}
            />
            {healthrayCash ? (
              <Row label="Paid in HealthRay by cash" value={`+${money(healthrayCash)}`} />
            ) : null}
            {pharmacyCash ? (
              <Row label="Pharmacy cash (after refunds)" value={`+${money(pharmacyCash)}`} />
            ) : null}
            <Row label="Cash that should be in the drawer" value={money(expected)} strong />
            <Row
              label="Cash counted"
              value={
                counted === null
                  ? shift.is_open
                    ? "Not counted yet"
                    : "Not counted"
                  : money(counted)
              }
            />
            <Row label="Difference" value={differenceText(difference, status)} strong />
          </tbody>
        </table>
        {changed ? (
          <p className="slip-warn">
            A payment in this shift was changed after it closed, so the drawer should now hold{" "}
            {money(shift.expected_cash)}. The figures above are what was handed over.
          </p>
        ) : null}
      </section>

      {denominations ? (
        <section aria-labelledby="slip-notes">
          <Section id="slip-notes">Notes counted</Section>
          <table className="slip-table">
            <tbody>
              {NOTES.filter((note) => denominations.notes?.[note]).map((note) => (
                <Row
                  key={note}
                  label={`₹${note} × ${denominations.notes[note]}`}
                  value={money(note * 100 * denominations.notes[note])}
                />
              ))}
              {denominations.coins ? (
                <Row label="Coins" value={money(denominations.coins)} />
              ) : null}
              <Row label="Total" value={money(denominations.total)} strong />
            </tbody>
          </table>
        </section>
      ) : null}

      <section aria-labelledby="slip-other">
        <Section id="slip-other">Money not in the drawer</Section>
        <p className="slip-note">Received another way, so it is not part of the cash count.</p>
        <table className="slip-table">
          <tbody>
            {otherModes.map(([label, sum]) => (
              <Row
                key={label}
                label={`${label} (${plural(sum.count, "payment")})`}
                value={money(sum.amount)}
              />
            ))}
            {!otherModes.length ? (
              <Row label={`Card / UPI / ${NEFT_LABEL}`} value={money(0)} />
            ) : null}
            {healthrayOther ? (
              <Row label="Paid in HealthRay (not cash)" value={money(healthrayOther)} />
            ) : null}
            {shift.prepaid.collected ? (
              <Row label="Paid earlier / online" value={money(shift.prepaid.collected)} />
            ) : null}
            {clearedTotal ? (
              <Row
                label={`${SOURCE_LABEL.payments_tab} and fee changes (${cleared.length})`}
                value={money(clearedTotal)}
              />
            ) : null}
          </tbody>
        </table>
      </section>

      <section aria-labelledby="slip-count">
        <Section id="slip-count">Shift summary</Section>
        <table className="slip-table">
          <tbody>
            <Row label="Payments received" value={shift.payment_count} />
            <Row label="Refunds given" value={shift.refund_count} />
            <Row label="Deposits received" value={shift.deposits.count} />
            {snap ? <Row label="Patients" value={snap.patients} /> : null}
            {snap ? <Row label="Bills finalised" value={snap.bills_finalised} /> : null}
          </tbody>
        </table>
      </section>

      <footer className="slip-sign">
        <div className="slip-sign__boxes">
          <div>
            <span className="slip-sign__line" aria-hidden="true" />
            Handed over by
          </div>
          <div>
            <span className="slip-sign__line" aria-hidden="true" />
            Received by
          </div>
        </div>
        <div>Printed {clock(new Date().toISOString())}</div>
      </footer>
    </article>
  );
}
