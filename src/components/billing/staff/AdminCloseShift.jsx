import { useId, useState } from "react";
import ConfirmModal from "../../ui/ConfirmModal";
import { useAdminCloseShift } from "../../../queries/hooks/useStaffDashboard";
import { errorOf } from "../format";
import { money } from "../dashboard/dashboardText";
import { cashPaise, cashTyped, countedProblem, countedWarning } from "./staffText";

const NOTE_MAX = 280;

export default function AdminCloseShift({ shift }) {
  const close = useAdminCloseShift();
  const countedId = useId();
  const noteId = useId();
  const [counted, setCounted] = useState("");
  const [notCounted, setNotCounted] = useState(false);
  const [note, setNote] = useState("");
  const [touched, setTouched] = useState({});
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState(null);

  const countedPaise = cashPaise(counted);
  const difference = countedPaise - shift.expected_cash;
  const countedError = notCounted ? null : countedProblem(counted);
  const noteError = notCounted && !note.trim() ? "Say why the cash isn't being counted." : null;
  const warning =
    notCounted || countedError ? null : countedWarning(countedPaise, shift.expected_cash);
  const ready = !countedError && !noteError;
  const show = (field) => touched[field] || touched.submit;

  const submit = async () => {
    setError(null);
    try {
      await close.mutateAsync({
        id: shift.id,
        ...(notCounted ? { not_counted: true } : { counted_cash: counted.trim() }),
        note: note.trim() || null,
      });
      setConfirming(false);
    } catch (e) {
      setError(errorOf(e, "That shift could not be closed"));
    }
  };

  return (
    <form
      className="sd-close"
      aria-label="Close this shift"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        setTouched((was) => ({ ...was, submit: true }));
        if (ready) setConfirming(true);
      }}
    >
      <h3 className="sd-drawer__sub">Close this shift for {shift.user.name}</h3>
      <p className="bdash-muted">
        For a shift the staff member left open. Count the drawer with them, or close it as not
        counted with a note saying why. Expected in the drawer:{" "}
        <strong>{money(shift.expected_cash)}</strong>.
      </p>
      <div className="sd-close__row">
        <div className="fset__field sd-close__field">
          <label htmlFor={countedId}>Counted cash{notCounted ? "" : " *"}</label>
          <input
            id={countedId}
            className="jb-assign"
            inputMode="decimal"
            autoComplete="off"
            value={counted}
            disabled={notCounted}
            aria-invalid={show("counted") && countedError ? true : undefined}
            aria-describedby={`${countedId}-msg`}
            onChange={(e) => setCounted(cashTyped(e.target.value))}
            onBlur={() => setTouched((was) => ({ ...was, counted: true }))}
          />
          <span id={`${countedId}-msg`} className="sd-field-msg">
            {show("counted") && countedError ? (
              <span className="sd-field-msg--error">{countedError}</span>
            ) : warning ? (
              <span className="sd-field-msg--warn" role="status">
                {warning}
              </span>
            ) : counted && !notCounted ? (
              `Difference ${difference < 0 ? "−" : difference > 0 ? "+" : ""}${money(Math.abs(difference))}`
            ) : null}
          </span>
        </div>
        <label className="sd-close__check">
          <input
            type="checkbox"
            checked={notCounted}
            onChange={(e) => setNotCounted(e.target.checked)}
          />
          Close as not counted
        </label>
        <div className="fset__field sd-close__note">
          <label htmlFor={noteId}>Note{notCounted ? " *" : " (optional)"}</label>
          <input
            id={noteId}
            className="jb-assign"
            maxLength={NOTE_MAX}
            value={note}
            aria-invalid={show("note") && noteError ? true : undefined}
            aria-describedby={`${noteId}-msg`}
            onChange={(e) => setNote(e.target.value)}
            onBlur={() => setTouched((was) => ({ ...was, note: true }))}
          />
          <span id={`${noteId}-msg`} className="sd-field-msg">
            {show("note") && noteError ? (
              <span className="sd-field-msg--error">{noteError}</span>
            ) : note.length > NOTE_MAX - 40 ? (
              `${NOTE_MAX - note.length} letters left`
            ) : null}
          </span>
        </div>
        <button type="submit" className="flow-btn flow-btn-mini" disabled={close.isPending}>
          Close shift
        </button>
      </div>
      {error && !confirming ? (
        <div className="brep-error" role="alert">
          {error}
        </div>
      ) : null}
      <ConfirmModal
        open={confirming}
        title={`Close ${shift.user.name}'s shift?`}
        confirmLabel="Close the shift"
        cancelLabel="Keep it open"
        busy={close.isPending}
        error={error}
        message={
          <>
            <div>
              Expected in the drawer {money(shift.expected_cash)}
              {notCounted
                ? " — closed as not counted, so no difference is recorded."
                : `, counted ${money(countedPaise)}, difference ${difference < 0 ? "−" : ""}${money(Math.abs(difference))}${difference < 0 ? " short" : difference > 0 ? " over" : ""}.`}
            </div>
            {warning ? <div className="sd-field-msg--warn">{warning}</div> : null}
            <div>
              The handover is recorded under {shift.user.name}&apos;s name, closed by you. No more
              cash can be taken on this shift.
            </div>
          </>
        }
        onCancel={() => setConfirming(false)}
        onConfirm={submit}
      />
    </form>
  );
}
