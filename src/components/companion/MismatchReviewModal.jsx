import { memo, useState } from "react";

const row = (label, left, right, highlight) => (
  <div
    style={{
      display: "grid",
      gridTemplateColumns: "110px 1fr 1fr",
      gap: 8,
      padding: "8px 10px",
      borderBottom: "1px solid #e5e7eb",
      background: highlight ? "#fef2f2" : "transparent",
      fontSize: 13,
    }}
  >
    <div style={{ fontWeight: 600, color: "#64748b" }}>{label}</div>
    <div style={{ color: "#0f172a" }}>{left || "—"}</div>
    <div style={{ color: highlight ? "#dc2626" : "#0f172a" }}>{right || "—"}</div>
  </div>
);

const MismatchReviewModal = memo(function MismatchReviewModal({
  action,
  fileName,
  category,
  mismatch,
  selectedPatient,
  onClose,
  onConfirm,
}) {
  const [busy, setBusy] = useState(false);
  const isAccept = action === "accept";
  const confirmColor = isAccept ? "#16a34a" : "#dc2626";
  const title = isAccept ? "✅ Confirm Accept" : "🗑️ Confirm Reject";
  const confirmLabel = isAccept ? "Accept & Save" : "Reject & Delete";

  const nameMismatch = mismatch?.mismatchedFields?.includes("name");
  const idMismatch = mismatch?.mismatchedFields?.includes("id");

  const handleConfirm = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await onConfirm();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      onClick={(e) => e.target === e.currentTarget && onClose()}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(15, 23, 42, 0.55)",
        backdropFilter: "blur(2px)",
        zIndex: 1000,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "min(520px, 100%)",
          maxHeight: "90vh",
          overflow: "auto",
          background: "#fff",
          borderRadius: 14,
          padding: 18,
          boxShadow: "0 20px 60px rgba(0,0,0,0.25)",
        }}
      >
        <div style={{ fontSize: 15, fontWeight: 800, marginBottom: 14 }}>{title}</div>

        <div
          style={{
            background: "#fef2f2",
            border: "1px solid #fecaca",
            borderRadius: 10,
            padding: "10px 12px",
            marginBottom: 12,
            fontSize: 12,
            color: "#991b1b",
          }}
        >
          ⚠️ The document's patient details don't match the selected patient.
          {isAccept
            ? " Accepting will save the extraction to this patient anyway."
            : " Rejecting will permanently delete this document and its file."}
        </div>

        <div
          style={{
            border: "1px solid #e5e7eb",
            borderRadius: 10,
            overflow: "hidden",
            marginBottom: 12,
          }}
        >
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "110px 1fr 1fr",
              gap: 8,
              padding: "8px 10px",
              background: "#f8fafc",
              borderBottom: "1px solid #e5e7eb",
              fontSize: 11,
              textTransform: "uppercase",
              letterSpacing: 0.4,
              color: "#64748b",
              fontWeight: 700,
            }}
          >
            <div>Field</div>
            <div>On document</div>
            <div>Selected patient</div>
          </div>
          {row("Name", mismatch?.reportName, mismatch?.selectedName, nameMismatch)}
          {row("Patient ID", mismatch?.reportId, mismatch?.selectedId, idMismatch)}
        </div>

        <div style={{ fontSize: 12, color: "#64748b", marginBottom: 4 }}>
          <strong>File:</strong> {fileName || "—"}
        </div>
        {category && (
          <div style={{ fontSize: 12, color: "#64748b", marginBottom: 4 }}>
            <strong>Category:</strong> {category}
          </div>
        )}
        {selectedPatient && (
          <div style={{ fontSize: 12, color: "#64748b", marginBottom: 16 }}>
            <strong>Patient:</strong> {selectedPatient.name}
            {selectedPatient.file_no ? ` · #${selectedPatient.file_no}` : ""}
            {selectedPatient.age ? ` · ${selectedPatient.age}Y` : ""}
            {selectedPatient.sex ? `/${selectedPatient.sex[0]}` : ""}
          </div>
        )}

        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            style={{
              height: 34,
              padding: "0 14px",
              borderRadius: 8,
              border: "1px solid #e2e8f0",
              background: "#fff",
              color: "#0f172a",
              fontSize: 13,
              fontWeight: 600,
              cursor: busy ? "not-allowed" : "pointer",
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={busy}
            style={{
              height: 34,
              padding: "0 16px",
              borderRadius: 8,
              border: 0,
              background: confirmColor,
              color: "#fff",
              fontSize: 13,
              fontWeight: 700,
              cursor: busy ? "not-allowed" : "pointer",
              opacity: busy ? 0.7 : 1,
            }}
          >
            {busy ? "Working…" : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
});

export default MismatchReviewModal;
