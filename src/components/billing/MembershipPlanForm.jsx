import { cloneElement, useId, useState } from "react";
import {
  useCreateMembershipPlan,
  useUpdateMembershipPlan,
} from "../../queries/hooks/useBillingMaster";
import { codeTyped, digitsTyped, moneyTyped, requestErrorOf } from "./format";
import useDialog from "./useDialog";
import BillDialogLayer from "./BillDialogLayer";

const text = (value) => (value === null || value === undefined ? "" : String(value));

const formOf = (plan) => ({
  code: text(plan?.code),
  name: text(plan?.name),
  price: plan ? String(plan.price / 100) : "",
  consult_count: text(plan?.consult_count),
  dietitian_count: plan ? String(plan.dietitian_count) : "0",
  lab_discount_pct: plan ? String(plan.lab_discount_pct) : "0",
  lab_excludes_outsourced: plan?.lab_excludes_outsourced ?? false,
});

function problemsOf(form) {
  const problems = {};
  if (!/^[A-Z0-9_-]{2,30}$/.test(form.code.trim().toUpperCase())) {
    problems.code = "Enter 2 to 30 letters, digits, - or _, e.g. GOLD-12.";
  }
  if (!form.name.trim()) problems.name = "Enter the plan's name, e.g. Gold yearly.";
  if (form.price === "" || Number.isNaN(Number(form.price))) {
    problems.price = "Enter the card price in rupees, e.g. 5000.";
  }
  const consults = Number(form.consult_count || 0);
  const diet = Number(form.dietitian_count || 0);
  if (form.consult_count === "") problems.consult_count = "Enter how many consultations it gives.";
  if (consults > 1000 || diet > 1000) problems.consult_count = "Use 1000 or fewer.";
  if (!problems.consult_count && consults + diet === 0) {
    problems.consult_count = "Give at least one consultation or dietitian visit.";
  }
  const pct = Number(form.lab_discount_pct || 0);
  if (Number.isNaN(pct) || pct < 0 || pct > 100) {
    problems.lab_discount_pct = "Enter a percentage from 0 to 100.";
  }
  return problems;
}

const bodyOf = (form) => ({
  code: form.code.trim().toUpperCase(),
  name: form.name.trim(),
  price: Number(form.price),
  consult_count: Number(form.consult_count || 0),
  dietitian_count: Number(form.dietitian_count || 0),
  lab_discount_pct: Number(form.lab_discount_pct || 0),
  lab_excludes_outsourced: form.lab_excludes_outsourced,
});

function Field({ label, required, hint, problem, children }) {
  const id = useId();
  const described = [hint && `${id}-hint`, problem && `${id}-err`].filter(Boolean).join(" ");
  return (
    <div className="fset__field">
      <label htmlFor={id}>
        {label}
        {required ? <span aria-hidden="true"> *</span> : null}
      </label>
      {cloneElement(children, {
        id,
        required,
        "aria-invalid": problem ? "true" : undefined,
        "aria-describedby": described || undefined,
      })}
      {hint ? (
        <small id={`${id}-hint`} className="flow-muted">
          {hint}
        </small>
      ) : null}
      {problem ? (
        <small id={`${id}-err`} className="bill-dialog__error">
          {problem}
        </small>
      ) : null}
    </div>
  );
}

export default function MembershipPlanForm({ plan, onClose }) {
  const editing = Boolean(plan);
  const [initial] = useState(() => formOf(plan));
  const [form, setForm] = useState(initial);
  const [tried, setTried] = useState(false);
  const [error, setError] = useState("");
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const dirty = JSON.stringify(form) !== JSON.stringify(initial);
  const requestClose = () => (dirty ? setConfirmDiscard(true) : onClose());
  const ref = useDialog(true, requestClose);
  const create = useCreateMembershipPlan();
  const update = useUpdateMembershipPlan();
  const busy = create.isPending || update.isPending;
  const titleId = useId();
  const problems = problemsOf(form);
  const shown = tried ? problems : {};

  const put = (key, typed) => (e) => {
    const value = e.target.type === "checkbox" ? e.target.checked : e.target.value;
    setForm((was) => ({ ...was, [key]: typed ? typed(value) : value }));
  };

  const submit = async (e) => {
    e.preventDefault();
    setTried(true);
    setError("");
    if (Object.keys(problems).length) return;
    try {
      if (editing) {
        await update.mutateAsync({ id: plan.id, ...bodyOf(form) });
        onClose(`Plan ${form.name.trim()} saved`);
      } else {
        await create.mutateAsync(bodyOf(form));
        onClose(`Plan ${form.name.trim()} added`);
      }
    } catch (err) {
      setError(requestErrorOf(err, "The plan could not be saved"));
    }
  };

  return (
    <BillDialogLayer>
      <div className="flow-dialog-backdrop" onClick={requestClose} role="presentation">
        <form
          ref={ref}
          className="flow-card bill-dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          onClick={(e) => e.stopPropagation()}
          onSubmit={submit}
          noValidate
        >
          <h2 id={titleId} className="bill-dialog__title">
            {editing ? `Edit plan ${plan.name}` : "New membership plan"}
          </h2>
          {editing && plan.cards_sold > 0 ? (
            <p className="fset__hint">
              {plan.cards_sold} card{plan.cards_sold === 1 ? "" : "s"} already sold keep the
              consultations they were sold with. A new lab discount applies to every card on this
              plan from now on.
            </p>
          ) : null}
          <fieldset className="disc-section">
            <legend>Plan</legend>
            <div className="bill-form">
              <Field label="Code" required problem={shown.code} hint="Printed on the bill line">
                <input
                  className="jb-assign"
                  maxLength={30}
                  placeholder="e.g. GOLD-12"
                  value={form.code}
                  onChange={put("code", codeTyped)}
                />
              </Field>
              <Field label="Name" required problem={shown.name}>
                <input
                  className="jb-assign"
                  maxLength={120}
                  placeholder="e.g. Gold yearly"
                  value={form.name}
                  onChange={put("name")}
                />
              </Field>
              <Field label="Price (₹)" required problem={shown.price}>
                <input
                  className="jb-assign"
                  inputMode="decimal"
                  placeholder="e.g. 5000"
                  value={form.price}
                  onChange={put("price", moneyTyped)}
                />
              </Field>
            </div>
          </fieldset>
          <fieldset className="disc-section">
            <legend>What the card gives</legend>
            <div className="bill-form">
              <Field label="Consultations" required problem={shown.consult_count}>
                <input
                  className="jb-assign"
                  inputMode="numeric"
                  maxLength={4}
                  placeholder="e.g. 12"
                  value={form.consult_count}
                  onChange={put("consult_count", digitsTyped)}
                />
              </Field>
              <Field label="Dietitian visits">
                <input
                  className="jb-assign"
                  inputMode="numeric"
                  maxLength={4}
                  placeholder="e.g. 4"
                  value={form.dietitian_count}
                  onChange={put("dietitian_count", digitsTyped)}
                />
              </Field>
              <Field
                label="Lab discount (%)"
                problem={shown.lab_discount_pct}
                hint="Off tests while consultations remain, and on the day the last one is used"
              >
                <input
                  className="jb-assign"
                  inputMode="decimal"
                  placeholder="e.g. 15"
                  value={form.lab_discount_pct}
                  onChange={put("lab_discount_pct", moneyTyped)}
                />
              </Field>
              <label className="fset__check">
                <input
                  type="checkbox"
                  checked={form.lab_excludes_outsourced}
                  onChange={put("lab_excludes_outsourced")}
                />
                Not on outsourced tests
              </label>
            </div>
          </fieldset>
          {error ? (
            <p className="bill-dialog__error" role="alert">
              {error}
            </p>
          ) : null}
          {confirmDiscard ? (
            <div
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
            <div className="bill-dialog__actions">
              <button type="button" className="flow-btn flow-btn-ghost" onClick={() => onClose()}>
                Cancel
              </button>
              <button type="submit" className="flow-btn flow-btn-primary" disabled={busy}>
                {busy ? "Saving…" : editing ? "Save plan" : "Add plan"}
              </button>
            </div>
          )}
        </form>
      </div>
    </BillDialogLayer>
  );
}
