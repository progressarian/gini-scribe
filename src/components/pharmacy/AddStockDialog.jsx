import { useState } from "react";
import FormField from "../ui/FormField";
import MasterFormDialog from "./MasterFormDialog";
import MedicinePicker from "./MedicinePicker";
import { DateInput, SelectInput } from "./Fields";
import { digitsTyped, moneyTyped, requestErrorOf } from "../billing/format";
import { inr, localDate, packUnits } from "./format";
import { toast } from "../../stores/uiStore";
import { useAddStock } from "../../queries/hooks/usePharmacyPurchases";
import { useVendorList } from "../../queries/hooks/usePharmacyVendors";
import { GST_PRESETS } from "../../../shared/pharmacyVocab";

const batchTyped = (v) => v.toUpperCase().replace(/[^A-Z0-9/._-]/g, "");

const EMPTY = {
  vendor_id: "",
  batch_no: "",
  expiry_date: "",
  qty_packs: "",
  free_packs: "",
  purchase_rate: "",
  gst_rate_pct: "5",
  mrp: "",
  sale_rate: "",
  rack_no: "",
};

const text = (v) => (v === null || v === undefined ? "" : String(Number(v)));

function problemsOf(medicine, form) {
  const problems = {};
  if (!medicine) problems.medicine = "Choose the medicine.";
  if (!form.batch_no) problems.batch_no = "Enter the batch number printed on the pack.";
  if (!form.expiry_date) problems.expiry_date = "Choose the expiry date.";
  else if (form.expiry_date <= localDate()) problems.expiry_date = "Expired stock cannot be added.";
  if (!Number(form.qty_packs) && !Number(form.free_packs))
    problems.qty_packs = "Enter how many packs you are adding.";
  if (!(Number(form.mrp) > 0)) problems.mrp = "Enter the MRP per pack.";
  if (!(Number(form.sale_rate) > 0)) problems.sale_rate = "Enter the sale rate per pack.";
  else if (Number(form.sale_rate) > Number(form.mrp))
    problems.sale_rate = "Sale rate cannot be more than the MRP.";
  return problems;
}

export default function AddStockDialog({ onClose }) {
  const addStock = useAddStock();
  const vendors = useVendorList({ status: "active", limit: 200 });
  const [medicine, setMedicine] = useState(null);
  const [form, setForm] = useState(EMPTY);
  const [touched, setTouched] = useState(false);
  const [error, setError] = useState("");
  const problems = problemsOf(medicine, form);
  const errors = touched ? problems : {};
  const set = (field) => (value) => setForm((f) => ({ ...f, [field]: value }));
  const typed = (field, clean) => (e) => set(field)(clean(e.target.value));

  const pick = (m) => {
    setMedicine(m);
    setForm((f) => ({
      ...f,
      mrp: f.mrp || text(m.default_mrp),
      sale_rate: f.sale_rate || text(m.default_sale_rate),
      gst_rate_pct: text(m.gst_rate_pct) || f.gst_rate_pct,
      rack_no: f.rack_no || m.default_rack || "",
    }));
  };

  const packs = Number(form.qty_packs || 0) + Number(form.free_packs || 0);

  const submit = async (e) => {
    e.preventDefault();
    setTouched(true);
    setError("");
    if (Object.keys(problems).length) return;
    try {
      const receipt = await addStock.mutateAsync({
        medicine_id: medicine.id,
        vendor_id: form.vendor_id ? Number(form.vendor_id) : null,
        batch_no: form.batch_no,
        expiry_date: form.expiry_date,
        qty_packs: Number(form.qty_packs || 0),
        free_packs: Number(form.free_packs || 0),
        purchase_rate: Number(form.purchase_rate || 0),
        gst_rate_pct: Number(form.gst_rate_pct || 0),
        mrp: Number(form.mrp),
        sale_rate: Number(form.sale_rate),
        rack_no: form.rack_no || null,
      });
      toast(
        `${medicine.name} batch ${form.batch_no}: ${packUnits(packs * medicine.pack_size, medicine)} added (${receipt.receipt_no}).`,
      );
      onClose();
    } catch (err) {
      setError(requestErrorOf(err, "Could not add the stock"));
    }
  };

  const money = (field, label, required = false) => (
    <FormField label={label} required={required} error={errors[field]}>
      <input
        className="jb-assign"
        inputMode="decimal"
        maxLength={12}
        value={form[field]}
        onChange={typed(field, moneyTyped)}
      />
    </FormField>
  );

  return (
    <MasterFormDialog
      title="Add stock"
      intro={
        <p className="phs-meta">
          Adds one batch to the main store as opening stock. It is posted at once and shows in the
          batch history.
        </p>
      }
      dirty={Boolean(medicine || form.batch_no || form.qty_packs)}
      busy={addStock.isPending}
      error={error}
      submitLabel="Add stock"
      onSubmit={submit}
      onClose={onClose}
    >
      <div className="bill-form">
        <div className="phv-span-all">
          {medicine ? (
            <div className="adj-facts" aria-label="Medicine">
              <p>
                <strong>{medicine.name}</strong>{" "}
                <span className="phs-meta">
                  {medicine.code} · {medicine.pack_label} of {medicine.pack_size}{" "}
                  {medicine.unit_label}
                </span>{" "}
                <button
                  type="button"
                  className="flow-btn flow-btn-ghost flow-btn-mini"
                  onClick={() => setMedicine(null)}
                >
                  Change
                </button>
              </p>
            </div>
          ) : (
            <MedicinePicker label="Medicine" onSelect={pick} autoFocus />
          )}
          {errors.medicine ? (
            <small className="form-field__error" role="alert">
              {errors.medicine}
            </small>
          ) : null}
        </div>
        <FormField label="Vendor" hint="Leave empty for stock already on the shelf">
          <SelectInput
            value={form.vendor_id}
            onChange={set("vendor_id")}
            options={[
              { value: "", label: "No vendor" },
              ...(vendors.data?.rows ?? []).map((v) => ({ value: String(v.id), label: v.name })),
            ]}
          />
        </FormField>
        <FormField label="Batch" required error={errors.batch_no}>
          <input
            className="jb-assign phv-mono"
            maxLength={30}
            value={form.batch_no}
            onChange={typed("batch_no", batchTyped)}
          />
        </FormField>
        <FormField label="Expiry" required error={errors.expiry_date}>
          <DateInput
            minDate={localDate(1)}
            value={form.expiry_date}
            onChange={set("expiry_date")}
          />
        </FormField>
        <FormField
          label="Qty (packs)"
          required
          error={errors.qty_packs}
          hint={medicine && packs ? packUnits(packs * medicine.pack_size, medicine) : undefined}
        >
          <input
            className="jb-assign"
            inputMode="numeric"
            maxLength={7}
            value={form.qty_packs}
            onChange={typed("qty_packs", digitsTyped)}
          />
        </FormField>
        <FormField label="Free (packs)">
          <input
            className="jb-assign"
            inputMode="numeric"
            maxLength={7}
            value={form.free_packs}
            onChange={typed("free_packs", digitsTyped)}
          />
        </FormField>
        {money("purchase_rate", "Purchase rate per pack")}
        <FormField label="GST %">
          <SelectInput
            value={form.gst_rate_pct}
            onChange={set("gst_rate_pct")}
            options={[...new Set([...GST_PRESETS.map(String), form.gst_rate_pct])].map((g) => ({
              value: g,
              label: `${g}%`,
            }))}
          />
        </FormField>
        {money("mrp", "MRP per pack", true)}
        {money("sale_rate", "Sale rate per pack", true)}
        <FormField label="Rack">
          <input
            className="jb-assign"
            maxLength={40}
            value={form.rack_no}
            onChange={(e) => set("rack_no")(e.target.value)}
          />
        </FormField>
      </div>
      {medicine && packs && Number(form.purchase_rate) ? (
        <p className="adj-change" role="status">
          Landing cost {inr(Number(form.purchase_rate) * (1 + Number(form.gst_rate_pct) / 100))} per
          pack (purchase rate + GST).
        </p>
      ) : null}
    </MasterFormDialog>
  );
}
