import { memo, useCallback } from "react";
import { fmtDate } from "./helpers";
import api from "../../services/api";
import { toast } from "../../stores/uiStore";

const ICON_MAP = {
  lab_report: "🧪",
  prescription: "📄",
  imaging: "🫀",
  discharge: "📋",
  radiology: "🫁",
};
const BG_MAP = {
  lab_report: "ri-g",
  prescription: "ri-b",
  imaging: "ri-r",
  radiology: "ri-r",
  discharge: "ri-o",
};

const VisitDocsPanel = memo(function VisitDocsPanel({ documents, onUploadReport }) {
  const prescriptions = documents.filter((d) => d.doc_type === "prescription");
  const labReports = documents.filter((d) => d.doc_type === "lab_report");
  const radiologyReports = documents.filter(
    (d) => d.doc_type === "imaging" || d.doc_type === "radiology",
  );
  const otherDocs = documents.filter(
    (d) => !["prescription", "lab_report", "imaging", "radiology"].includes(d.doc_type),
  );

  const openDoc = useCallback(async (doc) => {
    if (!doc.storage_path && doc.source !== "healthray") {
      toast("No file attached to this document", "warn");
      return;
    }

    const newTab = window.open("", "_blank");

    try {
      const { data } = await api.get(`/api/documents/${doc.id}/file-url`);

      // Mark as reviewed (fire-and-forget — clears R5 rule on next summary load)
      if (!doc.reviewed) {
        api.patch(`/api/documents/${doc.id}/reviewed`).catch(() => {});
      }

      if (!data.url) {
        newTab.close();
        toast("Could not get file link", "warn");
        return;
      }

      const res = await fetch(data.url);
      const blob = await res.blob();

      // Detect real mime type from URL extension, fallback to blob type, then mime_type from DB
      const urlPath = data.url.split("?")[0].toLowerCase(); // strip query params
      let mimeType;
      if (urlPath.endsWith(".jpg") || urlPath.endsWith(".jpeg")) {
        mimeType = "image/jpeg";
      } else if (urlPath.endsWith(".png")) {
        mimeType = "image/png";
      } else if (urlPath.endsWith(".pdf")) {
        mimeType = "application/pdf";
      } else {
        mimeType = blob.type || data.mime_type || "application/pdf";
      }

      const typedBlob = new Blob([blob], { type: mimeType });
      const blobUrl = URL.createObjectURL(typedBlob);
      newTab.location.href = blobUrl;
      setTimeout(() => URL.revokeObjectURL(blobUrl), 30_000);
    } catch {
      newTab?.close();
      toast("Failed to open document", "error");
    }
  }, []);

  const renderDoc = (doc, i) => (
    <div
      key={doc.id || i}
      className="report-card"
      style={{ cursor: "pointer" }}
      onClick={() => openDoc(doc)}
    >
      <div
        className={`report-icon ${BG_MAP[doc.doc_type] || "ri-b"}`}
        style={
          doc.doc_type === "imaging" || doc.doc_type === "radiology"
            ? { background: "#fff0f5" }
            : undefined
        }
      >
        {ICON_MAP[doc.doc_type] || "📄"}
      </div>
      <div style={{ flex: 1 }}>
        <div className="report-nm">{doc.title || doc.file_name || doc.doc_type}</div>
        <div className="report-dt">
          {fmtDate(doc.doc_date || doc.created_at)}
          {doc.source ? ` · ${doc.source}` : ""}
          {doc.notes ? ` · ${doc.notes}` : ""}
        </div>
      </div>
      {doc.doc_type === "prescription" ? (
        <button className="bx bx-p">View PDF</button>
      ) : (
        <span className={`report-status ${doc.has_abnormal ? "rs-ab" : "rs-ok"}`}>
          {doc.has_abnormal ? "Finding" : "Reviewed"}
        </span>
      )}
    </div>
  );

  return (
    <div className="panel-body">
      <div className="sc">
        <div className="sch">
          <div className="sct">
            <div className="sci ic-b">📁</div>Documents &amp; Files
          </div>
          <button className="bx bx-p" onClick={onUploadReport}>
            + Upload Document
          </button>
        </div>
        <div className="scb">
          {prescriptions.length > 0 && (
            <>
              <div className="subsec">Prescriptions</div>
              {prescriptions.map(renderDoc)}
            </>
          )}

          {labReports.length > 0 && (
            <>
              <div className="subsec" style={{ marginTop: 10 }}>
                Lab Reports (Uploaded)
              </div>
              {labReports.map(renderDoc)}
            </>
          )}

          {radiologyReports.length > 0 && (
            <>
              <div className="subsec" style={{ marginTop: 10 }}>
                Radiology &amp; Specialist Reports
              </div>
              {radiologyReports.map(renderDoc)}
            </>
          )}

          {otherDocs.length > 0 && (
            <>
              <div className="subsec" style={{ marginTop: 10 }}>
                Other Documents
              </div>
              {otherDocs.map(renderDoc)}
            </>
          )}

          {documents.length === 0 && (
            <div style={{ fontSize: 13, color: "var(--t3)", padding: 20, textAlign: "center" }}>
              No documents uploaded
            </div>
          )}

          <div className="addr" style={{ marginTop: 6 }} onClick={onUploadReport}>
            <span style={{ fontSize: 15, color: "var(--t3)" }}>+</span>
            <span className="addr-lbl">Upload a new document or report</span>
          </div>
        </div>
      </div>
    </div>
  );
});

export default VisitDocsPanel;
