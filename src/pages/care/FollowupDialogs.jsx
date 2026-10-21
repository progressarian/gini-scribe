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
import {
  HOLD_DECISIONS,
  HOLD_DECISION_LABEL,
  HOLD_NOTE_MAX,
  HOLD_NOTE_MIN,
  NOTE_REQUIRED_DECISIONS,
} from "../../../shared/coordinatorHold.js";
import {
  useCloseFollowup,
  useCompleteHold,
  useReopenFollowup,
  useSkipHold,
} from "../../queries/hooks/useCareFollowups";
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

const holdItem = (row) => ({
  patient: { name: row.name, fileNo: row.fileNo, phone: row.phone },
  target: row.referrals.map((r) => r.target).join(" · ") || "Referral",
});

function HoldNoteField({ value, onChange, required, invalid }) {
  const id = useId();
  const errId = useId();
  return (
    <div className="fset__field">
      <label htmlFor={id}>{required ? "Note (required)" : "Note (optional)"}</label>
      <textarea
        id={id}
        className="jb-assign"
        rows={3}
        maxLength={HOLD_NOTE_MAX}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={invalid}
        aria-describedby={invalid ? errId : undefined}
      />
      {invalid ? (
        <p id={errId} className="bill-dialog__error">
          Write what was decided — at least {HOLD_NOTE_MIN} characters
        </p>
      ) : null}
    </div>
  );
}

export function HoldDoneDialog({ row, onClose, onDone }) {
  const save = useCompleteHold();
  const [decision, setDecision] = useState("");
  const [note, setNote] = useState("");
  const [touched, setTouched] = useState(false);
  const [error, setError] = useState("");
  const needsNote = NOTE_REQUIRED_DECISIONS.includes(decision);
  const noteShort = needsNote && note.trim().length < HOLD_NOTE_MIN;
  const submit = async () => {
    setTouched(true);
    setError("");
    if (!decision || noteShort || save.isPending) return;
    try {
      await save.mutateAsync({ visitId: row.visitId, decision, note: note.trim() || null });
      onDone(`${row.name}: ${HOLD_DECISION_LABEL[decision]} — sent to the Rx desk`);
    } catch (e) {
      setError(requestErrorOf(e, "Could not send the patient on"));
    }
  };
  return (
    <Shell
      title={`Send to Prescription Explain — ${row.name}`}
      item={holdItem(row)}
      onClose={onClose}
      onSubmit={submit}
      busy={save.isPending}
      submitLabel="Done — send to Rx desk"
      error={error}
    >
      <fieldset className="cxl-charge">
        <legend>What was decided? (required)</legend>
        <div className="cxl-charge__types" role="radiogroup">
          {HOLD_DECISIONS.map((d) => (
            <label key={d.value} className="cxl-radio">
              <input
                type="radio"
                name="hold-decision"
                checked={decision === d.value}
                onChange={() => setDecision(d.value)}
              />
              {d.label}
            </label>
          ))}
        </div>
        {touched && !decision ? (
          <p className="bill-dialog__error">Choose what was decided</p>
        ) : null}
      </fieldset>
      <HoldNoteField
        value={note}
        onChange={setNote}
        required={needsNote}
        invalid={Boolean(touched && noteShort)}
      />
      <p className="cxl-confirm">
        The patient goes on to Prescription Explain. Their follow-up stays on this list
        {decision === "call_later" ? " so the calls carry on" : ""}.
      </p>
    </Shell>
  );
}

export function HoldSkipDialog({ row, onClose, onDone }) {
  const save = useSkipHold();
  const [reason, setReason] = useState("");
  const [touched, setTouched] = useState(false);
  const [error, setError] = useState("");
  const short = reason.trim().length < HOLD_NOTE_MIN;
  const submit = async () => {
    setTouched(true);
    setError("");
    if (short || save.isPending) return;
    try {
      await save.mutateAsync({ visitId: row.visitId, reason: reason.trim() });
      onDone(`${row.name}: sent on without the Care Coordinator`);
    } catch (e) {
      setError(requestErrorOf(e, "Could not send the patient on"));
    }
  };
  return (
    <Shell
      title={`Send on without the Care Coordinator — ${row.name}`}
      item={holdItem(row)}
      onClose={onClose}
      onSubmit={submit}
      busy={save.isPending}
      submitLabel="Send on"
      error={error}
    >
      <HoldNoteField
        value={reason}
        onChange={setReason}
        required
        invalid={Boolean(touched && short)}
      />
      <p className="cxl-confirm">Recorded with your name. The referral stays on Follow-ups.</p>
    </Shell>
  );
}
