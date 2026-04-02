import { memo, useState } from "react";

const FLAGS = [
  { value: "", label: "— No flag —" },
  { value: "review", label: "⚠ Review needed at next visit" },
  { value: "urgent", label: "❗ Urgent action this visit" },
  { value: "resolved", label: "✓ Issue resolved" },
  { value: "refer", label: "👨‍⚕️ Referral to be arranged" },
];

const DiagnosisNoteModal = memo(function DiagnosisNoteModal({ diagnosis, onClose, onSubmit }) {
  const [notes, setNotes] = useState(diagnosis.notes || "");
  const [flag, setFlag] = useState("");

  return (
    <div className="mo open" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="mbox" style={{ width: 420 }}>
        <div className="mttl">📝 Note — {diagnosis.label || diagnosis.diagnosis_id}</div>
        <div className="mf">
          <label className="ml">Clinical note / observation</label>
          <textarea className="mta" style={{ minHeight: 90 }} placeholder="Add your note..." value={notes} onChange={(e) => setNotes(e.target.value)} />
        </div>
        <div className="mf">
          <label className="ml">Action flag</label>
          <select className="ms" value={flag} onChange={(e) => setFlag(e.target.value)}>
            {FLAGS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
          </select>
        </div>
        <div className="macts">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn-p" onClick={() => onSubmit({ notes, flag })}>Save Note</button>
        </div>
      </div>
    </div>
  );
});

export default DiagnosisNoteModal;
