import { cloneElement, useId, useState } from "react";
import {
  useClearBillingConsultantFee,
  useSaveBillingConsultantFee,
} from "../../queries/hooks/useBillingMaster";
import { toast } from "../../stores/uiStore";
import { codeTyped, moneyTyped, requestErrorOf } from "./format";
import { cellSummary, whoOf } from "./consultantFeeText";
import useDialog from "./useDialog";

const text = (v) => (v === null || v === undefined ? "" : String(v));
const TYPED = { fee: moneyTyped, patient_value: moneyTyped, bill_code: codeTyped };
const TAKES_VALUE = ["amount", "percent"];
const RATE_KEYS = ["fee", "bill_name", "bill_code"];
const RULE_KEYS = ["patient_pays", "patient_value", "remainder"];
const PAYS_LABELS = {
  full: "The full fee",
  amount: "An amount (₹)",
  percent: "A percent of the fee",
  nothing: "Nothing",
};

function Field({ label, className = "", children }) {
  const id = useId();
  return (
    <div className={`fset__field ${className}`.trim()}>
      <label htmlFor={id}>{label}</label>
      {cloneElement(children, { id })}
    </div>
  );
}

const formOf = (cell, column, today) => ({
  fee: text(cell.own?.rate),
  bill_name: text(cell.own?.bill_name),
  bill_code: text(cell.own?.bill_code),
  patient_pays: cell.own_rule?.patient_pays ?? "",
  patient_value: text(cell.own_rule?.patient_value),
  remainder:
    cell.own_rule && cell.own_rule.patient_pays !== "full"
      ? cell.own_rule.remainder
      : column.effective_payer_name
        ? "claim"
        : "adjustment",
  valid_from: cell.own?.valid_from ?? cell.own_rule?.valid_from ?? today,
  valid_to: text(cell.own?.valid_to ?? cell.own_rule?.valid_to),
});

function bodyOf(form, initial, cell) {
  const changed = (key) => form[key].trim() !== initial[key].trim();
  const datesChanged = changed("valid_from") || changed("valid_to");
  const rate = RATE_KEYS.some(changed) || (datesChanged && Boolean(cell.own));
  const rule =
    Boolean(form.patient_pays) &&
    (RULE_KEYS.some(changed) || (datesChanged && Boolean(cell.own_rule)));
  if (!rate && !rule) return null;
  const body = {};
  if (rate) {
    for (const key of RATE_KEYS) body[key] = form[key].trim() || null;
  }
  if (rule) {
    body.patient_pays = form.patient_pays;
    if (TAKES_VALUE.includes(form.patient_pays)) body.patient_value = form.patient_value.trim();
    if (form.patient_pays !== "full") body.remainder = form.remainder;
  }
  if (changed("valid_from")) body.valid_from = form.valid_from;
  if (changed("valid_to")) body.valid_to = form.valid_to || null;
  return body;
}

export default function ConsultantFeeEditor({ target, parentLabel, today, date, onClose }) {
  const { row, column, cell } = target;
  const [initial] = useState(() => formOf(cell, column, today));
  const [form, setForm] = useState(initial);
  const [error, setError] = useState("");
  const [clearing, setClearing] = useState(false);
  const save = useSaveBillingConsultantFee();
  const clear = useClearBillingConsultantFee();
  const ref = useDialog(true, onClose);
  const titleId = useId();
  const who = `${whoOf(row)} (${row.visit_type})`;
  const set = (key) => (e) =>
    setForm({ ...form, [key]: TYPED[key] ? TYPED[key](e.target.value) : e.target.value });
  const hasOwn = Boolean(cell.own || cell.own_rule);
  const takesValue = TAKES_VALUE.includes(form.patient_pays);
  const hasRest = form.patient_pays && form.patient_pays !== "full";

  const submit = async (e) => {
    e.preventDefault();
    setError("");
    const body = bodyOf(form, initial, cell);
    if (!body) return setError("Nothing changed — change a value, or Cancel");
    try {
      const result = await save.mutateAsync({
        scheme_code: column.code,
        service_item_id: row.item.id,
        ...body,
      });
      toast(`Saved the ${column.display_label} fee for ${who}`, "success");
      if (result.starts_in_past) {
        toast("This fee starts in the past — bills already made keep their price", "warn", 6000);
      }
      return onClose();
    } catch (err) {
      return setError(requestErrorOf(err, "Could not save the fee"));
    }
  };

  const clearCell = async () => {
    setError("");
    try {
      await clear.mutateAsync({
        scheme_code: column.code,
        service_item_id: row.item.id,
        date,
      });
      toast(`Cleared the ${column.display_label} fee for ${who}`, "success");
      onClose();
    } catch (err) {
      setClearing(false);
      setError(requestErrorOf(err, "Could not clear the fee"));
    }
  };

  return (
    <div className="flow-dialog-backdrop" onClick={onClose} role="presentation">
      <form
        ref={ref}
        className="flow-card bill-dialog cf-editor"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(e) => e.stopPropagation()}
        onSubmit={submit}
      >
        <h2 id={titleId} className="bill-dialog__title">
          {column.display_label} · {who}
        </h2>
        <p className="fset__cardsub cf-editor__now">Now: {cellSummary(cell, parentLabel)}.</p>
        <div className="bill-form">
          <Field label="Fee (₹)" className="fset__field--narrow cf-editor__money">
            <input
              className="jb-assign"
              inputMode="decimal"
              placeholder={String(cell.fee ?? "")}
              value={form.fee}
              onChange={set("fee")}
            />
          </Field>
          <Field label="Patient pays">
            <select className="jb-assign" value={form.patient_pays} onChange={set("patient_pays")}>
              {cell.own_rule ? null : <option value="">As inherited</option>}
              {Object.entries(PAYS_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </Field>
          {takesValue ? (
            <Field
              label={form.patient_pays === "amount" ? "Amount (₹)" : "Percent (%)"}
              className="fset__field--narrow cf-editor__money"
            >
              <input
                className="jb-assign"
                inputMode="decimal"
                value={form.patient_value}
                onChange={set("patient_value")}
                required
              />
            </Field>
          ) : null}
          {hasRest ? (
            <Field label="The rest goes to">
              <select className="jb-assign" value={form.remainder} onChange={set("remainder")}>
                <option value="claim">
                  Claim{column.effective_payer_name ? ` (${column.effective_payer_name})` : ""}
                </option>
                <option value="adjustment">Adjustment</option>
              </select>
            </Field>
          ) : null}
        </div>
        <div className="bill-form">
          <Field label="Bill name">
            <input
              className="jb-assign"
              maxLength={200}
              placeholder={cell.bill_name ?? ""}
              value={form.bill_name}
              onChange={set("bill_name")}
            />
          </Field>
          <Field label="Bill code" className="bill-form__code">
            <input
              className="jb-assign"
              maxLength={40}
              placeholder={cell.bill_code ?? ""}
              value={form.bill_code}
              onChange={set("bill_code")}
            />
          </Field>
        </div>
        <div className="bill-form">
          <Field label="Valid from">
            <input
              type="date"
              className="jb-assign"
              value={form.valid_from}
              onChange={set("valid_from")}
              required
            />
          </Field>
          <Field label="Valid to">
            <input
              type="date"
              className="jb-assign"
              min={form.valid_from || undefined}
              value={form.valid_to}
              onChange={set("valid_to")}
            />
          </Field>
        </div>
        {error ? (
          <p className="bill-dialog__error" role="alert">
            {error}
          </p>
        ) : null}
        {clearing ? (
          <div
            className="bill-dialog__actions bill-dialog__discard"
            role="group"
            aria-label="Clear this cell?"
          >
            <span>Clear this cell's own fee and rule? It goes back to what it inherits.</span>
            <button
              type="button"
              className="flow-btn flow-btn-ghost"
              autoFocus
              onClick={() => setClearing(false)}
            >
              Keep
            </button>
            <button
              type="button"
              className="flow-btn flow-btn-red"
              disabled={clear.isPending}
              onClick={clearCell}
            >
              Clear
            </button>
          </div>
        ) : (
          <div className="bill-dialog__actions">
            {hasOwn ? (
              <button
                type="button"
                className="flow-btn flow-btn-red cf-editor__clear"
                onClick={() => setClearing(true)}
              >
                Clear
              </button>
            ) : null}
            <button type="button" className="flow-btn flow-btn-ghost" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="flow-btn flow-btn-primary" disabled={save.isPending}>
              Save
            </button>
          </div>
        )}
      </form>
    </div>
  );
}
