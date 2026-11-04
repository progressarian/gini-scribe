import { Link, useParams } from "react-router-dom";
import { Printer } from "lucide-react";
import { useShiftHandover } from "../../queries/hooks/useStaffDashboard";
import { errorOf } from "../../components/billing/format";
import { money } from "../../components/billing/dashboard/dashboardText";
import {
  cashStatus,
  clock,
  hoursOpen,
  SOURCE_LABEL,
} from "../../components/billing/staff/staffText";
import { takenModeText } from "../../components/billing/counter/lineText";
import { NEFT_LABEL } from "../../../shared/billingVocab.js";
import "./shiftSlip.css";

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

export default function ShiftSlipPage() {
  const { id } = useParams();
  const { data, isLoading, isError, error } = useShiftHandover(id);
  if (isLoading) return <main className="slip slip--status">Loading the handover…</main>;
  if (isError) {
    return (
      <main className="slip slip--status" role="alert">
        {errorOf(error, "Could not load this shift's handover")}{" "}
        <Link to="/giniflow/station/reception?tab=shift">Back to the counter</Link>
      </main>
    );
  }
  const { shift, payments, cleared } = data;
  const snap = shift.handover;
  const expected = snap?.expected_cash ?? shift.expected_cash;
  const counted = snap ? snap.counted_cash : shift.counted_cash;
  const difference = snap ? snap.difference : shift.difference;
  const changed = Boolean(snap) && snap.expected_cash !== shift.expected_cash;
  const status = cashStatus(shift);
  const otherModes = byModeAndApp(payments);
  const clearedTotal = cleared.reduce((sum, row) => sum + row.amount, 0);
  const denominations = shift.denominations;
  return (
    <main className="slip">
      <div className="slip-actions">
        <button type="button" className="slip-print" onClick={() => window.print()}>
          <Printer size={14} aria-hidden="true" /> Print
        </button>
      </div>
      <header className="slip-head">
        <h1>Cash handover — {shift.is_open ? "shift still open" : "shift closed"}</h1>
        <p>
          <strong>{shift.user.name}</strong> · opened {clock(shift.opened_at)}
          {shift.closed_at ? ` · closed ${clock(shift.closed_at)}` : ""} ({hoursOpen(shift)})
        </p>
        <p>
          Status: <strong>{status.label}</strong>
          {snap && !snap.closed_by_owner ? " · closed by an admin" : ""}
          {shift.note ? ` · Note: “${shift.note}”` : ""}
        </p>
      </header>

      <section aria-labelledby="slip-cash">
        <h2 id="slip-cash">Cash in the drawer</h2>
        <table className="slip-table">
          <tbody>
            <Row label="Opening cash" value={money(shift.opening_cash)} />
            <Row label="+ Cash taken" value={money(snap?.collected.cash ?? shift.collected.cash)} />
            <Row
              label="− Cash paid back"
              value={`−${money(snap?.refunded.cash ?? shift.refunded.cash)}`}
            />
            <Row label="= Expected in drawer" value={money(expected)} strong />
            <Row
              label="Counted"
              value={
                counted === null
                  ? shift.is_open
                    ? "Not closed yet"
                    : "Not counted"
                  : money(counted)
              }
            />
            <Row
              label="Difference"
              value={
                difference === null
                  ? "—"
                  : `${difference < 0 ? "−" : difference > 0 ? "+" : ""}${money(Math.abs(difference))} ${status.label}`
              }
              strong
            />
          </tbody>
        </table>
        {changed ? (
          <p className="slip-warn">
            A payment in this shift was changed after it closed: expected cash is now{" "}
            {money(shift.expected_cash)}. The figures above are as handed over.
          </p>
        ) : null}
      </section>

      {denominations ? (
        <section aria-labelledby="slip-notes">
          <h2 id="slip-notes">Note count</h2>
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
        <h2 id="slip-other">Other money (not in the drawer)</h2>
        <table className="slip-table">
          <tbody>
            {otherModes.map(([label, sum]) => (
              <Row key={label} label={`${label} (${sum.count})`} value={money(sum.amount)} />
            ))}
            {!otherModes.length ? (
              <Row label={`Card / UPI / ${NEFT_LABEL}`} value={money(0)} />
            ) : null}
            {shift.healthray.collected ? (
              <Row
                label="Paid in HealthRay (marked here)"
                value={money(shift.healthray.collected)}
              />
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
        <h2 id="slip-count">Work in this shift</h2>
        <table className="slip-table">
          <tbody>
            <Row label="Payments taken" value={shift.payment_count} />
            <Row label="Refunds paid out" value={shift.refund_count} />
            <Row label="Deposits taken" value={shift.deposits.count} />
            {snap ? <Row label="Patients" value={snap.patients} /> : null}
            {snap ? <Row label="Bills finalised" value={snap.bills_finalised} /> : null}
          </tbody>
        </table>
      </section>

      <footer className="slip-sign">
        <div>Signature: ______________________</div>
        <div>Printed {clock(new Date().toISOString())}</div>
      </footer>
    </main>
  );
}
