import { createPortal } from "react-dom";
import useDialog from "../useDialog";

const DRAFT_TEXT = (saved) => ({
  title: "Save this draft bill?",
  body: saved
    ? "This draft has changes since it was last saved. Discard puts it back the way it was saved."
    : "This draft hasn't been saved. Discard removes it.",
  discard: "Discard",
  keep: "Save draft",
});

const EDIT_TEXT = (billNo) => ({
  title: `Leave bill ${billNo} being edited?`,
  body: `The changes to bill ${billNo} are not saved. It prints as "being edited" until someone saves or discards the edit.`,
  discard: "Discard changes",
  keep: "Leave it open",
});

export default function LeaveDraftDialog({
  saved,
  editing = null,
  busy,
  error,
  onSave,
  onDiscard,
  onStay,
}) {
  const text = editing ? EDIT_TEXT(editing) : DRAFT_TEXT(saved);
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
            {text.title}
          </h2>
          <p className="modal-body">{text.body}</p>
          {error && <div className="bc-err">{error}</div>}
          <div className="modal-acts">
            <button type="button" className="st-btn st-btn-g" disabled={busy} onClick={onStay}>
              Stay
            </button>
            <button type="button" className="st-btn st-btn-red" disabled={busy} onClick={onDiscard}>
              {text.discard}
            </button>
            <button type="button" className="st-btn st-btn-grn" disabled={busy} onClick={onSave}>
              {text.keep}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
