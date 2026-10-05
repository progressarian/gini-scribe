import { moneyTyped } from "../format";

export const EMPTY_DISCOUNT = { kind: "percent", value: "", reason: "" };

export const discountDraft = (current) =>
  current
    ? { kind: current.kind, value: String(current.value), reason: current.reason || "" }
    : EMPTY_DISCOUNT;

export const discountText = (discount) =>
  discount.kind === "percent" ? `${discount.value}%` : `₹${discount.value.toLocaleString("en-IN")}`;

export function discountNote(discount) {
  if (!discount) return null;
  return [
    `${discountText(discount)} off`,
    discount.by_name && `by ${discount.by_name}`,
    discount.reason,
  ]
    .filter(Boolean)
    .join(" · ");
}

export const discountProblem = ({ kind, value }) => {
  const number = Number(value);
  if (!value.trim()) return "Enter the discount";
  if (!(number > 0)) return "The discount must be more than 0";
  if (kind === "percent" && number > 100) return "A percent discount can't be more than 100%";
  return null;
};

export default function ManualDiscountFields({ id, value, onChange }) {
  const set = (key) => (e) =>
    onChange({
      ...value,
      [key]: key === "value" ? moneyTyped(e.target.value) : e.target.value,
    });
  return (
    <div className="bc-mdisc">
      <div className="bc-mdisc__row">
        <label className="bc-field bc-mdisc__kind">
          <span className="bc-field__lbl">Type</span>
          <select className="bc-field__in" value={value.kind} onChange={set("kind")}>
            <option value="percent">% off</option>
            <option value="flat">₹ off</option>
          </select>
        </label>
        <label className="bc-field bc-mdisc__value">
          <span className="bc-field__lbl">
            {value.kind === "percent" ? "Discount %" : "Discount ₹"}
          </span>
          <input
            id={id}
            className="bc-field__in"
            inputMode="decimal"
            value={value.value}
            onChange={set("value")}
          />
        </label>
      </div>
      <label className="bc-field">
        <span className="bc-field__lbl">Reason (optional)</span>
        <input
          className="bc-field__in"
          value={value.reason}
          maxLength={1000}
          onChange={set("reason")}
        />
      </label>
    </div>
  );
}
