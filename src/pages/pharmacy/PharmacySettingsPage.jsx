import { useState } from "react";
import FormField from "../../components/ui/FormField";
import { requestErrorOf } from "../../components/billing/format";
import { when } from "../../components/billing/importText";
import { toast } from "../../stores/uiStore";
import SeriesCard from "../../components/billing/SeriesCard";
import {
  usePharmacySeries,
  usePharmacySettings,
  useSavePharmacySeries,
  useSavePharmacySettings,
} from "../../queries/hooks/usePharmacySettings";
import { GSTIN_HINT, PHARMACY_SERIES, isValidGstin } from "../../../shared/pharmacyVocab";
import "../../styles/flow.css";
import "../flow/FlowSettings.css";
import "../billing/billing.css";
import "../billing/billingUi.css";
import "./pharmacyStock.css";
import "./pharmacyVendors.css";

const SERIES_LABEL = {
  [PHARMACY_SERIES.bill]: "Pharmacy bills",
  [PHARMACY_SERIES.receipt]: "Pharmacy receipts",
  [PHARMACY_SERIES.credit_note]: "Pharmacy credit notes",
};

const TEXT = ["legal_name", "gstin", "drug_license_no", "address", "phone", "bill_footer"];

const text = (v) => (v === null || v === undefined ? "" : String(v));

const formOf = (s) => ({
  ...Object.fromEntries(TEXT.map((f) => [f, text(s[f])])),
  sale_rate_includes_gst: s.sale_rate_includes_gst,
  near_expiry_warn_days: text(s.near_expiry_warn_days),
  expiry_alert_days: text(s.expiry_alert_days),
  credit_limit:
    s.credit_limit === null || s.credit_limit === undefined ? "" : String(Number(s.credit_limit)),
});

function validate(form) {
  const errors = {};
  if (form.gstin && !isValidGstin(form.gstin)) errors.gstin = GSTIN_HINT;
  if (form.phone && !/^[0-9]{10,12}$/.test(form.phone))
    errors.phone = "Enter a 10 to 12 digit phone number.";
  const warn = Number(form.near_expiry_warn_days);
  const alert = Number(form.expiry_alert_days);
  if (!/^\d{1,3}$/.test(form.near_expiry_warn_days) || warn > 365)
    errors.near_expiry_warn_days = "Enter a number of days from 0 to 365.";
  if (!/^\d{1,3}$/.test(form.expiry_alert_days) || alert < 1 || alert > 730)
    errors.expiry_alert_days = "Enter a number of days from 1 to 730.";
  else if (!errors.near_expiry_warn_days && alert < warn)
    errors.expiry_alert_days = "This cannot be fewer days than the near-expiry warning.";
  if (
    form.max_discount_pct &&
    (!/^\d{1,3}(\.\d{1,2})?$/.test(form.max_discount_pct) || Number(form.max_discount_pct) > 100)
  )
    errors.max_discount_pct = "Enter a percentage from 0 to 100, or leave it blank for no limit.";
  if (form.credit_limit && !/^\d{1,8}(\.\d{1,2})?$/.test(form.credit_limit))
    errors.credit_limit = "Enter an amount in rupees, like 5000, or leave it blank for no limit.";
  return errors;
}

const money = (v) => {
  const clean = v.replace(/[^\d.]/g, "");
  const [whole, ...rest] = clean.split(".");
  return rest.length ? `${whole}.${rest.join("").slice(0, 2)}` : whole;
};

const digits = (v) => v.replace(/\D/g, "");
const upper = (v) => v.toUpperCase().replace(/\s/g, "");

function SettingsForm({ settings }) {
  const save = useSavePharmacySettings();
  const [form, setForm] = useState(() => formOf(settings));
  const [touched, setTouched] = useState(false);
  const [error, setError] = useState("");
  const errors = touched ? validate(form) : {};
  const dirty = JSON.stringify(form) !== JSON.stringify(formOf(settings));

  const set = (field, clean) => (e) => {
    const raw = e.target.type === "checkbox" ? e.target.checked : e.target.value;
    setForm((f) => ({ ...f, [field]: clean ? clean(raw) : raw }));
  };

  const input = (name, label, props = {}, extra = {}) => (
    <FormField label={label} hint={extra.hint} error={errors[name]} className={extra.className}>
      <input
        className="jb-assign"
        value={form[name]}
        onChange={set(name, extra.clean)}
        {...props}
      />
    </FormField>
  );

  const submit = (e) => {
    e.preventDefault();
    setTouched(true);
    setError("");
    if (Object.keys(validate(form)).length) {
      setError("Fix the highlighted fields, then save again.");
      return;
    }
    persist();
  };

  const persist = async () => {
    try {
      await save.mutateAsync({
        ...Object.fromEntries(TEXT.map((f) => [f, form[f].trim() || null])),
        sale_rate_includes_gst: form.sale_rate_includes_gst,
        near_expiry_warn_days: Number(form.near_expiry_warn_days),
        expiry_alert_days: Number(form.expiry_alert_days),
        credit_limit: form.credit_limit === "" ? null : Number(form.credit_limit),
        max_discount_pct: form.max_discount_pct === "" ? null : Number(form.max_discount_pct),
        version: settings.version,
      });
      toast("Pharmacy settings saved.");
      setTouched(false);
    } catch (err) {
      setError(requestErrorOf(err, "Could not save the pharmacy settings"));
    }
  };

  return (
    <form className="flow-card phset" onSubmit={submit} noValidate aria-label="Pharmacy settings">
      <h2 className="flow-sec-title">Bill header</h2>
      <p className="flow-muted">
        Printed at the top of pharmacy bills. Leave a field blank to use the hospital's billing
        details instead.
      </p>
      <div className="bill-form">
        {input("legal_name", "Legal name", { maxLength: 200 }, { className: "phv-span2" })}
        {input("gstin", "GSTIN", { maxLength: 15 }, { clean: upper })}
        {input(
          "drug_license_no",
          "Drug licence numbers",
          { maxLength: 200, placeholder: "e.g. 20B-1234, 21B-1235" },
          { className: "phv-span2" },
        )}
        {input("phone", "Phone", { inputMode: "numeric", maxLength: 12 }, { clean: digits })}
        {input("address", "Address", { maxLength: 500 }, { className: "phv-span-all" })}
        {input(
          "bill_footer",
          "Bill footer",
          {
            maxLength: 500,
            placeholder: "e.g. Goods once sold will be taken back only with the bill",
          },
          { className: "phv-span-all" },
        )}
      </div>

      <h2 className="flow-sec-title phset__section">Pricing</h2>
      <label className="fset__check phset__check">
        <input
          type="checkbox"
          checked={form.sale_rate_includes_gst}
          onChange={set("sale_rate_includes_gst")}
        />
        Sale rates already include GST
      </label>
      <p className="flow-muted">
        {form.sale_rate_includes_gst
          ? "A sale rate of ₹105 at 5% GST is billed as ₹100 + ₹5 GST."
          : "A sale rate of ₹100 at 5% GST is billed as ₹100 + ₹5 GST = ₹105."}{" "}
        IPD and department bills always fold the GST into the rate and show 0% GST.
      </p>

      <h2 className="flow-sec-title phset__section">Expiry</h2>
      <div className="bill-form">
        {input(
          "near_expiry_warn_days",
          "Near-expiry warning (days)",
          { inputMode: "numeric", maxLength: 3 },
          {
            clean: digits,
            hint: "Billing a batch that expires within this many days needs a confirmation",
          },
        )}
        {input(
          "expiry_alert_days",
          "Expiry alert (days)",
          { inputMode: "numeric", maxLength: 3 },
          {
            clean: digits,
            hint: "Batches expiring within this many days are listed for return to the vendor",
          },
        )}
      </div>

      <h2 className="flow-sec-title phset__section">Discounts and credit</h2>
      <div className="bill-form">
        {input(
          "max_discount_pct",
          "Maximum discount %",
          { inputMode: "decimal", maxLength: 6, placeholder: "No limit" },
          {
            clean: money,
            hint: "The most a pharmacist can give on one item or on the whole bill. Leave blank for no limit",
          },
        )}
        {input(
          "credit_limit",
          "Credit limit per patient (₹)",
          { inputMode: "decimal", maxLength: 11, placeholder: "No limit" },
          {
            clean: money,
            hint: "The most one patient may owe the pharmacy at a time. Leave blank for no limit",
          },
        )}
      </div>

      {error ? (
        <p className="bill-dialog__error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="phset__actions">
        <span className="phs-meta">
          {settings.updated_by_name
            ? `Last changed by ${settings.updated_by_name}, ${when(settings.updated_at)}`
            : null}
        </span>
        <button
          type="submit"
          className="flow-btn flow-btn-primary"
          disabled={!dirty || save.isPending}
        >
          {save.isPending ? "Saving…" : "Save settings"}
        </button>
      </div>
    </form>
  );
}

export default function PharmacySettingsPage() {
  const settings = usePharmacySettings();
  return (
    <div className="flow-root fset bill-ui phs">
      <header className="phs-head">
        <div>
          <h1 className="phs-title">Pharmacy settings</h1>
          <p className="phs-sub">Bill header, pricing and expiry rules for the pharmacy.</p>
        </div>
      </header>
      {settings.isError ? (
        <div className="phs-empty" role="alert">
          <p>Unable to load the pharmacy settings.</p>
          <button
            type="button"
            className="flow-btn flow-btn-ghost"
            onClick={() => settings.refetch()}
          >
            Try again
          </button>
        </div>
      ) : settings.isLoading ? (
        <p className="phs-empty" role="status">
          Loading settings…
        </p>
      ) : (
        <SettingsForm key={settings.data.version} settings={settings.data} />
      )}
      <SeriesCard
        series={Object.values(PHARMACY_SERIES)}
        labels={SERIES_LABEL}
        useSeries={usePharmacySeries}
        useSave={useSavePharmacySeries}
        description="Pharmacy bill, receipt and credit note numbers are separate from the hospital's and start again each financial year (April–March). Set up bills and receipts before the counter starts billing, and credit notes before the first return."
      />
    </div>
  );
}
