import { memo, useEffect } from "react";

const RxPdfModal = memo(function RxPdfModal({
  open,
  loading,
  status,
  blobUrl,
  error,
  onClose,
  onRetry,
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const handleDownload = () => {
    if (!blobUrl) return;
    const a = document.createElement("a");
    a.href = blobUrl;
    a.download = `prescription-${new Date().toISOString().slice(0, 10)}.pdf`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  const handleOpenNewTab = () => {
    if (!blobUrl) return;
    window.open(blobUrl, "_blank");
  };

  return (
    <div
      className="mo open"
      onClick={(e) => e.target === e.currentTarget && onClose()}
      style={{ zIndex: 200 }}
    >
      <div
        className="mbox"
        style={{
          width: "min(900px, 95vw)",
          height: "90vh",
          padding: 0,
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "12px 16px",
            borderBottom: "1px solid #e2e8f0",
            background: "#fff",
            flexShrink: 0,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontSize: 16, fontWeight: 700, color: "#0f172a" }}>🖨 Prescription</span>
            {loading && (
              <span style={{ fontSize: 11, color: "#64748b" }}>{status || "Generating PDF…"}</span>
            )}
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            {blobUrl && !loading && (
              <>
                <button
                  className="btn"
                  onClick={handleDownload}
                  style={{ fontSize: 11, padding: "6px 12px" }}
                >
                  ⬇ Download
                </button>
                <button
                  className="btn"
                  onClick={handleOpenNewTab}
                  style={{ fontSize: 11, padding: "6px 12px" }}
                >
                  ↗ Open in tab
                </button>
              </>
            )}
            <button
              className="btn"
              onClick={onClose}
              style={{ fontSize: 11, padding: "6px 12px" }}
              aria-label="Close"
            >
              ✕ Close
            </button>
          </div>
        </div>

        <div style={{ flex: 1, position: "relative", background: "#f1f5f9" }}>
          {loading && (
            <div
              style={{
                position: "absolute",
                inset: 0,
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                gap: 14,
                color: "#475569",
                background: "rgba(241,245,249,.92)",
                zIndex: 2,
              }}
            >
              <div
                style={{
                  width: 44,
                  height: 44,
                  border: "4px solid #cbd5e1",
                  borderTopColor: "#009e8c",
                  borderRadius: "50%",
                  animation: "rxspin 0.9s linear infinite",
                }}
              />
              <div style={{ fontSize: 13, fontWeight: 600 }}>
                {status || "Generating prescription PDF…"}
              </div>
              <div style={{ fontSize: 11, color: "#94a3b8" }}>
                This usually takes a few seconds.
              </div>
              <style>{`@keyframes rxspin{to{transform:rotate(360deg)}}`}</style>
            </div>
          )}

          {error && !loading && (
            <div
              style={{
                position: "absolute",
                inset: 0,
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                padding: 24,
                gap: 12,
                color: "#b91c1c",
              }}
            >
              <div style={{ fontSize: 14, fontWeight: 700 }}>Could not generate prescription</div>
              <div style={{ fontSize: 12, color: "#7f1d1d", textAlign: "center", maxWidth: 480 }}>
                {error}
              </div>
              {onRetry && (
                <button
                  className="btn"
                  onClick={onRetry}
                  style={{ fontSize: 12, padding: "6px 14px" }}
                >
                  Retry
                </button>
              )}
            </div>
          )}

          {blobUrl && (
            <iframe
              src={blobUrl}
              title="Prescription PDF"
              style={{ width: "100%", height: "100%", border: "none", background: "#fff" }}
            />
          )}
        </div>
      </div>
    </div>
  );
});

export default RxPdfModal;
