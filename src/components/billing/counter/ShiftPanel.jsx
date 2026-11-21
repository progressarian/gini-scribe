import { useState } from "react";
import { Link } from "react-router-dom";
import ConfirmModal from "../../ui/ConfirmModal";
import { useCurrentShift, useMyShifts } from "../../../queries/hooks/useBilling";
import { errorOf, rupees } from "../format";
import { PAYMENT_MODE_LABEL, shiftStateText, TAKE_MODE_LABEL } from "./lineText";
import { shiftReminder } from "./shiftReminder";
import OpenShiftForm from "./OpenShiftForm";
import CountCashFields from "./CountCashFields";
import { useCloseShiftForm } from "./useCloseShiftForm";

const clock = (iso) =>
  iso
    ? new Date(iso).toLocaleString("en-IN", {
        day: "2-digit",
        month: "short",
        hour: "numeric",
        minute: "2-digit",
        timeZone: "Asia/Kolkata",
      })
    : "—";

export default function ShiftPanel() {
  const { data: shift, isLoading } = useCurrentShift();
  const { data: mine } = useMyShifts();
  const count = useCloseShiftForm(shift);
  const { form, expected, countedAmount, countWarning, difference } = count;
  const [closing, setClosing] = useState(false);
  const [error, setError] = useState(null);
  const [done, setDone] = useState(null);
  const [closedId, setClosedId] = useState(null);

  const reminder = shiftReminder(shift);
  const earlier = (mine || []).filter((row) => !row.is_open);

  const close = async () => {
    setError(null);
    try {
      const closed = await count.close();
      setClosing(false);
      setClosedId(closed.id);
      setDone(
        `Shift closed. Expected ${rupees(closed.expected_cash)}, counted ${rupees(
          closed.counted_cash,
        )}, difference ${rupees(closed.difference)}. The handover is recorded.`,
      );
    } catch (e) {
      setError(errorOf(e, "That shift could not be closed"));
    }
  };

  const figure = (label, amount, key) => (
    <tr key={key}>
      <th scope="row">{label}</th>
      <td>{rupees(amount)}</td>
    </tr>
  );

  return (
    <section className="bc-card" aria-label="Shift">
      <h3 className="bc-card__title">Your shift</h3>
      {isLoading && <div className="empty-note">Loading…</div>}

      {!isLoading && !shift?.is_open && (
        <>
          <div className="bc-hint">No shift is open, so cash can&apos;t be taken yet.</div>
          <OpenShiftForm
            form={form}
            onOpening={() => {
              setError(null);
              setDone(null);
            }}
          />
        </>
      )}

      {shift?.is_open && (
        <>
          {reminder === "earlier" && (
            <div className="bc-pastday" role="alert">
              <span>
                <strong>This shift has been open since {clock(shift.opened_at)}.</strong> Count the
                cash and close it, then open a new shift for today, so each day&apos;s cash is
                handed over on its own.
              </span>
            </div>
          )}
          {reminder === "day_end" && (
            <div className="bc-hint" role="status">
              End of the day — count the cash and close your shift before you leave.
            </div>
          )}
          <div className="bc-hint">
            Open since {clock(shift.opened_at)} · {shift.payment_count} payments on{" "}
            {shift.bill_count} bills
            {shift.refund_count > 0
              ? ` · ${shift.refund_count} refund${shift.refund_count === 1 ? "" : "s"} paid out`
              : ""}
            {shift.deposits?.count > 0
              ? ` · ${shift.deposits.count} deposit${shift.deposits.count === 1 ? "" : "s"} taken (₹${shift.deposits.received.toLocaleString("en-IN", { minimumFractionDigits: 2 })}, included above)`
              : ""}
          </div>
          <div className="bc-shiftgrid">
            <div className="bc-shiftgrid__money">
              <table className="ltable bc-totals bc-totals--drawer" aria-label="Drawer">
                <tbody>
                  {figure("Opening cash", shift.opening_cash, "opening")}
                  {Object.entries(TAKE_MODE_LABEL)
                    .filter(
                      ([mode]) =>
                        Object.hasOwn(PAYMENT_MODE_LABEL, mode) || shift.collected[mode] > 0,
                    )
                    .map(([mode, label]) =>
                      figure(`${label} collected`, shift.collected[mode], mode),
                    )}
                  {figure("Cash paid back", shift.refunded?.cash ?? 0, "refunded-cash")}
                  {Object.entries(TAKE_MODE_LABEL)
                    .filter(([mode]) => mode !== "cash" && (shift.refunded?.[mode] ?? 0) > 0)
                    .map(([mode, label]) =>
                      figure(`${label} paid back`, shift.refunded[mode], `refunded-${mode}`),
                    )}
                  {shift.pharmacy?.cash_collected > 0 &&
                    figure(
                      "Pharmacy cash collected",
                      shift.pharmacy.cash_collected,
                      "pharmacy-cash",
                    )}
                  {shift.pharmacy?.cash_refunded > 0 &&
                    figure(
                      "Pharmacy cash paid back",
                      shift.pharmacy.cash_refunded,
                      "pharmacy-cash-out",
                    )}
                  {shift.healthray?.cash_collected > 0 &&
                    figure(
                      "Paid in HealthRay by cash",
                      shift.healthray.cash_collected,
                      "healthray-cash",
                    )}
                  {shift.healthray?.cash_refunded > 0 &&
                    figure(
                      "HealthRay cash paid back",
                      shift.healthray.cash_refunded,
                      "healthray-cash-out",
                    )}
                  {figure("Expected in the drawer", shift.expected_cash, "expected")}
                </tbody>
              </table>
              {shift.healthray?.collected > (shift.healthray?.cash_collected ?? 0) && (
                <div className="bc-hint" aria-label="Paid in HealthRay">
                  Paid in HealthRay{" "}
                  {rupees(shift.healthray.collected - (shift.healthray.cash_collected ?? 0))} by
                  card, UPI, NEFT or mode not recorded (not in the drawer)
                </div>
              )}
              {shift.pharmacy?.collected > shift.pharmacy?.cash_collected && (
                <div className="bc-hint" aria-label="Pharmacy card, UPI and NEFT">
                  Pharmacy card / UPI / NEFT{" "}
                  {rupees(shift.pharmacy.collected - shift.pharmacy.cash_collected)} (not in the
                  drawer)
                </div>
              )}
              {shift.prepaid?.collected > 0 && (
                <div className="bc-hint" aria-label="Paid earlier or online">
                  Paid earlier / online {rupees(shift.prepaid.collected)} (not in the drawer)
                </div>
              )}
            </div>

            <div className="bc-shiftgrid__close">
              <CountCashFields
                count={count}
                action={
                  <button
                    type="button"
                    className="st-btn st-btn-red"
                    disabled={!count.canClose}
                    onClick={() => {
                      setError(null);
                      setDone(null);
                      setClosing(true);
                    }}
                  >
                    Close shift
                  </button>
                }
              />
            </div>
          </div>
        </>
      )}

      {done && (
        <div className="bc-note" role="status">
          {done}{" "}
          {closedId ? (
            <Link to={`/billing/shift-slip/${closedId}`} target="_blank" rel="noopener">
              Print the handover slip
            </Link>
          ) : null}
        </div>
      )}
      {error && <div className="bc-err">{error}</div>}

      {!!earlier.length && (
        <div className="ltablewrap bc-requests bc-stack">
          <table className="ltable" aria-label="Your earlier shifts">
            <thead>
              <tr>
                <th>Opened</th>
                <th>Closed</th>
                <th>Expected</th>
                <th>Counted</th>
                <th>Difference</th>
                <th>Status</th>
                <th>
                  <span className="sr-only">Handover slip</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {earlier.map((row) => (
                <tr key={row.id}>
                  <td data-label="Opened">{clock(row.opened_at)}</td>
                  <td data-label="Closed">{clock(row.closed_at)}</td>
                  <td data-label="Expected">{rupees(row.expected_cash)}</td>
                  <td data-label="Counted">
                    {row.not_counted ? "Not counted" : rupees(row.counted_cash)}
                  </td>
                  <td data-label="Difference">
                    {row.difference === null ? "—" : rupees(row.difference)}
                  </td>
                  <td data-label="Status">{shiftStateText(row.is_open)}</td>
                  <td data-label="Slip">
                    <Link
                      to={`/billing/shift-slip/${row.id}`}
                      target="_blank"
                      rel="noopener"
                      aria-label={`Handover slip for the shift closed ${clock(row.closed_at)}`}
                    >
                      Slip
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <ConfirmModal
        open={closing}
        title="Close this shift?"
        confirmLabel="Close the shift"
        cancelLabel="Keep it open"
        busy={count.pending}
        error={error}
        message={
          <>
            <div>
              Expected in the drawer {rupees(expected)}, counted {rupees(countedAmount)}, difference{" "}
              {rupees(difference)}.
            </div>
            {countWarning ? <div className="bc-warn">{countWarning}</div> : null}
            <div>No more cash can be taken on this shift once it is closed.</div>
          </>
        }
        onCancel={() => setClosing(false)}
        onConfirm={close}
      />
    </section>
  );
}
