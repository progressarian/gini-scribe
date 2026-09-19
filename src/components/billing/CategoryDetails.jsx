import { useEffect, useId, useState } from "react";
import useAuthStore from "../../stores/authStore";
import { CAPABILITIES, hasCapability } from "../../../shared/permissions.js";
import {
  useDeleteBillingCategory,
  useUpdateBillingCategory,
} from "../../queries/hooks/useBillingMaster";
import { toast } from "../../stores/uiStore";
import { errorOf, usesOf } from "./format";

const COLORS = ["gray", "blue", "teal", "green", "purple", "amber", "red"];
const PAY_LATER = [
  { value: "", label: "Follow the billing setting" },
  { value: "true", label: "Allow pay later" },
  { value: "false", label: "Don't allow pay later" },
];
const FLAGS = [
  ["requires_ref", "Card number required"],
  ["requires_referral", "Needs a referral"],
  ["requires_referral_doc", "Needs the referral scanned"],
  ["print_category_on_bill", "Print the category on the bill"],
];

const text = (v) => (v === null || v === undefined ? "" : String(v));

const formOf = (category) => ({
  label: category.label,
  color: category.color || "gray",
  daily_cap: text(category.daily_cap),
  payer_name: text(category.payer_name),
  allow_pay_later: text(category.allow_pay_later),
  ...Object.fromEntries(FLAGS.map(([key]) => [key, Boolean(category[key])])),
});

const payloadOf = (form) => ({
  ...form,
  label: form.label.trim(),
  daily_cap: form.daily_cap.trim(),
  payer_name: form.payer_name.trim(),
  allow_pay_later: form.allow_pay_later === "" ? "" : form.allow_pay_later === "true",
});

function Field({ label, children }) {
  const id = useId();
  return (
    <div className="fset__field">
      <label htmlFor={id}>{label}</label>
      {children(id)}
    </div>
  );
}

export default function CategoryDetails({ category, parent, onBlocked, onDeleted, onDirtyChange }) {
  const role = useAuthStore((s) => s.currentDoctor?.role);
  const canSetCap = hasCapability(role, CAPABILITIES.ADMIN);
  const [form, setForm] = useState(() => formOf(category));
  const [error, setError] = useState("");
  const [confirming, setConfirming] = useState(false);
  const update = useUpdateBillingCategory();
  const remove = useDeleteBillingCategory();
  const set = (key) => (e) =>
    setForm({ ...form, [key]: e.target.type === "checkbox" ? e.target.checked : e.target.value });

  const before = payloadOf(formOf(category));
  const after = payloadOf(form);
  const changes = Object.fromEntries(
    Object.entries(after).filter(([key, value]) => String(value) !== String(before[key])),
  );
  const dirty = Object.keys(changes).length > 0;

  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);
  const name = category.display_label || category.label;

  const save = async (e) => {
    e.preventDefault();
    setError("");
    try {
      await update.mutateAsync({ code: category.code, ...changes });
      toast(`Saved ${name}`, "success");
    } catch (err) {
      setError(errorOf(err, "Could not save the category"));
    }
  };

  const setActive = async (is_active) => {
    setError("");
    try {
      await update.mutateAsync({ code: category.code, is_active });
      toast(`${name} ${is_active ? "brought back" : "retired"}`, "success");
    } catch (err) {
      setError(errorOf(err));
    }
  };

  const destroy = async () => {
    setConfirming(false);
    try {
      await remove.mutateAsync(category.code);
      toast(`Deleted ${name}`, "success");
      onDeleted();
    } catch (err) {
      const uses = usesOf(err);
      if (!uses) return setError(errorOf(err));
      onBlocked({
        name,
        uses,
        canDeactivate: category.is_active,
        deactivate: () => update.mutateAsync({ code: category.code, is_active: false }),
      });
    }
  };

  const inherited = parent?.payer_name;

  return (
    <form className="flow-card" aria-label={`${name} details`} onSubmit={save}>
      <div className="fset__cardhead">
        <h2 className="flow-sec-title">{name}</h2>
        <code className="bill-cat__code">{category.code}</code>
        {category.is_active ? null : <span className="fset__count">retired</span>}
      </div>
      <div className="bill-form">
        <Field label="Label">
          {(id) => (
            <input id={id} className="jb-assign" value={form.label} onChange={set("label")} />
          )}
        </Field>
        <Field label="Colour">
          {(id) => (
            <select id={id} className="jb-assign" value={form.color} onChange={set("color")}>
              {COLORS.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label="Patients per day">
          {(id) => (
            <input
              id={id}
              className="jb-assign"
              inputMode="numeric"
              placeholder="No limit"
              value={form.daily_cap}
              readOnly={!canSetCap}
              title={canSetCap ? undefined : "Only an admin can change this"}
              onChange={set("daily_cap")}
            />
          )}
        </Field>
      </div>
      <div className="bill-form">
        <Field label="Payer name">
          {(id) => (
            <input
              id={id}
              className="jb-assign"
              placeholder={inherited ? `Same as ${parent.label}: ${inherited}` : "None"}
              value={form.payer_name}
              onChange={set("payer_name")}
            />
          )}
        </Field>
        <Field label="Pay later">
          {(id) => (
            <select
              id={id}
              className="jb-assign"
              value={form.allow_pay_later}
              onChange={set("allow_pay_later")}
            >
              {PAY_LATER.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          )}
        </Field>
      </div>
      {canSetCap ? null : (
        <p className="fset__hint">Only an admin can change the patients-per-day limit.</p>
      )}
      {parent ? (
        <p className="fset__hint">
          The daily limit of {parent.label} counts its sub-categories too. Leave the payer name
          empty to use {parent.label}'s.
        </p>
      ) : null}
      <div className="fset__checks bill-cat__flags">
        {FLAGS.map(([key, label]) => (
          <label key={key} className="fset__check">
            <input type="checkbox" checked={form[key]} onChange={set(key)} />
            {label}
          </label>
        ))}
      </div>
      {error ? (
        <p className="bill-dialog__error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="bill-dialog__actions">
        {confirming ? (
          <>
            <button
              type="button"
              className="flow-btn flow-btn-red"
              aria-label={`Confirm delete ${name}`}
              onClick={destroy}
            >
              Confirm delete
            </button>
            <button
              type="button"
              className="flow-btn flow-btn-ghost"
              onClick={() => setConfirming(false)}
            >
              Keep
            </button>
          </>
        ) : (
          <button
            type="button"
            className="flow-btn flow-btn-ghost"
            aria-label={`Delete ${name}`}
            onClick={() => setConfirming(true)}
          >
            Delete
          </button>
        )}
        <button
          type="button"
          className="flow-btn flow-btn-ghost"
          onClick={() => setActive(!category.is_active)}
        >
          {category.is_active ? "Retire" : "Bring back"}
        </button>
        <button
          type="submit"
          className="flow-btn flow-btn-primary"
          disabled={!dirty || update.isPending}
        >
          Save
        </button>
      </div>
    </form>
  );
}
