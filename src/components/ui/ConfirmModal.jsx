// Lightweight confirmation modal for destructive actions (e.g. deleting
// an uploaded document). Pass `open` + handlers; render anywhere in the
// tree. Kept simple on purpose — no portal, no focus trap — because it's
// only used for click-initiated deletes that are dismissable with
// Escape / backdrop click.
import { useEffect } from "react";

export default function ConfirmModal({
  open,
  title = "Are you sure?",
  message,
  confirmLabel = "Delete",
  cancelLabel = "Cancel",
  variant = "danger",
  onConfirm,
  onCancel,
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => {
      if (e.key === "Escape") onCancel?.();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onCancel]);

  if (!open) return null;

  const danger = variant === "danger";
  const confirmBg = danger ? "#dc2626" : "#2563eb";
  const confirmHoverBg = danger ? "#b91c1c" : "#1d4ed8";

  return (
    <div
      role="dialog"
      aria-modal="true"
      onClick={onCancel}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(15, 23, 42, 0.55)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
        padding: 16,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "#fff",
          borderRadius: 12,
          padding: "22px 22px 18px",
          maxWidth: 420,
          width: "100%",
          boxShadow: "0 20px 50px rgba(0, 0, 0, 0.25)",
          fontFamily: "inherit",
        }}
      >
        <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 10, color: "#0f172a" }}>
          {title}
        </div>
        {message && (
          <div style={{ fontSize: 13, color: "#475569", lineHeight: 1.55, marginBottom: 18 }}>
            {message}
          </div>
        )}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button
            type="button"
            onClick={onCancel}
            style={{
              padding: "8px 14px",
              background: "#f1f5f9",
              color: "#334155",
              border: "1px solid #e2e8f0",
              borderRadius: 6,
              fontSize: 13,
              fontWeight: 600,
              cursor: "pointer",
              fontFamily: "inherit",
            }}
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            onMouseEnter={(e) => (e.currentTarget.style.background = confirmHoverBg)}
            onMouseLeave={(e) => (e.currentTarget.style.background = confirmBg)}
            style={{
              padding: "8px 14px",
              background: confirmBg,
              color: "#fff",
              border: 0,
              borderRadius: 6,
              fontSize: 13,
              fontWeight: 700,
              cursor: "pointer",
              fontFamily: "inherit",
            }}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
