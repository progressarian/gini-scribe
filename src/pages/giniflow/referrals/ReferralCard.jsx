import { useState } from "react";
import { letterHref } from "../../../queries/hooks/useGiniflowReferrals";
import { MED_SLOTS } from "../../../../shared/giniflowMedTiming";

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

// Where a reason stops being a glance and starts being a document. Below this
// it prints in full; above it, the card shows the opening and offers the rest.
const REASON_CLAMP = 240;

export default function ReferralCard({ referral: r, past = false, busy, onAction }) {
  const [booking, setBooking] = useState(false);
  const [reasonOpen, setReasonOpen] = useState(false);
  const [replying, setReplying] = useState(false);
  const [replyNote, setReplyNote] = useState("");
  // One blank row to start. A reply with no medicines is normal — the specialist
  // may have changed nothing — so nothing here is required.
  const [meds, setMeds] = useState([
    { medicineName: "", dose: "", frequency: "", timingCategory: "" },
  ]);
  const [replyError, setReplyError] = useState("");
  const [date, setDate] = useState(r.appointmentDate || "");
  const [note, setNote] = useState(r.appointmentNote || "");

  const setMed = (i, field) => (e) =>
    setMeds((rows) => rows.map((r, n) => (n === i ? { ...r, [field]: e.target.value } : r)));

  const sendReply = (e) => {
    e.preventDefault();
    const medicines = meds
      .filter((m) => m.medicineName.trim())
      .map((m) => ({
        medicineName: m.medicineName.trim(),
        dose: m.dose.trim() || null,
        frequency: m.frequency.trim() || null,
        timingCategory: m.timingCategory || null,
      }));
    if (!replyNote.trim() && !medicines.length) {
      return setReplyError("Write what the specialist said, or add the medicines they started");
    }
    setReplyError("");
    onAction("response", r, { note: replyNote.trim() || null, medicines });
    setReplying(false);
    setReplyNote("");
    setMeds([{ medicineName: "", dose: "", frequency: "", timingCategory: "" }]);
    return undefined;
  };

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
              r.referralNo,
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

      {/* Collapsed by default when it is long.
          
          A reason is prose a consultant typed, and one of them ran to 2,000
          characters — which made the card taller than the viewport, and that is
          what hid the "+ New referral" form above the fold and made the rail
          button look dead. Scrolling inside the card fixed the height but hid
          the text behind a scrollbar nobody notices; a named button says the
          rest is there. */}
      {r.reason && (
        <div className={`rc-reason${reasonOpen ? " open" : ""}`}>
          <strong>Reason:</strong>{" "}
          {reasonOpen || r.reason.length <= REASON_CLAMP
            ? r.reason
            : `${r.reason.slice(0, REASON_CLAMP).trimEnd()}…`}
          {r.reason.length > REASON_CLAMP && (
            <button
              type="button"
              className="rc-more"
              aria-expanded={reasonOpen}
              onClick={() => setReasonOpen((v) => !v)}
            >
              {reasonOpen ? "Show less" : "Show full reason"}
            </button>
          )}
        </div>
      )}

      {/* What came back. Printed before the booking note because it is the later
          event and the one that changes what anybody does next. */}
      {r.responseNote && (
        <div className="rc-reply">
          <strong>Specialist said:</strong> {r.responseNote}
          <div className="rc-reply-by">
            Recorded{r.responseBy ? ` by ${r.responseBy}` : ""}
            {r.responseAt ? ` · ${fmtDate(r.responseAt)}` : ""}
          </div>
        </div>
      )}

      {r.appointmentNote && (
        <div className="rc-appt">
          📅 {fmtDate(r.appointmentDate)} — {r.appointmentNote}
        </div>
      )}

      {replying && (
        <form className="rc-reply-form" onSubmit={sendReply}>
          <label className="rc-rf-note">
            <span>What did the specialist say?</span>
            <textarea
              rows={3}
              value={replyNote}
              autoFocus
              placeholder="e.g. CKD stage 5. Stop metformin. Start Erythropoietin. Review in 2 weeks with repeat KFT."
              onChange={(e) => setReplyNote(e.target.value)}
            />
          </label>

          {/* The medicines the specialist STARTED. These are written to the
              patient's chart as external, so Gini's own prescriber sees them at
              the moment they prescribe — which is the whole reason this exists,
              and not a filing convenience. */}
          <div className="rc-rf-meds">
            <span className="rc-rf-lbl">Medicines the specialist started</span>
            {meds.map((m, i) => (
              // eslint-disable-next-line react/no-array-index-key
              <div className="rc-rf-med" key={i}>
                <input
                  placeholder="Medicine name"
                  value={m.medicineName}
                  onChange={setMed(i, "medicineName")}
                />
                <input placeholder="Dose" value={m.dose} onChange={setMed(i, "dose")} />
                <input
                  placeholder="OD / BD"
                  value={m.frequency}
                  onChange={setMed(i, "frequency")}
                />
                <select value={m.timingCategory} onChange={setMed(i, "timingCategory")}>
                  <option value="">When…</option>
                  {MED_SLOTS.map((slot) => (
                    <option key={slot.key} value={slot.key}>
                      {slot.label}
                    </option>
                  ))}
                </select>
              </div>
            ))}
            <button
              type="button"
              className="rc-rf-add"
              onClick={() =>
                setMeds((rows) => [
                  ...rows,
                  { medicineName: "", dose: "", frequency: "", timingCategory: "" },
                ])
              }
            >
              + Another medicine
            </button>
          </div>

          {replyError && <div className="rf-error">{replyError}</div>}

          <div className="rc-book-acts">
            <button type="submit" className="btn btn-tl" disabled={busy}>
              Save reply and close referral
            </button>
            <button type="button" className="btn btn-g" onClick={() => setReplying(false)}>
              Cancel
            </button>
          </div>
        </form>
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
        {r.canRecordResponse && !r.responseNote && (
          <button type="button" className="btn btn-g" onClick={() => setReplying((v) => !v)}>
            📥 Record specialist reply
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
