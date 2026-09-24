import { useId, useState } from "react";
import useDialog from "./useDialog";
import { codeTyped } from "./format";

export default function AddDialog({
  title,
  submitLabel,
  note,
  nameLabel = "Name",
  codePlaceholder,
  codeHint,
  namePlaceholder,
  codeMax = 40,
  typeCode = codeTyped,
  busy,
  onAdd,
  onClose,
}) {
  const ref = useDialog(true, onClose);
  const id = useId();
  const [draft, setDraft] = useState({ code: "", name: "" });
  const code = draft.code.trim();
  const name = draft.name.trim();
  const submit = async (e) => {
    e.preventDefault();
    if (await onAdd({ code, name })) onClose();
  };
  return (
    <div className="flow-dialog-backdrop" onClick={onClose} role="presentation">
      <form
        ref={ref}
        className="flow-card bill-dialog bill-add-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        onClick={(e) => e.stopPropagation()}
        onSubmit={submit}
      >
        <h2 id={`${id}-title`} className="bill-dialog__title">
          {title}
        </h2>
        {note ? <p className="fset__cardsub">{note}</p> : null}
        <div className="bill-form">
          <div className="fset__field">
            <label htmlFor={`${id}-code`}>Code</label>
            <input
              id={`${id}-code`}
              className="jb-assign"
              placeholder={codePlaceholder}
              maxLength={codeMax}
              value={draft.code}
              onChange={(e) => setDraft({ ...draft, code: typeCode(e.target.value) })}
            />
            {codeHint ? <small className="flow-muted">{codeHint}</small> : null}
          </div>
          <div className="fset__field">
            <label htmlFor={`${id}-name`}>{nameLabel}</label>
            <input
              id={`${id}-name`}
              className="jb-assign"
              placeholder={namePlaceholder}
              maxLength={200}
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />
          </div>
        </div>
        <div className="bill-dialog__actions">
          <button type="button" className="flow-btn flow-btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            type="submit"
            className="flow-btn flow-btn-primary"
            disabled={busy || !code || !name}
          >
            {busy ? "Adding…" : submitLabel}
          </button>
        </div>
      </form>
    </div>
  );
}
