import { memo, useEffect, useRef, useState } from "react";
import * as pdfjsLib from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { fmtDate } from "./helpers";
import api from "../../services/api";
import { toast } from "../../stores/uiStore";
import "./PdfViewerModal.css";

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

const ICON_MAP = {
  lab_report: "🧪",
  prescription: "📄",
  imaging: "🫀",
  discharge: "📋",
  radiology: "🫁",
};

// Render a PDF with pdf.js into canvases. Chromium's built-in PDF plugin
// refuses to render blob: URLs inside a modal's nested browsing context and
// also gets stuck (about:blank inner frame, no bytes) on some cross-origin
// signed URLs. Rendering via pdf.js sidesteps the plugin entirely — works
// for Supabase URLs, blob URLs, and same-origin streams alike.
function PdfFrame({ src }) {
  const containerRef = useRef(null);
  const [status, setStatus] = useState("loading");
  const [errorMsg, setErrorMsg] = useState("");

  useEffect(() => {
    if (!src) return;
    const container = containerRef.current;
    if (!container) return;

    while (container.firstChild) container.removeChild(container.firstChild);
    setStatus("loading");
    setErrorMsg("");

    let cancelled = false;
    let loadingTask = null;

    (async () => {
      try {
        loadingTask = pdfjsLib.getDocument(src);
        const pdf = await loadingTask.promise;
        if (cancelled) return;

        const dpr = window.devicePixelRatio || 1;
        const availWidth = Math.max(320, container.clientWidth - 32);

        for (let i = 1; i <= pdf.numPages; i++) {
          if (cancelled) return;
          const page = await pdf.getPage(i);
          const baseViewport = page.getViewport({ scale: 1 });
          // Fit page to container width, cap at 2x to avoid huge canvases
          const scale = Math.min(2, Math.max(0.75, availWidth / baseViewport.width));
          const viewport = page.getViewport({ scale });

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
        if (!cancelled) setStatus("ready");
      } catch (e) {
        if (cancelled) return;
        console.error("[PdfFrame] pdf.js render failed:", e);
        setStatus("error");
        setErrorMsg(e?.message || "Failed to render PDF");
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

  return (
    <div className="pdf-js-shell">
      <div className="pdf-js-pages" ref={containerRef} />
      {status === "loading" && <div className="pdf-js-overlay">Rendering PDF…</div>}
      {status === "error" && <div className="pdf-js-overlay pdf-js-error">{errorMsg}</div>}
    </div>
  );
}

const PdfViewerModal = memo(function PdfViewerModal({ doc, src, onClose }) {
  const [url, setUrl] = useState(null);
  const [loading, setLoading] = useState(!src);
  const [error, setError] = useState(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [zoom, setZoom] = useState(null);
  const [fitScale, setFitScale] = useState(1);
  const [isPanning, setIsPanning] = useState(false);
  const contentRef = useRef(null);
  const imgRef = useRef(null);
  const panStateRef = useRef(null);
  const didPanRef = useRef(false);
  const pendingAnchorRef = useRef(null);
  const overlayMouseDownRef = useRef(false);
  const zoomRef = useRef(null);
  const fitScaleRef = useRef(1);

  const isPannable = zoom != null && zoom > fitScale + 0.001;

  const handlePanStart = (e) => {
    if (!isPannable || !contentRef.current) return;
    const point = e.touches ? e.touches[0] : e;
    panStateRef.current = {
      startX: point.clientX,
      startY: point.clientY,
      scrollLeft: contentRef.current.scrollLeft,
      scrollTop: contentRef.current.scrollTop,
    };
    didPanRef.current = false;
    setIsPanning(true);
    if (!e.touches) e.preventDefault();
  };

  const handlePanMove = (e) => {
    const state = panStateRef.current;
    if (!state || !contentRef.current) return;
    const point = e.touches ? e.touches[0] : e;
    const dx = point.clientX - state.startX;
    const dy = point.clientY - state.startY;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) didPanRef.current = true;
    contentRef.current.scrollLeft = state.scrollLeft - dx;
    contentRef.current.scrollTop = state.scrollTop - dy;
  };

  const handlePanEnd = () => {
    panStateRef.current = null;
    setIsPanning(false);
  };

  useEffect(() => {
    zoomRef.current = zoom;
  }, [zoom]);
  useEffect(() => {
    fitScaleRef.current = fitScale;
  }, [fitScale]);

  const computeFit = () => {
    const img = imgRef.current;
    const cont = contentRef.current;
    if (!img || !cont || !img.naturalWidth || !img.naturalHeight) return null;
    return Math.min(cont.clientWidth / img.naturalWidth, cont.clientHeight / img.naturalHeight, 1);
  };

  const zoomTo = (nextZoom, clientX, clientY) => {
    const img = imgRef.current;
    const cont = contentRef.current;
    const current = zoomRef.current;
    if (!img || !cont || !img.naturalWidth || current == null) return;
    const fs = fitScaleRef.current;
    const clamped = Math.max(fs, Math.min(4, nextZoom));
    if (Math.abs(clamped - current) < 0.0005) return;
    const contRect = cont.getBoundingClientRect();
    const imgRect = img.getBoundingClientRect();
    // Click in container-viewport space
    const cx = (clientX ?? contRect.left + contRect.width / 2) - contRect.left;
    const cy = (clientY ?? contRect.top + contRect.height / 2) - contRect.top;
    // Image's top-left offset inside the container — captures both the
    // margin:auto centering (when the image fits) and the current scroll
    // (when it overflows). Without this, clicks near the container edge
    // map to the wrong image fraction and zoom lands off-target.
    const imgOffsetX = imgRect.left - contRect.left;
    const imgOffsetY = imgRect.top - contRect.top;
    const curW = img.naturalWidth * current;
    const curH = img.naturalHeight * current;
    const fx = curW ? Math.max(0, Math.min(1, (cx - imgOffsetX) / curW)) : 0.5;
    const fy = curH ? Math.max(0, Math.min(1, (cy - imgOffsetY) / curH)) : 0.5;
    pendingAnchorRef.current = { fx, fy, cx, cy };
    setZoom(clamped);
  };

  useEffect(() => {
    const img = imgRef.current;
    const cont = contentRef.current;
    const anchor = pendingAnchorRef.current;
    if (zoom == null || !img || !cont || !img.naturalWidth || !anchor) return;
    const newW = img.naturalWidth * zoom;
    const newH = img.naturalHeight * zoom;
    const viewW = cont.clientWidth;
    const viewH = cont.clientHeight;
    const maxL = Math.max(0, newW - viewW);
    const maxT = Math.max(0, newH - viewH);
    cont.scrollLeft = Math.max(0, Math.min(maxL, anchor.fx * newW - anchor.cx));
    cont.scrollTop = Math.max(0, Math.min(maxT, anchor.fy * newH - anchor.cy));
    pendingAnchorRef.current = null;
  }, [zoom]);

  const handleImgLoad = () => {
    const fs = computeFit();
    if (fs == null) return;
    setFitScale(fs);
    fitScaleRef.current = fs;
    setZoom(fs);
    zoomRef.current = fs;
  };

  useEffect(() => {
    const cont = contentRef.current;
    if (!cont) return;
    const onWheel = (e) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      if (zoomRef.current == null) return;
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
      zoomTo(zoomRef.current * factor, e.clientX, e.clientY);
    };
    cont.addEventListener("wheel", onWheel, { passive: false });
    return () => cont.removeEventListener("wheel", onWheel);
  }, []);

  useEffect(() => {
    const cont = contentRef.current;
    const img = imgRef.current;
    if (!cont || !img) return;
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      const fs = computeFit();
      if (fs == null) return;
      const oldFit = fitScaleRef.current;
      fitScaleRef.current = fs;
      setFitScale(fs);
      const z = zoomRef.current;
      if (z != null && Math.abs(z - oldFit) < 0.001) {
        zoomRef.current = fs;
        setZoom(fs);
      }
    });
    observer.observe(cont);
    return () => observer.disconnect();
  }, [url]);

  useEffect(() => {
    if (!isPanning) return;
    const onMove = (e) => handlePanMove(e);
    const onUp = () => handlePanEnd();
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    window.addEventListener("touchmove", onMove, { passive: true });
    window.addEventListener("touchend", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      window.removeEventListener("touchmove", onMove);
      window.removeEventListener("touchend", onUp);
    };
  }, [isPanning]);

  const srcUrl = src?.url || null;
  const srcMime = src?.mimeType || null;
  const srcFileName = src?.fileName || null;

  useEffect(() => {
    if (srcUrl) {
      setUrl({
        url: srcUrl,
        mimeType: srcMime || "application/pdf",
        fileName: srcFileName || "document",
      });
      setLoading(false);
      setError(null);
      return;
    }
    if (!doc) return;

    let objectUrl = null;
    let cancelled = false;

    async function loadDoc() {
      setLoading(true);
      setError(null);

      // Mark as reviewed (fire-and-forget)
      if (doc.reviewed === false) {
        api.patch(`/api/documents/${doc.id}/reviewed`).catch(() => {});
      }

      // 1) Always try for a direct signed URL first — Chromium's PDF viewer
      //    renders real HTTPS URLs reliably, but fails silently for blob:
      //    URLs inside a nested browsing context (the modal iframe).
      //    /file-url returns a Supabase signed URL for stored docs and a
      //    404 for docs that only exist as a HealthRay buffer — in which
      //    case we fall through to blob streaming below.
      try {
        const { data } = await api.get(`/api/documents/${doc.id}/file-url`);
        if (!cancelled && data?.url) {
          setUrl({
            url: data.url,
            mimeType: data.mime_type || "application/pdf",
            fileName: data.file_name || doc.file_name || doc.title,
          });
          setLoading(false);
          return;
        }
      } catch (e) {
        console.warn(
          `[PdfViewer] /file-url failed for doc ${doc.id}, falling back to blob stream:`,
          e?.response?.status,
          e?.response?.data?.error || e?.message,
        );
      }

      // 2) Fallback: stream bytes and wrap in a blob URL (HealthRay path).
      try {
        const resp = await api.get(`/api/documents/${doc.id}/stream`, {
          responseType: "blob",
        });
        if (cancelled) return;

        const blob = resp.data;
        // MIME priority: response Content-Type header → blob's own type → default PDF
        // Never trust doc.mime_type from props — HealthRay docs often have wrong stored mime_type
        const headerMime = resp.headers["content-type"]?.split(";")[0].trim();
        const blobMime = blob.type && blob.type !== "application/octet-stream" ? blob.type : null;
        const mimeType =
          headerMime && headerMime !== "application/octet-stream"
            ? headerMime
            : blobMime || "application/pdf";

        objectUrl = URL.createObjectURL(new Blob([blob], { type: mimeType }));
        setUrl({ url: objectUrl, mimeType, fileName: doc.file_name || doc.title });
      } catch (err) {
        if (!cancelled) {
          console.error("Failed to load document:", err);
          setError("Failed to load document");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    loadDoc();

    return () => {
      cancelled = true;
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [doc, srcUrl, srcMime, srcFileName]);

  if (!doc && !src) return null;

  const viewDoc = doc || {
    doc_type: (src?.mimeType || "").startsWith("image/") ? "imaging" : "prescription",
    title: src?.title || src?.fileName,
    file_name: src?.fileName,
    doc_date: src?.docDate,
    source: src?.source,
  };

  const isPdf =
    url?.mimeType === "application/pdf" || (typeof url === "string" && url.includes(".pdf"));
  const isImage = url?.mimeType?.startsWith("image/");

  return (
    <div
      className="pdf-modal-overlay"
      onMouseDown={(e) => {
        overlayMouseDownRef.current = e.target === e.currentTarget;
      }}
      onMouseUp={(e) => {
        if (overlayMouseDownRef.current && e.target === e.currentTarget) {
          onClose();
        }
        overlayMouseDownRef.current = false;
      }}
    >
      <div className={`pdf-modal ${isFullscreen ? "fullscreen" : ""}`}>
        <div className="pdf-modal-header">
          <div className="pdf-modal-title">
            <span className="pdf-modal-icon">{ICON_MAP[viewDoc.doc_type] || "📄"}</span>
            <div>
              <div className="pdf-modal-name">
                {viewDoc.title || viewDoc.file_name || viewDoc.doc_type}
              </div>
              <div className="pdf-modal-meta">
                {fmtDate(viewDoc.doc_date || viewDoc.created_at)}
                {viewDoc.source ? ` · ${viewDoc.source}` : ""}
              </div>
            </div>
          </div>
          <div className="pdf-modal-actions">
            {url && !loading && (
              <>
                <button
                  className="pdf-btn"
                  onClick={() => setIsFullscreen(!isFullscreen)}
                  title={isFullscreen ? "Exit fullscreen" : "Fullscreen"}
                >
                  {isFullscreen ? "⊞" : "⊏"}
                </button>
                <a
                  className="pdf-btn"
                  href={typeof url === "string" ? url : url.url}
                  download={viewDoc.file_name || "document"}
                  onClick={(e) => e.stopPropagation()}
                  title="Download"
                >
                  ⬇
                </a>
                <button
                  className="pdf-btn"
                  onClick={() => {
                    const blobUrl = typeof url === "string" ? url : url.url;
                    const win = window.open("", "_blank");
                    if (win) {
                      win.document.write(
                        `<!DOCTYPE html><html><head><title>${viewDoc.file_name || "Document"}</title></head><body style="margin:0;padding:0;overflow:hidden"><iframe src="${blobUrl}" style="width:100vw;height:100vh;border:none"></iframe></body></html>`,
                      );
                      win.document.close();
                    }
                  }}
                  title="Open in new tab"
                >
                  ↗
                </button>
              </>
            )}
            <button className="pdf-btn pdf-btn-close" onClick={onClose}>
              ✕
            </button>
          </div>
        </div>

        <div
          className={`pdf-modal-content ${isPannable ? "pannable" : ""} ${isPanning ? "panning" : ""}`}
          ref={contentRef}
        >
          {loading && (
            <div className="pdf-loading">
              <div className="pdf-spinner"></div>
              <div>Loading document...</div>
            </div>
          )}

          {error && <div className="pdf-error">{error}</div>}

          {url && !loading && !error && (
            <>
              {isPdf && (
                <PdfFrame
                  src={typeof url === "string" ? url : url.url}
                  title={viewDoc.title || "PDF Document"}
                />
              )}
              {isImage && (
                <img
                  ref={imgRef}
                  src={typeof url === "string" ? url : url.url}
                  alt={viewDoc.title || "Document"}
                  className={`pdf-image ${isPannable ? "zoomed" : ""}`}
                  onLoad={handleImgLoad}
                  onMouseDown={handlePanStart}
                  onTouchStart={handlePanStart}
                  onClick={(e) => {
                    if (didPanRef.current) {
                      didPanRef.current = false;
                      return;
                    }
                    const atFit = zoom != null && Math.abs(zoom - fitScale) < 0.001;
                    if (atFit) {
                      zoomTo(Math.max(1, fitScale * 2), e.clientX, e.clientY);
                    } else {
                      zoomTo(fitScale);
                    }
                  }}
                  draggable={false}
                  style={
                    zoom != null && imgRef.current?.naturalWidth
                      ? {
                          width: `${imgRef.current.naturalWidth * zoom}px`,
                          height: `${imgRef.current.naturalHeight * zoom}px`,
                          maxWidth: "none",
                          maxHeight: "none",
                          objectFit: "fill",
                        }
                      : undefined
                  }
                  title={
                    isPannable
                      ? "Drag to pan · Ctrl+scroll to zoom · Click to fit"
                      : "Click to zoom · Ctrl+scroll to zoom"
                  }
                />
              )}
              {!isPdf && !isImage && (
                <iframe
                  src={typeof url === "string" ? url : url.url}
                  title={viewDoc.title || "Document"}
                  className="pdf-iframe"
                />
              )}
            </>
          )}
        </div>
        {isImage && zoom != null && !loading && !error && (
          <div className="pdf-zoom-bar" onMouseDown={(e) => e.stopPropagation()}>
            <button
              className="pdf-zoom-btn"
              onClick={() => zoomTo(zoom / 1.2)}
              title="Zoom out"
              disabled={zoom <= fitScale + 0.001}
            >
              −
            </button>
            <input
              type="range"
              min={fitScale}
              max={4}
              step={0.01}
              value={zoom}
              onChange={(e) => zoomTo(parseFloat(e.target.value))}
              className="pdf-zoom-slider"
            />
            <button
              className="pdf-zoom-btn"
              onClick={() => zoomTo(zoom * 1.2)}
              title="Zoom in"
              disabled={zoom >= 4 - 0.001}
            >
              +
            </button>
            <span className="pdf-zoom-pct">{Math.round(zoom * 100)}%</span>
            <button
              className="pdf-zoom-btn pdf-zoom-fit"
              onClick={() => zoomTo(fitScale)}
              title="Fit to screen"
            >
              Fit
            </button>
          </div>
        )}
      </div>
    </div>
  );
});

export default PdfViewerModal;
