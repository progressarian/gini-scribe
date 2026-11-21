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

function CashSince({ shift }) {
  const cashIn = Number(shift.collected?.cash ?? 0);
  const cashOut = Number(shift.refunded?.cash ?? 0);
  const pharmacyIn = Number(shift.pharmacy?.cash_collected ?? 0);
  const pharmacyOut = Number(shift.pharmacy?.cash_refunded ?? 0);
  const healthrayCash =
    Number(shift.healthray?.cash_collected ?? 0) - Number(shift.healthray?.cash_refunded ?? 0);
  const healthray =
    Number(shift.healthray?.collected ?? 0) - Number(shift.healthray?.cash_collected ?? 0);
  return (
    <>
      <table
        className="ltable bc-totals bc-totals--drawer"
        aria-label="Cash since the shift opened"
      >
        <caption className="bc-shiftask__cap">
          Cash since {openedAt(shift.opened_at)} (all days of this shift)
        </caption>
        <tbody>
          <tr>
            <th scope="row">Cash at the start</th>
            <td>{rupees(shift.opening_cash ?? 0)}</td>
          </tr>
          <tr>
            <th scope="row">Cash received from patients</th>
            <td>+{rupees(cashIn)}</td>
          </tr>
          <tr>
            <th scope="row">Cash refunded to patients</th>
            <td>−{rupees(cashOut)}</td>
          </tr>
          {healthrayCash ? (
            <tr>
              <th scope="row">Paid in HealthRay by cash</th>
              <td>+{rupees(healthrayCash)}</td>
            </tr>
          ) : null}
          {pharmacyIn || pharmacyOut ? (
            <tr>
              <th scope="row">Pharmacy cash (after refunds)</th>
              <td>+{rupees(pharmacyIn - pharmacyOut)}</td>
            </tr>
          ) : null}
          <tr>
            <th scope="row">Cash that should be in the drawer</th>
            <td>{rupees(shift.expected_cash ?? 0)}</td>
          </tr>
        </tbody>
      </table>
      {healthray ? (
        <p className="bc-hint">
          Paid in HealthRay {rupees(healthray)} by card, UPI, NEFT or with no mode recorded is not
          in this drawer, so it is not counted here.
        </p>
      ) : null}
    </>
  );
}

const fillAmount = (value) => Number(value ?? 0).toFixed(2);

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
            <CashSince shift={shift} />
            <p>
              Count the cash in the drawer and enter it below. No more cash can be taken on this
              shift once it is closed.{" "}
              {!count.byNotes ? (
                <button
                  type="button"
                  className="bc-linkbtn"
                  onClick={() => count.setCounted(fillAmount(count.expected))}
                >
                  Counted {rupees(count.expected)}, same as expected
                </button>
              ) : null}
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
            {shift.payment_count} payment{shift.payment_count === 1 ? "" : "s"} since then ·{" "}
            {rupees(shift.expected_cash)} cash should be in the drawer).
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
