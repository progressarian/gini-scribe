import { memo, useEffect, useState } from "react";
import { fmtDate } from "./helpers";
import api from "../../services/api";
import { toast } from "../../stores/uiStore";
import "./PdfViewerModal.css";

const ICON_MAP = {
  lab_report: "🧪",
  prescription: "📄",
  imaging: "🫀",
  discharge: "📋",
  radiology: "🫁",
};

const PdfViewerModal = memo(function PdfViewerModal({ doc, onClose }) {
  const [url, setUrl] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [imgZoomed, setImgZoomed] = useState(false);

  useEffect(() => {
    if (!doc) return;

    let objectUrl = null;

    async function loadDoc() {
      setLoading(true);
      setError(null);

      try {
        // Stream through backend — handles HealthRay (fresh URL, no CORS) and Supabase alike
        const resp = await api.get(`/api/documents/${doc.id}/stream`, {
          responseType: "blob",
        });

        // Mark as reviewed
        if (doc.reviewed === false) {
          api.patch(`/api/documents/${doc.id}/reviewed`).catch(() => {});
        }

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
        console.error("Failed to load document:", err);
        setError("Failed to load document");
      } finally {
        setLoading(false);
      }
    }

    loadDoc();

    return () => {
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [doc]);

  if (!doc) return null;

  const isPdf =
    url?.mimeType === "application/pdf" || (typeof url === "string" && url.includes(".pdf"));
  const isImage = url?.mimeType?.startsWith("image/");

  return (
    <div className="pdf-modal-overlay" onClick={onClose}>
      <div
        className={`pdf-modal ${isFullscreen ? "fullscreen" : ""}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="pdf-modal-header">
          <div className="pdf-modal-title">
            <span className="pdf-modal-icon">{ICON_MAP[doc.doc_type] || "📄"}</span>
            <div>
              <div className="pdf-modal-name">{doc.title || doc.file_name || doc.doc_type}</div>
              <div className="pdf-modal-meta">
                {fmtDate(doc.doc_date || doc.created_at)}
                {doc.source ? ` · ${doc.source}` : ""}
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
                  download={doc.file_name || "document"}
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
                        `<!DOCTYPE html><html><head><title>${doc.file_name || "Document"}</title></head><body style="margin:0;padding:0;overflow:hidden"><iframe src="${blobUrl}" style="width:100vw;height:100vh;border:none"></iframe></body></html>`,
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

        <div className="pdf-modal-content">
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
                <iframe
                  src={typeof url === "string" ? url : url.url}
                  title={doc.title || "PDF Document"}
                  className="pdf-iframe"
                />
              )}
              {isImage && (
                <img
                  src={typeof url === "string" ? url : url.url}
                  alt={doc.title || "Document"}
                  className={`pdf-image ${imgZoomed ? "zoomed" : ""}`}
                  onClick={() => setImgZoomed((z) => !z)}
                  title={imgZoomed ? "Click to fit" : "Click to zoom to full resolution"}
                />
              )}
              {!isPdf && !isImage && (
                <iframe
                  src={typeof url === "string" ? url : url.url}
                  title={doc.title || "Document"}
                  className="pdf-iframe"
                />
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
});

export default PdfViewerModal;
