import { useEffect, useState } from "react";
import ConfirmModal from "../../ui/ConfirmModal";
import { useChangeLineQuantity, useRemoveBillLine } from "../../../queries/hooks/useBilling";
import { errorOf, fromPaise } from "../format";
import { ORDER_STATE_NOTE, orderStateText, paymentRuleText } from "./lineText";

function QuantityCell({ bill, line, onBill, onError }) {
  const change = useChangeLineQuantity();
  const [value, setValue] = useState(String(line.quantity));

  useEffect(() => setValue(String(line.quantity)), [line.quantity]);

  if (bill.status !== "draft" || !line.allow_quantity)
    return <td data-label="Qty">{line.quantity}</td>;

  const commit = async () => {
    const quantity = Number(value);
    if (!Number.isInteger(quantity) || quantity === line.quantity) {
      setValue(String(line.quantity));
      return;
    }
    try {
      onBill(
        await change.mutateAsync({
          billId: bill.id,
          visitId: bill.visit_id,
          lineId: line.id,
          quantity,
        }),
      );
    } catch (e) {
      setValue(String(line.quantity));
      onError(errorOf(e, "That quantity could not be changed"));
    }
  };

  return (
    <td data-label="Qty">
      <span className="sr-only">{line.quantity}</span>
      <input
        className="bc-qty"
        type="number"
        min="1"
        max={line.max_quantity ?? undefined}
        value={value}
        aria-label={`Quantity for ${line.bill_name}`}
        disabled={change.isPending}
        onChange={(e) => setValue(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
      />
    </td>
  );
}

export default function BillLinesTable({ bill, onBill }) {
  const remove = useRemoveBillLine();
  const [going, setGoing] = useState(null);
  const [reason, setReason] = useState("");
  const [error, setError] = useState(null);
  const atReception = bill.lines.filter((line) => line.order_state);
  const receptionWay =
    bill.status === "draft"
      ? "remove it from this bill"
      : "cancel this bill and bill it again without it";

  const drop = async () => {
    setError(null);
    try {
      onBill(
        await remove.mutateAsync({
          billId: bill.id,
          visitId: bill.visit_id,
          lineId: going.id,
          reason: reason.trim(),
        }),
      );
      setGoing(null);
      setReason("");
    } catch (e) {
      setError(errorOf(e, "That line could not be removed"));
    }
  };

  return (
    <section className="bc-card" aria-label="Bill lines">
      <h3 className="bc-card__title">
        This bill{bill.bill_no ? ` · ${bill.bill_no}` : " · draft"}
      </h3>
      {!bill.lines.length ? (
        <div className="empty-note">Nothing on this bill yet.</div>
      ) : (
        <div className="ltablewrap bc-stack">
          <table className="ltable" aria-label="Bill lines">
            <thead>
              <tr>
                <th>Item</th>
                <th>Bill code</th>
                <th>Qty</th>
                <th>Actual</th>
                <th>Discount</th>
                <th>Payment rule</th>
                <th>Patient pays</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {bill.lines.map((line) => (
                <tr key={line.id}>
                  <td data-label="Item">
                    {line.bill_name}
                    {line.order_state && (
                      <>
                        {" "}
                        <span className="badge b-amb">{orderStateText(line.order_state)}</span>
                      </>
                    )}
                  </td>
                  <td data-label="Bill code">{line.bill_code || "—"}</td>
                  <QuantityCell bill={bill} line={line} onBill={onBill} onError={setError} />
                  <td data-label="Actual">{fromPaise(line.actual)}</td>
                  <td data-label="Discount">{fromPaise(line.discount)}</td>
                  <td data-label="Payment rule">{paymentRuleText(line.payment_rule)}</td>
                  <td data-label="Patient pays">{fromPaise(line.patient_payable)}</td>
                  <td data-label="" className="bc-cell-actions">
                    {bill.status === "draft" && (
                      <button
                        type="button"
                        className="st-btn st-btn-red"
                        aria-label={`Remove ${line.bill_name}`}
                        onClick={() => {
                          setError(null);
                          setReason("");
                          setGoing(line);
                        }}
                      >
                        Remove
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {atReception.map((line) => (
        <div className="bc-hint" role="note" key={line.id}>
          {line.bill_name} {ORDER_STATE_NOTE[line.order_state]} — {receptionWay}.
        </div>
      ))}
      {error && <div className="bc-err">{error}</div>}

      <ConfirmModal
        open={!!going}
        title={going ? `Remove ${going.bill_name}?` : ""}
        confirmLabel="Remove line"
        busy={remove.isPending}
        error={error}
        confirmDisabled={!reason.trim()}
        message={
          <label className="bc-field">
            <span className="bc-field__lbl">Why is this line being removed?</span>
            <textarea
              className="bc-field__in"
              rows={2}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </label>
        }
        onConfirm={drop}
        onCancel={() => setGoing(null)}
      />
    </section>
  );
}
