import { useState } from "react";

const EMPTY = { code: "", name: "" };

export default function AddForm({ label, onAdd, busy, namePlaceholder = "Name" }) {
  const [draft, setDraft] = useState(EMPTY);
  const submit = async (e) => {
    e.preventDefault();
    if (await onAdd({ code: draft.code.trim(), name: draft.name.trim() })) setDraft(EMPTY);
  };
  return (
    <form className="bill-tree__add" onSubmit={submit} aria-label={label}>
      <input
        className="jb-assign"
        aria-label={`${label} code`}
        placeholder="Code"
        value={draft.code}
        onChange={(e) => setDraft({ ...draft, code: e.target.value })}
      />
      <input
        className="jb-assign"
        aria-label={`${label} name`}
        placeholder={namePlaceholder}
        value={draft.name}
        onChange={(e) => setDraft({ ...draft, name: e.target.value })}
      />
      <button
        type="submit"
        className="flow-btn flow-btn-primary flow-btn-mini"
        disabled={busy || !draft.code.trim() || !draft.name.trim()}
      >
        + Add
      </button>
    </form>
  );
}
