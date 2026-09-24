import { useState } from "react";
import { Plus, X } from "lucide-react";
import {
  useCurrentShift,
  useDeskSettings,
  useRereadBill,
  useTakePayments,
} from "../../../queries/hooks/useBilling";
import { errorOf, fromPaise, moneyTyped } from "../format";
import { PAYMENT_MODE_LABEL } from "./lineText";
import { balanceOf, payLaterAllowed } from "./finaliseChecks";

const emptyRow = () => ({ mode: "cash", amount: "", reference: "" });

const paiseOf = (typed) => Math.round(Number(typed || 0) * 100);

const toRupees = (paise) => (Math.max(0, paise) / 100).toFixed(2).replace(/\.00$/, "");

const REFERENCE_HINT = {
  card: "e.g. last 4 digits or slip no.",
  upi: "e.g. UPI transaction ID",
};

export default function TotalsAndPayment({ bill, onBill, schemes, payLater, onPayLater }) {
  const { data: settings } = useDeskSettings();
  const { data: shift } = useCurrentShift();
  const take = useTakePayments();
  const reread = useRereadBill();
  const [rows, setRows] = useState([emptyRow()]);
  const [error, setError] = useState(null);
  const [note, setNote] = useState(null);
  const [capped, setCapped] = useState(null);

  const balance = balanceOf(bill);
  const entered = rows.reduce((sum, row) => sum + paiseOf(row.amount), 0);
  const remaining = balance - entered;
  const allowsLater = payLaterAllowed(bill, schemes, settings);
  const missingReference = rows.some(
    (row) => paiseOf(row.amount) > 0 && row.mode !== "cash" && !row.reference.trim(),
  );

  const change = (index, patch) =>
    setRows(rows.map((row, at) => (at === index ? { ...row, ...patch } : row)));

  const dueFor = (index) =>
    balance - rows.reduce((sum, row, at) => (at === index ? sum : sum + paiseOf(row.amount)), 0);

  const setAmount = (index, typed) => {
    const amount = moneyTyped(typed);
    const most = Math.max(0, dueFor(index));
    if (paiseOf(amount) > most) {
      change(index, { amount: toRupees(most) });
      setCapped({ index, most });
      return;
    }
    change(index, { amount });
    setCapped(null);
  };

  const pay = async () => {
    setError(null);
    setNote(null);
    try {
      onBill(
        await take.mutateAsync({
          billId: bill.id,
          visitId: bill.visit_id,
          version: bill.version,
          payments: rows
            .filter((row) => paiseOf(row.amount) > 0)
            .map((row) => ({
              mode: row.mode,
              amount: row.amount.trim(),
              ...(row.reference.trim() ? { reference: row.reference.trim() } : {}),
            })),
        }),
      );
      setRows([emptyRow()]);
      setCapped(null);
      setNote("Payment taken.");
    } catch (e) {
      if (e?.paymentTaken) {
        setRows([emptyRow()]);
        setError(
          "The payment was taken, but this bill could not be read back — press Save draft to see it.",
        );
        return;
      }
      const version = e?.response?.data?.version;
      setError(
        errorOf(e, "That payment could not be taken") +
          (version ? ` (it is now version ${version})` : ""),
      );
      if (version) {
        try {
          onBill(await reread.mutateAsync({ billId: bill.id }));
        } catch {
          setError("This bill changed and could not be read again — open it again");
        }
      }
    }
  };

  const total = (label, amount, key, tone = "") => (
    <tr key={key} className={tone ? `bc-t bc-t--${tone}` : "bc-t"}>
      <th scope="row">{label}</th>
      <td>{fromPaise(amount)}</td>
    </tr>
  );
  const progress = balance > 0 ? Math.min(100, Math.round((entered / balance) * 100)) : 0;
  const over = entered - balance;

  return (
    <section className="bc-card bc-pay" aria-label="Totals and payment">
      <h3 className="bc-card__title">Totals</h3>
      <table className="ltable bc-totals" aria-label="Totals">
        <tbody>
          {total("Actual", bill.totals.actual, "actual")}
          {total("Discount", bill.totals.discount, "discount", "minor")}
          {settings?.gst_enabled ? total("Tax", bill.totals.tax, "tax", "minor") : null}
          {total("Claimed", bill.totals.claim, "claim", "minor")}
          {total("Adjustment", bill.totals.adjustment, "adjustment", "minor")}
          {total("Round-off", bill.totals.round_off, "round", "minor")}
          {total("Patient payable", bill.totals.payable, "payable", "strong")}
          {total("Paid", bill.totals.paid, "paid", "minor")}
          {total("Balance", balance, "balance", balance > 0 ? "due" : "clear")}
        </tbody>
      </table>

      {bill.status !== "cancelled" && balance === 0 && (
        <div className="bc-pay__clear">No payment is needed on this bill.</div>
      )}

      {bill.status !== "cancelled" && balance > 0 && (
        <div className="bc-pay__take">
          <h3 className="bc-card__title">Payment</h3>
          {!shift?.is_open && (
            <div className="bc-pay__warn">
              No shift is open, so cash can&apos;t be taken yet — open one on the Shift tab.
            </div>
          )}
          <div className="bc-pay__lines">
            {rows.map((row, index) => {
              const others = entered - paiseOf(row.amount);
              const rest = balance - others;
              return (
                <div className="bc-pay__line" key={index}>
                  {rows.length > 1 && (
                    <div className="bc-pay__linehead">
                      <span>Payment {index + 1}</span>
                      <button
                        type="button"
                        className="bc-pay__remove"
                        aria-label={`Remove payment ${index + 1}`}
                        title="Remove"
                        onClick={() => {
                          setRows(rows.filter((_, at) => at !== index));
                          setCapped(null);
                        }}
                      >
                        <X size={14} aria-hidden="true" />
                      </button>
                    </div>
                  )}
                  <div className="bc-pay__fields">
                    <label className="bc-field">
                      <span className="bc-field__lbl">Mode</span>
                      <select
                        className="bc-field__in"
                        value={row.mode}
                        onChange={(e) => change(index, { mode: e.target.value })}
                      >
                        {Object.entries(PAYMENT_MODE_LABEL).map(([mode, label]) => (
                          <option key={mode} value={mode}>
                            {label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="bc-field">
                      <span className="bc-field__lbl">Amount</span>
                      <span className="bc-pay__money">
                        <span aria-hidden="true">₹</span>
                        <input
                          className="bc-field__in"
                          inputMode="decimal"
                          placeholder={toRupees(rest)}
                          value={row.amount}
                          aria-describedby={
                            capped?.index === index ? `bc-pay-cap-${index}` : undefined
                          }
                          onChange={(e) => setAmount(index, e.target.value)}
                        />
                      </span>
                    </label>
                    <button
                      type="button"
                      className="bc-pay__rest"
                      disabled={rest <= 0}
                      aria-label={`Fill payment ${index + 1} with the ${fromPaise(Math.max(0, rest))} still due`}
                      onClick={() => setAmount(index, toRupees(rest))}
                    >
                      Rest
                    </button>
                    {capped?.index === index && (
                      <p id={`bc-pay-cap-${index}`} className="bc-pay__cap" role="status">
                        Only {fromPaise(capped.most)} is still due, so this payment was capped at
                        that.
                      </p>
                    )}
                    {row.mode !== "cash" && (
                      <label className="bc-field bc-pay__ref">
                        <span className="bc-field__lbl">Reference</span>
                        <input
                          className="bc-field__in"
                          maxLength={60}
                          placeholder={REFERENCE_HINT[row.mode]}
                          value={row.reference}
                          onChange={(e) => change(index, { reference: e.target.value })}
                        />
                      </label>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          <button
            type="button"
            className="bc-pay__split"
            disabled={rows.length >= 10 || remaining <= 0}
            onClick={() => setRows([...rows, emptyRow()])}
          >
            <Plus size={14} aria-hidden="true" />
            Split payment
          </button>

          <div className="bc-pay__progress">
            <div className="bc-pay__progresstext">
              <span>
                {fromPaise(entered)} of {fromPaise(balance)} entered
              </span>
              {over > 0 ? (
                <span className="bc-pay__over">{fromPaise(over)} more than due</span>
              ) : (
                <span
                  className={remaining === 0 ? "bc-pay__left bc-pay__left--done" : "bc-pay__left"}
                  aria-label="Remaining balance"
                >
                  Remaining {fromPaise(Math.max(0, remaining))}
                </span>
              )}
            </div>
            <div className="bc-pay__bar" aria-hidden="true">
              <span
                className={over > 0 ? "bc-pay__fill bc-pay__fill--over" : "bc-pay__fill"}
                style={{ width: `${progress}%` }}
              />
            </div>
          </div>

          {missingReference && (
            <div className="bc-hint">Add the reference for each card or UPI payment.</div>
          )}

          <button
            type="button"
            className="bc-pay__go"
            disabled={entered <= 0 || entered > balance || missingReference || take.isPending}
            onClick={pay}
          >
            {take.isPending ? "Taking payment…" : "Take payment"}
            {entered > 0 && !take.isPending ? (
              <span className="bc-pay__goamt">{fromPaise(entered)}</span>
            ) : null}
          </button>

          {allowsLater && bill.status === "draft" && (
            <label className="bc-pay__later">
              <input
                type="checkbox"
                checked={payLater}
                onChange={(e) => onPayLater(e.target.checked)}
              />
              <span>Pay later</span>
            </label>
          )}
        </div>
      )}

      {note && <div className="bc-note">{note}</div>}
      {error && <div className="bc-err">{error}</div>}
    </section>
  );
}
