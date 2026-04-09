import { memo } from "react";

const DeleteMedicationModal = memo(function DeleteMedicationModal({
  medication,
  onClose,
  onSubmit,
}) {
  return (
    <div className="mo open" onClick={(e) => e.target === e.currentTarget && onClose()}>
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
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn-p"
            style={{ background: "var(--red)" }}
            onClick={() => onSubmit(medication.id)}
          >
            Delete Permanently
          </button>
        </div>
      </div>
    </div>
  );
});

export default DeleteMedicationModal;
