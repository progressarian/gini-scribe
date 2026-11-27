import { useId, useState } from "react";
import useDialog from "../billing/useDialog";
import BillDialogLayer from "../billing/BillDialogLayer";
import { requestErrorOf, fromPaise } from "../billing/format";
import { RELEASE_REASON_MAX } from "../../../shared/reportRelease.js";
import "./cancelRequests.css";
import "../../pages/billing/deskRequests.css";

export default function ReleaseNoteDialog({
  title,
  intro,
  patient,
  due = null,
  quote = null,
  label,
  required,
  submitLabel,
  pendingLabel,
  danger = false,
  failText,
  onSubmit,
  onClose,
}) {
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const ref = useDialog(true, onClose);
  const titleId = useId();
  const noteId = useId();
  const errorId = useId();
  const missing = required && !note.trim();

  const submit = async (e) => {
    e.preventDefault();
    if (missing) {
      setError(`${label} is required.`);
      return;
    }
    setError("");
    setBusy(true);
    try {
      await onSubmit(note.trim());
    } catch (err) {
      setError(requestErrorOf(err, failText));
      setBusy(false);
    }
  };

  return (
    <BillDialogLayer>
      <div className="flow-dialog-backdrop" onClick={onClose} role="presentation">
        <form
          ref={ref}
          className="flow-card bill-dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          onClick={(e) => e.stopPropagation()}
          onSubmit={submit}
        >
          <h2 id={titleId} className="bill-dialog__title">
            {title}
          </h2>
          <dl className="cxl-facts">
            <dt>Patient</dt>
            <dd>
              <strong>{patient.name}</strong>
              {patient.file_no ? ` · ${patient.file_no}` : ""}
            </dd>
            {patient.visit_date ? (
              <>
                <dt>Visit</dt>
                <dd>{patient.visit_date}</dd>
              </>
            ) : null}
            {due !== null ? (
              <>
                <dt>Bill due</dt>
                <dd>{due > 0 ? fromPaise(due) : "No final bill due yet"}</dd>
              </>
            ) : null}
          </dl>
          <p className="fset__cardsub">{intro}</p>
          {quote ? <p className="dreq__quote">{quote}</p> : null}
          <div className="fset__field">
            <label htmlFor={noteId}>
              {label}
              {required ? <span aria-hidden="true"> *</span> : null}
            </label>
            <textarea
              id={noteId}
              className="jb-assign"
              rows={3}
              maxLength={RELEASE_REASON_MAX}
              required={required}
              aria-invalid={!!error}
              aria-describedby={error ? errorId : undefined}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </div>
          {error ? (
            <p id={errorId} className="bill-dialog__error" role="alert">
              {error}
            </p>
          ) : null}
          <div className="bill-dialog__actions">
            <button type="button" className="flow-btn flow-btn-ghost" onClick={onClose}>
              Cancel
            </button>
            <button
              type="submit"
              className={`flow-btn ${danger ? "flow-btn-red" : "flow-btn-primary"}`}
              disabled={busy}
            >
              {busy ? pendingLabel : submitLabel}
            </button>
          </div>
        </form>
      </div>
    </BillDialogLayer>
  );
}
