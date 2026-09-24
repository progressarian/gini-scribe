import { cloneElement, useId, useState } from "react";
import { ITEM_KINDS } from "../../../shared/billingVocab.js";
import { useBillingGroups } from "../../queries/hooks/useBillingMaster";
import { useApproveDeskRequest } from "../../queries/hooks/useBillingRequests";
import { codeTyped, moneyTyped, requestErrorOf } from "./format";
import useDialog from "./useDialog";

function Field({ label, className = "", children }) {
  const id = useId();
  return (
    <div className={`fset__field ${className}`.trim()}>
      <label htmlFor={id}>{label}</label>
      {cloneElement(children, { id })}
    </div>
  );
}

export default function DeskRequestItemDialog({ request, onClose, onDone }) {
  const { data: groups = [] } = useBillingGroups({ activeOnly: true });
  const approve = useApproveDeskRequest();
  const [form, setForm] = useState({
    name: request.proposed_name ?? "",
    code: "",
    subgroup_id: "",
    kind: "procedure",
    base_price: "",
    note: "",
  });
  const [error, setError] = useState("");
  const ref = useDialog(true, onClose);
  const titleId = useId();
  const set = (key, typed) => (e) =>
    setForm({ ...form, [key]: typed ? typed(e.target.value) : e.target.value });

  const submit = async (e) => {
    e.preventDefault();
    setError("");
    try {
      const answered = await approve.mutateAsync({
        id: request.id,
        note: form.note.trim() || undefined,
        item: {
          name: form.name.trim(),
          code: form.code.trim(),
          subgroup_id: Number(form.subgroup_id),
          kind: form.kind,
          base_price: form.base_price.trim(),
        },
      });
      onDone(`Created ${answered.created_item?.name ?? form.name.trim()}`);
    } catch (err) {
      setError(requestErrorOf(err, "Could not create the item"));
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
          Create item for {request.proposed_name}
        </h2>
        <p className="fset__cardsub">
          The desk asked for this item and sent no price — you set the price here. Creating it
          approves the request.
        </p>
        <p className="dreq__quote">{request.reason}</p>
        <div className="bill-form">
          <Field label="Name">
            <input
              className="jb-assign"
              maxLength={200}
              value={form.name}
              onChange={set("name")}
              required
            />
          </Field>
          <Field label="Code" className="fset__field--narrow bill-form__code">
            <input
              className="jb-assign"
              maxLength={40}
              value={form.code}
              onChange={set("code", codeTyped)}
              required
            />
          </Field>
        </div>
        <div className="bill-form">
          <Field label="Subgroup">
            <select
              className="jb-assign"
              value={form.subgroup_id}
              onChange={set("subgroup_id")}
              required
            >
              <option value="">Choose a subgroup</option>
              {groups.map((g) => (
                <optgroup key={g.id} label={g.name}>
                  {g.subgroups
                    .filter((s) => s.is_active)
                    .map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                </optgroup>
              ))}
            </select>
          </Field>
          <Field label="Kind" className="fset__field--narrow">
            <select className="jb-assign" value={form.kind} onChange={set("kind")}>
              {ITEM_KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {kind}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Price (₹)" className="fset__field--narrow">
            <input
              className="jb-assign"
              inputMode="decimal"
              value={form.base_price}
              onChange={set("base_price", moneyTyped)}
              required
            />
          </Field>
        </div>
        <div className="bill-form">
          <Field label="Note for the desk">
            <input
              className="jb-assign"
              maxLength={1000}
              value={form.note}
              onChange={set("note")}
            />
          </Field>
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
          <button type="submit" className="flow-btn flow-btn-primary" disabled={approve.isPending}>
            Create item and approve
          </button>
        </div>
      </form>
    </div>
  );
}
