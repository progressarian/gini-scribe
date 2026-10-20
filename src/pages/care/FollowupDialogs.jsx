import { useId, useState } from "react";
import {
  CLOSE_OUTCOMES,
  NOT_AVAILABLE_REASONS,
  REASON_MAX,
  REASON_MIN,
} from "../../../shared/careFollowups.js";
import { requestErrorOf } from "../../components/billing/format";
import useDialog from "../../components/billing/useDialog";
import BillDialogLayer from "../../components/billing/BillDialogLayer";
import { useCloseFollowup, useReopenFollowup } from "../../queries/hooks/useCareFollowups";
import "../../styles/flow.css";
import "../billing/billing.css";
import "../billing/billingUi.css";
import "../../components/giniflow/cancelRequests.css";

function Shell({ title, item, onClose, onSubmit, busy, submitLabel, error, children }) {
  const ref = useDialog(true, onClose);
  const titleId = useId();
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
          onSubmit={(e) => {
            e.preventDefault();
            onSubmit();
          }}
          noValidate
        >
          <h2 id={titleId} className="bill-dialog__title">
            {title}
          </h2>
          <dl className="cxl-facts">
            <dt>Patient</dt>
            <dd>
              {item.patient.name} · {item.patient.fileNo || "no file no"}
              {item.patient.phone ? ` · ${item.patient.phone}` : ""}
            </dd>
            <dt>For</dt>
            <dd>{item.target}</dd>
          </dl>
          {children}
          {error ? (
            <p className="bill-dialog__error" role="alert">
              {error}
            </p>
          ) : null}
          <div className="bill-dialog__actions">
            <button type="button" className="flow-btn flow-btn-ghost" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="flow-btn flow-btn-primary" disabled={busy}>
              {busy ? "Saving…" : submitLabel}
            </button>
          </div>
        </form>
      </div>
    </BillDialogLayer>
  );
}

function ReasonField({ value, onChange, touched, label = "Reason (required)" }) {
  const id = useId();
  const errId = useId();
  const short = value.trim().length < REASON_MIN;
  return (
    <div className="fset__field">
      <label htmlFor={id}>{label}</label>
      <textarea
        id={id}
        className="jb-assign"
        rows={3}
        maxLength={REASON_MAX}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={Boolean(touched && short)}
        aria-describedby={touched && short ? errId : undefined}
      />
      {touched && short ? (
        <p id={errId} className="bill-dialog__error">
          Write the reason — at least 3 characters
        </p>
      ) : null}
    </div>
  );
}

export function OutcomeDialog({ item, initial = "", onClose, onDone }) {
  const save = useCloseFollowup();
  const [outcome, setOutcome] = useState(initial);
  const [preset, setPreset] = useState("");
  const [reason, setReason] = useState("");
  const [touched, setTouched] = useState(false);
  const [error, setError] = useState("");
  const fullReason = [preset, reason.trim()].filter(Boolean).join(" — ");
  const submit = async () => {
    setTouched(true);
    setError("");
    if (!outcome || fullReason.length < REASON_MIN || save.isPending) return;
    try {
      await save.mutateAsync({ id: item.id, status: outcome, reason: fullReason });
      const label = CLOSE_OUTCOMES.find((o) => o.value === outcome)?.label;
      onDone(`${item.patient.name}: ${label}`);
    } catch (e) {
      setError(requestErrorOf(e, "Could not save the outcome"));
    }
  };
  return (
    <Shell
      title={`Close follow-up — ${item.patient.name}`}
      item={item}
      onClose={onClose}
      onSubmit={submit}
      busy={save.isPending}
      submitLabel="Save outcome"
      error={error}
    >
      <fieldset className="cxl-charge">
        <legend>What happened? (required)</legend>
        <div className="cxl-charge__types" role="radiogroup">
          {CLOSE_OUTCOMES.map((o) => (
            <label key={o.value} className="cxl-radio">
              <input
                type="radio"
                name="followup-outcome"
                checked={outcome === o.value}
                onChange={() => {
                  setOutcome(o.value);
                  setPreset("");
                }}
              />
              {o.label}
            </label>
          ))}
        </div>
        {touched && !outcome ? <p className="bill-dialog__error">Choose what happened</p> : null}
        {outcome === "not_available" && (
          <div className="cxl-charge__types" role="radiogroup" aria-label="Common reasons">
            {NOT_AVAILABLE_REASONS.map((r) => (
              <label key={r} className="cxl-radio">
                <input
                  type="radio"
                  name="followup-preset"
                  checked={preset === r}
                  onChange={() => setPreset(r)}
                />
                {r}
              </label>
            ))}
          </div>
        )}
      </fieldset>
      <ReasonField
        value={reason}
        onChange={setReason}
        touched={touched && fullReason.length < REASON_MIN}
        label={
          outcome === "not_available" && preset ? "More detail (optional)" : "Reason (required)"
        }
      />
    </Shell>
  );
}

export function ReopenDialog({ item, onClose, onDone }) {
  const save = useReopenFollowup();
  const [reason, setReason] = useState("");
  const [touched, setTouched] = useState(false);
  const [error, setError] = useState("");
  const submit = async () => {
    setTouched(true);
    setError("");
    if (reason.trim().length < REASON_MIN || save.isPending) return;
    try {
      await save.mutateAsync({ id: item.id, reason: reason.trim() });
      onDone(`${item.patient.name}: reopened`);
    } catch (e) {
      setError(requestErrorOf(e, "Could not reopen"));
    }
  };
  return (
    <Shell
      title={`Reopen follow-up — ${item.patient.name}`}
      item={item}
      onClose={onClose}
      onSubmit={submit}
      busy={save.isPending}
      submitLabel="Reopen"
      error={error}
    >
      <ReasonField value={reason} onChange={setReason} touched={touched} />
    </Shell>
  );
}
