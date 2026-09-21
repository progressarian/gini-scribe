import { useState } from "react";
import { codeTyped } from "./format";

const EMPTY = { code: "", name: "" };

export default function AddForm({
  label,
  onAdd,
  busy,
  namePlaceholder = "Name",
  typeCode = codeTyped,
  codeMax = 40,
}) {
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
        maxLength={codeMax}
        value={draft.code}
        onChange={(e) => setDraft({ ...draft, code: typeCode(e.target.value) })}
      />
      <input
        className="jb-assign"
        aria-label={`${label} name`}
        placeholder={namePlaceholder}
        maxLength={200}
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
