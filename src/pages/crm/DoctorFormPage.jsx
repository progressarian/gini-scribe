import { cloneElement, isValidElement, Fragment, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import api from "../../services/api.js";
import ConfirmModal from "../../components/ui/ConfirmModal.jsx";
import { errorText } from "../../components/crm/import/importText.js";
import { DOCTOR_PRIORITIES, specialtyFromList } from "../../../shared/crmVocab.js";
import { isValidMobile, toEntryDigits } from "../../../shared/phone.js";
import { DOCTOR_REQUIRED_MESSAGES, doctorFieldError } from "../../../shared/crmDoctorRules.js";

const OTHER = "__other";
const REQUIRED_KEYS = ["full_name", "specialty", "mobile", "area"];
const CHECKED_KEYS = [
  "full_name",
  "specialty",
  "qualifications",
  "mobile",
  "whatsapp",
  "clinic_phone",
  "email",
  "clinic_name",
  "address_line",
  "area",
  "city",
  "pin_code",
  "notes",
];
const SANITISE = {
  mobile: toEntryDigits,
  whatsapp: toEntryDigits,
  pin_code: (v) => v.replace(/\D/g, "").slice(0, 6),
  clinic_phone: (v) => v.replace(/[^\d+\s-]/g, "").slice(0, 18),
};

const EMPTY = {
  full_name: "",
  specialty: "",
  qualifications: "",
  mobile: "",
  whatsapp: "",
  clinic_phone: "",
  email: "",
  clinic_name: "",
  address_line: "",
  area: "",
  city: "",
  pin_code: "",
  territory_id: "",
  priority: "unclassified",
  notes: "",
  owner_id: "",
};

const fromDoctor = (d) => Object.fromEntries(Object.keys(EMPTY).map((k) => [k, d[k] ?? EMPTY[k]]));

export default function DoctorFormPage() {
  const { doctorId } = useParams();
  const editing = Boolean(doctorId);
  const navigate = useNavigate();

  const [options, setOptions] = useState(null);
  const [original, setOriginal] = useState(null);
  const [form, setForm] = useState(EMPTY);
  const [specialtyPick, setSpecialtyPick] = useState("");
  const [sameWhatsapp, setSameWhatsapp] = useState(false);
  const [loadErr, setLoadErr] = useState(null);
  const [errors, setErrors] = useState({});
  const [touched, setTouched] = useState({});
  const [err, setErr] = useState(null);
  const [stale, setStale] = useState(false);
  const [saving, setSaving] = useState(false);
  const [mobileNote, setMobileNote] = useState(null);
  const [similar, setSimilar] = useState(null);
  const [online, setOnline] = useState(navigator.onLine !== false);

  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, []);

  useEffect(() => {
    let alive = true;
    Promise.all([
      api.get("/api/crm/doctors/form-options"),
      editing ? api.get(`/api/crm/doctors/${doctorId}/edit`) : Promise.resolve(null),
    ])
      .then(([opts, doc]) => {
        if (!alive) return;
        setOptions(opts.data);
        if (doc) {
          const values = fromDoctor(doc.data.doctor);
          const listed = specialtyFromList(values.specialty);
          setSpecialtyPick(values.specialty ? listed || OTHER : "");
          if (listed) values.specialty = listed;
          setSameWhatsapp(Boolean(values.mobile) && values.whatsapp === values.mobile);
          setOriginal({ ...doc.data.doctor, ...fromDoctor(doc.data.doctor) });
          setForm(values);
        }
      })
      .catch((e) => alive && setLoadErr(errorText(e, "Unable to load the doctor form.")));
    return () => {
      alive = false;
    };
  }, [doctorId, editing]);

  const isRequired = (key) => REQUIRED_KEYS.includes(key) && (!editing || Boolean(original?.[key]));

  const errorFor = (key, values, pick = specialtyPick, same = sameWhatsapp) => {
    if (key === "whatsapp" && same) return null;
    const value = String(values[key] ?? "").trim();
    if (!value) return isRequired(key) ? DOCTOR_REQUIRED_MESSAGES[key] : null;
    if (key === "specialty" && pick !== OTHER) return null;
    return doctorFieldError(key, value);
  };

  const set = (key) => (e) => {
    const raw = e?.target ? e.target.value : e;
    const value = SANITISE[key] ? SANITISE[key](raw) : raw;
    setForm((f) => {
      const next = { ...f, [key]: value };
      if (touched[key] || errors[key]) {
        setErrors((x) => ({ ...x, [key]: errorFor(key, next) || undefined }));
      }
      return next;
    });
  };

  const touch = (key) => {
    setTouched((t) => ({ ...t, [key]: true }));
    setErrors((x) => ({ ...x, [key]: errorFor(key, form) || undefined }));
  };

  const payloadValues = useMemo(() => {
    const values = { ...form };
    if (sameWhatsapp) values.whatsapp = values.mobile;
    return values;
  }, [form, sameWhatsapp]);

  const changed = useMemo(() => {
    if (!editing || !original) return null;
    return Object.fromEntries(
      Object.entries(payloadValues).filter(
        ([k, v]) => (k !== "owner_id" || options?.can_assign) && (original[k] ?? "") !== (v ?? ""),
      ),
    );
  }, [editing, original, payloadValues, options]);

  const checkMobileNow = async () => {
    setMobileNote(null);
    if (!isValidMobile(form.mobile) || (editing && form.mobile === original?.mobile)) return;
    try {
      const { data } = await api.get("/api/crm/doctors/check-mobile", {
        params: { mobile: form.mobile, except: doctorId },
      });
      if (data.taken) setMobileNote(data);
    } catch {
      setMobileNote(null);
    }
  };

  const localErrors = () =>
    Object.fromEntries(
      CHECKED_KEYS.map((k) => [k, errorFor(k, form)]).filter(([, problem]) => problem),
    );

  const focusFirst = (found) => {
    const first = CHECKED_KEYS.find((k) => found[k]);
    if (!first) return;
    const id =
      first === "specialty" && specialtyPick === OTHER ? "dfm-specialty-other" : `dfm-${first}`;
    const el = document.getElementById(id);
    el?.focus();
    el?.scrollIntoView({ block: "center", behavior: "smooth" });
  };

  const save = async (confirmSimilar = false) => {
    const found = localErrors();
    setErrors(found);
    setTouched(Object.fromEntries(CHECKED_KEYS.map((k) => [k, true])));
    setErr(null);
    if (Object.keys(found).length) {
      const n = Object.keys(found).length;
      setErr(`Fix ${n} highlighted field${n === 1 ? "" : "s"} before saving.`);
      focusFirst(found);
      return;
    }
    if (editing && changed && Object.keys(changed).length === 0) {
      navigate(`/crm/doctor/${doctorId}`);
      return;
    }
    setSaving(true);
    try {
      if (editing) {
        await api.put(`/api/crm/doctors/${doctorId}`, {
          ...changed,
          updated_at: original.updated_at,
        });
        navigate(`/crm/doctor/${doctorId}?saved=1`, { replace: true });
      } else {
        const body = { ...payloadValues, confirm_similar: confirmSimilar };
        if (!options?.can_assign) delete body.owner_id;
        const { data } = await api.post("/api/crm/doctors", body);
        navigate(`/crm/doctor/${data.id}?added=1`, { replace: true });
      }
    } catch (e) {
      const body = e?.response?.data || {};
      if (body.code === "similar") {
        setSimilar(body);
      } else {
        if (body.fields) {
          setErrors(body.fields);
          focusFirst(body.fields);
        }
        if (body.code === "stale") setStale(true);
        if (body.code === "mobile_taken") setMobileNote({ ...body, message: body.error });
        setErr(errorText(e, "Unable to save the doctor. Please try again."));
      }
    } finally {
      setSaving(false);
    }
  };

  if (loadErr) {
    return (
      <div className="rep dfm">
        <div className="rep__err" role="alert">
          {loadErr}{" "}
          <Link to="/crm/home" className="rep__link">
            Back to CRM home
          </Link>
        </div>
      </div>
    );
  }
  if (!options) {
    return (
      <div className="rep dfm">
        <div className="rep__loading">Loading…</div>
      </div>
    );
  }

  const field = (key, label, input, { required, hint, was } = {}) => (
    <div className={`dfm__field ${errors[key] ? "dfm__field--err" : ""}`}>
      <label className="dfm__label" htmlFor={`dfm-${key}`}>
        {label}
        {required && (
          <span className="dfm__req" aria-hidden="true">
            {" "}
            *
          </span>
        )}
      </label>
      {required && isValidElement(input) && input.type !== Fragment
        ? cloneElement(input, { "aria-required": true })
        : input}
      {was && <span className="dfm__was">Was: {was}</span>}
      {hint && !errors[key] && (
        <span className="dfm__hint" id={`dfm-${key}-hint`}>
          {hint}
        </span>
      )}
      {errors[key] && (
        <span className="dfm__err" id={`dfm-${key}-err`}>
          {errors[key]}
        </span>
      )}
    </div>
  );

  const inputProps = (key, extra = {}) => ({
    id: `dfm-${key}`,
    className: "rep__input",
    value: form[key] ?? "",
    onChange: set(key),
    onBlur: () => touch(key),
    "aria-invalid": Boolean(errors[key]),
    "aria-describedby": errors[key] ? `dfm-${key}-err` : `dfm-${key}-hint`,
    ...extra,
  });

  const requiredOnEdit = (key) => !editing || Boolean(original?.[key]);
  const nameWas =
    editing && original && form.full_name.trim() !== original.full_name ? original.full_name : null;
  const mobileWas =
    editing && original?.mobile && form.mobile !== original.mobile ? original.mobile : null;

  return (
    <div className="rep dfm">
      <header className="rep__bar">
        <button type="button" className="rep__back" onClick={() => navigate(-1)} aria-label="Back">
          ←
        </button>
        <div className="rep__bar-title">
          <strong>{editing ? `Edit ${original?.full_name || "doctor"}` : "Add doctor"}</strong>
          <span>
            {editing
              ? "Changes save straight away and show in the doctor's history."
              : options.can_assign
                ? "Choose who the doctor is assigned to, or leave unassigned."
                : "The doctor will be added to your list."}
          </span>
        </div>
      </header>

      {!online && (
        <div className="rep__notice" role="status">
          You are offline. Connect to the internet to save this doctor.
        </div>
      )}
      {err && (
        <div className="rep__err" role="alert">
          {err}{" "}
          {stale && (
            <button type="button" className="asg__link" onClick={() => window.location.reload()}>
              Reload
            </button>
          )}
        </div>
      )}

      <form
        className="dfm__form"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <fieldset className="dfm__group">
          <legend>Doctor</legend>
          {field(
            "full_name",
            "Name",
            <input {...inputProps("full_name", { autoComplete: "off", maxLength: 120 })} />,
            { required: true, hint: "“Dr” is added for you.", was: nameWas },
          )}
          {field(
            "specialty",
            "Specialty",
            <>
              <select
                id="dfm-specialty"
                aria-required={requiredOnEdit("specialty")}
                className="rep__input"
                value={specialtyPick}
                aria-invalid={Boolean(errors.specialty)}
                onBlur={() => touch("specialty")}
                onChange={(e) => {
                  const pick = e.target.value;
                  const value = pick === OTHER ? "" : pick;
                  setSpecialtyPick(pick);
                  setForm((f) => ({ ...f, specialty: value }));
                  if (touched.specialty || errors.specialty) {
                    setErrors((x) => ({
                      ...x,
                      specialty:
                        errorFor("specialty", { ...form, specialty: value }, pick) || undefined,
                    }));
                  }
                }}
              >
                <option value="">Choose…</option>
                {options.specialties.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
                <option value={OTHER}>Other (type it)</option>
              </select>
              {specialtyPick === OTHER && (
                <input
                  {...inputProps("specialty", {
                    id: "dfm-specialty-other",
                    placeholder: "Type the specialty",
                    maxLength: 80,
                    "aria-label": "Other specialty",
                  })}
                />
              )}
            </>,
            { required: requiredOnEdit("specialty") },
          )}
          {field(
            "qualifications",
            "Qualifications",
            <input
              {...inputProps("qualifications", { placeholder: "MBBS, MD", maxLength: 120 })}
            />,
          )}
        </fieldset>

        <fieldset className="dfm__group">
          <legend>Contact</legend>
          {field(
            "mobile",
            "Mobile",
            <input
              {...inputProps("mobile", {
                type: "tel",
                inputMode: "numeric",
                placeholder: "98765 43210",
                onChange: (e) => {
                  set("mobile")(e.target.value);
                  setMobileNote(null);
                },
                onBlur: () => {
                  touch("mobile");
                  checkMobileNow();
                },
              })}
            />,
            {
              required: requiredOnEdit("mobile"),
              was: mobileWas,
              hint:
                editing && !original?.mobile
                  ? "Mobile missing — add it when you can."
                  : "10 digits, starting 6-9.",
            },
          )}
          {mobileNote && (
            <div className="rep__notice dfm__wide" role="status">
              {mobileNote.message}{" "}
              {mobileNote.doctor_id && (
                <Link to={`/crm/doctor/${mobileNote.doctor_id}`} className="rep__link">
                  Open {mobileNote.doctor_name}
                </Link>
              )}
            </div>
          )}
          <div className={`dfm__field ${errors.whatsapp ? "dfm__field--err" : ""}`}>
            <div className="dfm__label-row">
              <span className="dfm__label">WhatsApp</span>
              <label className="rep__check dfm__check">
                <input
                  type="checkbox"
                  checked={sameWhatsapp}
                  onChange={(e) => {
                    setSameWhatsapp(e.target.checked);
                    setErrors((x) => ({
                      ...x,
                      whatsapp:
                        errorFor("whatsapp", form, specialtyPick, e.target.checked) || undefined,
                    }));
                  }}
                />
                Same as mobile
              </label>
            </div>
            {!sameWhatsapp && (
              <input
                {...inputProps("whatsapp", {
                  type: "tel",
                  inputMode: "numeric",
                  "aria-label": "WhatsApp number",
                })}
              />
            )}
            {errors.whatsapp && (
              <span className="dfm__err" id="dfm-whatsapp-err">
                {errors.whatsapp}
              </span>
            )}
          </div>
          {field(
            "clinic_phone",
            "Clinic phone",
            <input {...inputProps("clinic_phone", { type: "tel", maxLength: 18 })} />,
          )}
          {field(
            "email",
            "Email",
            <input {...inputProps("email", { type: "email", maxLength: 150 })} />,
          )}
        </fieldset>

        <fieldset className="dfm__group">
          <legend>Clinic</legend>
          {field(
            "clinic_name",
            "Clinic name",
            <input {...inputProps("clinic_name", { maxLength: 150 })} />,
          )}
          {field(
            "address_line",
            "Address",
            <input
              {...inputProps("address_line", { placeholder: "Shop / SCO, street", maxLength: 300 })}
            />,
          )}
          {field(
            "area",
            "Area",
            <input
              {...inputProps("area", { placeholder: "Sector 70, Sohana…", maxLength: 100 })}
            />,
            { required: requiredOnEdit("area") },
          )}
          {field("city", "City", <input {...inputProps("city", { maxLength: 80 })} />)}
          {field(
            "pin_code",
            "PIN",
            <input {...inputProps("pin_code", { inputMode: "numeric", maxLength: 6 })} />,
          )}
          {field(
            "territory_id",
            "Territory",
            <select {...inputProps("territory_id")}>
              <option value="">No territory</option>
              {options.territories.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>,
          )}
        </fieldset>

        <fieldset className="dfm__group">
          <legend>Classification</legend>
          {field(
            "priority",
            "Priority",
            <select {...inputProps("priority")}>
              {DOCTOR_PRIORITIES.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.value === "unclassified" ? "Not set" : p.label}
                </option>
              ))}
            </select>,
          )}
          {options.can_assign &&
            field(
              "owner_id",
              "Assigned to",
              <select {...inputProps("owner_id")}>
                <option value="">Unassigned</option>
                {options.staff.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.full_name}
                  </option>
                ))}
              </select>,
            )}
          <label className="dfm__field dfm__wide">
            <span className="dfm__label">Notes</span>
            <textarea
              className="rep__notes"
              rows={3}
              maxLength={2000}
              value={form.notes ?? ""}
              onChange={set("notes")}
            />
          </label>
        </fieldset>

        <div className="dfm__actions">
          <button type="button" className="rep__btn" onClick={() => navigate(-1)} disabled={saving}>
            Cancel
          </button>
          <button type="submit" className="rep__btn rep__btn--primary" disabled={saving || !online}>
            {saving ? "Saving…" : editing ? "Save changes" : "Add doctor"}
          </button>
        </div>
      </form>

      <ConfirmModal
        open={Boolean(similar)}
        variant="primary"
        title="This may be the same doctor"
        cancelLabel="Go back"
        confirmLabel="Add anyway"
        onCancel={() => setSimilar(null)}
        onConfirm={() => {
          setSimilar(null);
          save(true);
        }}
        message={
          similar && (
            <>
              <p>{similar.error}</p>
              <ul className="dfm__similar">
                {similar.similar.map((d) => (
                  <li key={d.id}>
                    <Link to={`/crm/doctor/${d.id}`}>{d.full_name}</Link>
                    {` · ${d.area || "No area"}${d.mobile ? ` · ${d.mobile}` : ""}`}
                  </li>
                ))}
              </ul>
            </>
          )
        }
      />
    </div>
  );
}
