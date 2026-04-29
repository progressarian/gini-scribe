import { memo, useState } from "react";

const REASONS = [
  "Side effect",
  "Adverse reaction",
  "Patient requested",
  "Course completed",
  "Replaced by better drug",
  "Cost / availability",
  "Not effective",
  "Doctor's clinical decision",
];

const StopMedicationModal = memo(function StopMedicationModal({
  medication,
  activeMeds,
  onClose,
  onSubmit,
}) {
  const [reason, setReason] = useState("");
  const [notes, setNotes] = useState("");
  const [loading, setLoading] = useState(false);

  // Active sub-medicines that hang off the med being stopped. If present we
  // offer a cascade checkbox so the doctor can stop them in the same action.
  const activeChildren = (activeMeds || []).filter(
    (m) => m && m.parent_medication_id === medication.id && m.is_active !== false,
  );
  const [cascade, setCascade] = useState(true);

  const handleSubmit = async () => {
    if (!reason || loading) return;
    setLoading(true);
    try {
      await onSubmit({
        reason,
        notes,
        cascade: activeChildren.length > 0 ? cascade : false,
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      className="mo open"
      onClick={(e) => {
        if (loading) return;
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="mbox">
        <div className="mttl">🛑 Stop Medication</div>
        <div style={{ fontSize: 13, color: "var(--t2)", marginBottom: 12 }}>
          Stopping: <strong>{medication.name}</strong> {medication.dose || ""}
        </div>
        <div className="mf">
          <label className="ml">Reason for stopping *</label>
          <select
            className="ms"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            disabled={loading}
          >
            <option value="">Select reason...</option>
            {REASONS.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </div>
        <div className="mf">
          <label className="ml">Notes (optional)</label>
          <textarea
            className="mta"
            placeholder="Additional notes..."
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            disabled={loading}
          />
        </div>
        {activeChildren.length > 0 && (
          <div
            className="mf"
            style={{
              padding: 10,
              background: "#FEF3C7",
              border: "1px solid #FCD34D",
              borderRadius: 6,
            }}
          >
            <label
              style={{
                display: "flex",
                alignItems: "flex-start",
                gap: 8,
                fontSize: 13,
                cursor: loading ? "not-allowed" : "pointer",
              }}
            >
              <input
                type="checkbox"
                checked={cascade}
                onChange={(e) => setCascade(e.target.checked)}
                disabled={loading}
                style={{ marginTop: 2 }}
              />
              <span>
                Also stop {activeChildren.length} support medicine
                {activeChildren.length === 1 ? "" : "s"} under this medicine
                <ul
                  style={{
                    margin: "4px 0 0 0",
                    paddingLeft: 18,
                    fontSize: 12,
                    color: "var(--t2)",
                  }}
                >
                  {activeChildren.map((c) => (
                    <li key={c.id}>
                      {c.name}
                      {c.support_condition ? ` — ${c.support_condition}` : ""}
                    </li>
                  ))}
                </ul>
              </span>
            </label>
          </div>
        )}
        <div className="macts">
          <button className="btn" onClick={onClose} disabled={loading}>
            Cancel
          </button>
          <button
            className="btn-p"
            style={{
              background: "var(--red)",
              display: "inline-flex",
              alignItems: "center",
              gap: 8,
              opacity: loading ? 0.75 : 1,
              cursor: loading || !reason ? "not-allowed" : "pointer",
            }}
            disabled={!reason || loading}
            onClick={handleSubmit}
          >
            {loading && (
              <span
                aria-hidden="true"
                style={{
                  width: 12,
                  height: 12,
                  border: "2px solid rgba(255,255,255,0.4)",
                  borderTopColor: "#fff",
                  borderRadius: "50%",
                  display: "inline-block",
                  animation: "spin 0.7s linear infinite",
                }}
              />
            )}
            {loading ? "Stopping…" : "Stop Medication"}
          </button>
        </div>
      </div>
    </div>
  );
});

export default StopMedicationModal;
