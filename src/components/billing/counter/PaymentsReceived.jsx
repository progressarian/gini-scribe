import { useState } from "react";
import { useCorrectPaymentMode } from "../../../queries/hooks/useBilling";
import { errorOf, fromPaise } from "../format";
import { HEALTHRAY_MODE } from "../../../../shared/billingVocab";
import { needsUpiApp, paymentModeText, TAKE_MODE_LABEL, takenModeText } from "./lineText";
import UpiAppField from "./UpiAppField";

const MODES = Object.keys(TAKE_MODE_LABEL);

const REFERENCE_HINT = {
  upi: "UPI transaction ID",
  neft: "UTR or cheque no.",
};

const isHealthray = (payment) => payment.mode === HEALTHRAY_MODE;

const currentMode = (payment) => (isHealthray(payment) ? payment.paid_via : payment.mode);

const modeText = (payment) =>
  [
    isHealthray(payment)
      ? paymentModeText(payment.mode)
      : takenModeText(payment.mode, payment.upi_app),
    isHealthray(payment) && payment.paid_via && takenModeText(payment.paid_via, payment.upi_app),
    payment.reference,
  ]
    .filter(Boolean)
    .join(" · ");

const timeOf = (iso) =>
  iso
    ? new Date(iso).toLocaleTimeString("en-IN", {
        timeZone: "Asia/Kolkata",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "—";

function CorrectForm({ bill, payment, onDone, onCancel }) {
  const correct = useCorrectPaymentMode();
  const healthray = isHealthray(payment);
  const [mode, setMode] = useState(MODES.find((m) => m !== currentMode(payment)) || "cash");
  const [reference, setReference] = useState("");
  const [upiApp, setUpiApp] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState(null);
  const needsReference = mode !== "cash";
  const needsApp = needsUpiApp(mode);

  const save = async (e) => {
    e.preventDefault();
    setError(null);
    try {
      await correct.mutateAsync({
        paymentId: payment.id,
        billId: bill.id,
        visitId: bill.visit_id,
        mode,
        reference: needsReference ? reference.trim() : null,
        upiApp: needsApp ? upiApp : null,
        reason: reason.trim(),
      });
      onDone();
    } catch (err) {
      setError(errorOf(err, "The payment mode could not be corrected"));
    }
  };

  return (
    <form className="bc-head__row" onSubmit={save} aria-label="Correct how it was paid">
      <label className="bc-field">
        <span className="bc-field__lbl">
          {healthray ? "Paid in HealthRay by" : "Really paid by"}
        </span>
        <select className="bc-field__in" value={mode} onChange={(e) => setMode(e.target.value)}>
          {MODES.filter(
            (m) => m !== currentMode(payment) || payment.reference || needsUpiApp(m),
          ).map((m) => (
            <option key={m} value={m}>
              {TAKE_MODE_LABEL[m]}
            </option>
          ))}
        </select>
      </label>
      {needsApp && <UpiAppField value={upiApp} onChange={setUpiApp} />}
      {needsReference && (
        <label className="bc-field">
          <span className="bc-field__lbl">Reference</span>
          <input
            className="bc-field__in"
            value={reference}
            maxLength={60}
            placeholder={REFERENCE_HINT[mode] ?? "Last 4 digits or slip no."}
            onChange={(e) => setReference(e.target.value)}
          />
        </label>
      )}
      <label className="bc-field">
        <span className="bc-field__lbl">Reason</span>
        <input
          className="bc-field__in"
          value={reason}
          maxLength={300}
          placeholder={
            healthray
              ? "e.g. Paid by UPI at the HealthRay counter"
              : "e.g. Paid by UPI, entered as cash"
          }
          onChange={(e) => setReason(e.target.value)}
        />
      </label>
      <span className="bc-head__hint">
        {fromPaise(payment.amount)} · {modeText(payment)} →{" "}
        {healthray ? `${paymentModeText(payment.mode)} · ` : ""}
        {takenModeText(mode, needsApp ? upiApp : null)}
        {payment.receipt_no ? ` · receipt ${payment.receipt_no}` : ""}. The amount stays the same.
      </span>
      <button
        type="submit"
        className="st-btn st-btn-grn"
        disabled={
          correct.isPending ||
          reason.trim().length < 5 ||
          (needsReference && !reference.trim()) ||
          (needsApp && !upiApp)
        }
      >
        {correct.isPending ? "Saving…" : "Save correction"}
      </button>
      <button type="button" className="st-btn st-btn-g" onClick={onCancel}>
        Cancel
      </button>
      {error && (
        <span className="bc-err" role="alert">
          {error}
        </span>
      )}
    </form>
  );
}

export default function PaymentsReceived({ bill, payments }) {
  const [open, setOpen] = useState(null);
  const received = (payments || []).filter((payment) => payment.direction === "in");
  if (!received.length) return null;
  const correctable = received.some((payment) => payment.can_correct);

  return (
    <section className="bc-card" aria-label="Payments received">
      <h3 className="bc-card__heading">Payments received</h3>
      <div className="ltablewrap">
        <table className="ltable bc-paytable" aria-label="Payments received">
          <thead>
            <tr>
              <th scope="col">Receipt</th>
              <th scope="col">Mode</th>
              <th scope="col" className="bc-num">
                Amount
              </th>
              <th scope="col">Time · by</th>
              {correctable && (
                <th scope="col">
                  <span className="sr-only">Actions</span>
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {received.map((payment) => (
              <tr key={payment.id}>
                <td>{payment.receipt_no || "—"}</td>
                <td>{modeText(payment)}</td>
                <td className="bc-num">{fromPaise(payment.amount)}</td>
                <td>
                  {timeOf(payment.received_at)}
                  {payment.received_by_name ? ` · ${payment.received_by_name}` : ""}
                </td>
                {correctable && (
                  <td>
                    {payment.can_correct && open !== payment.id && (
                      <button
                        type="button"
                        className="st-btn st-btn-g"
                        onClick={() => setOpen(payment.id)}
                        aria-label={`${isHealthray(payment) ? "Update mode of" : "Correct"} ${fromPaise(payment.amount)} ${paymentModeText(payment.mode)} payment`}
                      >
                        {isHealthray(payment) ? "Update mode" : "Correct mode"}
                      </button>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {received
        .filter((payment) => payment.id === open)
        .map((payment) => (
          <CorrectForm
            key={payment.id}
            bill={bill}
            payment={payment}
            onDone={() => setOpen(null)}
            onCancel={() => setOpen(null)}
          />
        ))}
    </section>
  );
}
