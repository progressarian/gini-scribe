import { createPortal } from "react-dom";
import useDialog from "../useDialog";

export default function LeaveDraftDialog({ saved, busy, error, onSave, onDiscard, onStay }) {
  const ref = useDialog(true, onStay);
  return createPortal(
    <div className="gf">
      <div className="modal-back" onClick={busy ? undefined : onStay} role="presentation">
        <div
          ref={ref}
          className="modal-card"
          role="dialog"
          aria-modal="true"
          aria-labelledby="leave-draft-title"
          onClick={(e) => e.stopPropagation()}
        >
          <h2 id="leave-draft-title" className="modal-title">
            Save this draft bill?
          </h2>
          <p className="modal-body">
            {saved
              ? "This draft has changes since it was last saved. Discard puts it back the way it was saved."
              : "This draft hasn't been saved. Discard removes it."}
          </p>
          {error && <div className="bc-err">{error}</div>}
          <div className="modal-acts">
            <button type="button" className="st-btn st-btn-g" disabled={busy} onClick={onStay}>
              Stay
            </button>
            <button type="button" className="st-btn st-btn-red" disabled={busy} onClick={onDiscard}>
              Discard
            </button>
            <button type="button" className="st-btn st-btn-grn" disabled={busy} onClick={onSave}>
              Save draft
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
