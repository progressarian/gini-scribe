import { useId, useState } from "react";
import {
  NOTE_REQUIRED_CANCEL_REASON,
  URGENT_CANCEL_REASONS,
  urgentCancelReasonLabel,
} from "../../../shared/testCancelReasons.js";
import { CANCEL_STAGE } from "../../../shared/testCancelStages.js";
import { requestErrorOf } from "../billing/format";
import {
  useCancelStage,
  useRaiseCancelRequest,
  useWithdrawCancelRequest,
} from "../../queries/hooks/useTestCancelRequests";
import CancelDecisionDialog from "./CancelDecisionDialog";
import useAuthStore from "../../stores/authStore";
import { CAPABILITIES as CAP, hasCapability } from "../../../shared/permissions.js";
import "./cancelRequests.css";

const NOTE_MAX = 300;

export function CancelHeldBadge() {
  return (
    <span className="cxl-held" role="status">
      <span aria-hidden="true">⏸</span> Cancellation requested — waiting for admin
    </span>
  );
}

export default function UrgentCancelControl({ stage, held, target, what, patient, full = false }) {
  const canDecide = hasCapability(
    useAuthStore((st) => st.currentDoctor?.role),
    CAP.GINIFLOW_TEST_CANCEL_DECIDE,
  );
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");
  const [touched, setTouched] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState("");
  const [deciding, setDeciding] = useState(false);
  const raise = useRaiseCancelRequest();
  const withdraw = useWithdrawCancelRequest();
  const info = useCancelStage(target, held || (open && canDecide));
  const reasonId = useId();
  const noteId = useId();
  const reasonErr = useId();
  const noteErr = useId();

  if (stage === CANCEL_STAGE.locked) {
    return <span className="dp-hint">Report is out — cannot be cancelled</span>;
  }

  if (held) {
    const pendingId = info.data?.pending_request_id;
    return (
      <div className="cxl-held-row">
        <CancelHeldBadge />
        {pendingId ? (
          <button
            type="button"
            className="st-btn st-btn-g"
            disabled={withdraw.isPending}
            onClick={async () => {
              setError("");
              try {
                await withdraw.mutateAsync({ id: pendingId });
              } catch (err) {
                setError(requestErrorOf(err, "Could not withdraw the request"));
              }
            }}
          >
            {withdraw.isPending ? "Withdrawing…" : "Withdraw request"}
          </button>
        ) : null}
        {error ? (
          <span className="bill-dialog__error" role="alert">
            {error}
          </span>
        ) : null}
      </div>
    );
  }

  if (stage !== CANCEL_STAGE.request) return null;

  if (done) {
    return (
      <span className="dp-hint" role="status">
        {done}
      </span>
    );
  }

  if (!open) {
    return (
      <button
        type="button"
        className={`st-btn st-btn-g${full ? " btn-full" : ""}`}
        onClick={() => setOpen(true)}
      >
        Request urgent cancellation
      </button>
    );
  }

  const needsNote = reason === NOTE_REQUIRED_CANCEL_REASON;
  const reasonError = reason ? "" : "Pick why this test must be cancelled";
  const noteError =
    needsNote && note.trim().length < 3
      ? "Say why — at least 3 characters"
      : note.trim() && note.trim().length < 3
        ? "Say why — at least 3 characters"
        : "";
  const valid = !reasonError && !noteError;
  const body = {
    target,
    reason_code: reason,
    ...(note.trim() ? { note: note.trim() } : {}),
  };

  const submit = async (e) => {
    e.preventDefault();
    setTouched(true);
    setError("");
    if (!valid) return;
    if (canDecide) {
      setDeciding(true);
      return;
    }
    try {
      await raise.mutateAsync(body);
      setDone("Sent to admin — the test is on hold until they decide");
    } catch (err) {
      setError(requestErrorOf(err, "Could not send the request"));
    }
  };

  return (
    <form
      className="cxl-form"
      onSubmit={submit}
      aria-label={`Urgent cancellation of ${what}`}
      noValidate
    >
      <p className="cxl-form__who">
        <strong>{patient?.name}</strong>
        {patient?.fileNo ? ` · ${patient.fileNo}` : ""} — {what}
      </p>
      <div className="fset__field">
        <label htmlFor={reasonId}>Why must it be cancelled? (required)</label>
        <select
          id={reasonId}
          className="ar-reason-input"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          aria-invalid={Boolean(touched && reasonError)}
          aria-describedby={touched && reasonError ? reasonErr : undefined}
        >
          <option value="">Choose a reason</option>
          {URGENT_CANCEL_REASONS.map((r) => (
            <option key={r.value} value={r.value}>
              {r.label}
            </option>
          ))}
        </select>
        {touched && reasonError ? (
          <p id={reasonErr} className="bill-dialog__error">
            {reasonError}
          </p>
        ) : null}
      </div>
      <div className="fset__field">
        <label htmlFor={noteId}>{needsNote ? "Note (required)" : "Note (optional)"}</label>
        <textarea
          id={noteId}
          className="ar-reason-input"
          rows={2}
          maxLength={NOTE_MAX}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          aria-invalid={Boolean(touched && noteError)}
          aria-describedby={touched && noteError ? noteErr : undefined}
        />
        <div className="cxl-count">
          {note.length}/{NOTE_MAX}
        </div>
        {touched && noteError ? (
          <p id={noteErr} className="bill-dialog__error">
            {noteError}
          </p>
        ) : null}
      </div>
      <p className="dp-hint">
        The sample is already collected. No refund unless an admin approves — if approved, a
        collection charge is kept.
      </p>
      {error ? (
        <p className="bill-dialog__error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="cxl-form__actions">
        <button type="submit" className="st-btn st-btn-red" disabled={raise.isPending}>
          {raise.isPending ? "Sending…" : canDecide ? "Cancel now…" : "Send to admin"}
        </button>
        <button type="button" className="st-btn st-btn-g" onClick={() => setOpen(false)}>
          Back
        </button>
      </div>
      {deciding && info.data ? (
        <CancelDecisionDialog
          mode="now"
          paid={info.data.paid}
          defaults={info.data.defaults}
          patient={patient}
          testName={what}
          reasonText={`${urgentCancelReasonLabel(reason)}${note.trim() ? ` — ${note.trim()}` : ""}`}
          nowInput={{
            target,
            reason_code: reason,
            ...(note.trim() ? { request_note: note.trim() } : {}),
          }}
          onClose={() => setDeciding(false)}
          onDone={(message) => {
            setDeciding(false);
            setDone(message);
          }}
        />
      ) : null}
    </form>
  );
}
