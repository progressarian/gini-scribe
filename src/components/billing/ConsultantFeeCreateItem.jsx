import { cloneElement, useId, useState } from "react";
import { useCreateBillingItem } from "../../queries/hooks/useBillingMaster";
import { toast } from "../../stores/uiStore";
import { FOLLOW_UP_WINDOW_MAX_DAYS } from "../../../shared/billingVocab";
import { codeTyped, digitsTyped, moneyTyped, requestErrorOf } from "./format";
import useDialog from "./useDialog";
import BillDialogLayer from "./BillDialogLayer";

function Field({ label, className = "", hint, children }) {
  const id = useId();
  const hintId = `${id}-hint`;
  return (
    <div className={`fset__field ${className}`.trim()}>
      <label htmlFor={id}>{label}</label>
      {cloneElement(children, { id, "aria-describedby": hint ? hintId : undefined })}
      {hint ? (
        <p id={hintId} className="fset__hint">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

const VISIT_CODES = { New: "NEW", "Follow Up": "FU" };

const suggestedCode = (doctor, days) =>
  `CONS-${doctor.doctor_id ?? "DEFAULT"}-${doctor.window ? `FU${days}` : (VISIT_CODES[doctor.visit_type] ?? "FU")}`;

const whoOf = (doctor) => doctor.doctor_name ?? "Hospital default";

const suggestedName = (doctor, days) =>
  doctor.window
    ? `Follow-up within ${days || "N"} days — ${whoOf(doctor)}`
    : `Consultation — ${whoOf(doctor)} (${doctor.visit_type})`;

export default function ConsultantFeeCreateItem({ doctor, onClose, onCreated }) {
  const create = useCreateBillingItem();
  const [form, setForm] = useState(() => ({
    days: "",
    name: suggestedName(doctor, ""),
    code: suggestedCode(doctor, ""),
    base_price: "",
  }));
  const [touched, setTouched] = useState({ name: false, code: false });
  const [error, setError] = useState("");
  const ref = useDialog(true, onClose);
  const titleId = useId();
  const set = (key, typed) => (e) => {
    const value = typed ? typed(e.target.value) : e.target.value;
    if (key === "name" || key === "code") setTouched({ ...touched, [key]: true });
    setForm({ ...form, [key]: value });
  };
  const setDays = (e) => {
    const days = digitsTyped(e.target.value).slice(0, 2);
    setForm({
      ...form,
      days,
      name: touched.name ? form.name : suggestedName(doctor, days),
      code: touched.code ? form.code : suggestedCode(doctor, days),
    });
  };

  const submit = async (e) => {
    e.preventDefault();
    setError("");
    const days = Number(form.days);
    if (
      doctor.window &&
      !(Number.isInteger(days) && days >= 1 && days <= FOLLOW_UP_WINDOW_MAX_DAYS)
    ) {
      setError(`Enter a number of days from 1 to ${FOLLOW_UP_WINDOW_MAX_DAYS}.`);
      return;
    }
    try {
      await create.mutateAsync({
        code: form.code.trim(),
        name: form.name.trim(),
        base_price: form.base_price.trim(),
        kind: "consultation",
        doctor_id: doctor.doctor_id,
        visit_type: doctor.visit_type,
        ...(doctor.window ? { follow_up_within_days: days } : {}),
      });
      toast(`Added ${form.name.trim()}`, "success");
      onCreated();
    } catch (err) {
      setError(requestErrorOf(err, "Could not create the item"));
    }
  };

  const title = doctor.window
    ? `Follow-up window fee for ${whoOf(doctor)}`
    : doctor.doctor_id
      ? `${doctor.visit_type} consultation item for ${doctor.doctor_name}`
      : `Hospital default ${doctor.visit_type} consultation item`;
  const intro = doctor.window
    ? doctor.doctor_id
      ? `A reduced Follow Up fee for patients this doctor saw recently. The smallest window that fits is used; otherwise the normal Follow Up fee applies.`
      : `A reduced Follow Up fee for any doctor without a window of the same length of their own.`
    : doctor.doctor_id
      ? `The General fee: what this doctor's ${doctor.visit_type} visit costs a patient with no category.`
      : `The General fee for a ${doctor.visit_type} visit with any doctor who has no ${doctor.visit_type} fee of their own.`;

  return (
    <BillDialogLayer>
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
            {title}
          </h2>
          <p className="fset__cardsub">{intro}</p>
          {doctor.window ? (
            <div className="bill-form">
              <Field
                label="Within how many days of the last visit"
                className="fset__field--narrow"
                hint={`Counted from this doctor's last full-fee visit, 1 to ${FOLLOW_UP_WINDOW_MAX_DAYS} days. If the last day is a Sunday or clinic holiday, the next open day still counts.`}
              >
                <input
                  className="jb-assign"
                  inputMode="numeric"
                  value={form.days}
                  onChange={setDays}
                  required
                  autoFocus
                />
              </Field>
            </div>
          ) : null}
          <div className="bill-form">
            <Field label="Price (₹)" className="fset__field--narrow">
              <input
                className="jb-assign"
                inputMode="decimal"
                value={form.base_price}
                onChange={set("base_price", moneyTyped)}
                required
                autoFocus={!doctor.window}
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
              {create.isPending ? "Saving…" : "Create item"}
            </button>
          </div>
        </form>
      </div>
    </BillDialogLayer>
  );
}
