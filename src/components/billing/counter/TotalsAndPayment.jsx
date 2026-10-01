import { useState } from "react";
import { CreditCard, Plus, X } from "lucide-react";
import ConfirmModal from "../../ui/ConfirmModal";
import {
  useBillPayments,
  useClearInHealthray,
  useCurrentShift,
  useDeskSettings,
  useRereadBill,
  useTakePayments,
} from "../../../queries/hooks/useBilling";
import { HEALTHRAY_MODE } from "../../../../shared/billingVocab.js";
import { errorOf, fromPaise, moneyTyped } from "../format";
import { HEALTHRAY_LABEL, PAYMENT_MODE_LABEL } from "./lineText";
import { balanceOf, payLaterAllowed } from "./finaliseChecks";
import { emptyPaymentRow } from "./counterForm";

const paiseOf = (typed) => Math.round(Number(typed || 0) * 100);

const toRupees = (paise) => (Math.max(0, paise) / 100).toFixed(2).replace(/\.00$/, "");

const REFERENCE_HINT = {
  card: "e.g. last 4 digits or slip no.",
  upi: "e.g. UPI transaction ID",
};

const healthrayPaidOf = (payments) =>
  (payments || [])
    .filter((payment) => payment.direction === "in" && payment.mode === HEALTHRAY_MODE)
    .reduce((sum, payment) => sum + payment.amount, 0);

export default function TotalsAndPayment({
  bill,
  patient,
  onBill,
  schemes,
  payLater,
  onPayLater,
  form,
}) {
  const { data: settings } = useDeskSettings();
  const { data: shift } = useCurrentShift();
  const { data: billPayments } = useBillPayments(bill.id);
  const take = useTakePayments();
  const clear = useClearInHealthray();
  const reread = useRereadBill();
  const [confirming, setConfirming] = useState(false);
  const [clearError, setClearError] = useState(null);
  const rows = form.value.rows;
  const setRows = (next) => form.set("rows", next);
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
      form.drop("rows", "payLater");
      setCapped(null);
      setNote("Payment taken.");
    } catch (e) {
      if (e?.paymentTaken) {
        form.drop("rows", "payLater");
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

  const clearInHealthray = async () => {
    setClearError(null);
    setError(null);
    setNote(null);
    try {
      onBill(
        await clear.mutateAsync({ billId: bill.id, visitId: bill.visit_id, version: bill.version }),
      );
      form.drop("rows", "payLater");
      setCapped(null);
      setConfirming(false);
      setNote(`Marked ${fromPaise(balance)} as paid in HealthRay.`);
    } catch (e) {
      if (e?.paymentTaken) {
        form.drop("rows", "payLater");
        setConfirming(false);
        setError(
          "The bill was marked paid in HealthRay, but it could not be read back — press Save draft to see it.",
        );
        return;
      }
      setClearError(errorOf(e, "This bill could not be marked as paid in HealthRay"));
      if (e?.response?.data?.version) {
        try {
          onBill(await reread.mutateAsync({ billId: bill.id }));
        } catch {
          setClearError("This bill changed and could not be read again — open it again");
        }
      }
    }
  };

  const healthrayPaid = healthrayPaidOf(billPayments);
  const clearable =
    bill.bill_type !== "credit_note" && (bill.status === "draft" || bill.status === "final");

  const shown = (label, amount, key, tone) => (amount ? total(label, amount, key, tone) : null);
  const total = (label, amount, key, tone = "") => (
    <tr key={key} className={tone ? `bc-t bc-t--${tone}` : "bc-t"}>
      <th scope="row">{label}</th>
      <td>{fromPaise(amount)}</td>
    </tr>
  );
  const over = entered - balance;

  return (
    <section className="bc-pay" aria-label="Totals and payment">
      <div className="bc-card bc-sum">
        <h3 className="bc-card__heading">Bill Summary</h3>
        <table className="bc-totals" aria-label="Totals">
          <tbody>
            {total("Subtotal", bill.totals.actual, "actual")}
            {total("Discount", bill.totals.discount, "discount")}
            {settings?.gst_enabled ? total("GST", bill.totals.tax, "tax") : null}
            {shown("Claimed", bill.totals.claim, "claim")}
            {shown("Adjustment", bill.totals.adjustment, "adjustment")}
            {shown("Round-off", bill.totals.round_off, "round")}
            {total("Total", bill.totals.payable, "payable", "strong")}
            {total("Paid", bill.totals.paid, "paid")}
            {bill.credits?.credited > 0 && total("Credited", bill.credits.credited, "credited")}
            {bill.credits?.refunded > 0 && total("Refunded", bill.credits.refunded, "refunded")}
            {total("Amount Due", balance, "balance", balance > 0 ? "due" : "clear")}
          </tbody>
        </table>
        {bill.status !== "cancelled" &&
          balance === 0 &&
          bill.lines.length > 0 &&
          healthrayPaid === 0 && (
            <div className="bc-pay__clear">No payment is needed on this bill.</div>
          )}
      </div>

      {bill.status !== "cancelled" && balance === 0 && healthrayPaid > 0 && (
        <div className="bc-card bc-pay__take">
          <h3 className="bc-card__heading">Payment</h3>
          <button type="button" className="bc-pay__hr bc-pay__hr--done" disabled>
            ✓ {HEALTHRAY_LABEL} — {fromPaise(healthrayPaid)}
          </button>
        </div>
      )}

      {bill.status !== "cancelled" && balance > 0 && (
        <div className="bc-card bc-pay__take">
          <h3 className="bc-card__heading">Payment</h3>
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
                      <span className="bc-field__lbl">Amount Received</span>
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
                      Full
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
            onClick={() => setRows([...rows, emptyPaymentRow()])}
          >
            <Plus size={14} aria-hidden="true" />
            Split payment
          </button>

          <dl className="bc-pay__mini">
            <div>
              <dt>Due</dt>
              <dd>{fromPaise(balance)}</dd>
            </div>
            <div>
              <dt>Receiving</dt>
              <dd>{fromPaise(entered)}</dd>
            </div>
            {over > 0 ? (
              <div className="bc-pay__over">
                <dt>Too much</dt>
                <dd>{fromPaise(over)} more than due</dd>
              </div>
            ) : (
              <div className={remaining === 0 ? "bc-pay__left--done" : "bc-pay__left"}>
                <dt>Balance</dt>
                <dd aria-label="Remaining balance">{fromPaise(Math.max(0, remaining))}</dd>
              </div>
            )}
          </dl>

          {missingReference && (
            <div className="bc-hint">Add the reference for each card or UPI payment.</div>
          )}

          <button
            type="button"
            className="bc-pay__go"
            disabled={entered <= 0 || entered > balance || missingReference || take.isPending}
            onClick={pay}
          >
            <CreditCard size={18} aria-hidden="true" />
            {take.isPending ? "Taking payment…" : "Take payment"}
            {entered > 0 && !take.isPending ? (
              <span className="bc-pay__goamt">{fromPaise(entered)}</span>
            ) : null}
          </button>

          {clearable && (
            <button
              type="button"
              className="bc-pay__hr"
              disabled={take.isPending || clear.isPending}
              onClick={() => {
                setClearError(null);
                setConfirming(true);
              }}
            >
              {HEALTHRAY_LABEL}
            </button>
          )}

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

      {form.restored && (
        <div className="bc-note" role="status">
          Restored what you&apos;d typed before the page reloaded.
        </div>
      )}
      {note && <div className="bc-note">{note}</div>}
      {error && <div className="bc-err">{error}</div>}

      <ConfirmModal
        open={confirming}
        title="Mark as paid in HealthRay?"
        variant="primary"
        confirmLabel={clear.isPending ? "Marking…" : `Mark ${fromPaise(balance)} paid`}
        cancelLabel="Cancel"
        busy={clear.isPending}
        error={clearError}
        message={
          <div className="bc-hr-confirm">
            <dl className="bc-hr-confirm__facts">
              <div>
                <dt>Patient</dt>
                <dd>
                  {patient?.name || "—"}
                  {patient?.fileNo ? ` · ${patient.fileNo}` : ""}
                </dd>
              </div>
              <div>
                <dt>Bill</dt>
                <dd>{bill.bill_no || "Draft"}</dd>
              </div>
              <div>
                <dt>Amount</dt>
                <dd>{fromPaise(balance)}</dd>
              </div>
            </dl>
            <p>
              This clears the bill in Scribe. No money is taken here and it is not added to the cash
              drawer.
            </p>
          </div>
        }
        onConfirm={clearInHealthray}
        onCancel={() => {
          if (!clear.isPending) setConfirming(false);
        }}
      />
    </section>
  );
}
