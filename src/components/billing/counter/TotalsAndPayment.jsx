import { useState } from "react";
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

export default function TotalsAndPayment({ bill, onBill, schemes, payLater, onPayLater }) {
  const { data: settings } = useDeskSettings();
  const { data: shift } = useCurrentShift();
  const take = useTakePayments();
  const reread = useRereadBill();
  const [rows, setRows] = useState([emptyRow()]);
  const [error, setError] = useState(null);
  const [note, setNote] = useState(null);

  const balance = balanceOf(bill);
  const entered = rows.reduce((sum, row) => sum + paiseOf(row.amount), 0);
  const remaining = balance - entered;
  const allowsLater = payLaterAllowed(bill, schemes, settings);
  const missingReference = rows.some(
    (row) => paiseOf(row.amount) > 0 && row.mode !== "cash" && !row.reference.trim(),
  );

  const change = (index, patch) =>
    setRows(rows.map((row, at) => (at === index ? { ...row, ...patch } : row)));

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

  const total = (label, amount, key) => (
    <tr key={key}>
      <th scope="row">{label}</th>
      <td>{fromPaise(amount)}</td>
    </tr>
  );

  return (
    <section className="bc-card" aria-label="Totals and payment">
      <h3 className="bc-card__title">Totals</h3>
      <table className="ltable bc-totals" aria-label="Totals">
        <tbody>
          {total("Actual", bill.totals.actual, "actual")}
          {total("Discount", bill.totals.discount, "discount")}
          {settings?.gst_enabled ? total("Tax", bill.totals.tax, "tax") : null}
          {total("Patient payable", bill.totals.payable, "payable")}
          {total("Claimed", bill.totals.claim, "claim")}
          {total("Adjustment", bill.totals.adjustment, "adjustment")}
          {total("Round-off", bill.totals.round_off, "round")}
          {total("Paid", bill.totals.paid, "paid")}
          {total("Balance", balance, "balance")}
        </tbody>
      </table>

      {bill.status !== "cancelled" && balance === 0 && (
        <div className="bc-hint">No payment is needed on this bill.</div>
      )}

      {bill.status !== "cancelled" && balance > 0 && (
        <>
          <h3 className="bc-card__title">Payment</h3>
          {!shift?.is_open && (
            <div className="bc-hint">
              No shift is open, so cash can&apos;t be taken yet — open one on the Shift tab.
            </div>
          )}
          {rows.map((row, index) => (
            <div className="bc-head__row" key={index}>
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
                <input
                  className="bc-field__in"
                  inputMode="decimal"
                  value={row.amount}
                  onChange={(e) => change(index, { amount: moneyTyped(e.target.value) })}
                />
              </label>
              {row.mode !== "cash" && (
                <label className="bc-field">
                  <span className="bc-field__lbl">Reference</span>
                  <input
                    className="bc-field__in"
                    maxLength={60}
                    value={row.reference}
                    onChange={(e) => change(index, { reference: e.target.value })}
                  />
                </label>
              )}
              {rows.length > 1 && (
                <button
                  type="button"
                  className="st-btn st-btn-g"
                  aria-label={`Remove payment ${index + 1}`}
                  onClick={() => setRows(rows.filter((_, at) => at !== index))}
                >
                  Remove
                </button>
              )}
            </div>
          ))}

          <div className="bc-head__row">
            <button
              type="button"
              className="st-btn st-btn-g"
              disabled={rows.length >= 10}
              onClick={() => setRows([...rows, emptyRow()])}
            >
              Add payment
            </button>
            <span className="bc-hint" aria-label="Remaining balance">
              Remaining {fromPaise(Math.max(0, remaining))}
            </span>
            <button
              type="button"
              className="st-btn st-btn-grn"
              disabled={entered <= 0 || entered > balance || missingReference || take.isPending}
              onClick={pay}
            >
              Take payment
            </button>
          </div>

          {allowsLater && bill.status === "draft" && (
            <label className="bc-check">
              <input
                type="checkbox"
                checked={payLater}
                onChange={(e) => onPayLater(e.target.checked)}
              />
              <span>Pay later</span>
            </label>
          )}
        </>
      )}

      {note && <div className="bc-note">{note}</div>}
      {error && <div className="bc-err">{error}</div>}
    </section>
  );
}
