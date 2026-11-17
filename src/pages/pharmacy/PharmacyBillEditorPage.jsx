import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, HandCoins, Printer, Trash2, Undo2 } from "lucide-react";
import ReturnDialog from "../../components/pharmacy/ReturnDialog";
import { AskCreditDialog, CollectDueDialog } from "../../components/pharmacy/CreditDialogs";
import useAuthStore from "../../stores/authStore";
import { CAPABILITIES, hasCapability } from "../../../shared/permissions";
import { useWithdrawCredit } from "../../queries/hooks/usePharmacyCredit";
import { toPaise, toRupees } from "../../../shared/pharmacyMoney";
import { PdfButton } from "../../components/billing/counter/PdfViewer";
import api from "../../services/api";
import { requestErrorOf } from "../../components/billing/format";
import ConfirmModal from "../../components/ui/ConfirmModal";
import MedicinePicker from "../../components/pharmacy/MedicinePicker";
import BatchPickerDialog from "../../components/pharmacy/BatchPickerDialog";
import { SelectInput } from "../../components/pharmacy/Fields";
import BillPayments, {
  firstPayment,
  paymentProblems,
  paymentsForApi,
} from "../../components/pharmacy/BillPayments";
import { inr, packUnits, showDate } from "../../components/pharmacy/format";
import { toast } from "../../stores/uiStore";
import { batchKeys, useBatchStock } from "../../queries/hooks/usePharmacyBatches";
import {
  pharmacyBillPdfUrl,
  useBill,
  useDiscardBill,
  useFinaliseBill,
  useBillPrescription,
  useBillReturns,
  useSaveBill,
} from "../../queries/hooks/usePharmacyBills";
import {
  BILL_STATUS_LABEL,
  PAYMENT_MODE_LABEL,
  PAYMENT_MODE_TEXT,
  SALE_TYPE_LABEL,
  SCHEDULE_LABEL,
  WALKIN_REGISTRATION_SOURCE,
} from "../../../shared/pharmacyVocab";
import { UPI_APP_LABEL } from "../../../shared/billingVocab";
import "../../styles/flow.css";
import "../flow/FlowSettings.css";
import "../billing/billing.css";
import "../billing/billingUi.css";
import "./pharmacyStock.css";
import "./pharmacyVendors.css";
import "./pharmacyBills.css";

const BADGE = { draft: "review", final: "ok", due: "out", cancelled: "out" };

export function BillStatus({ status, due = 0 }) {
  const shown = status === "final" && Number(due) > 0 ? "due" : status;
  return (
    <span className={`bill-status phs-badge phs-badge--${BADGE[shown]}`}>
      {BILL_STATUS_LABEL[shown]}
    </span>
  );
}

const useStockOptions = (q) => {
  const search = useBatchStock({ q, filter: "in_stock", limit: 10 }, { enabled: Boolean(q) });
  return { ...search, options: search.data?.rows ?? [] };
};

const describeStock = (m) =>
  [
    m.code,
    `${packUnits(m.sellable_units, m)} in stock`,
    m.batches[0]?.rack_no && `Rack ${m.batches[0].rack_no}`,
  ]
    .filter(Boolean)
    .join(" · ");

const lineInput = (l) => ({
  batch_id: l.batch_id,
  qty_units: l.qty_units,
  near_expiry_ok: l.near_expiry_ok,
  discount_pct: Number(l.discount_pct ?? 0),
});

const pctTyped = (v) => {
  const clean = v.replace(/[^\d.]/g, "");
  const [whole, ...rest] = clean.split(".");
  return rest.length ? `${whole.slice(0, 3)}.${rest.join("").slice(0, 2)}` : whole.slice(0, 3);
};

const lineDiscount = (l) => Number(l.discount_amount ?? 0) + Number(l.bill_discount ?? 0);

function DiscountInput({ line, busy, onSave }) {
  const saved = String(Number(line.discount_pct ?? 0) || "");
  const [value, setValue] = useState(saved);
  useEffect(() => setValue(saved), [saved]);
  const commit = () => {
    if (value === saved || (value === "" && saved === "")) return;
    onSave(line, value === "" ? 0 : Number(value));
  };
  return (
    <input
      className="jb-assign phb-qty"
      inputMode="decimal"
      maxLength={6}
      placeholder="0"
      aria-label={`Discount % for ${line.medicine_name} batch ${line.batch_no}`}
      disabled={busy}
      value={value}
      onChange={(e) => setValue(pctTyped(e.target.value))}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          commit();
        }
      }}
    />
  );
}

function PatientStrip({ bill }) {
  return (
    <dl className="adj-facts phb-patient-strip" aria-label="Patient and sale">
      <div>
        <dt>Patient</dt>
        <dd>
          <strong>{bill.patient_name}</strong>
          {bill.patient_source === WALKIN_REGISTRATION_SOURCE ? (
            <span className="phb-tag">Walk-in</span>
          ) : null}
        </dd>
      </div>
      <div>
        <dt>File number</dt>
        <dd className="phv-mono">{bill.patient_file_no ?? "—"}</dd>
      </div>
      <div>
        <dt>Account</dt>
        <dd>
          <Link className="phs-item" to={`/pharmacy/accounts/${bill.patient_id}`}>
            {Number(bill.patient_balance) > 0
              ? `Deposit ${inr(bill.patient_balance)}`
              : "Open account"}
          </Link>
        </dd>
      </div>
      {Number(bill.patient_due) > 0 ? (
        <div>
          <dt>Pharmacy due</dt>
          <dd className="phb-due">{inr(bill.patient_due)}</dd>
        </div>
      ) : null}
      <div>
        <dt>Mobile</dt>
        <dd>{bill.patient_phone ?? "—"}</dd>
      </div>
      <div>
        <dt>Age / sex</dt>
        <dd>{[bill.patient_age, bill.patient_sex].filter(Boolean).join(" / ") || "—"}</dd>
      </div>
      <div>
        <dt>Sale type</dt>
        <dd>
          {SALE_TYPE_LABEL[bill.sale_type]}
          {bill.ipd_number ? ` · ${bill.ipd_number}` : ""}
        </dd>
      </div>
      {bill.prescriber_name ? (
        <div>
          <dt>Prescribed by</dt>
          <dd>{bill.prescriber_name}</dd>
        </div>
      ) : null}
    </dl>
  );
}

function LinesTable({ bill, onChange, onRemove, onDiscount, busy }) {
  const editable = Boolean(onChange);
  const showDiscount = editable || bill.lines.some((l) => lineDiscount(l) > 0);
  return (
    <div className="fset__scroll">
      <table className="flow-table phs-table phb-lines" aria-label="Medicines on this bill">
        <thead>
          <tr>
            <th>Medicine</th>
            <th>Batch · expiry · rack</th>
            <th className="phs-num">Quantity</th>
            <th className="phs-num">Rate / pack</th>
            {showDiscount ? <th className="phs-num">Disc %</th> : null}
            <th className="phs-num">GST</th>
            <th className="phs-num">Amount</th>
            {editable ? <th aria-label="Actions" /> : null}
          </tr>
        </thead>
        <tbody>
          {bill.lines.map((l) => (
            <tr key={l.id}>
              <td data-label="Medicine">
                <span className="phs-item">{l.medicine_name}</span>
                {l.schedule && l.schedule !== "none" ? (
                  <span className="bill-status phs-badge phs-badge--review">
                    {SCHEDULE_LABEL[l.schedule] ?? l.schedule}
                  </span>
                ) : null}
                {l.hsn_code ? <span className="phs-meta">HSN {l.hsn_code}</span> : null}
              </td>
              <td data-label="Batch">
                <span className="phv-mono">{l.batch_no}</span>
                <span className="phs-meta">
                  Exp {showDate(l.expiry_date)}
                  {l.rack_no ? ` · Rack ${l.rack_no}` : ""}
                  {l.near_expiry_ok ? " · near expiry" : ""}
                </span>
              </td>
              <td data-label="Quantity" className="phs-num">
                {packUnits(l.qty_units, l)}
                <span className="phs-meta">
                  {l.qty_units} {l.unit_label}
                </span>
              </td>
              <td data-label="Rate / pack" className="phs-num">
                {inr(l.pack_sale_rate)}
                <span className="phs-meta">MRP {inr(l.pack_mrp)}</span>
              </td>
              {showDiscount ? (
                <td data-label="Disc %" className="phs-num">
                  {editable ? (
                    <DiscountInput line={l} busy={busy} onSave={onDiscount} />
                  ) : Number(l.discount_pct) ? (
                    `${Number(l.discount_pct)}%`
                  ) : (
                    "—"
                  )}
                  {lineDiscount(l) > 0 ? (
                    <span className="phs-meta">−{inr(lineDiscount(l))}</span>
                  ) : null}
                </td>
              ) : null}
              <td data-label="GST" className="phs-num">
                {Number(l.tax_rate_pct) ? `${Number(l.tax_rate_pct)}%` : "0%"}
                {Number(l.folded_gst) ? (
                  <span className="phs-meta">{Number(l.gst_rate_pct)}% in rate</span>
                ) : null}
              </td>
              <td data-label="Amount" className="phs-num">
                {inr(l.total)}
                {l.mrp_capped ? <span className="phs-meta">Capped at MRP</span> : null}
              </td>
              {editable ? (
                <td className="phb-line-acts">
                  <button
                    type="button"
                    className="flow-btn flow-btn-ghost"
                    disabled={busy}
                    onClick={() => onChange(l)}
                  >
                    Change
                  </button>
                  <button
                    type="button"
                    className="flow-btn flow-btn-ghost"
                    aria-label={`Remove ${l.medicine_name} batch ${l.batch_no}`}
                    disabled={busy}
                    onClick={() => onRemove(l)}
                  >
                    <Trash2 size={14} aria-hidden="true" />
                  </button>
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function BillDiscount({ bill, busy, onApply }) {
  const [kind, setKind] = useState(bill.discount_kind ?? "percent");
  const [value, setValue] = useState(
    bill.discount_value ? String(Number(bill.discount_value)) : "",
  );
  const max = bill.max_discount_pct === null ? null : Number(bill.max_discount_pct);
  const number = Number(value || 0);
  const tooMuch = kind === "percent" ? number > 100 || (max !== null && number > max) : false;
  const changed =
    (bill.discount_kind ?? null) !== (number ? kind : null) ||
    Number(bill.discount_value ?? 0) !== number;
  return (
    <fieldset className="phb-fieldset phb-billdisc">
      <legend>Bill discount</legend>
      <div className="phb-billdisc__row">
        <label className="sr-only" htmlFor="phb-disc-kind" id="phb-disc-kind-label">
          Discount as
        </label>
        <SelectInput
          id="phb-disc-kind"
          className="phb-disc-kind"
          value={kind}
          disabled={busy}
          onChange={setKind}
          options={[
            { value: "percent", label: "%" },
            { value: "amount", label: "₹" },
          ]}
        />
        <label className="sr-only" htmlFor="phb-disc-value">
          Bill discount
        </label>
        <input
          id="phb-disc-value"
          className="jb-assign phs-num"
          inputMode="decimal"
          maxLength={kind === "percent" ? 6 : 12}
          placeholder="0"
          disabled={busy}
          aria-invalid={tooMuch || undefined}
          value={value}
          onChange={(e) =>
            setValue(
              kind === "percent" ? pctTyped(e.target.value) : e.target.value.replace(/[^\d.]/g, ""),
            )
          }
        />
        <button
          type="button"
          className="flow-btn flow-btn-ghost"
          disabled={busy || tooMuch || !changed}
          onClick={() => onApply(number ? kind : null, number || null)}
        >
          {number ? "Apply" : "Remove"}
        </button>
      </div>
      <p className={`phs-meta${tooMuch ? " form-field__error" : ""}`}>
        {tooMuch
          ? `The most allowed is ${max ?? 100}%.`
          : max !== null
            ? `Up to ${max}% per item and on the whole bill.`
            : "Type a % or an amount off the whole bill. Each line can also have its own %."}
      </p>
    </fieldset>
  );
}

function BillTotals({ bill }) {
  const folded = bill.gst_folded;
  return (
    <dl className="phb-totals" aria-label="Bill totals">
      {Number(bill.discount_amount) > 0 ? (
        <div>
          <dt>
            Discount
            {bill.discount_kind === "percent"
              ? ` (incl. ${Number(bill.discount_value)}% on the bill)`
              : bill.discount_kind === "amount"
                ? ` (incl. ${inr(bill.discount_value)} on the bill)`
                : ""}
          </dt>
          <dd>−{inr(bill.discount_amount)}</dd>
        </div>
      ) : null}
      <div>
        <dt>{folded ? "Amount (GST included in rates)" : "Taxable value"}</dt>
        <dd>{inr(bill.taxable_amount)}</dd>
      </div>
      {folded ? (
        <div className="phb-totals__note">
          <dt>GST inside the rates</dt>
          <dd>{inr(bill.folded_gst_amount)}</dd>
        </div>
      ) : (
        <>
          <div>
            <dt>CGST</dt>
            <dd>{inr(bill.cgst_amount)}</dd>
          </div>
          <div>
            <dt>SGST</dt>
            <dd>{inr(bill.sgst_amount)}</dd>
          </div>
        </>
      )}
      <div>
        <dt>Round off</dt>
        <dd>{inr(bill.round_off)}</dd>
      </div>
      <div className="phb-totals__net">
        <dt>Total</dt>
        <dd>{inr(bill.net_amount)}</dd>
      </div>
      {bill.status === "final" ? (
        <div>
          <dt>{bill.bill_type === "credit_note" ? "Refunded" : "Paid"}</dt>
          <dd>{inr(bill.paid_amount)}</dd>
        </div>
      ) : null}
      {Number(bill.due_adjusted) > 0 ? (
        <div>
          <dt>Taken off the due</dt>
          <dd>{inr(bill.due_adjusted)}</dd>
        </div>
      ) : null}
      {Number(bill.due_amount) > 0 ? (
        <div className="phb-totals__due">
          <dt>Due</dt>
          <dd>{inr(bill.due_amount)}</dd>
        </div>
      ) : null}
    </dl>
  );
}

function PaymentsReceived({ payments, refunded = false }) {
  const title = refunded ? "Refund paid" : "Payments received";
  return (
    <section className="flow-card" aria-labelledby="phb-paid-title">
      <h2 id="phb-paid-title" className="flow-sec-title">
        {title}
      </h2>
      <table className="flow-table phs-table" aria-label={title}>
        <thead>
          <tr>
            <th>Receipt</th>
            <th>Mode</th>
            <th>Reference</th>
            <th className="phs-num">Amount</th>
          </tr>
        </thead>
        <tbody>
          {payments.map((p) => (
            <tr key={p.id}>
              <td data-label="Receipt" className="phv-mono">
                {p.receipt_no ?? "—"}
              </td>
              <td data-label="Mode">
                {PAYMENT_MODE_TEXT[p.mode]}
                {p.upi_app ? ` · ${UPI_APP_LABEL[p.upi_app] ?? p.upi_app}` : ""}
              </td>
              <td data-label="Reference">{p.reference ?? "—"}</td>
              <td data-label="Amount" className="phs-num">
                {inr(p.amount)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

const rxText = (item) =>
  [item.medicine_name, item.dose, item.frequency, item.duration].filter(Boolean).join(" · ");

function PrescriptionPanel({ billId, busy, onAdd }) {
  const query = useBillPrescription(billId);
  const items = query.data?.items ?? [];
  if (query.isLoading) {
    return (
      <p className="phs-meta" role="status">
        Loading today's prescription…
      </p>
    );
  }
  if (query.isError) {
    return (
      <p className="bill-dialog__error" role="alert">
        Could not load today's prescription.{" "}
        <button type="button" className="flow-btn flow-btn-ghost" onClick={() => query.refetch()}>
          Try again
        </button>
      </p>
    );
  }
  if (!items.length) return null;
  return (
    <section className="flow-card" aria-labelledby="phb-rx-title">
      <div className="fset__cardhead">
        <h2 id="phb-rx-title" className="flow-sec-title">
          Today's prescription
        </h2>
        <span className="fset__count">{items.length}</span>
      </div>
      <ul className="phb-rx">
        {items.map((item) => (
          <li key={item.rx_item_id} className="phb-rx__item">
            <span className="phb-rx__text">
              <span className="phb-patient__name">{item.medicine_name}</span>
              <span className="phs-meta">
                {[item.dose, item.frequency, item.duration].filter(Boolean).join(" · ") ||
                  "No dose details"}
              </span>
            </span>
            <span className="phb-rx__stock">
              {!item.medicine ? (
                <span className="phs-meta">Not in the medicine list</span>
              ) : item.medicine.sellable_units ? (
                <span className="phs-meta">
                  {item.medicine.name} · {packUnits(item.medicine.sellable_units, item.medicine)} in
                  stock
                </span>
              ) : (
                <span className="bill-status phs-badge phs-badge--out">Out of stock</span>
              )}
            </span>
            {item.on_bill ? (
              <span className="bill-status phs-badge phs-badge--ok">On bill</span>
            ) : item.medicine?.sellable_units ? (
              <button
                type="button"
                className="flow-btn flow-btn-ghost"
                disabled={busy}
                aria-label={`Add ${item.medicine_name} to the bill`}
                onClick={() => onAdd(item)}
              >
                Add
                {item.suggested_units ? ` ${packUnits(item.suggested_units, item.medicine)}` : ""}
              </button>
            ) : (
              <span />
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function CreditPanel({ request, canAsk, busy, onAsk, onWithdraw }) {
  const open = ["pending", "approved"].includes(request?.status);
  if (!open) {
    return (
      <div className="phb-credit">
        {request?.status === "rejected" ? (
          <p className="phb-credit__note is-off" role="status">
            Credit refused by {request.decided_by_name ?? "the pharmacy admin"}:{" "}
            {request.decision_note}
          </p>
        ) : null}
        {canAsk ? (
          <button type="button" className="flow-btn flow-btn-ghost" disabled={busy} onClick={onAsk}>
            <HandCoins size={14} aria-hidden="true" />
            Patient cannot pay in full? Ask for credit
          </button>
        ) : null}
      </div>
    );
  }
  return (
    <div className={`phb-credit phb-credit--${request.status}`} role="status">
      <p className="phb-credit__note">
        {request.status === "pending"
          ? `Credit of ${inr(request.amount)} asked by ${request.requested_by_name ?? "the pharmacist"} is waiting for approval. The bill is locked until then.`
          : `Credit of ${inr(request.approved_amount)} approved by ${request.decided_by_name ?? "the pharmacy admin"}${
              request.decision_note ? ` (${request.decision_note})` : ""
            }. Collect the rest now; the credit is collected later.`}
      </p>
      <button
        type="button"
        className="flow-btn flow-btn-ghost"
        disabled={busy}
        onClick={onWithdraw}
      >
        {request.status === "pending" ? "Withdraw request" : "Withdraw credit and edit bill"}
      </button>
    </div>
  );
}

function DraftBill({ bill }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const save = useSaveBill();
  const finalise = useFinaliseBill();
  const discard = useDiscardBill();
  const [picking, setPicking] = useState(null);
  const [loadingMedicine, setLoadingMedicine] = useState(false);
  const [payments, setPayments] = useState(() => firstPayment(bill.net_amount));
  const [payTouched, setPayTouched] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [error, setError] = useState("");

  const [askingCredit, setAskingCredit] = useState(false);
  const role = useAuthStore((st) => st.currentDoctor?.role);
  const canAskCredit = hasCapability(role, CAPABILITIES.PHARMACY_CREDIT_REQUEST);
  const withdraw = useWithdrawCredit();
  const request = bill.credit;
  const creditOpen = ["pending", "approved"].includes(request?.status);
  const shortBy = request?.status === "approved" ? request.approved_amount : 0;
  const payNow = toRupees(toPaise(bill.net_amount) - toPaise(shortBy));

  useEffect(() => {
    setPayments((rows) =>
      rows.length === 1 ? [{ ...rows[0], amount: firstPayment(payNow)[0].amount }] : rows,
    );
  }, [payNow]);

  const busy =
    save.isPending ||
    finalise.isPending ||
    discard.isPending ||
    loadingMedicine ||
    withdraw.isPending;
  const locked = creditOpen;

  const doWithdraw = async () => {
    setError("");
    try {
      await withdraw.mutateAsync({ id: request.id });
      toast("Credit request withdrawn. The bill can be changed again.");
    } catch (err) {
      setError(requestErrorOf(err, "Could not withdraw the credit request"));
    }
  };

  const saveLines = async (lines, extra = {}) => {
    setError("");
    try {
      await save.mutateAsync({
        id: bill.id,
        version: bill.version,
        sale_type: bill.sale_type,
        ipd_number: bill.ipd_number,
        prescriber_name: bill.prescriber_name,
        lines,
        ...extra,
      });
      return true;
    } catch (err) {
      setError(requestErrorOf(err, "Could not update the bill"));
      return false;
    }
  };

  const openPicker = async (medicineId, from = {}) => {
    setError("");
    setLoadingMedicine(true);
    try {
      const params = { medicine_id: medicineId };
      const found = await queryClient.fetchQuery({
        queryKey: batchKeys.medicine(params),
        queryFn: async () => (await api.get("/api/pharmacy/batches", { params })).data,
        staleTime: 0,
      });
      setPicking({
        medicine: { ...found.medicine, batches: found.batches },
        warnDays: found.near_expiry_warn_days,
        ...from,
      });
    } catch (err) {
      setError(requestErrorOf(err, "Could not load the batches"));
    } finally {
      setLoadingMedicine(false);
    }
  };

  const currentFor = (medicine) =>
    Object.fromEntries(
      bill.lines
        .filter((l) => l.medicine_id === medicine.id)
        .map((l) => [l.batch_id, { qty_units: l.qty_units, near_expiry_ok: l.near_expiry_ok }]),
    );

  const apply = async (chosen) => {
    const medicineId = picking.medicine.id;
    const others = bill.lines.filter((l) => l.medicine_id !== medicineId).map(lineInput);
    const kept = new Map(
      bill.lines
        .filter((l) => l.medicine_id === medicineId)
        .map((l) => [l.batch_id, Number(l.discount_pct ?? 0)]),
    );
    const withDiscount = chosen.map((c) => ({ ...c, discount_pct: kept.get(c.batch_id) ?? 0 }));
    if (await saveLines([...others, ...withDiscount])) setPicking(null);
  };

  const setLineDiscount = (line, pct) =>
    saveLines(
      bill.lines.map((l) =>
        l.id === line.id ? { ...lineInput(l), discount_pct: pct } : lineInput(l),
      ),
    );

  const setBillDiscount = (kind, value) =>
    saveLines(bill.lines.map(lineInput), {
      discount_kind: kind,
      discount_value: kind ? value : null,
    });

  const remove = (line) => saveLines(bill.lines.filter((l) => l.id !== line.id).map(lineInput));

  const check = paymentProblems(payments, bill.net_amount, shortBy, bill.patient_balance);

  const askFinalise = () => {
    setPayTouched(true);
    setError("");
    if (!bill.lines.length) {
      setError("Add at least one medicine before finalising.");
      return;
    }
    if (!check.ok) return;
    setConfirming(true);
  };

  const doFinalise = async () => {
    setError("");
    try {
      const done = await finalise.mutateAsync({
        id: bill.id,
        version: bill.version,
        payments: paymentsForApi(payments),
      });
      setConfirming(false);
      toast(
        Number(done.due_amount)
          ? `Bill ${done.bill_no} saved. ${inr(done.paid_amount)} received, ${inr(done.due_amount)} due.`
          : `Bill ${done.bill_no} saved. ${inr(done.paid_amount)} received.`,
      );
    } catch (err) {
      setConfirming(false);
      setError(requestErrorOf(err, "Could not finalise the bill"));
    }
  };

  const doDiscard = async () => {
    try {
      await discard.mutateAsync({ id: bill.id, version: bill.version });
      toast("Draft bill discarded.");
      navigate("/pharmacy/billing");
    } catch (err) {
      setConfirmDiscard(false);
      setError(requestErrorOf(err, "Could not discard the draft"));
    }
  };

  return (
    <>
      {bill.visit_id ? (
        <PrescriptionPanel
          billId={bill.id}
          busy={busy || locked}
          onAdd={(item) =>
            openPicker(item.medicine.id, {
              suggested: item.suggested_units,
              prescribed: rxText(item),
            })
          }
        />
      ) : null}

      <section className="flow-card" aria-labelledby="phb-lines-title">
        <div className="fset__cardhead">
          <h2 id="phb-lines-title" className="flow-sec-title">
            Medicines
          </h2>
          <span className="fset__count">{bill.lines.length}</span>
        </div>
        <div className="phb-add">
          <MedicinePicker
            disabled={locked}
            label="Add medicine"
            placeholder="Type at least 2 letters of the medicine name or code"
            useOptions={useStockOptions}
            optionId={(m) => m.medicine_id}
            describeOption={describeStock}
            noMatchText="No medicine in stock matches."
            onSelect={(m) => openPicker(m.medicine_id)}
          />
        </div>
        {bill.lines.length ? (
          <LinesTable
            bill={bill}
            busy={busy || locked}
            onChange={(l) => openPicker(l.medicine_id)}
            onRemove={remove}
            onDiscount={setLineDiscount}
          />
        ) : (
          <p className="phs-empty">No medicines yet. Search above to add the first one.</p>
        )}
        {save.isPending ? (
          <p className="phs-meta" role="status">
            Updating the bill…
          </p>
        ) : null}
      </section>

      <div className="phb-checkout">
        <section className="flow-card" aria-label="Totals">
          {bill.lines.length ? (
            <BillDiscount
              key={`${bill.discount_kind}-${bill.discount_value}`}
              bill={bill}
              busy={busy || locked}
              onApply={setBillDiscount}
            />
          ) : null}
          <BillTotals bill={bill} />
        </section>
        <section className="flow-card" aria-label="Collect payment">
          <CreditPanel
            request={request}
            canAsk={canAskCredit && bill.lines.length > 0}
            busy={busy}
            onAsk={() => setAskingCredit(true)}
            onWithdraw={doWithdraw}
          />
          {request?.status === "pending" ? null : (
            <BillPayments
              rows={payments}
              net={bill.net_amount}
              shortBy={shortBy}
              depositBalance={bill.patient_balance}
              onChange={setPayments}
              showErrors={payTouched}
            />
          )}
          {error ? (
            <p className="bill-dialog__error" role="alert">
              {error}
            </p>
          ) : null}
          <div className="phb-checkout__acts">
            <button
              type="button"
              className="flow-btn flow-btn-ghost"
              disabled={busy}
              onClick={() => setConfirmDiscard(true)}
            >
              Discard draft
            </button>
            <button
              type="button"
              className="flow-btn flow-btn-primary"
              disabled={busy || !bill.lines.length || request?.status === "pending"}
              onClick={askFinalise}
            >
              Finalise and collect{" "}
              {inr(toRupees(toPaise(bill.net_amount) - Math.max(check.gap, 0)))}
            </button>
          </div>
        </section>
      </div>

      {askingCredit ? <AskCreditDialog bill={bill} onClose={() => setAskingCredit(false)} /> : null}

      {picking ? (
        <BatchPickerDialog
          medicine={picking.medicine}
          current={currentFor(picking.medicine)}
          warnDays={picking.warnDays}
          suggested={picking.suggested}
          prescribed={picking.prescribed}
          onApply={apply}
          onClose={() => setPicking(null)}
        />
      ) : null}

      <ConfirmModal
        open={confirming}
        title="Finalise this bill?"
        variant="primary"
        confirmLabel={finalise.isPending ? "Finalising…" : "Finalise bill"}
        busy={finalise.isPending}
        confirmDisabled={finalise.isPending}
        onCancel={() => setConfirming(false)}
        onConfirm={doFinalise}
        message={
          <div className="phb-confirm-body">
            <p>
              <strong>{bill.patient_name}</strong> ({bill.patient_file_no}) ·{" "}
              {SALE_TYPE_LABEL[bill.sale_type]}
            </p>
            <p>
              {bill.lines.length} medicine line{bill.lines.length === 1 ? "" : "s"}, total{" "}
              <strong>{inr(bill.net_amount)}</strong>
            </p>
            {check.gap > 0 ? (
              <p>
                <strong>{inr(toRupees(check.gap))}</strong> stays due on approved credit and is
                collected later.
              </p>
            ) : null}
            <ul>
              {paymentsForApi(payments).map((p, i) => (
                <li key={i}>
                  {PAYMENT_MODE_TEXT[p.mode]} {inr(p.amount)}
                  {p.reference ? ` (${p.reference})` : ""}
                </li>
              ))}
            </ul>
            <p>
              The stock is taken off the shelf and the bill gets its number. It cannot be edited
              after this; a return needs a credit note.
            </p>
          </div>
        }
      />

      <ConfirmModal
        open={confirmDiscard}
        title="Discard this draft bill?"
        confirmLabel="Discard draft"
        busy={discard.isPending}
        onCancel={() => setConfirmDiscard(false)}
        onConfirm={doDiscard}
        message={`The draft for ${bill.patient_name} and its ${bill.lines.length} medicine line(s) will be deleted. No stock has been taken yet.`}
      />
    </>
  );
}

function ReturnsSection({ bill }) {
  const query = useBillReturns(bill.id);
  const notes = query.data?.notes ?? [];
  if (!notes.length) return null;
  return (
    <section className="flow-card" aria-labelledby="phb-returns-title">
      <h2 id="phb-returns-title" className="flow-sec-title">
        Returns
      </h2>
      <table className="flow-table phs-table" aria-label="Credit notes for this bill">
        <thead>
          <tr>
            <th>Credit note</th>
            <th>Reason</th>
            <th>Refund by</th>
            <th className="phs-num">Refunded</th>
          </tr>
        </thead>
        <tbody>
          {notes.map((n) => (
            <tr key={n.id}>
              <td data-label="Credit note">
                <Link className="phs-item" to={`/pharmacy/billing/${n.id}`}>
                  {n.bill_no}
                </Link>
                <span className="phs-meta">
                  {showDate(n.bill_date)}
                  {n.created_by_name ? ` by ${n.created_by_name}` : ""}
                </span>
              </td>
              <td data-label="Reason">{n.reason}</td>
              <td data-label="Refund by">{PAYMENT_MODE_LABEL[n.refund_mode] ?? "—"}</td>
              <td data-label="Refunded" className="phs-num">
                {inr(n.net_amount)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function FinalBill({ bill }) {
  const navigate = useNavigate();
  const credit = bill.bill_type === "credit_note";
  const returns = useBillReturns(bill.id, { enabled: !credit });
  const [returning, setReturning] = useState(false);
  const [collecting, setCollecting] = useState(false);
  const role = useAuthStore((st) => st.currentDoctor?.role);
  const canCollect = hasCapability(role, CAPABILITIES.PHARMACY_CREDIT_REQUEST);
  const returned = returns.data?.returned_units ?? {};
  const returnable = bill.lines.some((l) => l.qty_units > (returned[l.id] ?? 0));
  return (
    <>
      {credit ? (
        <p className="phs-sub">
          Credit note against{" "}
          <Link className="phs-item" to={`/pharmacy/billing/${bill.original_bill_id}`}>
            bill {bill.original_bill_no}
          </Link>
          {bill.notes ? ` · ${bill.notes}` : ""}
        </p>
      ) : null}
      <section className="flow-card" aria-labelledby="phb-final-lines">
        <div className="fset__cardhead">
          <h2 id="phb-final-lines" className="flow-sec-title">
            {credit ? "Medicines returned" : "Medicines"}
          </h2>
          {!credit && canCollect && Number(bill.due_amount) > 0 ? (
            <button
              type="button"
              className="flow-btn flow-btn-primary"
              onClick={() => setCollecting(true)}
            >
              Collect due {inr(bill.due_amount)}
            </button>
          ) : null}
          {!credit && bill.status === "final" && returns.isSuccess && returnable ? (
            <button
              type="button"
              className="flow-btn flow-btn-ghost"
              onClick={() => setReturning(true)}
            >
              <Undo2 size={14} aria-hidden="true" />
              Return medicines
            </button>
          ) : null}
        </div>
        <LinesTable bill={bill} />
        <BillTotals bill={bill} />
      </section>
      {bill.payments.length ? (
        <PaymentsReceived payments={bill.payments} refunded={credit} />
      ) : null}
      {!credit ? <ReturnsSection bill={bill} /> : null}
      {collecting ? <CollectDueDialog bill={bill} onClose={() => setCollecting(false)} /> : null}
      {returning ? (
        <ReturnDialog
          bill={bill}
          returned={returned}
          onClose={() => setReturning(false)}
          onDone={(note) => {
            setReturning(false);
            navigate(`/pharmacy/billing/${note.id}`);
          }}
        />
      ) : null}
    </>
  );
}

export default function PharmacyBillEditorPage() {
  const { id } = useParams();
  const query = useBill(id);
  const bill = query.data;

  return (
    <div className="flow-root fset bill-ui phs phb">
      <Link className="phb-back" to="/pharmacy/billing">
        <ArrowLeft size={14} aria-hidden="true" />
        Pharmacy bills
      </Link>
      {query.isError ? (
        <div className="phs-empty" role="alert">
          <p>
            {query.error?.response?.status === 404
              ? "This bill no longer exists. A discarded draft is deleted."
              : "Unable to load the bill. Please try again."}
          </p>
          <button type="button" className="flow-btn flow-btn-ghost" onClick={() => query.refetch()}>
            Try again
          </button>
        </div>
      ) : !bill ? (
        <p className="phs-empty" role="status">
          Loading the bill…
        </p>
      ) : (
        <>
          <header className="phs-head">
            <div>
              <h1 className="phs-title">
                {bill.bill_type === "credit_note"
                  ? `Credit note ${bill.bill_no}`
                  : bill.bill_no
                    ? `Bill ${bill.bill_no}`
                    : "New pharmacy bill"}{" "}
                {bill.bill_type === "credit_note" ? (
                  <span className="bill-status phs-badge phs-badge--review">Refunded</span>
                ) : (
                  <BillStatus status={bill.status} due={bill.due_amount} />
                )}
              </h1>
              <p className="phs-sub">
                {bill.status === "final"
                  ? `Finalised ${showDate(bill.bill_date)}${bill.finalised_by_name ? ` by ${bill.finalised_by_name}` : ""} · ${bill.location_name}`
                  : `Draft · ${bill.location_name}. Stock is only taken when the bill is finalised.`}
              </p>
            </div>
            {bill.status === "final" ? (
              <div className="phs-head__acts">
                <PdfButton
                  className="flow-btn flow-btn-primary phs-upload"
                  href={pharmacyBillPdfUrl(bill.id)}
                  title={`${bill.bill_type === "credit_note" ? "Credit note" : "Pharmacy bill"} ${bill.bill_no}`}
                  fileName={`Pharmacy_${bill.bill_no}.pdf`}
                >
                  <Printer size={15} aria-hidden="true" />
                  {bill.bill_type === "credit_note" ? "Print credit note" : "Print bill"}
                </PdfButton>
              </div>
            ) : null}
          </header>
          <PatientStrip bill={bill} />
          {bill.status === "draft" ? (
            <DraftBill key={bill.id} bill={bill} />
          ) : (
            <FinalBill key={bill.id} bill={bill} />
          )}
        </>
      )}
    </div>
  );
}
