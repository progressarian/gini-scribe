import { memo, useState } from "react";

const DeleteMedicationModal = memo(function DeleteMedicationModal({
  medication,
  onClose,
  onSubmit,
}) {
  const [loading, setLoading] = useState(false);

  const handleSubmit = async () => {
    if (loading) return;
    setLoading(true);
    try {
      await onSubmit(medication.id);
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
        <div className="mttl">🗑️ Delete Medication</div>
        <div style={{ fontSize: 13, color: "var(--t2)", marginBottom: 12 }}>
          Deleting: <strong>{medication.name}</strong> {medication.dose || ""}
        </div>
        <div
          style={{
            background: "var(--red-lt)",
            border: "1px solid var(--red-bd)",
            borderRadius: "var(--rs)",
            padding: "12px 14px",
            marginBottom: 16,
            fontSize: 13,
            color: "var(--red)",
          }}
        >
          ⚠️ This will permanently remove this medication from the patient's record. This action
          cannot be undone.
          <br />
          <br />
          If you want to keep a record but stop the medication, use "Stop" instead.
        </div>
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
            {loading ? "Deleting…" : "Delete Permanently"}
          </button>
        </div>
      </div>
    </div>
  );
});

export default DeleteMedicationModal;
