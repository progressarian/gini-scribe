import { memo, useEffect, useRef, useState } from "react";
import * as pdfjsLib from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import "./PdfViewerModal.css";

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

const ZOOM_MIN = 0.5;
const ZOOM_MAX = 3;
const ZOOM_STEP = 0.25;

// Chromium's built-in PDF plugin refuses to render blob: URLs inside a modal's
// nested browsing context (blank iframe). Render via pdf.js to sidestep it —
// same approach used by PdfViewerModal.
function PdfFrame({ src }) {
  const containerRef = useRef(null);
  const pdfRef = useRef(null);
  const renderTokenRef = useRef(0);
  const [status, setStatus] = useState("loading");
  const [errorMsg, setErrorMsg] = useState("");
  const [zoom, setZoom] = useState(1);
  const [fitScale, setFitScale] = useState(1);

  // Load PDF document once per src
  useEffect(() => {
    if (!src) return;
    let cancelled = false;
    let loadingTask = null;
    setStatus("loading");
    setErrorMsg("");
    pdfRef.current = null;

    (async () => {
      try {
        loadingTask = pdfjsLib.getDocument(src);
        const pdf = await loadingTask.promise;
        if (cancelled) return;
        pdfRef.current = pdf;

        // Compute a fit-to-width scale based on first page
        const page = await pdf.getPage(1);
        if (cancelled) return;
        const baseViewport = page.getViewport({ scale: 1 });
        const container = containerRef.current;
        const availWidth = Math.max(320, (container?.clientWidth || 800) - 32);
        const fit = Math.min(2, Math.max(0.75, availWidth / baseViewport.width));
        setFitScale(fit);
        setZoom(fit);
      } catch (e) {
        if (cancelled) return;
        console.error("[RxPdfModal] pdf.js load failed:", e);
        setStatus("error");
        setErrorMsg(e?.message || "Failed to load PDF");
      }
    })();

    return () => {
      cancelled = true;
      if (loadingTask) {
        try {
          loadingTask.destroy();
        } catch {}
      }
    };
  }, [src]);

  // Render pages at current zoom whenever zoom changes
  useEffect(() => {
    const pdf = pdfRef.current;
    const container = containerRef.current;
    if (!pdf || !container) return;

    const token = ++renderTokenRef.current;
    let cancelled = false;

    (async () => {
      try {
        while (container.firstChild) container.removeChild(container.firstChild);
        const dpr = window.devicePixelRatio || 1;

        for (let i = 1; i <= pdf.numPages; i++) {
          if (cancelled || token !== renderTokenRef.current) return;
          const page = await pdf.getPage(i);
          const viewport = page.getViewport({ scale: zoom });

          const canvas = document.createElement("canvas");
          canvas.width = Math.round(viewport.width * dpr);
          canvas.height = Math.round(viewport.height * dpr);
          canvas.style.width = `${viewport.width}px`;
          canvas.style.height = `${viewport.height}px`;
          canvas.className = "pdf-js-page";
          container.appendChild(canvas);

          const ctx = canvas.getContext("2d");
          ctx.scale(dpr, dpr);
          await page.render({ canvasContext: ctx, viewport }).promise;
        }
        if (!cancelled && token === renderTokenRef.current) setStatus("ready");
      } catch (e) {
        if (cancelled) return;
        console.error("[RxPdfModal] pdf.js render failed:", e);
        setStatus("error");
        setErrorMsg(e?.message || "Failed to render PDF");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [zoom]);

  const clamp = (v) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, v));
  const zoomIn = () => setZoom((z) => clamp(+(z + ZOOM_STEP).toFixed(2)));
  const zoomOut = () => setZoom((z) => clamp(+(z - ZOOM_STEP).toFixed(2)));
  const fit = () => setZoom(fitScale);
  const pct = Math.round(zoom * 100);

  return (
    <div className="pdf-js-shell pdf-js-shell--rx">
      <div className="pdf-js-pages pdf-js-pages--scroll" ref={containerRef} />
      {status === "loading" && <div className="pdf-js-overlay">Rendering PDF…</div>}
      {status === "error" && <div className="pdf-js-overlay pdf-js-error">{errorMsg}</div>}
      <div className="pdf-zoom-bar">
        <button
          className="pdf-zoom-btn"
          onClick={zoomOut}
          disabled={zoom <= ZOOM_MIN + 0.001}
          aria-label="Zoom out"
        >
          −
        </button>
        <input
          className="pdf-zoom-slider"
          type="range"
          min={ZOOM_MIN}
          max={ZOOM_MAX}
          step={0.05}
          value={zoom}
          onChange={(e) => setZoom(parseFloat(e.target.value))}
          aria-label="Zoom"
        />
        <button
          className="pdf-zoom-btn"
          onClick={zoomIn}
          disabled={zoom >= ZOOM_MAX - 0.001}
          aria-label="Zoom in"
        >
          +
        </button>
        <span className="pdf-zoom-pct">{pct}%</span>
        <button className="pdf-zoom-btn pdf-zoom-fit" onClick={fit} aria-label="Fit to width">
          Fit
        </button>
      </div>
    </div>
  );
}

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

        <div
          style={{
            flex: 1,
            position: "relative",
            background: "#f1f5f9",
            display: "flex",
            flexDirection: "column",
            minHeight: 0,
          }}
        >
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

          {blobUrl && <PdfFrame src={blobUrl} />}
        </div>
      </div>
    </div>
  );
});

export default RxPdfModal;
