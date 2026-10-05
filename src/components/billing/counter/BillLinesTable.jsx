import { useEffect, useState } from "react";
import { Pencil, Plus, Trash2 } from "lucide-react";
import ConfirmModal from "../../ui/ConfirmModal";
import {
  useChangeLineQuantity,
  useRemoveBillLine,
  useSetLineDiscount,
  useSetLinePrice,
} from "../../../queries/hooks/useBilling";
import useAuthStore from "../../../stores/authStore";
import { CAPABILITIES, hasCapability } from "../../../../shared/permissions.js";
import { errorOf, fromPaise, moneyTyped } from "../format";
import { ORDER_STATE_NOTE, orderStateText, paymentRuleText } from "./lineText";
import { ITEM_SEARCH_ID } from "./AddItems";
import { discountNote } from "./ManualDiscountFields";

function QuantityCell({ bill, line, locked, onBill, onError }) {
  const change = useChangeLineQuantity();
  const [value, setValue] = useState(String(line.quantity));

  useEffect(() => setValue(String(line.quantity)), [line.quantity]);

  if (bill.status !== "draft" || !line.allow_quantity || locked)
    return (
      <td data-label="Qty" className="bc-num">
        {line.quantity}
      </td>
    );

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
    <td data-label="Qty" className="bc-num">
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

function priceNoteText(line) {
  if (line.agreed_rate === null) {
    return line.rate > 0 ? "Category rate for this patient" : "Needs this patient's price";
  }
  if (!line.agreed_by) return "Price from HealthRay bill";
  return `Price for this patient${line.agreed_by_name ? ` · set by ${line.agreed_by_name}` : ""}`;
}

const manualValue = (line) => (line.manual_discount ? String(line.manual_discount.value) : "");

function DiscountCell({ bill, line, onBill, onError }) {
  const save = useSetLineDiscount();
  const [kind, setKind] = useState(line.manual_discount?.kind ?? "percent");
  const [value, setValue] = useState(manualValue(line));

  useEffect(() => {
    setKind(line.manual_discount?.kind ?? "percent");
    setValue(manualValue(line));
  }, [line.manual_discount?.kind, line.manual_discount?.value]);

  if (bill.status !== "draft") {
    return (
      <td data-label="Discount" className="bc-num">
        {fromPaise(line.discount)}
      </td>
    );
  }

  const commit = async (nextKind, nextValue) => {
    const number = Number(nextValue || 0);
    const current = line.manual_discount;
    const unchanged = current
      ? current.kind === nextKind && current.value === number
      : number === 0;
    if (unchanged) return;
    if (!Number.isFinite(number) || number < 0 || (nextKind === "percent" && number > 100)) {
      onError(
        nextKind === "percent"
          ? "A percent discount must be between 0 and 100"
          : "Enter the discount in ₹",
      );
      setKind(current?.kind ?? "percent");
      setValue(manualValue(line));
      return;
    }
    try {
      onBill(
        await save.mutateAsync({
          billId: bill.id,
          visitId: bill.visit_id,
          lineId: line.id,
          kind: nextKind,
          value: number,
        }),
      );
    } catch (e) {
      setKind(current?.kind ?? "percent");
      setValue(manualValue(line));
      onError(errorOf(e, "That discount could not be saved"));
    }
  };

  return (
    <td data-label="Discount" className="bc-num">
      <span className="bc-ldisc">
        <select
          className="bc-ldisc__kind"
          aria-label={`Discount type for ${line.bill_name}`}
          value={kind}
          disabled={save.isPending}
          onChange={(e) => {
            setKind(e.target.value);
            if (value.trim()) commit(e.target.value, value);
          }}
        >
          <option value="percent">%</option>
          <option value="flat">₹</option>
        </select>
        <input
          className="bc-ldisc__value"
          inputMode="decimal"
          placeholder="0"
          aria-label={`Discount for ${line.bill_name}`}
          value={value}
          disabled={save.isPending}
          onChange={(e) => setValue(moneyTyped(e.target.value))}
          onBlur={() => commit(kind, value)}
          onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
        />
      </span>
      {line.discount > 0 && <span className="bc-ldisc__taken">−{fromPaise(line.discount)}</span>}
    </td>
  );
}

function PriceNote({ line }) {
  if (!line.price_per_patient && line.agreed_rate === null) return null;
  return <div className="bc-hint bc-line-price">{priceNoteText(line)}</div>;
}

const RADIOLOGY = /radio|x-?ray|ultra|usg|scan|echo|imaging/i;

function categoryOf(line) {
  if (line.item_kind === "consultation")
    return { tone: "cons", label: "Consultation", noun: "consultation" };
  if (line.item_kind === "test") {
    return RADIOLOGY.test(line.group_name || "")
      ? { tone: "rad", label: "Radiology", noun: "radiology test" }
      : { tone: "lab", label: "Lab", noun: "lab test" };
  }
  if (line.item_kind === "procedure")
    return { tone: "proc", label: "Procedure", noun: "procedure" };
  return { tone: "other", label: "Other", noun: "other item" };
}

const counted = (count, noun) => `${count} ${noun}${count === 1 ? "" : "s"}`;

function includesText(lines) {
  const counts = new Map();
  for (const line of lines) {
    const { noun } = categoryOf(line);
    counts.set(noun, (counts.get(noun) || 0) + 1);
  }
  const parts = [...counts].map(([noun, count]) => counted(count, noun));
  const listed =
    parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}` : parts[0];
  return `This bill includes ${listed}.`;
}

function LineActions({ actions }) {
  return (
    <div className="bc-line-acts">
      {actions.map((action) => (
        <button
          key={action.label}
          type="button"
          className={action.danger ? "bc-icon-btn bc-icon-btn--danger" : "bc-icon-btn"}
          aria-label={action.aria}
          title={action.label}
          onClick={action.run}
        >
          <action.Icon size={16} aria-hidden="true" />
        </button>
      ))}
    </div>
  );
}

const focusItemSearch = () => {
  const input = document.getElementById(ITEM_SEARCH_ID);
  input?.scrollIntoView({ block: "center", behavior: "smooth" });
  input?.focus({ preventScroll: true });
};

const openItemSearch = (form) => {
  form.set("addOpen", true);
  requestAnimationFrame(() => requestAnimationFrame(focusItemSearch));
};

export default function BillLinesTable({ bill, onBill, form }) {
  const remove = useRemoveBillLine();
  const setPrice = useSetLinePrice();
  const me = useAuthStore((st) => st.currentDoctor);
  const admin = hasCapability(me?.role, CAPABILITIES.ADMIN);
  const [pricing, setPricing] = useState(null);
  const mayChangePrice = (line) =>
    line.agreed_rate === null || !line.agreed_by || line.agreed_by === me?.id || admin;
  const mayRemove = (line) => line.source !== "ordered" || line.added_by === me?.id || admin;
  const ordered = (line) => line?.source === "ordered";
  const removing = form.value.removing;
  const going = removing ? bill.lines.find((line) => line.id === removing.lineId) || null : null;
  const reason = going ? removing.reason : "";
  const setReason = (next) => form.set("removing", (was) => was && { ...was, reason: next });
  const [error, setError] = useState(null);
  const final = bill.status !== "draft";
  const atReception = final ? bill.lines.filter((line) => line.order_state) : [];

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

  const actionsFor = (line) =>
    bill.status !== "draft"
      ? []
      : [
          (line.price_per_patient || line.agreed_rate !== null) &&
            mayChangePrice(line) && {
              label: "Change price",
              Icon: Pencil,
              aria: `Change price of ${line.bill_name}`,
              run: () => {
                setError(null);
                setPricing({
                  line,
                  rate: line.agreed_rate === null ? "" : String(line.agreed_rate / 100),
                  reason: "",
                });
              },
            },
          mayRemove(line) && {
            label: "Remove",
            Icon: Trash2,
            aria: `Remove ${line.bill_name}`,
            danger: true,
            run: () => {
              setError(null);
              form.set("removing", { lineId: line.id, reason: "" });
            },
          },
        ].filter(Boolean);

  return (
    <section className="bc-card bc-items" aria-label="Bill lines">
      <div className="bc-card__bar">
        <h3 className="bc-card__heading">
          Bill Items
          <span className="bc-card__sub">{bill.bill_no || "Draft"}</span>
        </h3>
        {bill.status === "draft" && (
          <button type="button" className="bc-addbtn" onClick={() => openItemSearch(form)}>
            <Plus size={15} aria-hidden="true" />
            Add Service/Test
          </button>
        )}
      </div>
      {!bill.lines.length ? (
        <div className="empty-note">Nothing on this bill yet.</div>
      ) : (
        <>
          <div className="ltablewrap bc-stack">
            <table className="ltable bc-itable" aria-label="Bill lines">
              <thead>
                <tr>
                  <th className="bc-lineno">#</th>
                  <th>Service / Test</th>
                  <th>Category</th>
                  <th className="bc-num">Qty</th>
                  <th className="bc-num">Rate (₹)</th>
                  <th className="bc-num">Discount</th>
                  <th className="bc-num">Patient Pays (₹)</th>
                  <th>
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {bill.lines.map((line, index) => {
                  const category = categoryOf(line);
                  return (
                    <tr key={line.id}>
                      <th scope="row" className="bc-lineno">
                        {index + 1}
                      </th>
                      <td data-label="Service / Test">
                        <div className="bc-item__name">{line.bill_name}</div>
                        <div className="bc-item__sub">
                          {[
                            line.bill_code,
                            line.payment_rule &&
                              line.payment_rule !== "full" &&
                              paymentRuleText(line.payment_rule),
                          ]
                            .filter(Boolean)
                            .join(" · ")}
                        </div>
                        {line.source === "lab_case" && (
                          <span className="badge b-blu">from lab report</span>
                        )}
                        {final && line.order_state && (
                          <span className="badge b-amb">{orderStateText(line.order_state)}</span>
                        )}
                        {ordered(line) && (
                          <span className="badge b-blu">
                            ordered{line.added_by_name ? ` by ${line.added_by_name}` : ""}
                          </span>
                        )}
                        <PriceNote line={line} />
                        {line.manual_discount && (
                          <div className="bc-hint bc-line-price">
                            Discount {discountNote(line.manual_discount)}
                          </div>
                        )}
                      </td>
                      <td data-label="Category">
                        <span className={`bc-cat bc-cat--${category.tone}`}>{category.label}</span>
                      </td>
                      <QuantityCell
                        bill={bill}
                        line={line}
                        locked={!mayRemove(line)}
                        onBill={onBill}
                        onError={setError}
                      />
                      <td data-label="Rate" className="bc-num">
                        {fromPaise(line.rate)}
                      </td>
                      <DiscountCell bill={bill} line={line} onBill={onBill} onError={setError} />
                      <td data-label="Patient pays" className="bc-num bc-num--strong">
                        {fromPaise(line.patient_payable)}
                      </td>
                      <td data-label="" className="bc-cell-actions">
                        <LineActions actions={actionsFor(line)} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="bc-items__info">{includesText(bill.lines)}</p>
          <div className="bc-items__total">
            <span>Total (Patient Payable)</span>
            <strong>{fromPaise(bill.totals.payable)}</strong>
          </div>
        </>
      )}
      {atReception.map((line) => (
        <div className="bc-hint" role="note" key={line.id}>
          {line.bill_name} {ORDER_STATE_NOTE[line.order_state]} — cancel this bill and bill it again
          without it.
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
