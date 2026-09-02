import { useEffect, useRef, useState } from "react";
import { SPECIALTIES, URGENCIES } from "../../../../shared/giniflowReferrals";
import { useReferralPatientSearch } from "../../../queries/hooks/useGiniflowReferrals";

// The create panel — gini-stations.html `.ref-form` #refForm:608.
//
// Three gaps in the prototype this closes (19 §4.2):
//   · it has no <form>, no name/id attributes, no required and no validation —
//     so this is a real form, validated again by giniflowReferralSchema;
//   · its Patient field is a placeholder, not a picker — free text there lands a
//     referral with no patient_id, which is a letter nobody can find again;
//   · it omits `to_doctor_phone`, which §4.1's "Send to doctor" requires.
//
// And Cancel clears the fields. The prototype's toggleRefForm() only hides them,
// so reopening showed a half-typed referral to whoever came next.

const blank = {
  specialty: "",
  toDoctor: "",
  toDoctorPhone: "",
  hospital: "",
  urgency: "routine",
  presentingComplaint: "",
  reason: "",
  requestedAction: "",
  // Never "" — a blank allergy field on a letter reads as "none" to whoever
  // receives it, so the desk has to choose, including choosing "not asked".
  allergyStatus: "not_known",
  allergyNote: "",
  investigations: "",
};

// The three allergy states, in the order a desk should read them: the safe
// answer, the checked answer, and the one that needs a name typed after it.
//
// `tone` is the colour it prints in on the letter, so what the desk picks here
// looks like what the specialist will see.
const ALLERGY_OPTIONS = [
  {
    value: "not_known",
    icon: "⚠",
    label: "Not asked",
    sub: "nobody has checked",
    tone: "amb",
  },
  {
    value: "none_known",
    icon: "✓",
    label: "None known",
    sub: "I asked the patient",
    tone: "grn",
  },
  {
    value: "known",
    icon: "⛔",
    label: "Known allergy",
    sub: "name it below",
    tone: "red",
  },
];

// What each choice actually puts on the letter. Shown because the difference
// between "not asked" and "none known" is invisible until you see the sentence
// a specialist reads — and one of them tells them to check before prescribing.
const ALLERGY_HINT = {
  not_known: "The letter will print: NOT ASKED — please check with the patient before prescribing.",
  none_known: "The letter will print: None known — asked at referral.",
  known: "The letter prints exactly what you type, under Allergies.",
};

// A named group of fields. A real <fieldset>/<legend>, so the grouping survives
// for a screen reader as well as on screen.
//
// NOT collapsible. Every field here is one a receiving specialist reads, and a
// section folded shut is a section the desk forgets to fill — the letter would
// then go out short of the half that makes it useful, with nothing on screen
// saying so.
function Section({ title, hint, invalid, children }) {
  return (
    <fieldset className={`rf-sec${invalid ? " has-err" : ""}`}>
      <legend>
        {title}
        {hint && <span className="rf-sec-hint">{hint}</span>}
      </legend>
      <div className="rf-sec-body">{children}</div>
    </fieldset>
  );
}

// One field's error, under the field it belongs to.
//
// A single line at the foot of the form told the desk that SOMETHING was wrong
// on a form with eleven inputs. The message now sits against the input it
// describes, the input is marked aria-invalid, and submit puts the cursor in it.
function Err({ id, message }) {
  if (!message) return null;
  return (
    <p className="rff-err" id={id} role="alert">
      {message}
    </p>
  );
}

export default function ReferralForm({ open, date, busy, onCreate, onCancel }) {
  const [patientQuery, setPatientQuery] = useState("");
  const [patient, setPatient] = useState(null);
  const [fields, setFields] = useState(blank);
  const [errors, setErrors] = useState({});

  const { data: matches = [], isFetching } = useReferralPatientSearch(
    patient ? "" : patientQuery,
    date,
  );

  const reset = () => {
    setPatientQuery("");
    setPatient(null);
    setFields(blank);
    setErrors({});
  };

  const formRef = useRef(null);
  const firstFieldRef = useRef(null);

  useEffect(() => {
    if (!open) return reset();
    // Bring it into view and put the cursor in it.
    //
    // The form renders at the TOP of the scroll area, and a referral card with
    // a long reason is taller than the screen. So a coordinator who had
    // scrolled down to a card and then pressed "+ New referral" watched nothing
    // happen: the form had opened above them, off screen. The same click then
    // read as a dead button, and "✕ Close" as another one.
    formRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    firstFieldRef.current?.focus();
  }, [open]);

  if (!open) return null;

  const set = (name) => (e) => {
    const { value } = e.target;
    setFields((f) => ({ ...f, [name]: value }));
    // Cleared as it is corrected. An error that stays put while the field is
    // being fixed reads as a second, different problem.
    setErrors((prev) => (prev[name] ? { ...prev, [name]: null } : prev));
  };

  // Everything the server would refuse, refused here first — but the server
  // still refuses it too (giniflowReferralSchema). This is the faster message,
  // not the only one.
  const validate = () => {
    const next = {};
    if (!patient) next.patient = "Pick the patient from today's floor first";
    if (!fields.specialty) next.specialty = "Choose a specialty";
    if (fields.reason.trim().length < 3) next.reason = "A referral needs a reason";
    // The number "Send to doctor" will dial. Unchecked, a mistyped one reached
    // MSG91 and failed there, long after the desk had moved on.
    const digits = fields.toDoctorPhone.replace(/\D/g, "");
    if (digits && digits.length !== 10) next.toDoctorPhone = "10 digits, or leave it blank";
    if (fields.allergyStatus === "known" && !fields.allergyNote.trim())
      next.allergyNote = "Name the allergy, or choose one of the other two options";
    return next;
  };

  const submit = (e) => {
    e.preventDefault();
    const found = validate();
    setErrors(found);

    if (Object.keys(found).length) {
      // After the render that marks the field, not before.
      requestAnimationFrame(() => {
        const el = formRef.current?.querySelector("[aria-invalid='true']");
        el?.focus();
        el?.scrollIntoView({ behavior: "smooth", block: "center" });
      });
      return undefined;
    }

    return onCreate(
      {
        visitId: patient.visitId,
        specialty: fields.specialty,
        toDoctor: fields.toDoctor.trim() || null,
        toDoctorPhone: fields.toDoctorPhone.replace(/\D/g, "") || null,
        presentingComplaint: fields.presentingComplaint.trim() || null,
        requestedAction: fields.requestedAction.trim() || null,
        allergyStatus: fields.allergyStatus,
        allergyNote: fields.allergyStatus === "known" ? fields.allergyNote.trim() || null : null,
        hospital: fields.hospital.trim() || null,
        urgency: fields.urgency,
        reason: fields.reason.trim(),
        investigations: fields.investigations.trim() || null,
      },
      reset,
    );
  };

  const invalidIn = (keys) => keys.some((k) => errors[k]);

  // aria-invalid and aria-describedby in one place, so no field can be marked
  // invalid without also pointing at the message that says why.
  const aria = (name) =>
    errors[name] ? { "aria-invalid": "true", "aria-describedby": `err-${name}` } : {};

  return (
    <form ref={formRef} className="ref-form open" onSubmit={submit} noValidate>
      <div className="rf-title">New referral</div>

      {/* Outside both sections: a referral hangs off a visit, so there is
          nothing to fill in until this is answered. */}
      <div className="rff rff-pick rf-wide">
        <label htmlFor="rf-patient">
          Patient <span className="rff-req">required</span>
        </label>
        {patient ? (
          <div className="rf-picked">
            <span>
              <strong>{patient.name}</strong> · {patient.fileNo}
              {patient.age ? ` · ${patient.age}${(patient.sex || "").slice(0, 1)}` : ""}
            </span>
            <button type="button" onClick={() => setPatient(null)} aria-label="Change patient">
              ✕
            </button>
          </div>
        ) : (
          <>
            <input
              ref={firstFieldRef}
              id="rf-patient"
              autoComplete="off"
              placeholder="Search patient name or ID"
              value={patientQuery}
              onChange={(e) => setPatientQuery(e.target.value)}
              {...aria("patient")}
            />
            {patientQuery.trim().length >= 2 && (
              <div className="rf-results">
                {isFetching && <div className="rf-result-none">Searching…</div>}
                {!isFetching && !matches.length && (
                  <div className="rf-result-none">
                    Nobody by that name is on the floor today — a referral hangs off a visit.
                  </div>
                )}
                {matches.map((m) => (
                  <button
                    type="button"
                    key={m.visitId}
                    className="rf-result"
                    onClick={() => {
                      setPatient(m);
                      setPatientQuery("");
                      setErrors((prev) => (prev.patient ? { ...prev, patient: null } : prev));
                    }}
                  >
                    <strong>{m.name}</strong>
                    <span>
                      {m.fileNo}
                      {m.age ? ` · ${m.age}${(m.sex || "").slice(0, 1)}` : ""}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </>
        )}
        <Err id="err-patient" message={errors.patient} />
      </div>

      <Section
        title="Where it is going"
        hint="specialist · clinic · how soon"
        invalid={invalidIn(["specialty", "toDoctorPhone"])}
      >
        <div className="rf-grid">
          <div className="rff">
            <label htmlFor="rf-specialty">
              Specialty <span className="rff-req">required</span>
            </label>
            <select
              id="rf-specialty"
              value={fields.specialty}
              onChange={set("specialty")}
              {...aria("specialty")}
            >
              <option value="">— Choose</option>
              {SPECIALTIES.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.icon} {s.label}
                </option>
              ))}
            </select>
            <Err id="err-specialty" message={errors.specialty} />
          </div>

          <div className="rff">
            <label htmlFor="rf-doctor">Referred to (doctor name)</label>
            <input
              id="rf-doctor"
              placeholder="e.g. Dr. Suresh Gupta"
              value={fields.toDoctor}
              onChange={set("toDoctor")}
            />
          </div>

          <div className="rff">
            <label htmlFor="rf-hospital">Hospital / clinic</label>
            <input
              id="rf-hospital"
              placeholder="e.g. Max Hospital, Mohali"
              value={fields.hospital}
              onChange={set("hospital")}
            />
          </div>

          <div className="rff">
            <label htmlFor="rf-urgency">Urgency</label>
            <select id="rf-urgency" value={fields.urgency} onChange={set("urgency")}>
              {URGENCIES.map((u) => (
                <option key={u.value} value={u.value}>
                  {u.label}
                </option>
              ))}
            </select>
          </div>

          {/* The prototype omits this and then draws "Send to doctor" (§4.1). */}
          <div className="rff">
            <label htmlFor="rf-phone">Specialist&apos;s WhatsApp</label>
            <input
              id="rf-phone"
              type="tel"
              inputMode="tel"
              maxLength={14}
              placeholder="e.g. 98765 43210 — for “Send to doctor”"
              value={fields.toDoctorPhone}
              onChange={set("toDoctorPhone")}
              {...aria("toDoctorPhone")}
            />
            <Err id="err-toDoctorPhone" message={errors.toDoctorPhone} />
          </div>
        </div>
      </Section>

      <Section
        title="What the specialist needs to know"
        hint="this becomes the letter"
        invalid={invalidIn(["reason", "allergyNote"])}
      >
        {/* Three prompts where the prototype had one. A single box asking for
            complaint, history, question and request produced prose with no shape
            — and nothing to notice when the wrong text was pasted into it. */}
        <div className="rff rf-wide">
          <label htmlFor="rf-complaint">Presenting complaint</label>
          <textarea
            id="rf-complaint"
            rows={2}
            placeholder="What is happening now — e.g. Black tarry stools for 3 days, epigastric pain, one episode of coffee-ground vomiting"
            value={fields.presentingComplaint}
            onChange={set("presentingComplaint")}
          />
        </div>

        <div className="rff rf-wide">
          <label htmlFor="rf-reason">
            Reason for referral <span className="rff-req">required</span>
          </label>
          <textarea
            id="rf-reason"
            rows={3}
            placeholder="Why this specialist, and the relevant history…"
            value={fields.reason}
            onChange={set("reason")}
            {...aria("reason")}
          />
          <Err id="err-reason" message={errors.reason} />
        </div>

        {/* What the referrer is ASKING FOR. The prototype had no such field, so
            the request lived at the bottom of the reason paragraph where a busy
            consultant scanning the letter would miss it. */}
        <div className="rff rf-wide">
          <label htmlFor="rf-action">What I am asking you to do</label>
          <textarea
            id="rf-action"
            rows={2}
            placeholder="e.g. Assess for peptic ulcer bleed · Advise whether urgent OGD is indicated · Advise on gastroprotection"
            value={fields.requestedAction}
            onChange={set("requestedAction")}
          />
        </div>

        {/* Keeps the prototype's name. It does not duplicate the letter's derived
            "Key numbers" table.

            That table covers exactly four markers — HbA1c, creatinine, FBS,
            weight — because they are the four the chart carries as structured
            biomarkers. A referral routinely has to share what is NOT in that set:
            a UACR, an eGFR, a retinopathy report from last October, an ECG. This
            field is the only way to say any of it, and removing it as "redundant"
            took the useful half with the duplicated half. */}
        <div className="rff rf-wide">
          <label htmlFor="rf-inv">Key investigations to share</label>
          <input
            id="rf-inv"
            placeholder="Anything not in the key numbers — e.g. UACR 4643 · eGFR 11 · Retinopathy report Oct 2025 · ECG 28 Aug"
            value={fields.investigations}
            onChange={set("investigations")}
          />
        </div>

        {/* The clinical-safety field, and the only one on this form given its own
            box and its own colour.

            There is no allergy column anywhere in this database, so the letter
            could only ever say "not recorded" — and this is the moment somebody
            else is about to prescribe. Three explicit choices, so "nobody asked"
            is a stated position rather than a blank.

            A <select> was wrong for it. A closed dropdown shows one option and
            hides the other two, and its default — "Not asked" — is the one that
            prints an amber warning on a clinical letter. Somebody has to SEE the
            three and pick. Radios, styled as a segmented control: all three
            visible, one glance, and the state carries the colour it will print
            in. */}
        <div className="rff rf-wide rf-alg-field">
          <fieldset className="rf-alg" aria-describedby="rf-alg-hint">
            <legend>Allergies</legend>
            <div className="rf-alg-opts">
              {ALLERGY_OPTIONS.map((o) => (
                <label
                  key={o.value}
                  className={`rf-alg-opt rf-alg-${o.tone}${
                    fields.allergyStatus === o.value ? " sel" : ""
                  }`}
                >
                  <input
                    type="radio"
                    name="allergyStatus"
                    value={o.value}
                    checked={fields.allergyStatus === o.value}
                    onChange={set("allergyStatus")}
                  />
                  <span className="rf-alg-ico" aria-hidden="true">
                    {o.icon}
                  </span>
                  <span className="rf-alg-txt">
                    <strong>{o.label}</strong>
                    <em>{o.sub}</em>
                  </span>
                </label>
              ))}
            </div>

            {fields.allergyStatus === "known" && (
              <input
                className="rf-alg-note"
                aria-label="Name the allergy and what it does"
                placeholder="e.g. Penicillin — rash · Sulfa drugs — angioedema"
                value={fields.allergyNote}
                onChange={set("allergyNote")}
                autoFocus
                {...aria("allergyNote")}
              />
            )}
            <Err id="err-allergyNote" message={errors.allergyNote} />

            <p className="rf-alg-hint" id="rf-alg-hint">
              {ALLERGY_HINT[fields.allergyStatus]}
            </p>
          </fieldset>
        </div>
      </Section>

      <div className="rf-acts">
        <button type="submit" className="btn btn-tl" disabled={busy}>
          {busy ? "Creating…" : "Create referral + generate letter"}
        </button>
        <button
          type="button"
          className="btn btn-g"
          onClick={() => {
            reset();
            onCancel();
          }}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
