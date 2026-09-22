import { cloneElement, useId, useState } from "react";
import { useBillingGroups, useCreateBillingItem } from "../../queries/hooks/useBillingMaster";
import { toast } from "../../stores/uiStore";
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

const suggestedCode = (doctor) =>
  `CONS-${doctor.doctor_id}-${doctor.visit_type === "New" ? "NEW" : "FU"}`;

export default function ConsultantFeeCreateItem({ doctor, subgroupId, onClose }) {
  const { data: groups = [] } = useBillingGroups({ activeOnly: true });
  const create = useCreateBillingItem();
  const [form, setForm] = useState(() => ({
    name: `Consultation — ${doctor.doctor_name} (${doctor.visit_type})`,
    code: suggestedCode(doctor),
    subgroup_id: subgroupId ? String(subgroupId) : "",
    base_price: "",
  }));
  const [error, setError] = useState("");
  const ref = useDialog(true, onClose);
  const titleId = useId();
  const set = (key, typed) => (e) =>
    setForm({ ...form, [key]: typed ? typed(e.target.value) : e.target.value });

  const submit = async (e) => {
    e.preventDefault();
    setError("");
    try {
      await create.mutateAsync({
        code: form.code.trim(),
        name: form.name.trim(),
        subgroup_id: Number(form.subgroup_id),
        base_price: form.base_price.trim(),
        kind: "consultation",
        doctor_id: doctor.doctor_id,
        visit_type: doctor.visit_type,
      });
      toast(`Added ${form.name.trim()}`, "success");
      onClose();
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
          {doctor.visit_type} consultation item for {doctor.doctor_name}
        </h2>
        <p className="fset__cardsub">
          The General fee: what this doctor's {doctor.visit_type} visit costs a patient with no
          category.
        </p>
        <div className="bill-form">
          <Field label="Price (₹)" className="fset__field--narrow">
            <input
              className="jb-assign"
              inputMode="decimal"
              value={form.base_price}
              onChange={set("base_price", moneyTyped)}
              required
              autoFocus
            />
          </Field>
          <Field label="Code" className="bill-form__code">
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
          <Field label="Name">
            <input
              className="jb-assign"
              maxLength={200}
              value={form.name}
              onChange={set("name")}
              required
            />
          </Field>
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
          <button type="submit" className="flow-btn flow-btn-primary" disabled={create.isPending}>
            Create item
          </button>
        </div>
      </form>
    </div>
  );
}
