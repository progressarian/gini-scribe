// The counselling note — gini-stations.html #pharmPane, first block.
//
// Hindi first, then English, because Hindi is the language the sentence is read
// aloud in. Both are generated from the prescription's `change_type` values by
// `server/services/giniflow/counsellingNote.js`, so the note cannot drift from
// what was actually prescribed.

export default function CounsellingNote({ note, sentAt, lastSend, onSend, sending }) {
  if (!note) return null;

  return (
    <div className="dp-sec ph-note">
      <div className="dp-sec-title ph-note-title">Counselling note — read to patient</div>

      <p className="ph-hindi" lang="hi">
        <strong>आज की दवाइयाँ:</strong> {note.hindi.replace(/^आज की दवाइयाँ:\s*/, "")}
      </p>

      <p className="ph-english">
        <strong>In English:</strong> {note.english}
      </p>

      {note.changes.length > 0 && (
        <ul className="ph-changes">
          {note.changes.map((c) => (
            <li key={`${c.medicationId}-${c.changeType}`} className={`ph-chg-${c.changeType}`}>
              <span className="ph-chg-tag">{c.changeType}</span> {c.name}
            </li>
          ))}
        </ul>
      )}

      <div className="ph-note-foot">
        <button className="st-btn st-btn-tl" onClick={onSend} disabled={sending}>
          📱{" "}
          {sending ? "Sending…" : sentAt ? "Send again on WhatsApp" : "Send to patient on WhatsApp"}
        </button>
        {/* PH-01. Only a message that actually left the building gets the tick.
            While the WhatsApp template is unapproved MSG91 logs instead of
            sending, and the counter is told exactly that. */}
        {lastSend && !lastSend.sent && !lastSend.alreadySent && (
          <span className="ph-unsent">⚠ {lastSend.reason || "Logged, not sent"}</span>
        )}
        {sentAt && (
          <span className="ph-sent">
            ✓ Card sent{" "}
            {new Date(sentAt).toLocaleTimeString("en-IN", {
              hour: "2-digit",
              minute: "2-digit",
              hour12: false,
              timeZone: "Asia/Kolkata",
            })}
          </span>
        )}
      </div>
    </div>
  );
}
