import useDialog from "./useDialog";

export default function ConfirmDeleteDialog({ name, note, onKeep, onDelete }) {
  const ref = useDialog(true, onKeep);
  return (
    <div className="flow-dialog-backdrop" onClick={onKeep} role="presentation">
      <div
        ref={ref}
        className="flow-card bill-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-delete-title"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="confirm-delete-title" className="bill-dialog__title">
          Delete {name}?
        </h2>
        {note ? <p className="fset__cardsub">{note}</p> : null}
        <div className="bill-dialog__actions">
          <button type="button" className="flow-btn flow-btn-ghost" onClick={onKeep}>
            Keep
          </button>
          <button
            type="button"
            className="flow-btn flow-btn-red"
            aria-label={`Confirm delete ${name}`}
            onClick={onDelete}
          >
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}
