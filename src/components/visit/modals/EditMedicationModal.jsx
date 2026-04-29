import { memo, useState } from "react";

const TIMINGS = [
  "Fasting",
  "Before breakfast",
  "After breakfast",
  "Before lunch",
  "After lunch",
  "Before dinner",
  "After dinner",
  "At bedtime",
  "With milk",
  "SOS only",
];

const EditMedicationModal = memo(function EditMedicationModal({
  medication,
  activeMeds,
  onClose,
  onSubmit,
}) {
  const [dose, setDose] = useState(medication.dose || "");
  const [frequency, setFrequency] = useState(medication.frequency || "OD");
  const [timings, setTimings] = useState(() => {
    const existing = (medication.timing || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    return TIMINGS.filter((t) => existing.some((e) => e.toLowerCase() === t.toLowerCase()));
  });
  const [reason, setReason] = useState("");
  const [loading, setLoading] = useState(false);

  // Parent selection. Empty string = standalone (clear the link). Eligible
  // parents: any other top-level active med for this patient.
  const parentCandidates = (activeMeds || []).filter(
    (m) =>
      m &&
      m.id !== medication.id &&
      !m.parent_medication_id &&
      Number.isFinite(Number(m.id)),
  );
  const [parentId, setParentId] = useState(
    medication.parent_medication_id ? String(medication.parent_medication_id) : "",
  );
  const [supportCondition, setSupportCondition] = useState(medication.support_condition || "");
  const isSubMed = !!parentId;

  const toggleTiming = (t) =>
    setTimings((ts) => (ts.includes(t) ? ts.filter((x) => x !== t) : [...ts, t]));

  const handleSubmit = async () => {
    if (loading) return;
    setLoading(true);
    try {
      const payload = {
        dose,
        frequency,
        timing: timings.join(", "),
        reason,
      };
      const initialParent = medication.parent_medication_id
        ? String(medication.parent_medication_id)
        : "";
      if (parentId !== initialParent) {
        payload.parent_medication_id = parentId ? Number(parentId) : null;
      }
      const initialSupport = medication.support_condition || "";
      if ((parentId ? supportCondition : "") !== initialSupport) {
        payload.support_condition = parentId ? supportCondition || null : null;
      }
      await onSubmit(payload);
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
        <div className="mttl">✏️ Edit Medication</div>
        <div style={{ fontSize: 13, color: "var(--t2)", marginBottom: 12 }}>
          Editing: <strong>{medication.name}</strong>
        </div>
        {parentCandidates.length > 0 && (
          <div className="mf">
            <label className="ml">Type</label>
            <select
              className="ms"
              value={parentId}
              onChange={(e) => setParentId(e.target.value)}
              disabled={loading}
            >
              <option value="">Standalone medicine</option>
              {parentCandidates.map((m) => (
                <option key={m.id} value={String(m.id)}>
                  Support medicine for {m.name}
                </option>
              ))}
            </select>
          </div>
        )}
        {isSubMed && (
          <div className="mf">
            <label className="ml">Support for what</label>
            <input
              className="mi"
              placeholder="e.g. SOS for nausea/vomiting"
              value={supportCondition}
              onChange={(e) => setSupportCondition(e.target.value)}
              disabled={loading}
            />
          </div>
        )}
        <div className="g2">
          <div className="mf">
            <label className="ml">Dosage</label>
            <input
              className="mi"
              placeholder="e.g. 24 Units"
              value={dose}
              onChange={(e) => setDose(e.target.value)}
              disabled={loading}
            />
          </div>
          <div className="mf">
            <label className="ml">Frequency</label>
            <select
              className="ms"
              value={frequency}
              onChange={(e) => setFrequency(e.target.value)}
              disabled={loading}
            >
              <option value="OD">Once daily (OD)</option>
              <option value="BD">Twice daily (BD)</option>
              <option value="TDS">Three times (TDS)</option>
              <option value="Once weekly">Once weekly</option>
              <option value="SOS">As needed (SOS)</option>
            </select>
          </div>
        </div>
        <div className="mf">
          <label className="ml">When to take</label>
          <div className="time-pills">
            {TIMINGS.map((t) => (
              <label key={t}>
                <input
                  type="checkbox"
                  checked={timings.includes(t)}
                  onChange={() => toggleTiming(t)}
                  disabled={loading}
                />
                <span>{t}</span>
              </label>
            ))}
          </div>
        </div>
        <div className="mf">
          <label className="ml">Reason for change</label>
          <textarea
            className="mta"
            style={{ minHeight: 50 }}
            placeholder="Why is this being changed?"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            disabled={loading}
          />
        </div>
        <div className="macts">
          <button className="btn" onClick={onClose} disabled={loading}>
            Cancel
          </button>
          <button
            className="btn-p"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 8,
              opacity: loading ? 0.75 : 1,
              cursor: loading ? "not-allowed" : "pointer",
            }}
            disabled={loading}
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
            {loading ? "Saving…" : "Save Changes"}
          </button>
        </div>
      </div>
    </div>
  );
});

export default EditMedicationModal;
