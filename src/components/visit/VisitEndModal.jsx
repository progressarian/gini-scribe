import { memo } from "react";

const VisitEndModal = memo(function VisitEndModal({ patient, summary, onClose, onConfirm }) {
  return (
    <div className="mo open" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="mbox" style={{ width: 430 }}>
        <div className="mttl">✅ Complete &amp; Save Visit #{summary.totalVisits}</div>
        <div style={{ fontSize: 13, color: "var(--t2)", marginBottom: 14, lineHeight: 1.6 }}>
          Finalise Visit #{summary.totalVisits} for <strong>{patient.name}</strong>.
        </div>
        <div style={{ background: "var(--bg)", borderRadius: 8, padding: 12, marginBottom: 12 }}>
          <div className="mf" style={{ marginBottom: 10 }}>
            <label className="ml">Visit classification</label>
            <select className="ms">
              <option>Improving — Continuous Care</option>
              <option>Stable — Routine follow-up</option>
              <option>Worsening — Needs attention</option>
            </select>
          </div>
          <div className="mf" style={{ marginBottom: 0 }}>
            <label className="ml">Next Visit Date</label>
            <input className="mi" type="date" style={{ height: 36 }} />
          </div>
        </div>
        <div className="macts">
          <button className="btn" onClick={onClose}>
            Back
          </button>
          <button className="btn-p" onClick={onConfirm}>
            Save &amp; Complete
          </button>
        </div>
      </div>
    </div>
  );
});

export default VisitEndModal;
