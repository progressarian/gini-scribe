import { useState } from "react";
import useDialog from "../billing/useDialog";
import BillDialogLayer from "../billing/BillDialogLayer";
import { requestErrorOf } from "../billing/format";
import FormField from "../ui/FormField";
import { toast } from "../../stores/uiStore";
import { useCreateVendor, useUpdateVendor } from "../../queries/hooks/usePharmacyVendors";
import {
  GSTIN_HINT,
  IFSC_HINT,
  PAN_HINT,
  isValidGstin,
  isValidIfsc,
  isValidPan,
} from "../../../shared/pharmacyVocab";

const TEXT_FIELDS = [
  "name",
  "contact_person",
  "phone",
  "alt_phone",
  "email",
  "address",
  "city",
  "state",
  "pincode",
  "gstin",
  "pan",
  "drug_license_no",
  "drug_license_expiry",
  "payment_terms_days",
  "bank_name",
  "bank_account",
  "ifsc",
  "notes",
];

const text = (v) => (v === null || v === undefined ? "" : String(v));
const digitsOnly = (v) => v.replace(/\D/g, "");

const formOf = (vendor) => Object.fromEntries(TEXT_FIELDS.map((f) => [f, text(vendor?.[f])]));

const RULES = {
  name: (v) => (v.trim().length >= 2 ? null : "Enter the vendor name."),
  phone: (v) => (/^[0-9]{10,12}$/.test(v) ? null : "Enter a 10 to 12 digit phone number."),
  alt_phone: (v) =>
    !v || /^[0-9]{10,12}$/.test(v) ? null : "Enter a 10 to 12 digit phone number.",
  email: (v) =>
    !v || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim()) ? null : "Enter a valid email address.",
  pincode: (v) => (!v || /^[1-9][0-9]{5}$/.test(v) ? null : "Enter a 6-digit pincode."),
  gstin: (v) => (!v || isValidGstin(v) ? null : GSTIN_HINT),
  pan: (v) => (!v || isValidPan(v) ? null : PAN_HINT),
  ifsc: (v) => (!v || isValidIfsc(v) ? null : IFSC_HINT),
  bank_account: (v) =>
    !v || /^[0-9]{6,20}$/.test(v) ? null : "Enter the account number using 6 to 20 digits.",
  payment_terms_days: (v) =>
    !v || (/^[0-9]+$/.test(v) && Number(v) <= 365)
      ? null
      : "Enter the number of days, from 0 to 365.",
};

const errorsOf = (form) =>
  Object.fromEntries(
    Object.entries(RULES)
      .map(([field, rule]) => [field, rule(form[field])])
      .filter(([, message]) => message),
  );

const payloadOf = (form) => ({
  ...Object.fromEntries(TEXT_FIELDS.map((f) => [f, form[f].trim() || null])),
  name: form.name.trim(),
  payment_terms_days: Number(form.payment_terms_days) || 0,
});

const UPPERCASE = ["gstin", "pan", "ifsc"];
const DIGITS = ["phone", "alt_phone", "pincode", "bank_account", "payment_terms_days"];

export default function VendorDialog({ vendor, onClose }) {
  const editing = Boolean(vendor?.id);
  const [form, setForm] = useState(() => formOf(vendor));
  const [touched, setTouched] = useState(false);
  const [error, setError] = useState("");
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const create = useCreateVendor();
  const update = useUpdateVendor();
  const busy = create.isPending || update.isPending;
  const dirty = JSON.stringify(form) !== JSON.stringify(formOf(vendor));
  const requestClose = () => (dirty ? setConfirmDiscard(true) : onClose());
  const ref = useDialog(true, requestClose);
  const fieldErrors = touched ? errorsOf(form) : {};

  const set = (field) => (e) => {
    let value = e.target.value;
    if (UPPERCASE.includes(field)) value = value.toUpperCase().replace(/\s/g, "");
    if (DIGITS.includes(field)) value = digitsOnly(value);
    setForm((f) => ({ ...f, [field]: value }));
  };

  const submit = async (e) => {
    e.preventDefault();
    setTouched(true);
    setError("");
    if (Object.keys(errorsOf(form)).length) {
      setError("Fix the highlighted fields, then save again.");
      return;
    }
    try {
      const saved = editing
        ? await update.mutateAsync({ id: vendor.id, version: vendor.version, ...payloadOf(form) })
        : await create.mutateAsync(payloadOf(form));
      toast(editing ? `${saved.name} updated.` : `${saved.name} added as a vendor.`);
      onClose(saved);
    } catch (err) {
      setError(
        requestErrorOf(err, editing ? "Could not save the vendor" : "Could not add the vendor"),
      );
    }
  };

  const field = (name, label, props = {}, extra = {}) => (
    <FormField
      label={label}
      hint={extra.hint}
      required={extra.required}
      error={fieldErrors[name]}
      className={extra.className}
    >
      <input className="jb-assign" value={form[name]} onChange={set(name)} {...props} />
    </FormField>
  );

  return (
    <BillDialogLayer>
      <div className="flow-dialog-backdrop" onClick={requestClose} role="presentation">
        <form
          ref={ref}
          className="flow-card bill-dialog bill-dialog--wide phv-dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby="phv-dialog-title"
          onClick={(e) => e.stopPropagation()}
          onSubmit={submit}
          noValidate
        >
          <h2 id="phv-dialog-title" className="bill-dialog__title">
            {editing ? `Edit ${vendor.name}` : "Add vendor"}
          </h2>

          <h3 className="phv-section">Contact</h3>
          <div className="bill-form">
            {field(
              "name",
              "Vendor name",
              { maxLength: 160, placeholder: "e.g. Mohali Pharma Distributors" },
              { required: true, className: "phv-span2" },
            )}
            {field("contact_person", "Contact person", { maxLength: 120 })}
            {field(
              "phone",
              "Phone",
              { inputMode: "numeric", maxLength: 12, placeholder: "10 to 12 digits" },
              { required: true },
            )}
            {field("alt_phone", "Alternate phone", { inputMode: "numeric", maxLength: 12 })}
            {field("email", "Email", { type: "email", maxLength: 160 })}
          </div>

          <h3 className="phv-section">Address</h3>
          <div className="bill-form">
            {field("address", "Address", { maxLength: 500 }, { className: "phv-span2" })}
            {field("city", "City", { maxLength: 80 })}
            {field("state", "State", { maxLength: 80 })}
            {field("pincode", "Pincode", { inputMode: "numeric", maxLength: 6 })}
          </div>

          <h3 className="phv-section">Tax and licence</h3>
          <div className="bill-form">
            {field("gstin", "GSTIN", { maxLength: 15, placeholder: "03ABCDE1234F1Z5" })}
            {field("pan", "PAN", { maxLength: 10, placeholder: "ABCDE1234F" })}
            {field("drug_license_no", "Drug licence number", { maxLength: 80 })}
            {field("drug_license_expiry", "Drug licence expiry", { type: "date" })}
          </div>

          <h3 className="phv-section">Payment</h3>
          <div className="bill-form">
            {field(
              "payment_terms_days",
              "Payment terms (days)",
              { inputMode: "numeric", maxLength: 3, placeholder: "0" },
              { hint: "Days allowed to pay an invoice. 0 means on delivery." },
            )}
            {field("bank_name", "Bank name", { maxLength: 120 })}
            {field("bank_account", "Account number", { inputMode: "numeric", maxLength: 20 })}
            {field("ifsc", "IFSC", { maxLength: 11, placeholder: "HDFC0001234" })}
          </div>

          <div className="bill-form">
            <FormField label="Notes" className="phv-span-all">
              <textarea
                className="jb-assign"
                rows={2}
                maxLength={1000}
                value={form.notes}
                onChange={set("notes")}
              />
            </FormField>
          </div>

          {error ? (
            <p className="bill-dialog__error" role="alert">
              {error}
            </p>
          ) : null}

          {confirmDiscard ? (
            <div
              className="bill-dialog__actions bill-dialog__discard"
              role="group"
              aria-label="Discard changes?"
            >
              <span>Discard your changes?</span>
              <button
                type="button"
                className="flow-btn flow-btn-ghost"
                autoFocus
                onClick={() => setConfirmDiscard(false)}
              >
                Keep editing
              </button>
              <button type="button" className="flow-btn flow-btn-red" onClick={() => onClose()}>
                Discard
              </button>
            </div>
          ) : (
            <div className="bill-dialog__actions">
              <button type="button" className="flow-btn flow-btn-ghost" onClick={requestClose}>
                Cancel
              </button>
              <button type="submit" className="flow-btn flow-btn-primary" disabled={busy}>
                {busy ? "Saving…" : editing ? "Save vendor" : "Add vendor"}
              </button>
            </div>
          )}
        </form>
      </div>
    </BillDialogLayer>
  );
}
