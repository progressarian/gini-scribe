import FormField from "../ui/FormField";
import MasterFormDialog from "./MasterFormDialog";
import useMasterForm from "./useMasterForm";
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
const digits = (v) => v.replace(/\D/g, "");
const upper = (v) => v.toUpperCase().replace(/\s/g, "");

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

const validate = (form) =>
  Object.fromEntries(
    Object.entries(RULES)
      .map(([field, rule]) => [field, rule(form[field])])
      .filter(([, message]) => message),
  );

const payload = (form) => ({
  ...Object.fromEntries(TEXT_FIELDS.map((f) => [f, form[f].trim() || null])),
  name: form.name.trim(),
  payment_terms_days: Number(form.payment_terms_days) || 0,
});

const mutations = { useCreate: useCreateVendor, useUpdate: useUpdateVendor };

export default function VendorDialog({ record: vendor, onClose }) {
  const f = useMasterForm({
    record: vendor,
    initial: formOf(vendor),
    validate,
    payload,
    mutations,
    noun: "vendor",
    onClose,
  });

  return (
    <MasterFormDialog
      title={f.editing ? `Edit ${vendor.name}` : "Add vendor"}
      dirty={f.dirty}
      busy={f.busy}
      error={f.error}
      submitLabel={f.editing ? "Save vendor" : "Add vendor"}
      onSubmit={f.submit}
      onClose={onClose}
    >
      <h3 className="phv-section">Contact</h3>
      <div className="bill-form">
        {f.input(
          "name",
          "Vendor name",
          { maxLength: 160, placeholder: "e.g. Mohali Pharma Distributors" },
          { required: true, className: "phv-span2" },
        )}
        {f.input("contact_person", "Contact person", { maxLength: 120 })}
        {f.input(
          "phone",
          "Phone",
          { inputMode: "numeric", maxLength: 12, placeholder: "10 to 12 digits" },
          { required: true, clean: digits },
        )}
        {f.input(
          "alt_phone",
          "Alternate phone",
          { inputMode: "numeric", maxLength: 12 },
          { clean: digits },
        )}
        {f.input("email", "Email", { type: "email", maxLength: 160 })}
      </div>

      <h3 className="phv-section">Address</h3>
      <div className="bill-form">
        {f.input("address", "Address", { maxLength: 500 }, { className: "phv-span2" })}
        {f.input("city", "City", { maxLength: 80 })}
        {f.input("state", "State", { maxLength: 80 })}
        {f.input("pincode", "Pincode", { inputMode: "numeric", maxLength: 6 }, { clean: digits })}
      </div>

      <h3 className="phv-section">Tax and licence</h3>
      <div className="bill-form">
        {f.input(
          "gstin",
          "GSTIN",
          { maxLength: 15, placeholder: "03ABCDE1234F1Z5" },
          { clean: upper },
        )}
        {f.input("pan", "PAN", { maxLength: 10, placeholder: "ABCDE1234F" }, { clean: upper })}
        {f.input("drug_license_no", "Drug licence number", { maxLength: 80 })}
        {f.date("drug_license_expiry", "Drug licence expiry")}
      </div>

      <h3 className="phv-section">Payment</h3>
      <div className="bill-form">
        {f.input(
          "payment_terms_days",
          "Payment terms (days)",
          { inputMode: "numeric", maxLength: 3, placeholder: "0" },
          { hint: "Days allowed to pay an invoice. 0 means on delivery.", clean: digits },
        )}
        {f.input("bank_name", "Bank name", { maxLength: 120 })}
        {f.input(
          "bank_account",
          "Account number",
          { inputMode: "numeric", maxLength: 20 },
          { clean: digits },
        )}
        {f.input("ifsc", "IFSC", { maxLength: 11, placeholder: "HDFC0001234" }, { clean: upper })}
      </div>

      <div className="bill-form">
        <FormField label="Notes" className="phv-span-all">
          <textarea
            className="jb-assign"
            rows={2}
            maxLength={1000}
            value={f.form.notes}
            onChange={f.setField("notes")}
          />
        </FormField>
      </div>
    </MasterFormDialog>
  );
}
