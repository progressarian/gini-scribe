import { cloneElement, useId, useState } from "react";
import { useCopyBillingConsultantFees } from "../../queries/hooks/useBillingMaster";
import { toast } from "../../stores/uiStore";
import { requestErrorOf } from "./format";
import useDialog from "./useDialog";

function Field({ label, children }) {
  const id = useId();
  return (
    <div className="fset__field">
      <label htmlFor={id}>{label}</label>
      {cloneElement(children, { id })}
    </div>
  );
}

function CategoryOptions({ tree }) {
  return tree.flatMap((top) => [
    <option key={top.code} value={top.code}>
      {top.label}
    </option>,
    ...top.sub_categories.map((sub) => (
      <option key={sub.code} value={sub.code}>
        {`   ${sub.display_label}`}
      </option>
    )),
  ]);
}

export default function ConsultantFeeCopy({ tree, from: initialFrom, date, onClose }) {
  const copy = useCopyBillingConsultantFees();
  const [form, setForm] = useState({ from: initialFrom ?? "", to: "", valid_from: "" });
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState("");
  const ref = useDialog(true, onClose);
  const titleId = useId();
  const labels = new Map(
    tree.flatMap((top) => [
      [top.code, top.label],
      ...top.sub_categories.map((sub) => [sub.code, sub.display_label]),
    ]),
  );
  const set = (key) => (e) => {
    setConfirming(false);
    setForm({ ...form, [key]: e.target.value });
  };

  const review = (e) => {
    e.preventDefault();
    setError("");
    if (form.from === form.to) return setError("Choose two different categories");
    return setConfirming(true);
  };

  const run = async () => {
    setError("");
    try {
      const result = await copy.mutateAsync({
        from_scheme_code: form.from,
        to_scheme_code: form.to,
        ...(form.valid_from ? { valid_from: form.valid_from } : {}),
        ...(date ? { date } : {}),
      });
      toast(
        result.copied
          ? `Copied ${result.copied} fee${result.copied === 1 ? "" : "s"} from ${labels.get(form.from)} to ${labels.get(form.to)}`
          : `${labels.get(form.from)} has no fees of its own to copy`,
        result.copied ? "success" : "warn",
      );
      onClose();
    } catch (err) {
      setConfirming(false);
      setError(requestErrorOf(err, "Could not copy the column"));
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
        onSubmit={review}
      >
        <h2 id={titleId} className="bill-dialog__title">
          Copy a column
        </h2>
        <p className="fset__cardsub">
          Copies every doctor's own fee, bill name, bill code and patient-pays rule from one
          category to another. Inherited values are not copied.
        </p>
        <div className="bill-form">
          <Field label="Copy from">
            <select className="jb-assign" value={form.from} onChange={set("from")} required>
              <option value="">Choose a category</option>
              <CategoryOptions tree={tree} />
            </select>
          </Field>
          <Field label="Copy to">
            <select className="jb-assign" value={form.to} onChange={set("to")} required>
              <option value="">Choose a category</option>
              <CategoryOptions tree={tree} />
            </select>
          </Field>
          <Field label="Starting (optional)">
            <input
              type="date"
              className="jb-assign"
              value={form.valid_from}
              onChange={set("valid_from")}
            />
          </Field>
        </div>
        {error ? (
          <p className="bill-dialog__error" role="alert">
            {error}
          </p>
        ) : null}
        {confirming ? (
          <div
            className="bill-dialog__actions bill-dialog__discard"
            role="group"
            aria-label="Confirm the copy"
          >
            <span>
              Copy {labels.get(form.from)} to {labels.get(form.to)}? Each doctor's own fee there is
              replaced{form.valid_from ? ` from ${form.valid_from}` : ""}.
            </span>
            <button
              type="button"
              className="flow-btn flow-btn-ghost"
              autoFocus
              onClick={() => setConfirming(false)}
            >
              Back
            </button>
            <button
              type="button"
              className="flow-btn flow-btn-primary"
              disabled={copy.isPending}
              onClick={run}
            >
              Copy
            </button>
          </div>
        ) : (
          <div className="bill-dialog__actions">
            <button type="button" className="flow-btn flow-btn-ghost" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="flow-btn flow-btn-primary">
              Copy…
            </button>
          </div>
        )}
      </form>
    </div>
  );
}
