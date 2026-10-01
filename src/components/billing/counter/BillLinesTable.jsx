import { useEffect, useState } from "react";
import ConfirmModal from "../../ui/ConfirmModal";
import {
  useChangeLineQuantity,
  useRemoveBillLine,
  useSetLinePrice,
} from "../../../queries/hooks/useBilling";
import useAuthStore from "../../../stores/authStore";
import { CAPABILITIES, hasCapability } from "../../../../shared/permissions.js";
import { errorOf, fromPaise, moneyTyped } from "../format";
import { ORDER_STATE_NOTE, orderStateText, paymentRuleText } from "./lineText";

function QuantityCell({ bill, line, locked, onBill, onError }) {
  const change = useChangeLineQuantity();
  const [value, setValue] = useState(String(line.quantity));

  useEffect(() => setValue(String(line.quantity)), [line.quantity]);

  if (bill.status !== "draft" || !line.allow_quantity || locked)
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

function PriceNote({ line, mayChange, onChange }) {
  if (!line.price_per_patient) return null;
  return (
    <div className="bc-hint bc-line-price">
      {line.agreed_rate === null
        ? line.rate > 0
          ? "Category rate for this patient"
          : "Needs this patient's price"
        : `Price for this patient${line.agreed_by_name ? ` · set by ${line.agreed_by_name}` : ""}`}
      {mayChange && (
        <>
          {" "}
          <button type="button" className="st-btn st-btn-g" onClick={onChange}>
            Change price
          </button>
        </>
      )}
    </div>
  );
}

export default function BillLinesTable({ bill, onBill, form }) {
  const remove = useRemoveBillLine();
  const setPrice = useSetLinePrice();
  const me = useAuthStore((st) => st.currentDoctor);
  const admin = hasCapability(me?.role, CAPABILITIES.ADMIN);
  const [pricing, setPricing] = useState(null);
  const mayChangePrice = (line) => line.agreed_rate === null || line.agreed_by === me?.id || admin;
  const mayRemove = (line) => line.source !== "ordered" || line.added_by === me?.id || admin;
  const ordered = (line) => line?.source === "ordered";
  const removing = form.value.removing;
  const going = removing ? bill.lines.find((line) => line.id === removing.lineId) || null : null;
  const reason = going ? removing.reason : "";
  const setReason = (next) => form.set("removing", (was) => was && { ...was, reason: next });
  const [error, setError] = useState(null);
  const atReception = bill.lines.filter((line) => line.order_state);
  const receptionWay =
    bill.status === "draft"
      ? "remove it from this bill"
      : "cancel this bill and bill it again without it";

  const savePrice = async () => {
    setError(null);
    try {
      onBill(
        await setPrice.mutateAsync({
          billId: bill.id,
          visitId: bill.visit_id,
          lineId: pricing.line.id,
          agreed_rate: pricing.rate.trim(),
          reason: pricing.reason.trim(),
        }),
      );
      setPricing(null);
    } catch (e) {
      setError(errorOf(e, "That price could not be saved"));
    }
  };

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
      form.drop("removing");
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
                    {line.source === "lab_case" && (
                      <>
                        {" "}
                        <span className="badge b-blu">from lab report</span>
                      </>
                    )}
                    {line.order_state && (
                      <>
                        {" "}
                        <span className="badge b-amb">{orderStateText(line.order_state)}</span>
                      </>
                    )}
                    {ordered(line) && (
                      <>
                        {" "}
                        <span className="badge b-blu">
                          ordered{line.added_by_name ? ` by ${line.added_by_name}` : ""}
                        </span>
                      </>
                    )}
                    <PriceNote
                      line={line}
                      mayChange={bill.status === "draft" && mayChangePrice(line)}
                      onChange={() => {
                        setError(null);
                        setPricing({
                          line,
                          rate: line.agreed_rate === null ? "" : String(line.agreed_rate / 100),
                          reason: "",
                        });
                      }}
                    />
                  </td>
                  <td data-label="Bill code">{line.bill_code || "—"}</td>
                  <QuantityCell
                    bill={bill}
                    line={line}
                    locked={!mayRemove(line)}
                    onBill={onBill}
                    onError={setError}
                  />
                  <td data-label="Actual">{fromPaise(line.actual)}</td>
                  <td data-label="Discount">{fromPaise(line.discount)}</td>
                  <td data-label="Payment rule">{paymentRuleText(line.payment_rule)}</td>
                  <td data-label="Patient pays">{fromPaise(line.patient_payable)}</td>
                  <td data-label="" className="bc-cell-actions">
                    {bill.status === "draft" && mayRemove(line) && (
                      <button
                        type="button"
                        className="st-btn st-btn-red"
                        aria-label={`Remove ${line.bill_name}`}
                        onClick={() => {
                          setError(null);
                          form.set("removing", { lineId: line.id, reason: "" });
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
        message={
          <label className="bc-field">
            <span className="bc-field__lbl">
              Why is this line being removed? {ordered(going) ? "(required)" : "(optional)"}
            </span>
            <textarea
              className="bc-field__in"
              rows={2}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </label>
        }
        confirmDisabled={ordered(going) && !reason.trim()}
        onConfirm={drop}
        onCancel={() => form.drop("removing")}
      />

      <ConfirmModal
        open={!!pricing}
        title={pricing ? `Price of ${pricing.line.bill_name} for this patient` : ""}
        confirmLabel="Save price"
        variant="primary"
        busy={setPrice.isPending}
        error={error}
        confirmDisabled={!pricing?.rate.trim() || !pricing?.reason.trim()}
        message={
          pricing && (
            <>
              <label className="bc-field">
                <span className="bc-field__lbl">Price ₹</span>
                <input
                  className="bc-field__in"
                  inputMode="decimal"
                  value={pricing.rate}
                  onChange={(e) => setPricing({ ...pricing, rate: moneyTyped(e.target.value) })}
                />
              </label>
              <label className="bc-field">
                <span className="bc-field__lbl">Why is the price changing?</span>
                <textarea
                  className="bc-field__in"
                  rows={2}
                  value={pricing.reason}
                  onChange={(e) => setPricing({ ...pricing, reason: e.target.value })}
                />
              </label>
            </>
          )
        }
        onConfirm={savePrice}
        onCancel={() => setPricing(null)}
      />
    </section>
  );
}
