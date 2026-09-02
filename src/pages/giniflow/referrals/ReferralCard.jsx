import { useState } from "react";
import { letterHref } from "../../../queries/hooks/useGiniflowReferrals";

// One `.ref-card` — gini-stations.html #s-referrals:636.
//
// The card is deliberately NOT clickable. Unlike `.pt-card` in Lab it has no
// onclick and no cursor:pointer, because a referral has three different next
// steps and none of them is "open". Every action is an explicit button.
//
// The past-referral buttons the prototype draws — "View specialist report" and
// "Add to medicines" — are NOT rendered: the return leg is deferred (19 §12.3),
// and a button that toasts and does nothing is worse than an absent one on a
// screen a coordinator is trusting.

const fmtDate = (value) =>
  value
    ? new Date(value).toLocaleDateString("en-IN", {
        weekday: "short",
        day: "numeric",
        month: "short",
        year: "numeric",
      })
    : "";

const patientLine = (r) =>
  [
    r.age ? `${r.age}${(r.sex || "").slice(0, 1).toUpperCase()}` : null,
    r.fileNo,
    r.appointmentDate ? `Appt ${fmtDate(r.appointmentDate)}` : null,
  ]
    .filter(Boolean)
    .join(" · ");

export default function ReferralCard({ referral: r, past = false, busy, onAction }) {
  const [booking, setBooking] = useState(false);
  const [date, setDate] = useState(r.appointmentDate || "");
  const [note, setNote] = useState(r.appointmentNote || "");

  const book = (e) => {
    e.preventDefault();
    if (!date) return;
    onAction("appointment", r, { date, note });
    setBooking(false);
  };

  return (
    <div className={`ref-card${past ? " is-past" : ""}`}>
      <div className="rc-head">
        <div className="rf-ico" aria-hidden="true">
          {r.icon}
        </div>
        <div className="rc-body">
          <div className="rcn">{r.title}</div>
          <div className="rcs">
            {[
              r.hospital,
              r.referredBy ? `Referred by ${r.referredBy}` : null,
              fmtDate(r.visitDate || r.createdAt),
            ]
              .filter(Boolean)
              .join(" · ")}
          </div>
        </div>
        <span className={`badge b-${r.urgencyTone}`}>{r.urgencyLabel}</span>
      </div>

      <div className="rc-stats">
        <div>
          <div className="rc-slbl">Patient</div>
          <div className="rc-sval">{r.name}</div>
          <div className="rc-ssub">{patientLine(r)}</div>
        </div>
        <div>
          <div className="rc-slbl">Key investigations</div>
          <div className="rc-ssub rc-inv">
            {r.investigations || <em>none listed for the specialist</em>}
          </div>
        </div>
      </div>

      {r.reason && (
        <div className="rc-reason">
          <strong>Reason:</strong> {r.reason}
        </div>
      )}

      {r.appointmentNote && (
        <div className="rc-appt">
          📅 {fmtDate(r.appointmentDate)} — {r.appointmentNote}
        </div>
      )}

      {booking && (
        <form className="rc-book" onSubmit={book}>
          {/* Gini books nothing — this records the slot somebody else's clinic
              gave, which is why the note is free text. */}
          <label>
            <span>Specialist&apos;s date</span>
            <input
              type="date"
              value={date}
              required
              onChange={(e) => setDate(e.target.value)}
              autoFocus
            />
          </label>
          <label className="rc-book-note">
            <span>Note</span>
            <input
              type="text"
              value={note}
              placeholder="e.g. 10:30 AM, OPD block B — carry all reports"
              onChange={(e) => setNote(e.target.value)}
            />
          </label>
          <div className="rc-book-acts">
            <button type="submit" className="btn btn-tl" disabled={busy}>
              Save appointment
            </button>
            <button type="button" className="btn btn-g" onClick={() => setBooking(false)}>
              Cancel
            </button>
          </div>
        </form>
      )}

      <div className="rc-foot">
        <a
          className="btn btn-tl"
          href={letterHref(r.id)}
          target="_blank"
          rel="noreferrer"
          onClick={() => onAction("letter", r)}
        >
          📄 Referral letter
        </a>
        {r.canSendToDoctor && (
          <button
            type="button"
            className="btn btn-g"
            disabled={busy}
            onClick={() => onAction("send", r, { to: "doctor" })}
          >
            📱 Send to doctor
          </button>
        )}
        {r.canSendToPatient && (
          <button
            type="button"
            className="btn btn-g"
            disabled={busy}
            onClick={() => onAction("send", r, { to: "patient" })}
          >
            📱 Send to patient
          </button>
        )}
        {r.status !== "completed" && (
          <button type="button" className="btn btn-g" onClick={() => setBooking((v) => !v)}>
            📅 {r.appointmentDate ? "Change appointment" : "Book appointment"}
          </button>
        )}
        {r.status === "appointment_booked" && (
          <button
            type="button"
            className="btn btn-g"
            disabled={busy}
            onClick={() => onAction("complete", r)}
          >
            ✓ Mark seen
          </button>
        )}
        {r.canRemove && (
          <button
            type="button"
            className="btn btn-g rc-del"
            disabled={busy}
            onClick={() => onAction("remove", r)}
          >
            Remove
          </button>
        )}
        <span className={`badge b-${r.statusTone} rc-status`}>{r.statusLabel}</span>
      </div>
    </div>
  );
}
