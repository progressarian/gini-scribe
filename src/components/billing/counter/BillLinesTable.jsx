import { useEffect, useState } from "react";
import ConfirmModal from "../../ui/ConfirmModal";
import { useChangeLineQuantity, useRemoveBillLine } from "../../../queries/hooks/useBilling";
import { errorOf, fromPaise } from "../format";
import { paymentRuleText } from "./lineText";

function QuantityCell({ bill, line, onBill, onError }) {
  const change = useChangeLineQuantity();
  const [value, setValue] = useState(String(line.quantity));

  useEffect(() => setValue(String(line.quantity)), [line.quantity]);

  if (bill.status !== "draft" || !line.allow_quantity) return <td>{line.quantity}</td>;

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
    <td>
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
        <div className="ltablewrap">
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
                  <td>{line.bill_name}</td>
                  <td>{line.bill_code || "—"}</td>
                  <QuantityCell bill={bill} line={line} onBill={onBill} onError={setError} />
                  <td>{fromPaise(line.actual)}</td>
                  <td>{fromPaise(line.discount)}</td>
                  <td>{paymentRuleText(line.payment_rule)}</td>
                  <td>{fromPaise(line.patient_payable)}</td>
                  <td>
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
