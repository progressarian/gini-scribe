import { rupees } from "../billing/format";
import MasterFormDialog from "./MasterFormDialog";
import useMasterForm from "./useMasterForm";
import { useCreateMedicine, useUpdateMedicine } from "../../queries/hooks/usePharmacyMedicines";
import { MEDICINE_TYPES } from "../../../shared/medicineTypes";
import {
  GST_MAX,
  GST_PRESETS,
  HSN_HINT,
  PACK_LABELS,
  SCHEDULE_LABEL,
  UNIT_LABELS,
  isValidHsn,
  splitUnits,
} from "../../../shared/pharmacyVocab";

const CUSTOM = "custom";

const text = (v) => (v === null || v === undefined ? "" : String(v));

const formOf = (m) => ({
  code: text(m?.code),
  name: text(m?.name),
  generic_name: text(m?.generic_name),
  manufacturer: text(m?.manufacturer),
  form: m?.form ?? "TAB",
  strength: text(m?.strength),
  pack_size: text(m?.pack_size ?? 10),
  unit_label: m?.unit_label ?? "tab",
  pack_label: m?.pack_label ?? "strip",
  hsn_code: text(m?.hsn_code),
  gst_choice:
    m && !GST_PRESETS.includes(Number(m.gst_rate_pct))
      ? CUSTOM
      : text(Number(m?.gst_rate_pct ?? 5)),
  gst_custom:
    m && !GST_PRESETS.includes(Number(m.gst_rate_pct)) ? text(Number(m.gst_rate_pct)) : "",
  schedule: m?.schedule ?? "none",
  default_mrp: text(m?.default_mrp),
  default_sale_rate: text(m?.default_sale_rate),
  min_stock_units: text(m?.min_stock_units ?? 0),
  max_stock_units: text(m?.max_stock_units),
  reorder_qty_units: text(m?.reorder_qty_units),
  default_rack: text(m?.default_rack),
  allow_loose_sale: m?.allow_loose_sale ?? false,
});

const MONEY = /^\d{1,8}(\.\d{1,2})?$/;
const WHOLE = /^\d{1,9}$/;

const gstOf = (form) => (form.gst_choice === CUSTOM ? form.gst_custom : form.gst_choice);

function validate(form, editing) {
  const errors = {};
  if (form.name.trim().length < 2) errors.name = "Enter the medicine name.";
  if ((editing || form.code) && !/^[A-Z0-9-]{2,30}$/.test(form.code))
    errors.code = "Use 2 to 30 letters, digits or hyphens.";
  if (!WHOLE.test(form.pack_size) || Number(form.pack_size) < 1 || Number(form.pack_size) > 10000)
    errors.pack_size = "Enter how many units are in one pack (1 to 10000).";
  if (form.hsn_code && !isValidHsn(form.hsn_code)) errors.hsn_code = HSN_HINT;
  const gst = gstOf(form);
  if (!/^\d{1,2}(\.\d{1,2})?$/.test(gst) || Number(gst) > GST_MAX)
    errors.gst_custom = `Enter a GST rate from 0 to ${GST_MAX}.`;
  if (form.default_mrp && (!MONEY.test(form.default_mrp) || Number(form.default_mrp) <= 0))
    errors.default_mrp = "Enter the MRP in rupees, for example 120.50.";
  if (
    form.default_sale_rate &&
    (!MONEY.test(form.default_sale_rate) || Number(form.default_sale_rate) <= 0)
  )
    errors.default_sale_rate = "Enter the sale rate in rupees, for example 110.";
  else if (
    form.default_sale_rate &&
    form.default_mrp &&
    Number(form.default_sale_rate) > Number(form.default_mrp)
  )
    errors.default_sale_rate = "The sale rate cannot be more than the MRP.";
  if (!WHOLE.test(form.min_stock_units || "0")) errors.min_stock_units = "Enter a whole number.";
  if (
    form.max_stock_units &&
    (!WHOLE.test(form.max_stock_units) || Number(form.max_stock_units) < 1)
  )
    errors.max_stock_units = "Enter a whole number above 0.";
  else if (form.max_stock_units && Number(form.max_stock_units) < Number(form.min_stock_units || 0))
    errors.max_stock_units = "The maximum cannot be less than the minimum.";
  if (
    form.reorder_qty_units &&
    (!WHOLE.test(form.reorder_qty_units) || Number(form.reorder_qty_units) < 1)
  )
    errors.reorder_qty_units = "Enter a whole number above 0.";
  return errors;
}

const orNull = (v) => (v.trim() ? v.trim() : null);

const payloadOf = (form, editing) => ({
  ...(editing || form.code ? { code: form.code } : {}),
  name: form.name.trim(),
  generic_name: orNull(form.generic_name),
  manufacturer: orNull(form.manufacturer),
  form: form.form,
  strength: orNull(form.strength),
  pack_size: Number(form.pack_size),
  unit_label: form.unit_label,
  pack_label: form.pack_label,
  hsn_code: orNull(form.hsn_code),
  gst_rate_pct: Number(gstOf(form)),
  schedule: form.schedule,
  default_mrp: orNull(form.default_mrp),
  default_sale_rate: orNull(form.default_sale_rate),
  min_stock_units: Number(form.min_stock_units || 0),
  max_stock_units: orNull(form.max_stock_units),
  reorder_qty_units: orNull(form.reorder_qty_units),
  default_rack: orNull(form.default_rack),
  allow_loose_sale: form.allow_loose_sale,
});

const packHint = (units, form) => {
  if (!WHOLE.test(units || "") || !WHOLE.test(form.pack_size) || Number(form.pack_size) < 1)
    return null;
  const { packs, loose } = splitUnits(Number(units), Number(form.pack_size));
  return `= ${packs} ${form.pack_label}${packs === 1 ? "" : "s"}${loose ? ` + ${loose} ${form.unit_label}` : ""}`;
};

const perUnit = (amount, form) =>
  MONEY.test(amount || "") && WHOLE.test(form.pack_size) && Number(form.pack_size) > 0
    ? `${rupees(Number(amount) / Number(form.pack_size))} per ${form.unit_label}`
    : null;

const mutations = { useCreate: useCreateMedicine, useUpdate: useUpdateMedicine };
const digits = (v) => v.replace(/\D/g, "");
const decimal = (v) => v.replace(/[^\d.]/g, "");
const code = (v) => v.toUpperCase().replace(/[^A-Z0-9-]/g, "");
const plain = (list) => list.map((v) => ({ value: v, label: v }));

export default function MedicineDialog({ record: medicine, onClose }) {
  const f = useMasterForm({
    record: medicine,
    initial: formOf(medicine),
    validate,
    payload: payloadOf,
    mutations,
    noun: "medicine",
    onClose,
    successText: (saved, editing) =>
      editing ? `${saved.name} updated.` : `${saved.name} added with code ${saved.code}.`,
  });
  const { form } = f;

  return (
    <MasterFormDialog
      title={f.editing ? `Edit ${medicine.name}` : "Add medicine"}
      intro={
        medicine?.needs_review ? (
          <p className="phm-review-note" role="note">
            Imported from the DARPAN stock list. Check the pack size, GST rate, HSN code and prices,
            then save to mark it reviewed.
          </p>
        ) : null
      }
      dirty={f.dirty}
      busy={f.busy}
      error={f.error}
      submitLabel={f.editing ? "Save medicine" : "Add medicine"}
      onSubmit={f.submit}
      onClose={onClose}
    >
      <h3 className="phv-section">Medicine</h3>
      <div className="bill-form">
        {f.input(
          "name",
          "Medicine name",
          { maxLength: 200, placeholder: "e.g. Glycomet 500 SR" },
          { required: true, className: "phv-span2" },
        )}
        {f.input(
          "code",
          "Code",
          { maxLength: 30, placeholder: f.editing ? "" : "Generated if left blank" },
          { required: f.editing, clean: code },
        )}
        {f.input(
          "generic_name",
          "Generic name / composition",
          { maxLength: 300, placeholder: "e.g. Metformin 500 mg" },
          { className: "phv-span2" },
        )}
        {f.input("manufacturer", "Manufacturer", { maxLength: 160 })}
        {f.select("form", "Form", plain(MEDICINE_TYPES), { required: true })}
        {f.input("strength", "Strength", { maxLength: 60, placeholder: "e.g. 500 mg" })}
      </div>

      <h3 className="phv-section">Pack</h3>
      <div className="bill-form">
        {f.select("pack_label", "Pack", plain(PACK_LABELS), { required: true })}
        {f.input(
          "pack_size",
          "Units per pack",
          { inputMode: "numeric", maxLength: 5 },
          {
            required: true,
            clean: digits,
            hint: `How many ${form.unit_label} in one ${form.pack_label}`,
          },
        )}
        {f.select("unit_label", "Unit", plain(UNIT_LABELS), { required: true })}
        <label className="fset__check">
          <input
            type="checkbox"
            checked={form.allow_loose_sale}
            onChange={f.setField("allow_loose_sale")}
          />
          Can be sold loose (single {form.unit_label})
        </label>
      </div>

      <h3 className="phv-section">Tax and price</h3>
      <div className="bill-form">
        {f.input(
          "hsn_code",
          "HSN code",
          { inputMode: "numeric", maxLength: 8, placeholder: "e.g. 3004" },
          { clean: digits },
        )}
        {f.select(
          "gst_choice",
          "GST rate",
          [
            ...GST_PRESETS.map((p) => ({ value: String(p), label: `${p}%` })),
            { value: CUSTOM, label: "Custom rate" },
          ],
          { required: true },
        )}
        {form.gst_choice === CUSTOM
          ? f.input(
              "gst_custom",
              "Custom GST rate (%)",
              { inputMode: "decimal", maxLength: 5 },
              { required: true, clean: decimal },
            )
          : null}
        {f.select(
          "schedule",
          "Drug schedule",
          Object.entries(SCHEDULE_LABEL).map(([value, label]) => ({ value, label })),
        )}
        {f.input(
          "default_mrp",
          `MRP per ${form.pack_label} (₹)`,
          { inputMode: "decimal", maxLength: 11 },
          { clean: decimal, hint: perUnit(form.default_mrp, form) },
        )}
        {f.input(
          "default_sale_rate",
          `Sale rate per ${form.pack_label} (₹)`,
          { inputMode: "decimal", maxLength: 11 },
          {
            clean: decimal,
            hint:
              perUnit(form.default_sale_rate, form) ??
              "Before GST. Each purchase batch can set its own rate.",
          },
        )}
      </div>

      <h3 className="phv-section">Stock levels and storage</h3>
      <div className="bill-form">
        {f.input(
          "min_stock_units",
          `Minimum stock (${form.unit_label})`,
          { inputMode: "numeric", maxLength: 9 },
          { clean: digits, hint: packHint(form.min_stock_units, form) ?? "Alert below this" },
        )}
        {f.input(
          "max_stock_units",
          `Maximum stock (${form.unit_label})`,
          { inputMode: "numeric", maxLength: 9 },
          { clean: digits, hint: packHint(form.max_stock_units, form) ?? "Alert above this" },
        )}
        {f.input(
          "reorder_qty_units",
          `Reorder quantity (${form.unit_label})`,
          { inputMode: "numeric", maxLength: 9 },
          { clean: digits, hint: packHint(form.reorder_qty_units, form) },
        )}
        {f.input(
          "default_rack",
          "Rack",
          { maxLength: 40, placeholder: "e.g. A-3" },
          { hint: "Where this medicine is usually kept" },
        )}
      </div>
    </MasterFormDialog>
  );
}
