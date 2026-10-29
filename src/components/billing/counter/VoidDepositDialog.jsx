import { useState } from "react";
import { createPortal } from "react-dom";
import useDialog from "../useDialog";
import { useVoidDeposit } from "../../../queries/hooks/useBilling";
import { errorOf, fromPaise } from "../format";
import { when } from "../importText";
import { PAYMENT_MODE_LABEL } from "./lineText";

const REASON_MIN = 5;

export default function VoidDepositDialog({ entry, patient, balance, onClose, onVoided }) {
  const voiding = useVoidDeposit();
  const [reason, setReason] = useState("");
  const [error, setError] = useState(null);
  const busy = voiding.isPending;
  const close = busy ? () => {} : onClose;
  const ref = useDialog(true, close);
  const ready = reason.trim().length >= REASON_MIN && !busy;

  const submit = async (event) => {
    event.preventDefault();
    if (!ready) return;
    setError(null);
    try {
      const done = await voiding.mutateAsync({ entryId: entry.id, reason: reason.trim() });
      onVoided(done);
    } catch (e) {
      setError(errorOf(e, "The receipt could not be voided"));
    }
  };

  return createPortal(
    <div className="gf">
      <div className="modal-back" onClick={close} role="presentation">
        <form
          ref={ref}
          className="modal-card"
          role="dialog"
          aria-modal="true"
          aria-labelledby="void-deposit-title"
          onClick={(e) => e.stopPropagation()}
          onSubmit={submit}
        >
          <h2 id="void-deposit-title" className="modal-title">
            Void deposit receipt {entry.receipt_no}?
          </h2>
          <dl className="bc-pay__mini">
            <div>
              <dt>Patient</dt>
              <dd>
                {patient?.name || "—"}
                {patient?.file_no ? ` · ${patient.file_no}` : ""}
              </dd>
            </div>
            <div>
              <dt>Receipt</dt>
              <dd>
                {[entry.receipt_no, PAYMENT_MODE_LABEL[entry.mode] ?? entry.mode, entry.reference]
                  .filter(Boolean)
                  .join(" · ")}
              </dd>
            </div>
            <div>
              <dt>Taken</dt>
              <dd>
                {when(entry.created_at)}
                {entry.created_by_name ? ` · ${entry.created_by_name}` : ""}
              </dd>
            </div>
            <div className="bc-pay__left">
              <dt>Amount</dt>
              <dd>{fromPaise(entry.amount)}</dd>
            </div>
          </dl>
          <p className="modal-body">
            Use this only when no money was received — the deposit was entered by mistake. Deposit
            balance {fromPaise(balance)} → {fromPaise(balance - entry.amount)}. This receipt will no
            longer count in collections, shift totals or the cash drawer. It stays on record as
            voided and can't be undone. If the patient really paid and wants the money back, use{" "}
            <strong>Pay back</strong> instead.
          </p>
          <label className="bc-field">
            <span className="bc-field__lbl">Reason *</span>
            <textarea
              className="bc-field__in"
              rows={2}
              maxLength={300}
              placeholder="e.g. Entered by mistake — bill already settled in cash"
              value={reason}
              onChange={(e) => {
                setReason(e.target.value);
                setError(null);
              }}
              aria-invalid={reason.length > 0 && reason.trim().length < REASON_MIN}
              autoFocus
            />
          </label>
          {error && (
            <div className="bc-err" role="alert">
              {error}
            </div>
          )}
          <div className="modal-acts">
            <button type="button" className="st-btn st-btn-g" disabled={busy} onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="st-btn st-btn-red" disabled={!ready}>
              {busy ? "Voiding…" : "Void receipt"}
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body,
  );
}
