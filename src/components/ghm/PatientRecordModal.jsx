import { useCallback, useEffect, useState } from "react";
import { ExternalLink, History, Paperclip, X } from "lucide-react";
import api, { API_URL } from "../../services/api.js";
import useBodyScrollLock from "../../hooks/useBodyScrollLock.js";
import "./PatientRecordModal.css";
import BlockedBadge from "../ui/BlockedBadge.jsx";
import { usePatientBlock } from "../../queries/hooks/usePatientBlocks.js";

const TABS = [
  { id: "documents", label: "Documents", Icon: Paperclip },
  { id: "visits", label: "Visits", Icon: History },
];

const DOC_TYPE_LABEL = {
  prescription: "Prescription",
  lab_report: "Lab Report",
  radiology: "Radiology",
  imaging: "Imaging",
  discharge_summary: "Discharge",
  other: "Other",
};

const fmtDate = (v) => {
  if (!v) return "—";
  const s = String(v).slice(0, 10);
  const d = new Date(`${s}T00:00:00`);
  if (Number.isNaN(d.getTime())) return s;
  return d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
};

const docLabel = (t) => DOC_TYPE_LABEL[t] || (t ? t.replace(/_/g, " ") : "Document");

const streamUrl = (docId) =>
  `${API_URL}/api/ghm-patient-record/document/${docId}/stream?token=${encodeURIComponent(
    localStorage.getItem("gini_auth_token") || "",
  )}`;

function DocViewer({ doc, onClose }) {
  return (
    <div className="prm-viewer" role="dialog" aria-label={doc.title || "Document"}>
      <div className="prm-viewer__bar">
        <span className="prm-viewer__title">{doc.title || doc.file_name || "Document"}</span>
        <a className="prm-btn" href={streamUrl(doc.id)} target="_blank" rel="noreferrer noopener">
          <ExternalLink size={14} aria-hidden="true" />
          Open in new tab
        </a>
        <button type="button" className="prm-btn" onClick={onClose}>
          <X size={14} aria-hidden="true" />
          Close
        </button>
      </div>
      <iframe className="prm-viewer__frame" src={streamUrl(doc.id)} title="Document" />
    </div>
  );
}

export default function PatientRecordModal({ patientId, patientName, onClose }) {
  const [tab, setTab] = useState("documents");
  const [record, setRecord] = useState(null);
  const [error, setError] = useState("");
  const [viewDoc, setViewDoc] = useState(null);

  useBodyScrollLock();

  useEffect(() => {
    let cancelled = false;
    api
      .get(`/api/ghm-patient-record/${patientId}`)
      .then(({ data }) => !cancelled && setRecord(data))
      .catch(
        () => !cancelled && setError("Could not load this patient's record. Please try again."),
      );
    return () => {
      cancelled = true;
    };
  }, [patientId]);

  const escClose = useCallback(
    (e) => {
      if (e.key !== "Escape") return;
      if (viewDoc) setViewDoc(null);
      else onClose();
    },
    [viewDoc, onClose],
  );

  useEffect(() => {
    document.addEventListener("keydown", escClose);
    return () => document.removeEventListener("keydown", escClose);
  }, [escClose]);

  const counts = record ? { documents: record.documents.length, visits: record.visits.length } : {};
  const { block } = usePatientBlock(patientId);

  return (
    <div className="prm-overlay" onClick={onClose}>
      <div className="prm" onClick={(e) => e.stopPropagation()}>
        <div className="prm__hdr">
          <div>
            <h3>
              {patientName || record?.patient?.name || "Patient record"}{" "}
              <BlockedBadge block={block} size="sm" />
            </h3>
            {record?.patient && (
              <span className="prm__sub">
                {[
                  record.patient.file_no,
                  record.patient.phone,
                  record.patient.sex,
                  record.patient.age != null ? `${record.patient.age} yrs` : null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
            )}
          </div>
          <button type="button" className="prm__x" onClick={onClose} aria-label="Close">
            <X size={17} aria-hidden="true" />
          </button>
        </div>

        <div className="prm__tabs">
          {TABS.map(({ id, label, Icon }) => (
            <button
              type="button"
              key={id}
              className={`prm__tab ${tab === id ? "prm__tab--active" : ""}`}
              onClick={() => setTab(id)}
            >
              <Icon size={15} aria-hidden="true" />
              {label}
              {counts[id] != null && <span className="prm__count">{counts[id]}</span>}
            </button>
          ))}
        </div>

        <div className="prm__body">
          {error && <div className="prm-empty">{error}</div>}
          {!error && !record && <div className="prm-empty">Loading record…</div>}

          {record && tab === "documents" && (
            <>
              {record.documents.length === 0 ? (
                <div className="prm-empty">No documents on file for this patient.</div>
              ) : (
                <table className="prm-tbl">
                  <thead>
                    <tr>
                      <th>Date</th>
                      <th>Type</th>
                      <th>Title</th>
                      <th>Source</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {record.documents.map((d) => (
                      <tr key={d.id}>
                        <td className="prm-nowrap">{fmtDate(d.doc_date || d.created_at)}</td>
                        <td>
                          <span className="prm-badge">{docLabel(d.doc_type)}</span>
                        </td>
                        <td>{d.title || d.file_name || "—"}</td>
                        <td className="prm-muted">{d.source || "—"}</td>
                        <td>
                          {d.has_file ? (
                            <button type="button" className="prm-btn" onClick={() => setViewDoc(d)}>
                              View
                            </button>
                          ) : (
                            <span className="prm-muted">No file</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </>
          )}

          {record && tab === "visits" && (
            <>
              {record.visits.length === 0 ? (
                <div className="prm-empty">No visits recorded.</div>
              ) : (
                <table className="prm-tbl">
                  <thead>
                    <tr>
                      <th>Date</th>
                      <th>Slot</th>
                      <th>Doctor</th>
                      <th>MO</th>
                      <th>Type</th>
                    </tr>
                  </thead>
                  <tbody>
                    {record.visits.map((v) => (
                      <tr key={v.id}>
                        <td className="prm-nowrap">{fmtDate(v.appointment_date)}</td>
                        <td className="prm-muted">{v.time_slot || "—"}</td>
                        <td>{v.doctor_name || "—"}</td>
                        <td className="prm-muted">{v.assigned_mo || "—"}</td>
                        <td className="prm-muted">{v.visit_type || "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </>
          )}
        </div>

        {viewDoc && <DocViewer doc={viewDoc} onClose={() => setViewDoc(null)} />}
      </div>
    </div>
  );
}
