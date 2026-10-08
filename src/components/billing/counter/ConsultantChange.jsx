import { useState } from "react";
import ConfirmModal from "../../ui/ConfirmModal";
import {
  useConfirmConsultantChange,
  useConsultantChange,
  useDismissConsultantChange,
} from "../../../queries/hooks/useBilling";
import { errorOf, fromPaise } from "../format";

const REFUND_MODES = [
  { value: "cash", label: "Cash" },
  { value: "card", label: "Card" },
  { value: "upi", label: "UPI" },
];

function outcome(preview) {
  if (preview.new_fee === null) return "the new consultant has no fee set yet";
  if (preview.difference > 0) return `${fromPaise(preview.difference)} more to collect`;
  if (preview.difference < 0) return `${fromPaise(-preview.difference)} goes back to the patient`;
  return "same fee";
}

export default function ConsultantChange({ visitId, patient, onSettled }) {
  const { data: change } = useConsultantChange(visitId);
  const confirm = useConfirmConsultantChange();
  const dismiss = useDismissConsultantChange();
  const [step, setStep] = useState(null);
  const [leftover, setLeftover] = useState("deposit");
  const [refundMode, setRefundMode] = useState("cash");
  const [note, setNote] = useState("");
  const [error, setError] = useState(null);
  const [done, setDone] = useState(null);

  if (!change && !done) return null;

  const preview = change?.preview;
  const close = () => {
    if (confirm.isPending || dismiss.isPending) return;
    setStep(null);
    setError(null);
  };

  const settle = async () => {
    setError(null);
    try {
      const made = await confirm.mutateAsync({
        changeId: change.id,
        visitId,
        leftover,
        refund_mode: leftover === "refund" ? refundMode : null,
        note: note.trim() || null,
      });
      setDone(
        `Consultant change settled: ${fromPaise(made.to_deposit)} credited to the deposit, ` +
          `${fromPaise(made.applied_from_deposit)} used for the new fee` +
          (made.refund_requested
            ? `, ${fromPaise(made.refund_requested)} refund waiting for a second person's approval.`
            : made.left_in_deposit
              ? `, ${fromPaise(made.left_in_deposit)} kept in the deposit.`
              : "."),
      );
      setStep(null);
      onSettled?.();
    } catch (e) {
      setError(errorOf(e, "The consultant change could not be settled"));
    }
  };

  const keepBill = async () => {
    setError(null);
    try {
      await dismiss.mutateAsync({ changeId: change.id, visitId, note: note.trim() });
      setDone("The bill stays as it is; the consultant change is closed.");
      setStep(null);
    } catch (e) {
      setError(errorOf(e, "The consultant change could not be closed"));
    }
  };

  if (!change) {
    return (
      <div className="bc-note" role="status">
        {done}
      </div>
    );
  }

  const leftOver = preview?.left_in_deposit ?? 0;

  return (
    <div className="bc-hint" role="status" aria-label="Consultant changed">
      <strong>
        Consultant changed — {change.from.name} → {change.to.name}
      </strong>
      {preview && (
        <>
          {" "}
          · billed {fromPaise(preview.charged)}, new fee{" "}
          {preview.new_fee === null ? "not set" : fromPaise(preview.new_fee)} · {outcome(preview)}
        </>
      )}
      {change.reassigned_by?.name ? ` · changed by ${change.reassigned_by.name}` : ""}
      <div className="bc-head__row">
        <button
          type="button"
          className="st-btn st-btn-blu"
          disabled={!preview || preview.new_fee === null}
          onClick={() => {
            setNote("");
            setStep("confirm");
          }}
        >
          Settle fee change
        </button>
        <button
          type="button"
          className="st-btn st-btn-g"
          onClick={() => {
            setNote("");
            setStep("dismiss");
          }}
        >
          Keep the bill as it is
        </button>
      </div>

      <ConfirmModal
        open={step === "confirm"}
        title="Settle the consultant change?"
        variant="primary"
        confirmLabel={confirm.isPending ? "Settling…" : "Settle fee change"}
        busy={confirm.isPending}
        error={error}
        onConfirm={settle}
        onCancel={close}
        message={
          preview && (
            <div className="bc-mdisc">
              <dl className="bc-pay__mini">
                <div>
                  <dt>Patient</dt>
                  <dd>
                    {patient?.name || "—"}
                    {patient?.fileNo ? ` · ${patient.fileNo}` : ""}
                  </dd>
                </div>
                <div>
                  <dt>Bill</dt>
                  <dd>{preview.bills.join(", ") || "—"}</dd>
                </div>
                <div>
                  <dt>Consultant</dt>
                  <dd>
                    {change.from.name} → {change.to.name}
                  </dd>
                </div>
                <div>
                  <dt>Billed for {change.from.name}</dt>
                  <dd>{fromPaise(preview.charged)}</dd>
                </div>
                <div>
                  <dt>Into the deposit</dt>
                  <dd>{fromPaise(preview.to_deposit)}</dd>
                </div>
                <div>
                  <dt>New fee · {change.to.name}</dt>
                  <dd>{fromPaise(preview.new_fee)}</dd>
                </div>
                <div>
                  <dt>Paid from the deposit</dt>
                  <dd>{fromPaise(preview.applied_from_deposit)}</dd>
                </div>
                <div className="bc-pay__left">
                  <dt>Still to collect</dt>
                  <dd>{fromPaise(preview.to_collect)}</dd>
                </div>
                {leftOver > 0 && (
                  <div>
                    <dt>Left over</dt>
                    <dd>{fromPaise(leftOver)}</dd>
                  </div>
                )}
              </dl>
              {leftOver > 0 && (
                <fieldset className="bc-field">
                  <legend className="bc-field__lbl">The {fromPaise(leftOver)} left over</legend>
                  <label>
                    <input
                      type="radio"
                      name="cc-leftover"
                      value="deposit"
                      checked={leftover === "deposit"}
                      onChange={() => setLeftover("deposit")}
                    />{" "}
                    Keep in the patient's deposit
                  </label>
                  <label>
                    <input
                      type="radio"
                      name="cc-leftover"
                      value="refund"
                      checked={leftover === "refund"}
                      onChange={() => setLeftover("refund")}
                    />{" "}
                    Refund it — needs a second person's approval
                  </label>
                  {leftover === "refund" && (
                    <label className="bc-field">
                      <span className="bc-field__lbl">Pay back by</span>
                      <select
                        className="bc-field__in"
                        value={refundMode}
                        onChange={(e) => setRefundMode(e.target.value)}
                      >
                        {REFUND_MODES.map((mode) => (
                          <option key={mode.value} value={mode.value}>
                            {mode.label}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                </fieldset>
              )}
              <label className="bc-field">
                <span className="bc-field__lbl">Note (optional)</span>
                <input
                  className="bc-field__in"
                  value={note}
                  maxLength={300}
                  onChange={(e) => setNote(e.target.value)}
                />
              </label>
              <p className="bc-hint">
                A credit note is made for {change.from.name}'s consultation and {change.to.name}'s
                consultation is added to this visit's draft bill. This can't be undone.
              </p>
            </div>
          )
        }
      />

      <ConfirmModal
        open={step === "dismiss"}
        title="Keep the bill as it is?"
        variant="primary"
        confirmLabel={dismiss.isPending ? "Saving…" : "Keep the bill"}
        busy={dismiss.isPending}
        confirmDisabled={!note.trim()}
        error={error}
        onConfirm={keepBill}
        onCancel={close}
        message={
          <div className="bc-mdisc">
            <p className="bc-hint">
              The patient stays with {change.to.name}, but the bill keeps {change.from.name}'s
              consultation fee.
            </p>
            <label className="bc-field">
              <span className="bc-field__lbl">Why the bill stays as it is (required)</span>
              <input
                className="bc-field__in"
                value={note}
                maxLength={300}
                onChange={(e) => setNote(e.target.value)}
              />
            </label>
          </div>
        }
      />
    </div>
  );
}
