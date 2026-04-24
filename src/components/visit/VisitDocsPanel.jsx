import { memo, useCallback, useState } from "react";
import { fmtDate } from "./helpers";
import { toast } from "../../stores/uiStore";
import PdfViewerModal from "./PdfViewerModal";
import { getDocStatus } from "../../utils/docStatus";
import DocStatusPill from "../ui/DocStatusPill";
import MismatchActions from "./MismatchActions";
import usePatientStore from "../../stores/patientStore";

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

const parseExt = (raw) => {
  if (!raw) return null;
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
  return raw;
};

const isMismatchReview = (doc) =>
  parseExt(doc.extracted_data)?.extraction_status === "mismatch_review";

const VisitDocsPanel = memo(function VisitDocsPanel({ documents, patientId, onUploadReport }) {
  const [viewingDoc, setViewingDoc] = useState(null);
  const patient = usePatientStore((s) => s.patient);

  const visibleDocuments = documents.filter(
    (d) => d.storage_path || d.file_url || d.source === "healthray",
  );

  const prescriptions = visibleDocuments.filter((d) => d.doc_type === "prescription");
  const labReports = visibleDocuments.filter((d) => d.doc_type === "lab_report");
  const radiologyReports = visibleDocuments.filter(
    (d) => d.doc_type === "imaging" || d.doc_type === "radiology",
  );
  const otherDocs = visibleDocuments.filter(
    (d) => !["prescription", "lab_report", "imaging", "radiology"].includes(d.doc_type),
  );

  const openDoc = useCallback((doc) => {
    if (!doc.storage_path && doc.source !== "healthray") {
      toast("No file attached to this document", "warn");
      return;
    }
    setViewingDoc(doc);
  }, []);

  const renderDoc = (doc, i) => {
    const status = getDocStatus(doc);
    const needsReview = status.kind === "mismatch";
    const isPending = status.kind === "pending";
    return (
      <div
        key={doc.id || i}
        className="report-card"
        style={{
          cursor: "pointer",
          border: needsReview ? "1px solid #fecaca" : isPending ? "1px solid #c4b5fd" : undefined,
          background: needsReview ? "#fef2f2" : isPending ? "#f5f3ff" : undefined,
        }}
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
            {doc.created_at &&
            (doc.created_at || "").slice(0, 10) !== (doc.doc_date || "").slice(0, 10)
              ? ` · Uploaded ${fmtDate(doc.created_at)}`
              : ""}
            {doc.notes ? ` · ${doc.notes}` : ""}
          </div>
          {needsReview && (
            <>
              <div
                style={{
                  fontSize: 11,
                  color: "#b91c1c",
                  fontWeight: 600,
                  marginTop: 3,
                }}
                title="Extraction not applied — patient name on doc doesn't match."
              >
                ⚠️ Name mismatch — extraction not applied
              </div>
              <MismatchActions
                doc={{ ...doc, patient_id: doc.patient_id || patientId }}
                patient={patient}
                compact
              />
            </>
          )}
        </div>
        {status.label ? (
          <DocStatusPill doc={doc} patientId={patientId} size="sm" />
        ) : doc.doc_type === "prescription" ? (
          <button className="bx bx-p">View PDF</button>
        ) : (
          <span className={`report-status ${doc.has_abnormal ? "rs-ab" : "rs-ok"}`}>
            {doc.has_abnormal ? "Finding" : "Reviewed"}
          </span>
        )}
      </div>
    );
  };

  return (
    <>
      {viewingDoc && <PdfViewerModal doc={viewingDoc} onClose={() => setViewingDoc(null)} />}
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

            {visibleDocuments.length === 0 && (
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
    </>
  );
});

export default VisitDocsPanel;
