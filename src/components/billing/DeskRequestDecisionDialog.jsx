import { useId, useState } from "react";
import {
  useApproveDeskRequest,
  useRejectDeskRequest,
} from "../../queries/hooks/useBillingRequests";
import { REFUND_MODES } from "../../../shared/billingVocab.js";

const DEPOSIT_PAY_MODES = ["cash", "card", "upi"];
import { fromPaise, requestErrorOf } from "./format";
import { refundLegsText, refundModeText } from "./counter/lineText";
import useDialog from "./useDialog";
import BillDialogLayer from "./BillDialogLayer";

function RefundSummary({ request }) {
  const preview = request.refund?.preview;
  if (!preview) {
    return request.refund?.preview_error ? (
      <p className="bill-dialog__error">{request.refund.preview_error}</p>
    ) : null;
  }
  return (
    <div className="fset__cardsub">
      <ul className="dreq__lines">
        {preview.lines.map((line) => (
          <li key={line.line_id}>
            {line.bill_name} × {line.quantity} — {fromPaise(line.patient_payable)}
          </li>
        ))}
      </ul>
      <div>
        Credit note for {fromPaise(preview.totals.payable)}.{" "}
        {preview.refund.due > 0
          ? `${fromPaise(preview.refund.due)} goes back to the patient.`
          : "No money goes back."}
        {preview.refund.against_balance > 0
          ? ` ${fromPaise(preview.refund.against_balance)} reduces the balance still owed first.`
          : ""}
      </div>
      {preview.tests_done.length ? (
        <div>
          {preview.tests_done.join(", ")} already done — write your reason in the note to approve.
        </div>
      ) : null}
    </div>
  );
}

export default function DeskRequestDecisionDialog({ request, mode, subject, onClose, onDone }) {
  const approve = useApproveDeskRequest();
  const reject = useRejectDeskRequest();
  const rejecting = mode === "reject";
  const depositRefund = request.kind === "deposit_refund";
  const refund = request.kind === "refund" || depositRefund;
  const decide = rejecting ? reject : approve;
  const asked = request.refund?.requested_mode ?? request.deposit_refund?.requested_mode ?? null;
  const modes = depositRefund ? DEPOSIT_PAY_MODES : REFUND_MODES;
  const [note, setNote] = useState("");
  const [refundMode, setRefundMode] = useState(asked);
  const [modeReason, setModeReason] = useState("");
  const [error, setError] = useState("");
  const ref = useDialog(true, onClose);
  const titleId = useId();
  const noteId = useId();
  const modeId = useId();
  const modeReasonId = useId();
  const modeChanged = refund && !rejecting && refundMode !== asked;
  const legs = request.refund?.preview?.refund?.legs;

  const submit = async (e) => {
    e.preventDefault();
    setError("");
    try {
      await decide.mutateAsync(
        rejecting
          ? { id: request.id, note }
          : {
              id: request.id,
              note: note.trim() || undefined,
              ...(refund ? { approved_mode: refundMode } : {}),
              ...(modeChanged ? { mode_reason: modeReason.trim() } : {}),
            },
      );
      onDone(rejecting ? `Rejected — ${subject}` : `Approved — ${subject}`);
    } catch (err) {
      setError(
        requestErrorOf(err, rejecting ? "Could not reject the request" : "Could not approve it"),
      );
    }
  };

  const title = rejecting
    ? `Reject request for ${subject}`
    : refund
      ? `Approve ${subject}?`
      : `Bill ${subject} again?`;

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
          <p className="fset__cardsub">
            {rejecting
              ? "The desk sees this note, so say why — a rejection without a note is refused."
              : depositRefund
                ? `Approving lets the desk pay ${fromPaise(request.deposit_refund.amount)} back from ${request.patient?.name ?? "the patient"}'s deposit. It must be approved by someone other than the person who asked.`
                : refund && refundMode === "deposit"
                  ? "Approving makes the credit note now and keeps the money as this patient's deposit — nothing is paid out at the counter."
                  : refund
                    ? "Approving makes the credit note now. The desk then pays the money back from its counter."
                    : "The desk may add this item to the visit once more. One approval allows one extra line."}
          </p>
          <p className="dreq__quote">{request.reason}</p>
          {refund && !depositRefund ? <RefundSummary request={request} /> : null}
          {refund && !rejecting ? (
            <>
              <div className="fset__field">
                <label htmlFor={modeId}>Money goes back as</label>
                <select
                  id={modeId}
                  className="jb-assign"
                  value={refundMode}
                  onChange={(e) => setRefundMode(e.target.value)}
                >
                  {modes.map((value) => (
                    <option key={value} value={value}>
                      {refundModeText(value)}
                      {value === asked ? " (asked for)" : ""}
                    </option>
                  ))}
                </select>
                {refundMode === "as_paid" && legs?.length ? (
                  <div className="dreq__muted">{refundLegsText(legs, fromPaise)}</div>
                ) : null}
              </div>
              {modeChanged ? (
                <div className="fset__field">
                  <label htmlFor={modeReasonId}>Why another way than the desk asked</label>
                  <textarea
                    id={modeReasonId}
                    className="jb-assign"
                    rows={2}
                    maxLength={1000}
                    value={modeReason}
                    onChange={(e) => setModeReason(e.target.value)}
                  />
                </div>
              ) : null}
            </>
          ) : null}
          <div className="fset__field">
            <label htmlFor={noteId}>{rejecting ? "Note" : "Note for the desk"}</label>
            <textarea
              id={noteId}
              className="jb-assign"
              rows={3}
              maxLength={1000}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </div>
          {error ? (
            <p className="bill-dialog__error" role="alert">
              {error}
            </p>
          ) : null}
          <div className="bill-dialog__actions">
            <button type="button" className="flow-btn flow-btn-ghost" onClick={onClose}>
              Cancel
            </button>
            <button
              type="submit"
              className={`flow-btn ${rejecting ? "flow-btn-red" : "flow-btn-primary"}`}
              disabled={decide.isPending || (modeChanged && !modeReason.trim())}
            >
              {rejecting ? "Reject request" : refund ? "Approve refund" : "Approve request"}
            </button>
          </div>
        </form>
      </div>
    </BillDialogLayer>
  );
}
