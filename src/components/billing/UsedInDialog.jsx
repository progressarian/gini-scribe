import useDialog from "./useDialog";

export default function UsedInDialog({ blocked, error, onDeactivate, onClose, busy }) {
  const ref = useDialog(Boolean(blocked), onClose);
  if (!blocked) return null;
  return (
    <div className="flow-dialog-backdrop" onClick={onClose} role="presentation">
      <div
        ref={ref}
        className="flow-card bill-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="used-in-title"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="used-in-title" className="bill-dialog__title">
          {blocked.name} can't be deleted
        </h2>
        <p className="flow-muted">It is still used in:</p>
        <ul className="bill-dialog__list" aria-label="Used in">
          {blocked.uses.map((use) => (
            <li key={`${use.table}.${use.column}`}>{use.text}</li>
          ))}
        </ul>
        <p className="flow-muted">Deactivate it instead to stop it being used from now on.</p>
        {error ? (
          <p className="bill-dialog__error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="bill-dialog__actions">
          <button type="button" className="flow-btn flow-btn-ghost" onClick={onClose}>
            Close
          </button>
          {blocked.canDeactivate ? (
            <button
              type="button"
              className="flow-btn flow-btn-primary"
              disabled={busy}
              onClick={onDeactivate}
            >
              Deactivate instead
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
