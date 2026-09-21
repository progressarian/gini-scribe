import { cloneElement, useId, useState } from "react";
import { useCreateBillingItem, useUpdateBillingItem } from "../../queries/hooks/useBillingMaster";
import { codeTyped, digitsTyped, errorOf, moneyTyped } from "./format";
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

const text = (v) => (v === null || v === undefined ? "" : String(v));

const formOf = (item, subgroupId, prefill = {}) => ({
  code: text(item?.code),
  name: text(item?.name),
  subgroup_id: text(item?.subgroup_id ?? subgroupId),
  kind: item?.kind ?? "other",
  base_price: text(item?.base_price),
  unit: item?.unit ?? "each",
  allow_quantity: item?.allow_quantity ?? false,
  max_quantity: text(item?.max_quantity),
  tax_code_id: text(item?.tax_code_id),
  price_includes_tax: item?.price_includes_tax ?? false,
  doctor_id: text(item?.doctor_id),
  visit_type: text(item?.visit_type),
  test_catalog_id: text(item?.test_catalog_id),
  ...Object.fromEntries(Object.entries(prefill).map(([key, value]) => [key, text(value)])),
});

const payloadOf = (form) => {
  const consultation = form.kind === "consultation";
  const taxed = Boolean(form.tax_code_id);
  return {
    code: form.code.trim(),
    name: form.name.trim(),
    subgroup_id: Number(form.subgroup_id) || null,
    kind: form.kind,
    base_price: form.base_price.trim(),
    unit: form.unit.trim() || "each",
    allow_quantity: form.allow_quantity,
    max_quantity: form.allow_quantity ? form.max_quantity.trim() || null : null,
    tax_code_id: taxed ? Number(form.tax_code_id) : null,
    price_includes_tax: taxed ? form.price_includes_tax : false,
    doctor_id: consultation && form.doctor_id ? Number(form.doctor_id) : null,
    visit_type: consultation ? form.visit_type || null : null,
    test_catalog_id: form.kind === "test" ? form.test_catalog_id || null : null,
  };
};

const withCurrent = (options, id, current) =>
  !id || options.some((o) => String(o.id) === String(id)) ? options : [...options, current()];

const TYPED = { base_price: moneyTyped, code: codeTyped, max_quantity: digitsTyped };

const same = (key, a, b) =>
  key === "base_price" ? Number(a) === Number(b) : String(a ?? "") === String(b ?? "");

export default function ItemDialog({
  item,
  prefill,
  subgroupId,
  groups,
  choices,
  taxCodes,
  onClose,
}) {
  const [initial] = useState(() => formOf(item, subgroupId, prefill));
  const [form, setForm] = useState(initial);
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const dirty = JSON.stringify(form) !== JSON.stringify(initial) || reason.trim() !== "";
  const requestClose = () => (dirty ? setConfirmDiscard(true) : onClose());
  const ref = useDialog(true, requestClose);
  const create = useCreateBillingItem();
  const update = useUpdateBillingItem();
  const busy = create.isPending || update.isPending;
  const editing = Boolean(item);
  const set = (key) => (e) =>
    setForm({
      ...form,
      [key]:
        e.target.type === "checkbox"
          ? e.target.checked
          : TYPED[key]
            ? TYPED[key](e.target.value)
            : e.target.value,
    });

  const before = editing ? payloadOf(formOf(item)) : null;
  const priceChanged =
    editing &&
    form.base_price.trim() !== "" &&
    !same("base_price", form.base_price, item.base_price);

  const submit = async (e) => {
    e.preventDefault();
    setError("");
    const payload = payloadOf(form);
    try {
      if (!editing) {
        await create.mutateAsync(payload);
        return onClose(`Added ${payload.name}`);
      }
      const changes = Object.fromEntries(
        Object.entries(payload).filter(([key, value]) => !same(key, value, before[key])),
      );
      if (!Object.keys(changes).length) return onClose();
      if (priceChanged) {
        if (!reason.trim()) return setError("Give a reason for the price change");
        changes.reason = reason.trim();
      }
      await update.mutateAsync({ id: item.id, ...changes });
      return onClose(`Saved ${payload.name}`);
    } catch (err) {
      setError(errorOf(err, "Could not save the item"));
    }
  };

  const tests = withCurrent(
    (choices?.tests ?? [])
      .filter((t) => !t.item_id || t.item_id === item?.id)
      .map((t) => ({ id: t.id, label: t.test_name })),
    item?.test_catalog_id,
    () => ({ id: item.test_catalog_id, label: `${item.test_name ?? "Test"} (retired)` }),
  );
  const taxOptions = withCurrent(
    taxCodes.map((t) => ({ id: t.id, label: `${t.code} · ${t.rate_pct}%` })),
    item?.tax_code_id,
    () => ({ id: item.tax_code_id, label: `${item.tax_code ?? "Tax code"} (inactive)` }),
  );
  const consultants = withCurrent(
    (choices?.consultants ?? []).map((d) => ({ id: d.id, label: d.name })),
    item?.doctor_id,
    () => ({ id: item.doctor_id, label: `${item.doctor_name ?? "Doctor"} (inactive)` }),
  );

  return (
    <div className="flow-dialog-backdrop" onClick={requestClose} role="presentation">
      <form
        ref={ref}
        className="flow-card bill-dialog bill-dialog--wide"
        role="dialog"
        aria-modal="true"
        aria-labelledby="item-dialog-title"
        onClick={(e) => e.stopPropagation()}
        onSubmit={submit}
      >
        <h2 id="item-dialog-title" className="bill-dialog__title">
          {editing ? `Edit ${item.name}` : "Add item"}
        </h2>
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
              onChange={set("code")}
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
                    .filter((s) => s.is_active || String(s.id) === form.subgroup_id)
                    .map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                </optgroup>
              ))}
            </select>
          </Field>
          <Field label="Kind">
            <select className="jb-assign" value={form.kind} onChange={set("kind")}>
              {(choices?.kinds ?? [form.kind]).map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Price (₹)" className="fset__field--narrow">
            <input
              className="jb-assign"
              inputMode="decimal"
              value={form.base_price}
              onChange={set("base_price")}
              required
            />
          </Field>
          <Field label="Unit" className="fset__field--narrow">
            <input className="jb-assign" maxLength={30} value={form.unit} onChange={set("unit")} />
          </Field>
        </div>

        {priceChanged ? (
          <Field label="Reason for the price change" className="bill-form__reason">
            <input
              className="jb-assign"
              maxLength={500}
              value={reason}
              placeholder={`${item.base_price} → ${form.base_price.trim()}`}
              onChange={(e) => setReason(e.target.value)}
              required
            />
          </Field>
        ) : null}

        <div className="bill-form">
          <label className="fset__check">
            <input type="checkbox" checked={form.allow_quantity} onChange={set("allow_quantity")} />
            Quantity can be more than 1
          </label>
          {form.allow_quantity ? (
            <Field label="Max quantity" className="fset__field--narrow">
              <input
                className="jb-assign"
                inputMode="numeric"
                maxLength={9}
                placeholder="No limit"
                value={form.max_quantity}
                onChange={set("max_quantity")}
              />
            </Field>
          ) : null}
          <Field label="Tax code">
            <select className="jb-assign" value={form.tax_code_id} onChange={set("tax_code_id")}>
              <option value="">No tax</option>
              {taxOptions.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </select>
          </Field>
          {form.tax_code_id ? (
            <label className="fset__check">
              <input
                type="checkbox"
                checked={form.price_includes_tax}
                onChange={set("price_includes_tax")}
              />
              Price includes tax
            </label>
          ) : null}
        </div>

        {form.kind === "consultation" ? (
          <div className="bill-form">
            <Field label="Consultant">
              <select className="jb-assign" value={form.doctor_id} onChange={set("doctor_id")}>
                <option value="">Hospital default (any consultant)</option>
                {consultants.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Visit type">
              <select
                className="jb-assign"
                value={form.visit_type}
                onChange={set("visit_type")}
                required
              >
                <option value="">Choose a visit type</option>
                {(choices?.visitTypes ?? []).map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
              </select>
            </Field>
          </div>
        ) : null}

        {form.kind === "test" ? (
          <div className="bill-form">
            <Field label="Catalogue test">
              <select
                className="jb-assign"
                value={form.test_catalog_id}
                onChange={set("test_catalog_id")}
                required
              >
                <option value="">Choose a test</option>
                {tests.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.label}
                  </option>
                ))}
              </select>
            </Field>
          </div>
        ) : null}

        {error ? (
          <p className="bill-dialog__error" role="alert">
            {error}
          </p>
        ) : null}
        {confirmDiscard ? (
          <div
            key="discard"
            className="bill-dialog__actions bill-dialog__discard"
            role="group"
            aria-label="Discard changes?"
          >
            <span>Discard your changes?</span>
            <button
              type="button"
              className="flow-btn flow-btn-ghost"
              autoFocus
              onClick={() => setConfirmDiscard(false)}
            >
              Keep editing
            </button>
            <button type="button" className="flow-btn flow-btn-red" onClick={() => onClose()}>
              Discard
            </button>
          </div>
        ) : (
          <div key="actions" className="bill-dialog__actions">
            <button type="button" className="flow-btn flow-btn-ghost" onClick={() => onClose()}>
              Cancel
            </button>
            <button type="submit" className="flow-btn flow-btn-primary" disabled={busy}>
              {editing ? "Save" : "Add item"}
            </button>
          </div>
        )}
      </form>
    </div>
  );
}
