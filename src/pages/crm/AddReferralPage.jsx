import { useState, useEffect, useRef } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import api from "../../services/api.js";
import { URGENCIES } from "../../../shared/crmVocab.js";
import {
  REFERRAL_FIELD_LIMITS,
  referralFieldError,
  referralFormErrors,
  referralPhoneDigits,
} from "../../../shared/crmReferralRules.js";
import { errorText } from "../../components/crm/import/importText.js";

const FIELD_ORDER = ["patient_name", "patient_phone", "reason_category", "expected_action"];

// Log a referral (brief §6).
//
// Same shape as the visit screen for the same reason — this is filled in on a
// phone, often while the doctor is still talking. The doctor is already chosen,
// the service line and urgency are chips, and the only typing is the patient's
// name and number.
//
// It saves as *claimed*. A rep saying a doctor sent someone is a claim until
// the patient turns up and says so themselves, at which point registration
// confirms it. That distinction is the whole of §6, so the screen says it
// rather than quietly implying the referral is banked.

export default function AddReferralPage() {
  const { doctorId } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();

  const [doctorName, setDoctorName] = useState(params.get("name") || "");
  const [lines, setLines] = useState([]);
  const [form, setForm] = useState({
    patient_name: "",
    patient_phone: "",
    reason_category: "",
    service_line_id: null,
    urgency: "routine",
    expected_action: "",
  });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState(null);
  const [errors, setErrors] = useState({});
  const [touched, setTouched] = useState({});
  const formRef = useRef(null);

  useEffect(() => {
    api
      .get("/api/crm/service-lines")
      .then(({ data }) => setLines(data))
      .catch(() => setLines([]));
    if (!doctorName) {
      api
        .get(`/api/crm/doctors/${doctorId}`)
        .then(({ data }) => setDoctorName(data.doctor.full_name))
        .catch(() => {});
    }
  }, [doctorId, doctorName]);

  const hasPatient = Boolean(form.patient_name.trim() || form.patient_phone.trim());

  const errorFor = (key, values) =>
    key === "patient_name"
      ? referralFormErrors(values).patient_name
      : referralFieldError(key, values[key]);

  const set = (k, v) =>
    setForm((f) => {
      const next = { ...f, [k]: v };
      setErrors((x) => {
        const updated = { ...x };
        for (const key of k === "patient_phone" ? [k, "patient_name"] : [k]) {
          if (touched[key] || x[key]) updated[key] = errorFor(key, next) || undefined;
        }
        return updated;
      });
      return next;
    });

  const touch = (key) => {
    setTouched((t) => ({ ...t, [key]: true }));
    setErrors((x) => ({ ...x, [key]: errorFor(key, form) || undefined }));
  };

  const save = async () => {
    const found = referralFormErrors(form);
    setErrors(found);
    setTouched(Object.fromEntries(FIELD_ORDER.map((k) => [k, true])));
    const first = FIELD_ORDER.find((k) => found[k]);
    if (first) {
      setErr(null);
      formRef.current?.querySelector(`#ref-${first}`)?.focus();
      return;
    }
    setSaving(true);
    setErr(null);
    try {
      const { data } = await api.post("/api/crm/referrals", {
        referring_doctor_id: doctorId,
        ...form,
        patient_phone: form.patient_phone ? referralPhoneDigits(form.patient_phone) : "",
      });
      navigate(`/crm/home?referral=${encodeURIComponent(data.referral_code)}`);
    } catch (e) {
      const fields = e?.response?.data?.fields;
      if (fields) setErrors(fields);
      setErr(errorText(e, "Unable to log the referral."));
      setSaving(false);
    }
  };

  const errorCount = FIELD_ORDER.filter((k) => errors[k]).length;

  const inputProps = (key, extra = {}) => ({
    id: `ref-${key}`,
    className: "rep__input",
    value: form[key],
    onChange: (e) => set(key, e.target.value),
    onBlur: () => touch(key),
    maxLength: REFERRAL_FIELD_LIMITS[key],
    "aria-invalid": Boolean(errors[key]),
    "aria-describedby": errors[key] ? `ref-${key}-err` : undefined,
    ...extra,
  });

  const fieldError = (key) =>
    errors[key] && (
      <span className="dfm__err" id={`ref-${key}-err`}>
        {errors[key]}
      </span>
    );

  return (
    <div className="rep">
      <header className="rep__bar">
        <button className="rep__back" onClick={() => navigate(-1)} aria-label="Back">
          ←
        </button>
        <div className="rep__bar-title">
          <strong>Referral from {doctorName || "…"}</strong>
          <span>Logged as claimed until the patient confirms at registration</span>
        </div>
      </header>

      {err && (
        <div className="rep__err" role="alert">
          {err}
        </div>
      )}

      <form
        className="rep__form"
        ref={formRef}
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <section className="rep__field">
          <span className="rep__label">Patient</span>
          <span className="dfm__hint">Enter the name, the mobile, or both.</span>
          <div className={`dfm__field ${errors.patient_name ? "dfm__field--err" : ""}`}>
            <label className="dfm__label" htmlFor="ref-patient_name">
              Name
            </label>
            <input
              {...inputProps("patient_name", {
                placeholder: "Ramesh Kumar",
                autoComplete: "off",
                autoFocus: true,
              })}
            />
            {fieldError("patient_name")}
          </div>
          <div className={`dfm__field ${errors.patient_phone ? "dfm__field--err" : ""}`}>
            <label className="dfm__label" htmlFor="ref-patient_phone">
              Mobile
            </label>
            <input
              {...inputProps("patient_phone", {
                type: "tel",
                inputMode: "numeric",
                autoComplete: "off",
                placeholder: "10-digit mobile",
                maxLength: 14,
                onChange: (e) => set("patient_phone", referralPhoneDigits(e.target.value)),
              })}
            />
            {errors.patient_phone ? (
              fieldError("patient_phone")
            ) : (
              <span className="dfm__hint">How we match them at registration.</span>
            )}
          </div>
        </section>

        <section className="rep__field">
          <span className="rep__label">
            Service <em>optional</em>
          </span>
          <div className="rep__chips">
            {lines.map((l) => (
              <button
                key={l.id}
                type="button"
                aria-pressed={form.service_line_id === l.id}
                className={`rep__chip ${form.service_line_id === l.id ? "rep__chip--on" : ""}`}
                onClick={() => set("service_line_id", form.service_line_id === l.id ? null : l.id)}
              >
                {l.name}
              </button>
            ))}
          </div>
        </section>

        <section className="rep__field">
          <span className="rep__label">Urgency</span>
          <div className="rep__chips">
            {URGENCIES.map((u) => (
              <button
                key={u.value}
                type="button"
                aria-pressed={form.urgency === u.value}
                className={`rep__chip ${form.urgency === u.value ? "rep__chip--on" : ""}`}
                onClick={() => set("urgency", u.value)}
              >
                {u.label}
              </button>
            ))}
          </div>
        </section>

        <section className={`rep__field ${errors.reason_category ? "dfm__field--err" : ""}`}>
          <label className="rep__label" htmlFor="ref-reason_category">
            Reason <em>optional</em>
          </label>
          <input
            {...inputProps("reason_category", { placeholder: "Chest pain, second opinion…" })}
          />
          {fieldError("reason_category")}
          {/* Not a clinical note. Anything clinical belongs in the record, not
              in a field the growth team can read. */}
          <span className="rep__hint">Keep this non-clinical — a category, not a history.</span>
        </section>

        <section className={`rep__field ${errors.expected_action ? "dfm__field--err" : ""}`}>
          <label className="rep__label" htmlFor="ref-expected_action">
            Expected action <em>optional</em>
          </label>
          <input
            {...inputProps("expected_action", { placeholder: "Cardiology opinion, admission…" })}
          />
          {fieldError("expected_action")}
        </section>

        <div className="rep__save">
          <button
            type="submit"
            className="rep__btn rep__btn--primary rep__btn--lg"
            disabled={saving}
          >
            {saving ? "Saving…" : "Log referral"}
          </button>
          <span className="rep__hint rep__hint--center" role="status">
            {errorCount
              ? `Fix ${errorCount} highlighted field${errorCount === 1 ? "" : "s"} before saving.`
              : hasPatient
                ? "You'll own the follow-up on this one"
                : "A name or a mobile number is needed"}
          </span>
        </div>
      </form>
    </div>
  );
}
