import { useState } from "react";
import { Link } from "react-router-dom";
import ConfirmModal from "../../ui/ConfirmModal";
import { useSkipShiftClose } from "../../../queries/hooks/useBilling";
import { errorOf, rupees } from "../format";
import CountCashFields from "./CountCashFields";
import OpenShiftForm from "./OpenShiftForm";
import { useCloseShiftForm } from "./useCloseShiftForm";

const openedAt = (iso) =>
  new Date(iso).toLocaleString("en-IN", {
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "Asia/Kolkata",
  });

export default function EarlierShiftDialog({ shift, onContinue, onCancel }) {
  const count = useCloseShiftForm(shift);
  const skip = useSkipShiftClose();
  const [step, setStep] = useState("ask");
  const [closed, setClosed] = useState(null);
  const [error, setError] = useState(null);

  const skipForNow = async () => {
    setError(null);
    try {
      await skip.mutateAsync();
      onContinue();
    } catch (e) {
      setError(errorOf(e, "Could not carry on without closing the shift"));
    }
  };

  const closeShift = async () => {
    setError(null);
    try {
      setClosed(await count.close());
      setStep("open");
    } catch (e) {
      setError(errorOf(e, "That shift could not be closed"));
    }
  };

  if (step === "close") {
    return (
      <ConfirmModal
        open
        title="Count the cash and close the shift"
        variant="primary"
        confirmLabel={count.pending ? "Closing…" : "Close the shift"}
        cancelLabel="Back"
        confirmDisabled={!count.canClose}
        busy={count.pending}
        error={error}
        message={
          <div className="bc-shiftask">
            <p>
              Expected in the drawer <strong>{rupees(count.expected)}</strong>. No more cash can be
              taken on this shift once it is closed.
            </p>
            <CountCashFields count={count} />
          </div>
        }
        onConfirm={closeShift}
        onCancel={() => {
          setError(null);
          setStep("ask");
        }}
      />
    );
  }

  if (step === "open") {
    return (
      <ConfirmModal
        open
        title="Open today's shift"
        cancelLabel="Not now"
        message={
          <div className="bc-shiftask">
            {closed ? (
              <p role="status">
                Shift closed. Expected {rupees(closed.expected_cash)}, counted{" "}
                {rupees(closed.counted_cash)}, difference {rupees(closed.difference)}.{" "}
                <Link to={`/billing/shift-slip/${closed.id}`} target="_blank" rel="noopener">
                  Print the handover slip
                </Link>
              </p>
            ) : null}
            <p>Open today&apos;s shift to carry on with the payment.</p>
            <OpenShiftForm form={count.form} onOpened={onContinue} />
          </div>
        }
        onCancel={onCancel}
      />
    );
  }

  return (
    <ConfirmModal
      open
      title="Close yesterday's shift first"
      variant="primary"
      confirmLabel="Close shift and continue"
      cancelLabel="Not now"
      secondaryLabel={skip.isPending ? "Carrying on…" : "Skip for now"}
      onSecondary={skipForNow}
      busy={skip.isPending}
      error={error}
      message={
        <div className="bc-shiftask">
          <p>
            Your shift opened on <strong>{openedAt(shift.opened_at)}</strong> is still open (
            {shift.payment_count} payment{shift.payment_count === 1 ? "" : "s"} ·{" "}
            {rupees(shift.expected_cash)} cash expected in the drawer).
          </p>
          <p>
            Close it so today&apos;s cash is counted on its own, then open today&apos;s shift. Skip
            puts this payment on the old shift and won&apos;t ask again today.
          </p>
        </div>
      }
      onConfirm={() => {
        setError(null);
        setStep("close");
      }}
      onCancel={onCancel}
    />
  );
}
