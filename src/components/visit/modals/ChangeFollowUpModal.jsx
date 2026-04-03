import { memo, useState } from "react";

const ChangeFollowUpModal = memo(function ChangeFollowUpModal({ currentDate, onClose, onSubmit }) {
  const [date, setDate] = useState(currentDate || "");
  const [notes, setNotes] = useState("");

  return (
    <div className="mo open" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="mbox">
        <div className="mttl">📅 Schedule Follow-up</div>
        <div className="mf">
          <label className="ml">Follow-up Date *</label>
          <input
            className="mi"
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </div>
        <div className="mf">
          <label className="ml">Notes (optional)</label>
          <textarea
            className="mta"
            style={{ minHeight: 55 }}
            placeholder="e.g. Repeat labs before visit..."
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </div>
        <div className="macts">
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn-p" disabled={!date} onClick={() => onSubmit({ date, notes })}>
            Save Date
          </button>
        </div>
      </div>
    </div>
  );
});

export default ChangeFollowUpModal;
