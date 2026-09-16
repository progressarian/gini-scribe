import { useState, useEffect, useMemo, useRef } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import api from "../../services/api.js";
import { useDictation } from "../../hooks/useDictation.js";
import { enqueue, drain } from "../../crm/offlineQueue.js";
import { VISIT_TYPES, VISIT_OUTCOMES } from "../../../shared/crmVocab.js";

// Log a visit in under a minute, standing in a corridor (brief §5).
//
// The clock starts when the rep taps a doctor, so every decision here is about
// removing keystrokes: the doctor is already chosen, type/purpose/outcome are
// chips rather than dropdowns, the next-visit date arrives pre-filled from the
// cadence policy, and notes are optional. A visit with nothing but a doctor and
// a type is a valid visit — an empty log beats a log nobody filled in.
//
// Save never waits on the network. The visit goes to the local queue and the
// screen returns immediately; the queue drains when there is signal.

const PURPOSES = [
  "Introduction",
  "Relationship",
  "Service update",
  "Referral follow-up",
  "Issue / complaint",
  "CME invite",
];

const GAP_PROMPTS = {
  mobile: { label: "Add mobile?", field: "mobile", type: "tel", placeholder: "98765 43210" },
  specialty: { label: "Add specialty?", field: "specialty", placeholder: "Orthopedics" },
  clinic: { label: "Add clinic?", field: "clinic_name", placeholder: "Clinic or hospital" },
  area: { label: "Add area?", field: "area", placeholder: "Sector / locality" },
};

export default function AddVisitPage() {
  const { doctorId } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();

  const [doctor, setDoctor] = useState(null);
  const [visitType, setVisitType] = useState("in_person");
  const [purpose, setPurpose] = useState(null);
  const [outcome, setOutcome] = useState(null);
  const [notes, setNotes] = useState("");
  const [followUp, setFollowUp] = useState(false);
  const [nextVisit, setNextVisit] = useState("");
  const [cadence, setCadence] = useState(null);
  const [saving, setSaving] = useState(false);
  const [gapValue, setGapValue] = useState("");
  const [openGap, setOpenGap] = useState(null);
  const [gapSaved, setGapSaved] = useState([]);
  const [err, setErr] = useState(null);

  // Minted here, not on the server. This is the whole basis of the offline
  // story: the id exists before the network is involved, so a retry is a no-op
  // rather than a second visit.
  const visitId = useMemo(() => crypto.randomUUID(), []);
  const startedAt = useRef(Date.now());

  const dictation = useDictation({
    onTranscript: (text) => setNotes((n) => (n ? `${n} ${text}` : text)),
  });

  useEffect(() => {
    let alive = true;
    api
      .get("/api/crm/home")
      .then(({ data }) => {
        if (!alive) return;
        const d = data.my_doctors.find((x) => x.doctor_id === doctorId);
        setDoctor(d || { doctor_id: doctorId, full_name: params.get("name") || "Doctor" });
      })
      .catch(() => setDoctor({ doctor_id: doctorId, full_name: params.get("name") || "Doctor" }));
    api
      .get(`/api/crm/doctors/${doctorId}/next-visit`)
      .then(({ data }) => {
        if (!alive || !data?.next_visit_date) return;
        setCadence(data);
        setNextVisit(data.next_visit_date);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [doctorId, params]);

  const gaps = (doctor?.missing_fields || []).filter(
    (g) => !gapSaved.includes(g) && GAP_PROMPTS[g],
  );

  const saveGap = async () => {
    const prompt = GAP_PROMPTS[openGap];
    if (!prompt || !gapValue.trim()) return setOpenGap(null);
    try {
      await api.patch(`/api/crm/doctors/${doctorId}`, { [prompt.field]: gapValue.trim() });
      setGapSaved((s) => [...s, openGap]);
    } catch (e) {
      setErr(e?.response?.data?.error || "Could not save that");
    } finally {
      setOpenGap(null);
      setGapValue("");
    }
  };

  // One permission prompt, and it never blocks the save. If the rep declines,
  // or the fix takes too long, the visit is logged without a location.
  const captureGps = () =>
    new Promise((resolve) => {
      if (!navigator.geolocation) return resolve(null);
      const done = (v) => resolve(v);
      const timer = setTimeout(() => done(null), 4000);
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          clearTimeout(timer);
          done({
            latitude: pos.coords.latitude,
            longitude: pos.coords.longitude,
            accuracy: pos.coords.accuracy,
            captured_at: new Date().toISOString(),
          });
        },
        () => {
          clearTimeout(timer);
          done(null);
        },
        { enableHighAccuracy: false, timeout: 4000, maximumAge: 300_000 },
      );
    });

  const save = async () => {
    setSaving(true);
    setErr(null);
    const gps = await captureGps();
    const nowIso = new Date().toISOString();
    const visit = {
      id: visitId,
      doctor_id: doctorId,
      visit_type: visitType,
      purpose,
      outcome,
      discussion_notes: notes.trim() || null,
      follow_up_required: followUp,
      next_visit_date: nextVisit || null,
      occurred_at: nowIso,
      client_created_at: nowIso,
      gps,
    };

    // Durable before anything else happens. If the browser dies on the next
    // line, the visit is still on the phone.
    enqueue(visit);
    drain((v) => api.post("/api/crm/visits", v).then((r) => r.data), {
      online: navigator.onLine !== false,
    }).catch(() => {});

    const seconds = Math.round((Date.now() - startedAt.current) / 1000);
    navigate(`/crm/home?logged=${encodeURIComponent(doctor?.full_name || "")}&secs=${seconds}`);
  };

  return (
    <div className="rep">
      <header className="rep__bar">
        <button className="rep__back" onClick={() => navigate(-1)} aria-label="Back">
          ←
        </button>
        <div className="rep__bar-title">
          <strong>{doctor?.full_name || "…"}</strong>
          <span>{[doctor?.specialty, doctor?.area].filter(Boolean).join(" · ")}</span>
        </div>
      </header>

      {err && <div className="rep__err">{err}</div>}

      <div className="rep__form">
        <Field label="Visit type">
          <Chips
            options={VISIT_TYPES.map((v) => ({ value: v.value, label: `${v.icon} ${v.label}` }))}
            value={visitType}
            onChange={setVisitType}
          />
        </Field>

        <Field label="Purpose" optional>
          <Chips
            options={PURPOSES.map((p) => ({ value: p, label: p }))}
            value={purpose}
            onChange={(v) => setPurpose(v === purpose ? null : v)}
          />
        </Field>

        <Field label="Outcome" optional>
          <Chips
            options={VISIT_OUTCOMES.map((o) => ({ value: o.value, label: o.label, tone: o.tone }))}
            value={outcome}
            onChange={(v) => setOutcome(v === outcome ? null : v)}
          />
        </Field>

        {gaps.length > 0 && (
          <Field label="Quick add — while you're with them">
            <div className="rep__chips">
              {gaps.map((g) => (
                <button
                  key={g}
                  type="button"
                  className="rep__chip rep__chip--gap"
                  onClick={() => {
                    setOpenGap(g);
                    setGapValue("");
                  }}
                >
                  {GAP_PROMPTS[g].label}
                </button>
              ))}
            </div>
            {openGap && (
              <div className="rep__gap">
                <input
                  className="rep__input"
                  type={GAP_PROMPTS[openGap].type || "text"}
                  value={gapValue}
                  onChange={(e) => setGapValue(e.target.value)}
                  placeholder={GAP_PROMPTS[openGap].placeholder}
                  autoFocus
                />
                <button className="rep__btn rep__btn--sm" onClick={saveGap}>
                  Save
                </button>
                <button
                  className="rep__btn rep__btn--sm rep__btn--ghost"
                  onClick={() => setOpenGap(null)}
                >
                  Cancel
                </button>
              </div>
            )}
            {gapSaved.length > 0 && (
              <span className="rep__saved">Saved: {gapSaved.join(", ")}</span>
            )}
          </Field>
        )}

        <Field label="Notes" optional>
          <textarea
            className="rep__notes"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="What was discussed?"
            rows={3}
          />
          <div className="rep__dictate">
            <button
              type="button"
              className={`rep__btn rep__btn--sm ${dictation.listening ? "rep__btn--rec" : ""}`}
              onClick={dictation.toggle}
              disabled={dictation.busy}
            >
              {dictation.busy ? "Transcribing…" : dictation.listening ? "◼ Stop" : "🎤 Dictate"}
            </button>
            {/* Dictation is a convenience, never a dependency. If the mic is
                blocked, the browser has no recogniser, or there is no signal
                for the batch fallback, the rep types — and the save path does
                not know or care. */}
            {dictation.error && (
              <span className="rep__hint">Dictation unavailable — type instead</span>
            )}
            {dictation.caption && <span className="rep__caption">{dictation.caption}</span>}
          </div>
        </Field>

        <Field label="Follow-up">
          <label className="rep__check">
            <input
              type="checkbox"
              checked={followUp}
              onChange={(e) => setFollowUp(e.target.checked)}
            />
            Needs a follow-up
          </label>
          <div className="rep__next">
            <label className="rep__next-label">
              Next visit
              {cadence && (
                <span className="rep__hint">
                  {" "}
                  — {cadence.priority} doctor, every {cadence.interval_days} days
                </span>
              )}
            </label>
            <input
              className="rep__input"
              type="date"
              value={nextVisit}
              onChange={(e) => setNextVisit(e.target.value)}
            />
          </div>
        </Field>
      </div>

      <div className="rep__save">
        <button
          className="rep__btn rep__btn--primary rep__btn--lg"
          onClick={save}
          disabled={saving}
        >
          {saving ? "Saving…" : "Save visit"}
        </button>
        <span className="rep__hint rep__hint--center">
          Saves on your phone first — syncs when you have signal
        </span>
      </div>
    </div>
  );
}

function Field({ label, optional, children }) {
  return (
    <section className="rep__field">
      <span className="rep__label">
        {label}
        {optional && <em> optional</em>}
      </span>
      {children}
    </section>
  );
}

function Chips({ options, value, onChange }) {
  return (
    <div className="rep__chips">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          className={`rep__chip ${value === o.value ? "rep__chip--on" : ""} ${o.tone ? `rep__chip--${o.tone}` : ""}`}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
