import { memo, useCallback } from "react";
import { fmtDate } from "./helpers";
import api from "../../services/api";

const VisitLabsPanel = memo(function VisitLabsPanel({ documents, labResults, onUploadReport }) {
  const labDocs = documents.filter((d) => d.doc_type === "lab_report");
  const radiologyDocs = documents.filter(
    (d) => d.doc_type === "imaging" || d.doc_type === "radiology",
  );

  const openDoc = useCallback(async (doc) => {
    if (doc.storage_path) {
      try {
        const { data } = await api.get(`/api/documents/${doc.id}/file-url`);
        if (data.url) {
          window.open(data.url, "_blank");
          return;
        }
      } catch {
        /* fall through */
      }
    }
  }, []);

  return (
    <div className="panel-body">
      {/* Blood Reports */}
      <div className="sc">
        <div className="sch">
          <div className="sct">
            <div className="sci ic-b">🩸</div>Blood Reports
          </div>
          <button className="bx bx-p" onClick={onUploadReport}>+ Upload Report</button>
        </div>
        <div className="scb">
          {labDocs.length > 0 ? (
            labDocs.map((doc, i) => (
              <div
                key={doc.id || i}
                className="report-card"
                style={{ cursor: "pointer" }}
                onClick={() => openDoc(doc)}
              >
                <div className="report-icon ri-b">🧪</div>
                <div style={{ flex: 1 }}>
                  <div className="report-nm">{doc.title || doc.file_name || "Lab Report"}</div>
                  <div className="report-dt">
                    {fmtDate(doc.doc_date)}
                    {doc.source ? ` · ${doc.source}` : ""}
                    {doc.notes ? ` · ${doc.notes}` : ""}
                  </div>
                </div>
                <span
                  className={`report-status ${i === 0 ? "rs-new" : doc.has_abnormal ? "rs-ab" : "rs-ok"}`}
                >
                  {i === 0 ? "Latest" : doc.has_abnormal ? "Abnormal" : "Normal"}
                </span>
              </div>
            ))
          ) : (
            <div style={{ fontSize: 13, color: "var(--t3)", padding: 20, textAlign: "center" }}>
              No lab reports uploaded yet
            </div>
          )}
        </div>
      </div>

      {/* Radiology Reports */}
      <div className="sc">
        <div className="sch">
          <div className="sct">
            <div className="sci ic-t">🩻</div>Radiology Reports
          </div>
          <button className="bx bx-p" onClick={onUploadReport}>+ Upload</button>
        </div>
        <div className="scb">
          {radiologyDocs.length > 0 ? (
            radiologyDocs.map((doc, i) => (
              <div
                key={doc.id || i}
                className="report-card"
                style={{ cursor: "pointer" }}
                onClick={() => openDoc(doc)}
              >
                <div className="report-icon ri-r" style={{ background: "#fff0f5" }}>
                  {doc.title?.toLowerCase().includes("echo") ? "🫀" : "🫁"}
                </div>
                <div style={{ flex: 1 }}>
                  <div className="report-nm">
                    {doc.title || doc.file_name || "Radiology Report"}
                  </div>
                  <div className="report-dt">
                    {fmtDate(doc.doc_date)}
                    {doc.source ? ` · ${doc.source}` : ""}
                    {doc.notes ? ` · ${doc.notes}` : ""}
                  </div>
                </div>
                <span className="report-status rs-ab">Review</span>
              </div>
            ))
          ) : (
            <div style={{ fontSize: 13, color: "var(--t3)", padding: 20, textAlign: "center" }}>
              No radiology reports
            </div>
          )}
          <div className="addr">
            <span style={{ fontSize: 14, color: "var(--t3)" }}>+</span>
            <span className="addr-lbl">Upload new radiology report</span>
          </div>
        </div>
      </div>

      {/* All Test Results */}
      {labResults.length > 0 && (
        <div className="sc">
          <div className="sch">
            <div className="sct">
              <div className="sci ic-b">📋</div>All Test Results
            </div>
          </div>
          <div className="scb">
            <div
              style={{
                border: "1px solid var(--border)",
                borderRadius: "var(--rs)",
                overflow: "hidden",
              }}
            >
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "2fr 1fr 1fr 1fr 1fr",
                  padding: "6px 12px",
                  background: "var(--bg)",
                  gap: 6,
                }}
              >
                <span className="mthl">Test</span>
                <span className="mthl">Result</span>
                <span className="mthl">Unit</span>
                <span className="mthl">Range</span>
                <span className="mthl">Date</span>
              </div>
              {labResults.slice(0, 30).map((l, i) => (
                <div
                  key={l.id || i}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "2fr 1fr 1fr 1fr 1fr",
                    padding: "8px 12px",
                    borderTop: "1px solid var(--border)",
                    gap: 6,
                    fontSize: 12,
                  }}
                >
                  <span style={{ fontWeight: 600 }}>{l.test_name}</span>
                  <span
                    style={{
                      fontWeight: 700,
                      color: l.flag === "HIGH" || l.flag === "LOW" ? "var(--red)" : "var(--text)",
                    }}
                  >
                    {l.result ?? l.result_text ?? "—"}{" "}
                    {l.flag && <span style={{ fontSize: 9 }}>({l.flag})</span>}
                  </span>
                  <span style={{ color: "var(--t3)" }}>{l.unit || ""}</span>
                  <span style={{ color: "var(--t4)", fontSize: 11 }}>{l.ref_range || ""}</span>
                  <span style={{ color: "var(--t3)" }}>{fmtDate(l.test_date)}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

    </div>
  );
});

export default VisitLabsPanel;
