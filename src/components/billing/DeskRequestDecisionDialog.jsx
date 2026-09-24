import { useId, useState } from "react";
import {
  useApproveDeskRequest,
  useRejectDeskRequest,
} from "../../queries/hooks/useBillingRequests";
import { requestErrorOf } from "./format";
import useDialog from "./useDialog";

export default function DeskRequestDecisionDialog({ request, mode, subject, onClose, onDone }) {
  const approve = useApproveDeskRequest();
  const reject = useRejectDeskRequest();
  const rejecting = mode === "reject";
  const decide = rejecting ? reject : approve;
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const ref = useDialog(true, onClose);
  const titleId = useId();
  const noteId = useId();

  const submit = async (e) => {
    e.preventDefault();
    setError("");
    try {
      await decide.mutateAsync(
        rejecting ? { id: request.id, note } : { id: request.id, note: note.trim() || undefined },
      );
      onDone(rejecting ? `Rejected — ${subject}` : `Approved — ${subject}`);
    } catch (err) {
      setError(
        requestErrorOf(err, rejecting ? "Could not reject the request" : "Could not approve it"),
      );
    }
  };

  return (
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
          {rejecting ? `Reject request for ${subject}` : `Bill ${subject} again?`}
        </h2>
        <p className="fset__cardsub">
          {rejecting
            ? "The desk sees this note, so say why — a rejection without a note is refused."
            : "The desk may add this item to the visit once more. One approval allows one extra line."}
        </p>
        <p className="dreq__quote">{request.reason}</p>
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
            disabled={decide.isPending}
          >
            {rejecting ? "Reject request" : "Approve request"}
          </button>
        </div>
      </form>
    </div>
  );
}
