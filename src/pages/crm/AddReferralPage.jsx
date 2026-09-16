import { useState, useEffect } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import api from "../../services/api.js";
import { URGENCIES } from "../../../shared/crmVocab.js";

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

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const canSave = form.patient_name.trim() || form.patient_phone.trim();

  const save = async () => {
    if (!canSave) return;
    setSaving(true);
    setErr(null);
    try {
      const { data } = await api.post("/api/crm/referrals", {
        referring_doctor_id: doctorId,
        ...form,
      });
      navigate(`/crm/home?referral=${encodeURIComponent(data.referral_code)}`);
    } catch (e) {
      setErr(e?.response?.data?.error || "Could not log the referral");
      setSaving(false);
    }
  };

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

      {err && <div className="rep__err">{err}</div>}

      <div className="rep__form">
        <section className="rep__field">
          <span className="rep__label">Patient</span>
          <input
            className="rep__input"
            value={form.patient_name}
            onChange={(e) => set("patient_name", e.target.value)}
            placeholder="Name"
            autoFocus
          />
          <input
            className="rep__input"
            type="tel"
            value={form.patient_phone}
            onChange={(e) => set("patient_phone", e.target.value)}
            placeholder="Phone — how we match them at registration"
          />
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
                className={`rep__chip ${form.urgency === u.value ? "rep__chip--on" : ""}`}
                onClick={() => set("urgency", u.value)}
              >
                {u.label}
              </button>
            ))}
          </div>
        </section>

        <section className="rep__field">
          <span className="rep__label">
            Reason <em>optional</em>
          </span>
          <input
            className="rep__input"
            value={form.reason_category}
            onChange={(e) => set("reason_category", e.target.value)}
            placeholder="Chest pain, second opinion…"
          />
          {/* Not a clinical note. Anything clinical belongs in the record, not
              in a field the growth team can read. */}
          <span className="rep__hint">Keep this non-clinical — a category, not a history.</span>
        </section>

        <section className="rep__field">
          <span className="rep__label">
            Expected action <em>optional</em>
          </span>
          <input
            className="rep__input"
            value={form.expected_action}
            onChange={(e) => set("expected_action", e.target.value)}
            placeholder="Cardiology opinion, admission…"
          />
        </section>
      </div>

      <div className="rep__save">
        <button
          className="rep__btn rep__btn--primary rep__btn--lg"
          onClick={save}
          disabled={saving || !canSave}
        >
          {saving ? "Saving…" : "Log referral"}
        </button>
        <span className="rep__hint rep__hint--center">
          {canSave ? "You'll own the follow-up on this one" : "A name or a phone number is needed"}
        </span>
      </div>
    </div>
  );
}
