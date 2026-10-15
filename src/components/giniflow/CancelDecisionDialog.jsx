import { useEffect, useId, useState } from "react";
import { chargeOf } from "../../../shared/testCancelStages.js";
import { fromPaise, requestErrorOf } from "../billing/format";
import useDialog from "../billing/useDialog";
import BillDialogLayer from "../billing/BillDialogLayer";
import {
  useApproveCancelRequest,
  useCancelNow,
  useRejectCancelRequest,
} from "../../queries/hooks/useTestCancelRequests";
import "../../styles/flow.css";
import "../../pages/billing/billing.css";
import "../../pages/billing/billingUi.css";
import "./cancelRequests.css";

const NOTE_MAX = 500;

export default function CancelDecisionDialog({
  mode,
  request,
  paid,
  defaults,
  patient,
  testName,
  stageText,
  reasonText,
  billText,
  nowInput,
  onClose,
  onDone,
}) {
  const approve = useApproveCancelRequest();
  const reject = useRejectCancelRequest();
  const now = useCancelNow();
  const rejecting = mode === "reject";
  const action = rejecting ? reject : mode === "now" ? now : approve;
  const [type, setType] = useState(defaults?.type ?? "percent");
  const [value, setValue] = useState(String(defaults?.[defaults?.type ?? "percent"] ?? ""));
  const [note, setNote] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [touched, setTouched] = useState(false);
  const [error, setError] = useState("");
  const ref = useDialog(true, onClose);
  const titleId = useId();
  const valueId = useId();
  const noteId = useId();
  const valueErrId = useId();
  const noteErrId = useId();

  useEffect(() => {
    if (defaults) setValue(String(defaults[type] ?? ""));
  }, [type]);

  const money = chargeOf({ type, value, paid: (paid ?? 0) / 100 });
  const noteError =
    note.trim().length < 3 ? "Write a short note for the record — at least 3 characters" : "";
  const valueError = rejecting ? "" : money.error || "";
  const ready = !noteError && !valueError && !action.isPending;
  const who = `${patient?.name ?? "Patient"}${patient?.fileNo ? ` (${patient.fileNo})` : ""}`;

  const submit = async (e) => {
    e.preventDefault();
    setTouched(true);
    setError("");
    if (!ready) return;
    if (!rejecting && !confirming) {
      setConfirming(true);
      return;
    }
    try {
      const body = { note: note.trim() };
      if (rejecting) await reject.mutateAsync({ id: request.id, ...body });
      else if (mode === "now")
        await now.mutateAsync({ ...nowInput, ...body, charge_type: type, charge_value: value });
      else
        await approve.mutateAsync({
          id: request.id,
          ...body,
          charge_type: type,
          charge_value: value,
        });
      onDone(
        rejecting
          ? `Cancellation rejected — ${testName}`
          : money.refund > 0
            ? `${testName} cancelled — ${fromPaise(money.refund)} to pay back at the Refunds tab`
            : `${testName} cancelled — no refund, full charge kept`,
      );
    } catch (err) {
      setConfirming(false);
      setError(
        requestErrorOf(
          err,
          rejecting ? "Could not reject the request" : "Could not cancel the test",
        ),
      );
    }
  };

  const title = rejecting
    ? `Reject cancellation of ${testName}`
    : mode === "now"
      ? `Cancel ${testName} after collection`
      : `Approve cancellation of ${testName}`;

  return (
    <BillDialogLayer>
      <div className="flow-dialog-backdrop" onClick={onClose} role="presentation">
        <form
          ref={ref}
          className="flow-card bill-dialog cxl-dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          onClick={(e) => e.stopPropagation()}
          onSubmit={submit}
          noValidate
        >
          <h2 id={titleId} className="bill-dialog__title">
            {title}
          </h2>
          <dl className="cxl-facts">
            <dt>Patient</dt>
            <dd>{who}</dd>
            <dt>Test</dt>
            <dd>
              {testName}
              {stageText ? ` · ${stageText}` : ""}
            </dd>
            {billText ? (
              <>
                <dt>Bill</dt>
                <dd>{billText}</dd>
              </>
            ) : null}
            {reasonText ? (
              <>
                <dt>Reason</dt>
                <dd>{reasonText}</dd>
              </>
            ) : null}
          </dl>

          {confirming ? (
            <div className="cxl-confirm" role="status">
              <p>
                Cancel <strong>{testName}</strong> for <strong>{who}</strong>.{" "}
                {money.refund > 0
                  ? `Keep ${fromPaise(money.charge)}, refund ${fromPaise(money.refund)}.`
                  : `Keep the full ${fromPaise(money.charge)} — no refund.`}{" "}
                The test stops and can't be restarted.
              </p>
            </div>
          ) : (
            <>
              {!rejecting ? (
                <fieldset className="cxl-charge">
                  <legend>Collection charge kept</legend>
                  <div className="cxl-charge__types" role="radiogroup">
                    {[
                      ["percent", "Percentage"],
                      ["fixed", "Fixed amount"],
                    ].map(([key, label]) => (
                      <label key={key} className="cxl-radio">
                        <input
                          type="radio"
                          name="charge-type"
                          value={key}
                          checked={type === key}
                          onChange={() => setType(key)}
                        />
                        {label}
                      </label>
                    ))}
                  </div>
                  <div className="fset__field">
                    <label htmlFor={valueId}>
                      {type === "percent" ? "Percentage of what was paid" : "Amount in ₹"}
                    </label>
                    <div className="cxl-value">
                      {type === "fixed" ? <span aria-hidden="true">₹</span> : null}
                      <input
                        id={valueId}
                        className="jb-assign"
                        inputMode="decimal"
                        value={value}
                        onChange={(e) => setValue(e.target.value.replace(/[^\d.]/g, ""))}
                        onBlur={() => setTouched(true)}
                        aria-invalid={Boolean(touched && valueError)}
                        aria-describedby={touched && valueError ? valueErrId : undefined}
                      />
                      {type === "percent" ? <span aria-hidden="true">%</span> : null}
                    </div>
                    {touched && valueError ? (
                      <p id={valueErrId} className="bill-dialog__error">
                        {valueError}
                      </p>
                    ) : null}
                  </div>
                  <dl className="cxl-sum" aria-live="polite">
                    <dt>Paid</dt>
                    <dd>{fromPaise(paid ?? 0)}</dd>
                    <dt>Collection charge</dt>
                    <dd>−{fromPaise(money.charge ?? 0)}</dd>
                    <dt className="cxl-sum__total">Refund</dt>
                    <dd className="cxl-sum__total">
                      {money.error
                        ? "—"
                        : money.refund > 0
                          ? fromPaise(money.refund)
                          : "No refund — full charge kept"}
                    </dd>
                  </dl>
                </fieldset>
              ) : null}
              <div className="fset__field">
                <label htmlFor={noteId}>Note for the record (required)</label>
                <textarea
                  id={noteId}
                  className="jb-assign"
                  rows={3}
                  maxLength={NOTE_MAX}
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  aria-invalid={Boolean(touched && noteError)}
                  aria-describedby={touched && noteError ? noteErrId : undefined}
                />
                <div className="cxl-count">
                  {note.length}/{NOTE_MAX}
                </div>
                {touched && noteError ? (
                  <p id={noteErrId} className="bill-dialog__error">
                    {noteError}
                  </p>
                ) : null}
              </div>
            </>
          )}
          {error ? (
            <p className="bill-dialog__error" role="alert">
              {error}
            </p>
          ) : null}
          <div className="bill-dialog__actions">
            <button
              type="button"
              className="flow-btn flow-btn-ghost"
              onClick={confirming ? () => setConfirming(false) : onClose}
            >
              {confirming ? "Back" : "Close"}
            </button>
            <button
              type="submit"
              className={`flow-btn ${rejecting ? "flow-btn-red" : "flow-btn-primary"}`}
              disabled={action.isPending}
            >
              {action.isPending
                ? rejecting
                  ? "Rejecting…"
                  : "Cancelling…"
                : rejecting
                  ? "Reject request"
                  : confirming
                    ? "Confirm"
                    : mode === "now"
                      ? "Cancel test…"
                      : "Approve and cancel test…"}
            </button>
          </div>
        </form>
      </div>
    </BillDialogLayer>
  );
}
