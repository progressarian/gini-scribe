import { useState } from "react";
import ConfirmModal from "../../ui/ConfirmModal";
import {
  useCloseShift,
  useCurrentShift,
  useMyShifts,
  useOpenShift,
} from "../../../queries/hooks/useBilling";
import { errorOf, moneyTyped, rupees } from "../format";
import { PAYMENT_MODE_LABEL, shiftStateText } from "./lineText";

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
  const openShift = useOpenShift();
  const closeShift = useCloseShift();
  const [opening, setOpening] = useState("");
  const [counted, setCounted] = useState("");
  const [note, setNote] = useState("");
  const [closing, setClosing] = useState(false);
  const [error, setError] = useState(null);
  const [done, setDone] = useState(null);

  const expected = Number(shift?.expected_cash ?? 0);
  const countedAmount = Number(counted || 0);
  const difference = Number((countedAmount - expected).toFixed(2));
  const earlier = (mine || []).filter((row) => !row.is_open);

  const open = async () => {
    setError(null);
    setDone(null);
    try {
      await openShift.mutateAsync(opening.trim() ? { opening_cash: opening.trim() } : {});
      setOpening("");
    } catch (e) {
      setError(errorOf(e, "That shift could not be opened"));
    }
  };

  const close = async () => {
    setError(null);
    try {
      const closed = await closeShift.mutateAsync({
        counted_cash: counted.trim(),
        ...(note.trim() ? { note: note.trim() } : {}),
      });
      setClosing(false);
      setCounted("");
      setNote("");
      setDone(
        `Shift closed. Expected ${rupees(closed.expected_cash)}, counted ${rupees(
          closed.counted_cash,
        )}, difference ${rupees(closed.difference)}.`,
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
          <div className="bc-head__row">
            <label className="bc-field">
              <span className="bc-field__lbl">Opening cash</span>
              <input
                className="bc-field__in"
                inputMode="decimal"
                value={opening}
                onChange={(e) => setOpening(moneyTyped(e.target.value))}
              />
            </label>
            <button
              type="button"
              className="st-btn st-btn-grn"
              disabled={openShift.isPending}
              onClick={open}
            >
              Open shift
            </button>
          </div>
        </>
      )}

      {shift?.is_open && (
        <>
          <div className="bc-hint">
            Open since {clock(shift.opened_at)} · {shift.payment_count} payments on{" "}
            {shift.bill_count} bills
          </div>
          <table className="ltable bc-totals" aria-label="Drawer">
            <tbody>
              {figure("Opening cash", shift.opening_cash, "opening")}
              {Object.entries(PAYMENT_MODE_LABEL).map(([mode, label]) =>
                figure(`${label} collected`, shift.collected[mode], mode),
              )}
              {figure("Expected in the drawer", shift.expected_cash, "expected")}
            </tbody>
          </table>

          <div className="bc-head__row">
            <label className="bc-field">
              <span className="bc-field__lbl">Counted cash</span>
              <input
                className="bc-field__in"
                inputMode="decimal"
                value={counted}
                onChange={(e) => setCounted(moneyTyped(e.target.value))}
              />
            </label>
            <label className="bc-field">
              <span className="bc-field__lbl">Note</span>
              <input
                className="bc-field__in"
                maxLength={280}
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
            </label>
            <span className="bc-hint" aria-label="Difference">
              Difference {rupees(difference)}
            </span>
            <button
              type="button"
              className="st-btn st-btn-red"
              disabled={!counted.trim() || closeShift.isPending}
              onClick={() => {
                setError(null);
                setDone(null);
                setClosing(true);
              }}
            >
              Close shift
            </button>
          </div>
        </>
      )}

      {done && <div className="bc-note">{done}</div>}
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
              </tr>
            </thead>
            <tbody>
              {earlier.map((row) => (
                <tr key={row.id}>
                  <td data-label="Opened">{clock(row.opened_at)}</td>
                  <td data-label="Closed">{clock(row.closed_at)}</td>
                  <td data-label="Expected">{rupees(row.expected_cash)}</td>
                  <td data-label="Counted">{rupees(row.counted_cash)}</td>
                  <td data-label="Difference">{rupees(row.difference)}</td>
                  <td data-label="Status">{shiftStateText(row.is_open)}</td>
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
        busy={closeShift.isPending}
        error={error}
        message={
          <>
            <div>
              Expected in the drawer {rupees(expected)}, counted {rupees(countedAmount)}, difference{" "}
              {rupees(difference)}.
            </div>
            <div>No more cash can be taken on this shift once it is closed.</div>
          </>
        }
        onCancel={() => setClosing(false)}
        onConfirm={close}
      />
    </section>
  );
}
