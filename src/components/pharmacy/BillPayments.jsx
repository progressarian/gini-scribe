import { Plus, X } from "lucide-react";
import FormField from "../ui/FormField";
import { inr } from "./format";
import { toPaise, toRupees } from "../../../shared/pharmacyMoney";
import { DEFAULT_UPI_APP } from "../../../shared/billingVocab";
import {
  PAYMENTS_AT_ONCE,
  PAYMENT_MODE_LABEL,
  TAKE_PAYMENT_MODES,
} from "../../../shared/pharmacyVocab";
import { SelectInput } from "./Fields";

export const firstPayment = (net) => [
  { mode: "cash", amount: toRupees(toPaise(net)), reference: "" },
];

const moneyTyped = (v) => {
  const clean = v.replace(/[^\d.]/g, "");
  const [whole, ...rest] = clean.split(".");
  return rest.length ? `${whole}.${rest.join("").slice(0, 2)}` : whole;
};

export function paymentProblems(rows, net, shortBy = 0, depositBalance = 0) {
  const fromDeposit = rows
    .filter((p) => p.mode === "deposit")
    .reduce((sum, p) => sum + toPaise(p.amount), 0);
  const problems = rows.map((p) => {
    const e = {};
    if (!(toPaise(p.amount) > 0)) e.amount = "Enter an amount more than 0.";
    else if (p.mode === "deposit" && fromDeposit > toPaise(depositBalance))
      e.amount = `Only ${inr(depositBalance)} is left in the deposit.`;
    return e;
  });
  const gap = toPaise(net) - rows.reduce((sum, p) => sum + toPaise(p.amount), 0);
  const allowed = toPaise(shortBy);
  const nothing = rows.length === 1 && !(toPaise(rows[0].amount) > 0) && allowed >= toPaise(net);
  if (nothing) return { rows: [{}], gap, allowed, fits: true, ok: true };
  const fits = gap >= 0 && gap <= allowed;
  return {
    rows: problems,
    gap,
    allowed,
    fits,
    ok: fits && problems.every((e) => !Object.keys(e).length),
  };
}

export const paymentsForApi = (rows) =>
  rows
    .filter((p) => toPaise(p.amount) > 0)
    .map((p) => ({
      mode: p.mode,
      amount: toPaise(p.amount) / 100,
      reference: p.mode === "cash" || p.mode === "deposit" ? null : p.reference.trim() || null,
      upi_app: p.mode === "upi" ? DEFAULT_UPI_APP : null,
    }));

export default function BillPayments({
  rows,
  net,
  onChange,
  showErrors,
  shortBy = 0,
  totalLabel = "the bill total",
  legend = "Payment",
  depositBalance = 0,
}) {
  const check = paymentProblems(rows, net, shortBy, depositBalance);
  const modes =
    Number(depositBalance) > 0 ? [...TAKE_PAYMENT_MODES, "deposit"] : TAKE_PAYMENT_MODES;
  const update = (i, patch) => onChange(rows.map((p, j) => (j === i ? { ...p, ...patch } : p)));
  const addRow = () =>
    onChange([
      ...rows,
      {
        mode: "upi",
        amount: check.gap > check.allowed ? toRupees(check.gap - check.allowed) : "",
        reference: "",
      },
    ]);

  return (
    <fieldset className="phb-fieldset phb-pay">
      <legend>{legend}</legend>
      {rows.map((p, i) => {
        const errors = showErrors ? check.rows[i] : {};
        return (
          <div className="phb-pay__row" key={i} role="group" aria-label={`Payment ${i + 1}`}>
            <FormField label="Mode">
              <SelectInput
                value={p.mode}
                onChange={(mode) => update(i, { mode })}
                options={modes.map((m) => ({
                  value: m,
                  label:
                    m === "deposit"
                      ? `From deposit (${inr(depositBalance)} left)`
                      : PAYMENT_MODE_LABEL[m],
                }))}
              />
            </FormField>
            <FormField label="Amount (₹)" required error={errors.amount}>
              <input
                className="jb-assign phs-num"
                inputMode="decimal"
                maxLength={12}
                value={p.amount}
                onChange={(e) => update(i, { amount: moneyTyped(e.target.value) })}
              />
            </FormField>
            {p.mode !== "cash" && p.mode !== "deposit" ? (
              <FormField label="Reference (optional)">
                <input
                  className="jb-assign"
                  maxLength={60}
                  value={p.reference}
                  onChange={(e) => update(i, { reference: e.target.value })}
                />
              </FormField>
            ) : null}
            {rows.length > 1 ? (
              <button
                type="button"
                className="flow-btn flow-btn-ghost phb-pay__remove"
                aria-label={`Remove payment ${i + 1}`}
                onClick={() => onChange(rows.filter((_, j) => j !== i))}
              >
                <X size={14} aria-hidden="true" />
              </button>
            ) : null}
          </div>
        );
      })}
      <div className="phb-pay__foot">
        {rows.length < PAYMENTS_AT_ONCE ? (
          <button type="button" className="flow-btn flow-btn-ghost" onClick={addRow}>
            <Plus size={14} aria-hidden="true" />
            Split payment
          </button>
        ) : (
          <span />
        )}
        <p
          className={`phb-pay__gap${check.fits ? "" : " is-off"}`}
          role="status"
          aria-live="polite"
        >
          {check.gap < 0
            ? `${inr(toRupees(-check.gap))} more than ${totalLabel}`
            : check.gap > check.allowed
              ? `Still to collect ${inr(toRupees(check.gap - check.allowed))}`
              : rows.some((p) => !(toPaise(p.amount) > 0))
                ? "Enter the amount of each payment"
                : check.gap > 0
                  ? `${inr(toRupees(check.gap))} left as due`
                  : `Payments match ${totalLabel}`}
        </p>
      </div>
    </fieldset>
  );
}
