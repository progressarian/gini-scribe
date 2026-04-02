import { memo, useState } from "react";

const REASONS = [
  "Side effect","Adverse reaction","Patient requested","Course completed",
  "Replaced by better drug","Cost / availability","Not effective","Doctor's clinical decision",
];

const StopMedicationModal = memo(function StopMedicationModal({ medication, onClose, onSubmit }) {
  const [reason, setReason] = useState("");
  const [notes, setNotes] = useState("");

  return (
    <div className="mo open" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="mbox">
        <div className="mttl">🛑 Stop Medication</div>
        <div style={{ fontSize: 13, color: "var(--t2)", marginBottom: 12 }}>
          Stopping: <strong>{medication.name}</strong> {medication.dose || ""}
        </div>
        <div className="mf">
          <label className="ml">Reason for stopping *</label>
          <select className="ms" value={reason} onChange={(e) => setReason(e.target.value)}>
            <option value="">Select reason...</option>
            {REASONS.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
        </div>
        <div className="mf">
          <label className="ml">Notes (optional)</label>
          <textarea className="mta" placeholder="Additional notes..." value={notes} onChange={(e) => setNotes(e.target.value)} />
        </div>
        <div className="macts">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn-p" style={{ background: "var(--red)" }} disabled={!reason} onClick={() => onSubmit({ reason, notes })}>Stop Medication</button>
        </div>
      </div>
    </div>
  );
});

export default StopMedicationModal;
