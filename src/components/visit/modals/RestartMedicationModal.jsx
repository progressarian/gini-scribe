import { memo, useMemo, useState } from "react";

// Restart confirmation modal. Two variants depending on the medication shape:
//   1. Parent with stopped support meds → cascade checkbox.
//   2. Sub-medicine whose parent isn't being restarted alongside it → choose
//      whether to restart it as a support med (keep parent_medication_id) or
//      promote it to a standalone medicine (clear the link).
const RestartMedicationModal = memo(function RestartMedicationModal({
  medication,
  activeMeds,
  stoppedMeds,
  onClose,
  onSubmit,
}) {
  const stoppedChildren = useMemo(
    () => (stoppedMeds || []).filter((m) => m && m.parent_medication_id === medication.id),
    [stoppedMeds, medication.id],
  );

  const parent = useMemo(() => {
    if (!medication.parent_medication_id) return null;
    return (
      (activeMeds || []).find((m) => m.id === medication.parent_medication_id) ||
      (stoppedMeds || []).find((m) => m.id === medication.parent_medication_id) ||
      null
    );
  }, [medication.parent_medication_id, activeMeds, stoppedMeds]);

  const isSubMed = !!medication.parent_medication_id;

  const [cascade, setCascade] = useState(true);
  const [asStandalone, setAsStandalone] = useState(false);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async () => {
    if (loading) return;
    setLoading(true);
    try {
      await onSubmit({
        cascade: stoppedChildren.length > 0 ? cascade : false,
        asStandalone: isSubMed ? asStandalone : false,
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
        <div className="mttl">↻ Restart Medication</div>
        <div style={{ fontSize: 13, color: "var(--t2)", marginBottom: 12 }}>
          Restarting: <strong>{medication.name}</strong>
          {medication.dose ? ` ${medication.dose}` : ""}
        </div>

        {isSubMed && (
          <div
            className="mf"
            style={{
              padding: 10,
              background: "#EEF2FF",
              border: "1px solid #C7D2FE",
              borderRadius: 6,
            }}
          >
            <div style={{ fontSize: 12, color: "var(--t2)", marginBottom: 6 }}>
              This medicine was a support medicine
              {parent ? (
                <>
                  {" "}
                  for <strong>{parent.name}</strong>
                  {parent.is_active === false ? " (currently stopped)" : ""}.
                </>
              ) : (
                "."
              )}
            </div>
            <label
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                fontSize: 13,
                cursor: loading ? "not-allowed" : "pointer",
                marginBottom: 4,
              }}
            >
              <input
                type="radio"
                name="restart-mode"
                checked={!asStandalone}
                onChange={() => setAsStandalone(false)}
                disabled={loading}
              />
              Restart as support medicine{parent ? ` for ${parent.name}` : ""}
            </label>
            <label
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                fontSize: 13,
                cursor: loading ? "not-allowed" : "pointer",
              }}
            >
              <input
                type="radio"
                name="restart-mode"
                checked={asStandalone}
                onChange={() => setAsStandalone(true)}
                disabled={loading}
              />
              Restart as a standalone medicine
            </label>
          </div>
        )}

        {stoppedChildren.length > 0 && (
          <div
            className="mf"
            style={{
              padding: 10,
              background: "#ECFDF5",
              border: "1px solid #A7F3D0",
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
                Also restart {stoppedChildren.length} support medicine
                {stoppedChildren.length === 1 ? "" : "s"} under this medicine
                <ul
                  style={{
                    margin: "4px 0 0 0",
                    paddingLeft: 18,
                    fontSize: 12,
                    color: "var(--t2)",
                  }}
                >
                  {stoppedChildren.map((c) => (
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
            disabled={loading}
            onClick={handleSubmit}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 8,
              opacity: loading ? 0.75 : 1,
            }}
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
            {loading ? "Restarting…" : "Restart"}
          </button>
        </div>
      </div>
    </div>
  );
});

export default RestartMedicationModal;
