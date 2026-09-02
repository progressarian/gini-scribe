import { useEffect, useState } from "react";
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
  reason: "",
  investigations: "",
};

export default function ReferralForm({ open, date, busy, onCreate, onCancel }) {
  const [patientQuery, setPatientQuery] = useState("");
  const [patient, setPatient] = useState(null);
  const [fields, setFields] = useState(blank);
  const [error, setError] = useState("");

  const { data: matches = [], isFetching } = useReferralPatientSearch(
    patient ? "" : patientQuery,
    date,
  );

  const reset = () => {
    setPatientQuery("");
    setPatient(null);
    setFields(blank);
    setError("");
  };

  useEffect(() => {
    if (!open) reset();
  }, [open]);

  if (!open) return null;

  const set = (name) => (e) => setFields((f) => ({ ...f, [name]: e.target.value }));

  const submit = (e) => {
    e.preventDefault();
    if (!patient) return setError("Pick the patient from today's floor first");
    if (!fields.specialty) return setError("Choose a specialty");
    if (fields.reason.trim().length < 3) return setError("A referral needs a reason");
    setError("");
    return onCreate(
      {
        visitId: patient.visitId,
        specialty: fields.specialty,
        toDoctor: fields.toDoctor.trim() || null,
        toDoctorPhone: fields.toDoctorPhone.trim() || null,
        hospital: fields.hospital.trim() || null,
        urgency: fields.urgency,
        reason: fields.reason.trim(),
        investigations: fields.investigations.trim() || null,
      },
      reset,
    );
  };

  return (
    <form className="ref-form open" onSubmit={submit}>
      <div className="rf-title">New referral</div>

      <div className="rf-grid">
        <div className="rff rff-pick">
          <label htmlFor="rf-patient">Patient</label>
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
                id="rf-patient"
                autoComplete="off"
                placeholder="Search patient name or ID"
                value={patientQuery}
                onChange={(e) => setPatientQuery(e.target.value)}
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
          <label htmlFor="rf-specialty">Specialty</label>
          <select id="rf-specialty" required value={fields.specialty} onChange={set("specialty")}>
            <option value="">— Choose</option>
            {SPECIALTIES.map((s) => (
              <option key={s.value} value={s.value}>
                {s.icon} {s.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="rf-grid">
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
            placeholder="e.g. 98765 43210 — for “Send to doctor”"
            value={fields.toDoctorPhone}
            onChange={set("toDoctorPhone")}
          />
        </div>
      </div>

      <div className="rff rf-wide">
        <label htmlFor="rf-reason">Reason for referral</label>
        <textarea
          id="rf-reason"
          rows={3}
          required
          placeholder="Clinical reason, relevant history, specific question for specialist…"
          value={fields.reason}
          onChange={set("reason")}
        />
      </div>

      <div className="rff rf-wide">
        <label htmlFor="rf-inv">Key investigations to share</label>
        <input
          id="rf-inv"
          placeholder="e.g. HbA1c, UACR, eGFR, Retinopathy report from Oct 2025"
          value={fields.investigations}
          onChange={set("investigations")}
        />
      </div>

      {error && <div className="rf-error">{error}</div>}

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
