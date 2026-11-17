import { useId, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ArrowLeft, Download, Upload } from "lucide-react";
import { downloadFile } from "../../lib/downloadBlob";
import { requestErrorOf } from "../../components/billing/format";
import FormField from "../../components/ui/FormField";
import ConfirmModal from "../../components/ui/ConfirmModal";
import MedicinePicker from "../../components/pharmacy/MedicinePicker";
import { DateInput, SelectInput } from "../../components/pharmacy/Fields";
import {
  PurchaseLinesEditor,
  PurchaseLinesView,
  PurchaseTotals,
} from "../../components/pharmacy/PurchaseLines";
import { inr, localDate, showDate } from "../../components/pharmacy/format";
import { when } from "../../components/billing/importText";
import { toast } from "../../stores/uiStore";
import { PurchaseStatus } from "./PharmacyPurchasesPage";
import { useVendorList } from "../../queries/hooks/usePharmacyVendors";
import {
  RECEIPT_TEMPLATE_URL,
  useCancelPurchase,
  useImportReceipt,
  usePostPurchase,
  usePurchase,
  useSavePurchase,
} from "../../queries/hooks/usePharmacyPurchases";
import { purchaseTotals, receivedUnits, toRupees } from "../../../shared/pharmacyMoney";
import "../../styles/flow.css";
import "../flow/FlowSettings.css";
import "../billing/billing.css";
import "../billing/billingUi.css";
import "./pharmacyStock.css";
import "./pharmacyVendors.css";

const text = (v) => (v === null || v === undefined ? "" : String(v));
const num = (v) => (v === "" || v === null || v === undefined ? "" : String(Number(v)));

let nextKey = 0;
const newKey = () => `l${(nextKey += 1)}`;

const lineFromServer = (l) => ({
  key: newKey(),
  medicine: {
    id: l.medicine_id,
    name: l.medicine_name,
    pack_size: l.pack_size,
    pack_label: l.pack_label,
    unit_label: l.unit_label,
  },
  batch_no: l.batch_no,
  expiry_date: l.expiry_date,
  qty_packs: String(l.qty_packs),
  free_packs: String(l.free_packs),
  purchase_rate: num(l.purchase_rate),
  discount_pct: num(l.discount_pct),
  gst_rate_pct: num(l.gst_rate_pct),
  mrp: num(l.mrp),
  sale_rate: num(l.sale_rate),
  rack_no: text(l.rack_no),
});

const lineFromMedicine = (m) => ({
  key: newKey(),
  medicine: m,
  batch_no: "",
  expiry_date: "",
  qty_packs: "",
  free_packs: "0",
  purchase_rate: "",
  discount_pct: "0",
  gst_rate_pct: num(m.gst_rate_pct),
  mrp: num(m.default_mrp),
  sale_rate: num(m.default_sale_rate),
  rack_no: text(m.default_rack),
});

const formFrom = (purchase) => ({
  vendor_id: text(purchase.vendor_id),
  invoice_no: text(purchase.invoice_no),
  invoice_date: text(purchase.invoice_date),
  notes: text(purchase.notes),
  lines: purchase.lines.map(lineFromServer),
});

const MONEY = /^\d{1,8}(\.\d{1,2})?$/;

function lineErrors(lines) {
  const errors = {};
  const today = localDate();
  const seen = new Set();
  for (const l of lines) {
    const e = (field, message) => {
      errors[`${l.key}.${field}`] = message;
    };
    if (!/^[A-Z0-9][A-Z0-9/._-]{0,29}$/.test(l.batch_no)) e("batch_no", "Enter the batch number.");
    if (!l.expiry_date) e("expiry_date", "Enter the expiry date.");
    else if (l.expiry_date <= today) e("expiry_date", "This batch has already expired.");
    const qty = Number(l.qty_packs || 0) + Number(l.free_packs || 0);
    if (!qty) e("qty_packs", "Enter the quantity received.");
    if (!MONEY.test(l.purchase_rate)) e("purchase_rate", "Enter the purchase rate.");
    if (!MONEY.test(l.discount_pct || "0") || Number(l.discount_pct) > 100)
      e("discount_pct", "Discount must be 0 to 100%.");
    if (!MONEY.test(l.gst_rate_pct) || Number(l.gst_rate_pct) > 28)
      e("gst_rate_pct", "GST must be 0 to 28%.");
    if (!MONEY.test(l.mrp) || Number(l.mrp) <= 0) e("mrp", "Enter the MRP.");
    if (!MONEY.test(l.sale_rate) || Number(l.sale_rate) <= 0)
      e("sale_rate", "Enter the sale rate.");
    else if (Number(l.sale_rate) > Number(l.mrp)) e("sale_rate", "Sale rate cannot be above MRP.");
    const key = `${l.medicine.id}|${l.batch_no}|${l.expiry_date}`;
    if (l.batch_no && seen.has(key)) e("batch_no", "This batch is already on another line.");
    seen.add(key);
  }
  return errors;
}

const linePayload = (l) => ({
  medicine_id: l.medicine.id,
  batch_no: l.batch_no,
  expiry_date: l.expiry_date,
  qty_packs: Number(l.qty_packs || 0),
  free_packs: Number(l.free_packs || 0),
  purchase_rate: l.purchase_rate || "0",
  discount_pct: l.discount_pct || "0",
  gst_rate_pct: l.gst_rate_pct || "0",
  mrp: l.mrp,
  sale_rate: l.sale_rate,
  rack_no: l.rack_no.trim() || null,
});

function DraftReceipt({ purchase: loaded }) {
  const [purchase, setPurchase] = useState(loaded);
  const opening = purchase.kind === "opening";
  const vendors = useVendorList({ status: "active", limit: 200 }, { enabled: !opening });
  const save = useSavePurchase();
  const post = usePostPurchase();
  const cancel = useCancelPurchase();
  const initial = useMemo(() => formFrom(purchase), [purchase]);
  const importer = useImportReceipt();
  const fileId = useId();
  const fileRef = useRef(null);
  const [report, setReport] = useState(null);
  const [form, setForm] = useState(initial);
  const [touched, setTouched] = useState(false);
  const [error, setError] = useState("");
  const [confirmPost, setConfirmPost] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [reason, setReason] = useState("");
  const [cancelError, setCancelError] = useState("");
  const busy = save.isPending || post.isPending;

  const strip = ({ lines, ...rest }) =>
    JSON.stringify({ ...rest, lines: lines.map(({ key, ...l }) => l) });
  const dirty = strip(form) !== strip(initial);

  const headerErrors = {};
  if (!opening) {
    if (!form.vendor_id) headerErrors.vendor_id = "Choose the vendor.";
    if (!form.invoice_no.trim()) headerErrors.invoice_no = "Enter the vendor's invoice number.";
    if (!form.invoice_date) headerErrors.invoice_date = "Enter the invoice date.";
    else if (form.invoice_date > localDate())
      headerErrors.invoice_date = "The invoice date cannot be in the future.";
  }
  const errors = touched ? { ...headerErrors, ...lineErrors(form.lines) } : {};
  const numericLines = form.lines.map((l) => ({
    qty_packs: Number(l.qty_packs || 0),
    purchase_rate: l.purchase_rate,
    discount_pct: l.discount_pct,
    gst_rate_pct: l.gst_rate_pct,
  }));
  const totals = purchaseTotals(numericLines);
  const units = form.lines.reduce((n, l) => n + receivedUnits(l, l.medicine.pack_size), 0);
  const vendorName =
    vendors.data?.rows.find((v) => String(v.id) === form.vendor_id)?.name ?? purchase.vendor_name;

  const setHeader = (field) => (e) => setForm((f) => ({ ...f, [field]: e.target.value }));
  const pickHeader = (field) => (value) => setForm((f) => ({ ...f, [field]: value }));
  const setLine = (key, field, value) =>
    setForm((f) => ({
      ...f,
      lines: f.lines.map((l) => (l.key === key ? { ...l, [field]: value } : l)),
    }));
  const removeLine = (key) =>
    setForm((f) => ({ ...f, lines: f.lines.filter((l) => l.key !== key) }));
  const addMedicine = (m) => setForm((f) => ({ ...f, lines: [...f.lines, lineFromMedicine(m)] }));

  const persist = async () => {
    const saved = await save.mutateAsync({
      id: purchase.id,
      version: purchase.version,
      vendor_id: opening ? null : form.vendor_id || null,
      invoice_no: form.invoice_no.trim() || null,
      invoice_date: form.invoice_date || null,
      notes: form.notes.trim() || null,
      lines: form.lines.map(linePayload),
    });
    setPurchase(saved);
    return saved;
  };

  const onSave = async () => {
    setError("");
    try {
      await persist();
      toast(`${purchase.receipt_no} saved as a draft.`);
    } catch (err) {
      setError(requestErrorOf(err, "Could not save the receipt"));
    }
  };

  const askPost = () => {
    setTouched(true);
    setError("");
    if (!form.lines.length) {
      setError("Add at least one medicine before posting.");
      return;
    }
    if (Object.keys({ ...headerErrors, ...lineErrors(form.lines) }).length) {
      setError("Fix the highlighted fields before posting.");
      return;
    }
    setConfirmPost(true);
  };

  const onPost = async () => {
    try {
      const saved = dirty ? await persist() : purchase;
      const posted = await post.mutateAsync({ id: purchase.id, version: saved.version });
      toast(`${posted.receipt_no} posted. ${units} units added to ${posted.location_name}.`);
      setConfirmPost(false);
    } catch (err) {
      setConfirmPost(false);
      setError(requestErrorOf(err, "Could not post the receipt"));
    }
  };

  const onTemplate = async () => {
    setError("");
    try {
      await downloadFile(RECEIPT_TEMPLATE_URL, "pharmacy-stock-template.xlsx");
    } catch (err) {
      setError(err.message || "Could not download the template");
    }
  };

  const onImport = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setError("");
    setReport(null);
    try {
      const result = await importer.mutateAsync({
        id: purchase.id,
        version: purchase.version,
        file,
      });
      setPurchase(result.purchase);
      setForm(formFrom(result.purchase));
      setReport({ added: result.added, skipped: result.skipped });
    } catch (err) {
      setError(requestErrorOf(err, "Could not import the file"));
    }
  };

  const onCancel = async () => {
    if (reason.trim().length < 3) {
      setCancelError("Say why this receipt is cancelled.");
      return;
    }
    try {
      await cancel.mutateAsync({
        id: purchase.id,
        version: purchase.version,
        reason: reason.trim(),
      });
      toast(`${purchase.receipt_no} cancelled.`);
      setCancelling(false);
    } catch (err) {
      setCancelError(requestErrorOf(err, "Could not cancel the receipt"));
    }
  };

  return (
    <>
      {!opening ? (
        <section className="flow-card" aria-labelledby="pur-invoice-title">
          <h2 id="pur-invoice-title" className="flow-sec-title">
            Vendor invoice
          </h2>
          <div className="bill-form">
            <FormField label="Vendor" required error={errors.vendor_id} className="phv-span2">
              <SelectInput
                value={form.vendor_id}
                onChange={pickHeader("vendor_id")}
                options={[
                  { value: "", label: "Choose a vendor" },
                  ...(purchase.vendor_id &&
                  !vendors.data?.rows.some((v) => v.id === purchase.vendor_id)
                    ? [{ value: String(purchase.vendor_id), label: purchase.vendor_name }]
                    : []),
                  ...(vendors.data?.rows ?? []).map((v) => ({
                    value: String(v.id),
                    label: v.city ? `${v.name} · ${v.city}` : v.name,
                  })),
                ]}
              />
            </FormField>
            <FormField label="Invoice number" required error={errors.invoice_no}>
              <input
                className="jb-assign"
                maxLength={60}
                value={form.invoice_no}
                onChange={setHeader("invoice_no")}
              />
            </FormField>
            <FormField label="Invoice date" required error={errors.invoice_date}>
              <DateInput
                maxDate={localDate()}
                value={form.invoice_date}
                onChange={pickHeader("invoice_date")}
              />
            </FormField>
          </div>
        </section>
      ) : (
        <p className="phm-review-note" role="note">
          Opening stock records what is already on the shelf when the pharmacy starts using Scribe.
          Enter each batch with its expiry, MRP, sale rate and rack.
        </p>
      )}

      <section className="flow-card" aria-labelledby="pur-lines-title">
        <div className="fset__cardhead">
          <h2 id="pur-lines-title" className="flow-sec-title">
            Medicines received
          </h2>
          <span className="fset__count">{form.lines.length}</span>
        </div>
        <p className="flow-muted pur-hint">
          Quantities and rates are per pack. Free packs are added to stock at no cost.
        </p>
        <div className="pur-add-row">
          <div className="pur-add">
            <MedicinePicker label="Add a medicine" onSelect={addMedicine} />
          </div>
          <div className="pur-import">
            <button
              type="button"
              className="flow-btn flow-btn-ghost phs-upload"
              onClick={onTemplate}
            >
              <Download size={15} aria-hidden="true" />
              Download template
            </button>
            <button
              type="button"
              className="flow-btn flow-btn-ghost phs-upload"
              disabled={dirty || importer.isPending}
              onClick={() => fileRef.current?.click()}
              aria-describedby={dirty ? `${fileId}-hint` : undefined}
            >
              <Upload size={15} aria-hidden="true" />
              {importer.isPending ? "Importing…" : "Import from Excel"}
            </button>
            <input
              ref={fileRef}
              id={fileId}
              type="file"
              accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              className="sr-only"
              tabIndex={-1}
              aria-label="Filled stock template"
              onChange={onImport}
            />
            {dirty ? (
              <span id={`${fileId}-hint`} className="phs-meta">
                Save the draft before importing
              </span>
            ) : null}
          </div>
        </div>
        {report ? (
          <div className="pur-report" role="status">
            <p>
              {report.added} row{report.added === 1 ? "" : "s"} added from the file.
              {report.skipped.length
                ? ` ${report.skipped.length} row${report.skipped.length === 1 ? " was" : "s were"} skipped:`
                : ""}
            </p>
            {report.skipped.length ? (
              <ul>
                {report.skipped.slice(0, 50).map((r) => (
                  <li key={r.row}>
                    Row {r.row}: {r.reason}
                  </li>
                ))}
              </ul>
            ) : null}
            {report.skipped.length > 50 ? (
              <p>and {report.skipped.length - 50} more. Fix them in the file and import again.</p>
            ) : null}
          </div>
        ) : null}
        {form.lines.length ? (
          <PurchaseLinesEditor
            lines={form.lines}
            errors={errors}
            onChange={setLine}
            onRemove={removeLine}
          />
        ) : (
          <p className="phs-empty">No medicines yet. Search above to add the first one.</p>
        )}
        <PurchaseTotals
          discount={toRupees(totals.discount)}
          taxable={toRupees(totals.taxable)}
          gst={toRupees(totals.gst)}
          total={toRupees(totals.total)}
        />
        <div>
          <FormField label="Notes" className="pur-notes">
            <textarea
              className="jb-assign"
              rows={2}
              maxLength={1000}
              value={form.notes}
              onChange={setHeader("notes")}
            />
          </FormField>
        </div>

        {error ? (
          <p className="bill-dialog__error" role="alert">
            {error}
          </p>
        ) : null}

        <div className="phset__actions">
          <button
            type="button"
            className="flow-btn flow-btn-ghost"
            onClick={() => {
              setReason("");
              setCancelError("");
              setCancelling(true);
            }}
          >
            Cancel receipt
          </button>
          <div className="pur-actions">
            <span className="phs-meta" role="status">
              {dirty ? "Unsaved changes" : "All changes saved"}
            </span>
            <button
              type="button"
              className="flow-btn flow-btn-ghost"
              disabled={!dirty || busy}
              onClick={onSave}
            >
              {save.isPending ? "Saving…" : "Save draft"}
            </button>
            <button
              type="button"
              className="flow-btn flow-btn-primary"
              disabled={busy}
              onClick={askPost}
            >
              {post.isPending ? "Posting…" : "Post to stock"}
            </button>
          </div>
        </div>
      </section>

      <ConfirmModal
        open={confirmPost}
        title={`Post ${purchase.receipt_no} to stock?`}
        message={
          <>
            {opening ? "Opening stock" : `${vendorName ?? "Vendor"}, invoice ${form.invoice_no}`}:{" "}
            {form.lines.length} medicine{form.lines.length === 1 ? "" : "s"}, {units} units in all,
            go into {purchase.location_name}.
            {!opening ? ` Net payable ${inr(toRupees(totals.total))}.` : ""} A posted receipt cannot
            be edited; a mistake has to be corrected with a stock adjustment.
          </>
        }
        confirmLabel="Post to stock"
        variant="primary"
        busy={busy}
        onConfirm={onPost}
        onCancel={() => setConfirmPost(false)}
      />

      <ConfirmModal
        open={cancelling}
        title={`Cancel ${purchase.receipt_no}?`}
        message={
          <div className="fset bill-ui pur-cancel">
            <p className="pur-confirm-text">
              The draft is kept for the record but nothing is added to stock.
            </p>
            <FormField label="Reason" required hint="Up to 500 characters.">
              <textarea
                className="jb-assign pur-reason__input"
                rows={3}
                maxLength={500}
                placeholder="e.g. Wrong vendor chosen, invoice entered twice"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            </FormField>
          </div>
        }
        confirmLabel="Cancel receipt"
        cancelLabel="Keep draft"
        busy={cancel.isPending}
        error={cancelError}
        onConfirm={onCancel}
        onCancel={() => setCancelling(false)}
      />
    </>
  );
}

function FinishedReceipt({ purchase }) {
  return (
    <section className="flow-card" aria-labelledby="pur-lines-title">
      <div className="fset__cardhead">
        <h2 id="pur-lines-title" className="flow-sec-title">
          Medicines received
        </h2>
        <span className="fset__count">{purchase.lines.length}</span>
      </div>
      {purchase.status === "cancelled" ? (
        <p className="phm-review-note" role="note">
          Cancelled {when(purchase.cancelled_at)}. Reason: {purchase.cancel_reason}
        </p>
      ) : (
        <p className="flow-muted">
          Posted to {purchase.location_name} {when(purchase.posted_at)}
          {purchase.posted_by_name ? ` by ${purchase.posted_by_name}` : ""}.
        </p>
      )}
      <PurchaseLinesView lines={purchase.lines} />
      <PurchaseTotals
        discount={purchase.discount_amount}
        taxable={purchase.taxable_amount}
        gst={purchase.gst_amount}
        total={purchase.net_amount}
      />
      {purchase.notes ? <p className="flow-muted">Notes: {purchase.notes}</p> : null}
    </section>
  );
}

export default function PharmacyPurchaseEditorPage() {
  const { id } = useParams();
  const receipt = usePurchase(id);
  const purchase = receipt.data;

  return (
    <div className="flow-root fset bill-ui phs">
      <Link to="/pharmacy/purchases" className="pur-back">
        <ArrowLeft size={14} aria-hidden="true" /> All goods receipts
      </Link>
      {receipt.isError ? (
        <div className="phs-empty" role="alert">
          <p>
            {receipt.error?.response?.status === 404
              ? "This goods receipt does not exist."
              : "Unable to load this goods receipt."}
          </p>
          <button
            type="button"
            className="flow-btn flow-btn-ghost"
            onClick={() => receipt.refetch()}
          >
            Try again
          </button>
        </div>
      ) : receipt.isLoading ? (
        <p className="phs-empty" role="status">
          Loading goods receipt…
        </p>
      ) : (
        <>
          <header className="phs-head">
            <div>
              <h1 className="phs-title">
                {purchase.receipt_no} <PurchaseStatus status={purchase.status} />
              </h1>
              <p className="phs-sub">
                {purchase.kind === "opening" ? "Opening stock" : "Purchase"} into{" "}
                {purchase.location_name}
                {purchase.kind === "purchase" && purchase.status !== "draft"
                  ? ` · ${purchase.vendor_name}, invoice ${purchase.invoice_no} of ${showDate(purchase.invoice_date)}`
                  : ""}
              </p>
            </div>
          </header>
          {purchase.status === "draft" ? (
            <DraftReceipt key={purchase.id} purchase={purchase} />
          ) : (
            <FinishedReceipt purchase={purchase} />
          )}
        </>
      )}
    </div>
  );
}
