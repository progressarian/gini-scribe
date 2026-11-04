import { useState } from "react";
import ConfirmModal from "../../ui/ConfirmModal";
import { useAdminCloseShift } from "../../../queries/hooks/useStaffDashboard";
import { errorOf, moneyTyped } from "../format";
import { money } from "../dashboard/dashboardText";

export default function AdminCloseShift({ shift }) {
  const close = useAdminCloseShift();
  const [counted, setCounted] = useState("");
  const [notCounted, setNotCounted] = useState(false);
  const [note, setNote] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState(null);
  const countedPaise = Math.round(Number(counted || 0) * 100);
  const difference = countedPaise - shift.expected_cash;
  const ready = notCounted ? note.trim().length > 0 : counted.trim().length > 0;

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
      onSubmit={(e) => {
        e.preventDefault();
        if (ready) setConfirming(true);
      }}
    >
      <h3 className="sd-drawer__sub">Close this shift for {shift.user.name}</h3>
      <p className="bdash-muted">
        For a shift the staff member left open. Count the drawer with them, or close it as not
        counted with a note saying why.
      </p>
      <div className="sd-close__row">
        <label className="fset__field">
          <span>Counted cash</span>
          <input
            className="jb-assign"
            inputMode="decimal"
            value={counted}
            disabled={notCounted}
            onChange={(e) => setCounted(moneyTyped(e.target.value))}
          />
        </label>
        <label className="sd-close__check">
          <input
            type="checkbox"
            checked={notCounted}
            onChange={(e) => setNotCounted(e.target.checked)}
          />
          Close as not counted
        </label>
        <label className="fset__field sd-close__note">
          <span>Note{notCounted ? " (required)" : ""}</span>
          <input
            className="jb-assign"
            maxLength={280}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </label>
        <button
          type="submit"
          className="flow-btn flow-btn-mini"
          disabled={!ready || close.isPending}
        >
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
