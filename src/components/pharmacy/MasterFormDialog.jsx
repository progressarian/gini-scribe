import { useId, useState } from "react";
import useDialog from "../billing/useDialog";
import BillDialogLayer from "../billing/BillDialogLayer";
import "../../pages/pharmacy/pharmacyVendors.css";

export default function MasterFormDialog({
  title,
  intro = null,
  dirty,
  busy,
  error,
  submitLabel,
  onSubmit,
  onClose,
  wide = true,
  children,
}) {
  const titleId = useId();
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const requestClose = () => (dirty ? setConfirmDiscard(true) : onClose());
  const ref = useDialog(true, requestClose);

  return (
    <BillDialogLayer>
      <div className="flow-dialog-backdrop" onClick={requestClose} role="presentation">
        <form
          ref={ref}
          className={`flow-card bill-dialog${wide ? " bill-dialog--wide" : ""} phv-dialog`}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          onClick={(e) => e.stopPropagation()}
          onSubmit={onSubmit}
          noValidate
        >
          <h2 id={titleId} className="bill-dialog__title">
            {title}
          </h2>
          {intro}
          {children}

          {error ? (
            <p className="bill-dialog__error" role="alert">
              {error}
            </p>
          ) : null}

          {confirmDiscard ? (
            <div
              className="bill-dialog__actions bill-dialog__discard"
              role="group"
              aria-label="Discard changes?"
            >
              <span>Discard your changes?</span>
              <button
                type="button"
                className="flow-btn flow-btn-ghost"
                autoFocus
                onClick={() => setConfirmDiscard(false)}
              >
                Keep editing
              </button>
              <button type="button" className="flow-btn flow-btn-red" onClick={() => onClose()}>
                Discard
              </button>
            </div>
          ) : (
            <div className="bill-dialog__actions">
              <button type="button" className="flow-btn flow-btn-ghost" onClick={requestClose}>
                Cancel
              </button>
              <button type="submit" className="flow-btn flow-btn-primary" disabled={busy}>
                {busy ? "Saving…" : submitLabel}
              </button>
            </div>
          )}
        </form>
      </div>
    </BillDialogLayer>
  );
}
