import "./PatientScreen.css";
import { memo, useEffect, useMemo, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { makeNavClick } from "../lib/navClick";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { docCategories, fDate } from "./constants";
import useCompanionStore from "../stores/companionStore";
import MismatchReviewModal from "../components/companion/MismatchReviewModal.jsx";
import CompanionBell from "./CompanionBell.jsx";
import PdfViewerModal from "../components/visit/PdfViewerModal.jsx";
import { useCompanionPatient } from "../queries/hooks/useCompanionPatient.js";
import { qk } from "../queries/keys.js";
import DocStatusPill from "../components/ui/DocStatusPill.jsx";

const tabs = [
  ["records", "📎 Docs"],
  ["rx", "💊 Meds"],
  ["labs", "🔬 Labs"],
  ["visits", "📜 Visits"],
];

export default function PatientScreen() {
  const { id } = useParams();
  const navigate = useNavigate();
  const navClick = makeNavClick(navigate);
  const { patientTab, setPatientTab, selectedPatient } = useCompanionStore();
  const setStorePatient = useCompanionStore((s) => s.setSelectedPatient);

  const [viewingDoc, setViewingDoc] = useState(null);

  const idNum = id ? parseInt(id) : null;
  const { data: patientData, isLoading } = useCompanionPatient(idNum);
  const loading = isLoading;

  // Keep other companion screens (list, capture) in sync with the currently
  // selected patient — they still read from the zustand store.
  useEffect(() => {
    if (patientData && patientData.id === idNum) {
      setStorePatient(patientData);
    }
  }, [patientData, idNum, setStorePatient]);

  // Guard against rendering stale header info from a previously-selected
  // patient while a new id is still loading.
  const patient =
    selectedPatient?.id === idNum
      ? selectedPatient
      : patientData?.id === idNum
        ? patientData
        : null;

  if (!patient && !loading) {
    return (
      <div className="patient__loading">
        <div className="patient__loading-spinner" />
      </div>
    );
  }

  return (
    <div>
      <div className="patient__header">
        <div
          className="patient__header-row"
          style={{ display: "flex", alignItems: "center", gap: 8 }}
        >
          <button onClick={navClick("/companion")} className="patient__back">
            ←
          </button>
          {patient && (
            <div className="patient__header-info" style={{ flex: 1, minWidth: 0 }}>
              <div className="patient__header-name">{patient.name}</div>
              <div className="patient__header-details">
                {patient.age ? `${patient.age}Y` : ""}
                {patient.sex ? `/${patient.sex[0]}` : ""}
                {patient.file_no ? ` · ${patient.file_no}` : ""}
                {patient.phone ? ` · ${patient.phone}` : ""}
              </div>
            </div>
          )}
          <CompanionBell />
        </div>
        <div className="patient__header-actions">
          <button
            onClick={navClick(`/companion/multi-capture/${id}`)}
            className="patient__action-btn patient__action-btn--multi"
          >
            <span className="patient__action-icon">📤</span>
            <span className="patient__action-label">Multi Upload</span>
          </button>
          <button
            onClick={navClick(`/companion/capture/${id}`)}
            className="patient__action-btn patient__action-btn--capture"
          >
            <span className="patient__action-icon">📸</span>
            <span className="patient__action-label">Capture</span>
          </button>
        </div>
        <div className="patient__tabs">
          {tabs.map(([tabId, label]) => (
            <button
              key={tabId}
              onClick={() => setPatientTab(tabId)}
              className={`patient__tab ${patientTab === tabId ? "patient__tab--active" : ""}`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {loading && (
        <div className="patient__loading">
          <div className="patient__loading-spinner" />
        </div>
      )}

      {!loading && patientData && (
        <div className="patient__body">
          {patientTab === "records" && (
            <RecordsTab
              patientData={patientData}
              onCapture={() => navigate(`/companion/capture/${id}`)}
              onViewDoc={setViewingDoc}
            />
          )}
          {patientTab === "rx" && <MedicationsTab patientData={patientData} />}
          {patientTab === "labs" && <LabsTab patientData={patientData} />}
          {patientTab === "visits" && <VisitsTab patientData={patientData} />}
        </div>
      )}

      {viewingDoc && <PdfViewerModal doc={viewingDoc} onClose={() => setViewingDoc(null)} />}
    </div>
  );
}

const PHASE_BADGE = {
  classifying: { label: "🏷️ Classifying…", color: "#f59e0b" },
  extracting: { label: "⏳ Extracting…", color: "#7c3aed" },
  syncing: { label: "💾 Saving data…", color: "#2563eb" },
  awaiting_review: { label: "⚠️ Needs review", color: "#dc2626" },
};

const RecordsTab = memo(function RecordsTab({ patientData, onCapture, onViewDoc }) {
  const docs = patientData.documents || [];
  const pendingExtractions = useCompanionStore((s) => s.pendingExtractions);
  const acceptMismatchedExtraction = useCompanionStore((s) => s.acceptMismatchedExtraction);
  const rejectMismatchedExtraction = useCompanionStore((s) => s.rejectMismatchedExtraction);
  const [mismatchReview, setMismatchReview] = useState(null);
  const [processing, setProcessing] = useState({}); // { [docId]: "accept"|"reject" }
  const queryClient = useQueryClient();

  // Refetch patient docs + mismatch list every time the Records tab mounts
  // (user switches tabs → RecordsTab remounts → effect fires).
  useEffect(() => {
    queryClient.invalidateQueries({ queryKey: qk.companion.patient(patientData.id) });
    queryClient.invalidateQueries({ queryKey: ["companion", "mismatchReviews"] });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const acceptMutation = useMutation({
    mutationFn: ({ docId, opts }) => acceptMismatchedExtraction(docId, opts),
    onMutate: ({ docId }) => {
      setProcessing((p) => ({ ...p, [docId]: "accept" }));
    },
    onSettled: (_d, _e, { docId }) => {
      setProcessing((p) => {
        const n = { ...p };
        delete n[docId];
        return n;
      });
      queryClient.invalidateQueries({ queryKey: qk.companion.patient(patientData.id) });
      queryClient.invalidateQueries({ queryKey: ["companion", "mismatchReviews"] });
    },
  });

  const rejectMutation = useMutation({
    mutationFn: ({ docId, opts }) => rejectMismatchedExtraction(docId, opts),
    onMutate: ({ docId }) => {
      setProcessing((p) => ({ ...p, [docId]: "reject" }));
    },
    onSettled: (_d, _e, { docId }) => {
      setProcessing((p) => {
        const n = { ...p };
        delete n[docId];
        return n;
      });
      queryClient.invalidateQueries({ queryKey: qk.companion.patient(patientData.id) });
      queryClient.invalidateQueries({ queryKey: ["companion", "mismatchReviews"] });
    },
  });

  // Parse extracted_data once per docs array identity; avoids re-parsing JSON
  // on every parent re-render (tab switch, store update).
  const parsedDocs = useMemo(() => {
    return docs.map((doc) => {
      const cat = docCategories.find((c) => c.id === doc.doc_type) || {
        label: "📄",
        color: "#64748b",
      };
      let ext = null;
      if (doc.extracted_data) {
        if (typeof doc.extracted_data === "string") {
          try {
            ext = JSON.parse(doc.extracted_data);
          } catch {
            ext = null;
          }
        } else {
          ext = doc.extracted_data;
        }
      }
      return { doc, cat, ext };
    });
  }, [docs]);

  if (docs.length === 0) {
    return (
      <div className="patient__empty">
        <div className="patient__empty-icon">📎</div>
        <div className="patient__empty-text">No documents yet</div>
        <button onClick={onCapture} className="patient__empty-btn">
          📸 Capture
        </button>
      </div>
    );
  }

  return (
    <div>
      {parsedDocs.map(({ doc, cat, ext }) => {
        const pending = pendingExtractions[doc.id];
        const sentinelMismatch =
          !pending && ext?.extraction_status === "mismatch_review"
            ? {
                status: "mismatch",
                phase: "awaiting_review",
                mismatch: ext.mismatch,
                pendingPayload: ext.pending_payload,
                pendingMeta: ext.pending_meta || {},
                category: ext.category || doc.doc_type,
                fileName: ext.file_name || doc.title,
              }
            : null;
        const sentinelPending =
          !pending && !sentinelMismatch && ext?.extraction_status === "pending"
            ? { status: "extracting", phase: "extracting" }
            : null;
        // Pick up failed state persisted to the DB so the Retry button shows
        // even after a page refresh on the companion tablet.
        const sentinelFailed =
          !pending && !sentinelMismatch && !sentinelPending && ext?.extraction_status === "failed"
            ? {
                status: "failed",
                phase: "failed",
                error: ext.error_message || "Extraction failed",
              }
            : null;
        const state = pending || sentinelMismatch || sentinelPending || sentinelFailed;
        const phaseChip =
          state && state.status !== "failed"
            ? PHASE_BADGE[state.phase] || PHASE_BADGE.extracting
            : null;

        const proc = processing[doc.id];

        return (
          <div key={doc.id} className="patient__doc-card" style={{ position: "relative" }}>
            {proc && (
              <div
                style={{
                  position: "absolute",
                  inset: 0,
                  background: "rgba(255,255,255,0.85)",
                  backdropFilter: "blur(1px)",
                  zIndex: 2,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 10,
                  borderRadius: 8,
                  color: proc === "accept" ? "#15803d" : "#b91c1c",
                  fontWeight: 700,
                  fontSize: 13,
                }}
              >
                <span
                  style={{
                    width: 18,
                    height: 18,
                    border: "2px solid currentColor",
                    borderTopColor: "transparent",
                    borderRadius: "50%",
                    display: "inline-block",
                    animation: "spin 0.7s linear infinite",
                  }}
                />
                {proc === "accept" ? "Saving extraction…" : "Deleting document…"}
              </div>
            )}
            <div className="patient__doc-row">
              <div className="patient__doc-icon" style={{ background: cat.color + "15" }}>
                {cat.label?.split(" ")[0]}
              </div>
              <div className="patient__doc-info">
                <div className="patient__doc-title">{doc.title || doc.doc_type}</div>
                <div className="patient__doc-meta">
                  {doc.source} • {fDate(doc.doc_date)}
                </div>
                {(phaseChip || state?.status === "failed") && (
                  <div className="patient__doc-badges">
                    {phaseChip && (
                      <span
                        className="patient__doc-badge"
                        style={{ color: phaseChip.color, borderColor: phaseChip.color }}
                      >
                        {phaseChip.label}
                      </span>
                    )}
                    {state?.status === "failed" && (
                      // Same pill + Retry button users see on /visit?tab=labs,
                      // /opd, /docs, /dashboard. Reads extracted_data from
                      // the DB (persisted by companionStore on failure), so
                      // it works even after a page refresh. Falls back to
                      // the in-memory error string so freshly-failed tasks
                      // show the message immediately.
                      <DocStatusPill
                        doc={{
                          id: doc.id,
                          extracted_data: {
                            extraction_status: "failed",
                            error_message: ext?.error_message || state.error || "Extraction failed",
                            retry_count: ext?.retry_count || 3,
                          },
                        }}
                        patientId={patientData.id}
                        size="sm"
                      />
                    )}
                  </div>
                )}
                {ext && !state && (
                  <div className="patient__doc-badges">
                    {ext.medications?.length > 0 && (
                      <span className="patient__doc-badge patient__doc-badge--med">
                        💊{ext.medications.length}
                      </span>
                    )}
                    {ext.labs?.length > 0 && (
                      <span className="patient__doc-badge patient__doc-badge--lab">
                        🔬{ext.labs.length}
                      </span>
                    )}
                    {ext.diagnoses?.length > 0 && (
                      <span className="patient__doc-badge patient__doc-badge--dx">
                        🏥{ext.diagnoses.length}
                      </span>
                    )}
                  </div>
                )}
              </div>
              {doc.storage_path && (
                <button onClick={() => onViewDoc(doc)} className="patient__doc-view-btn">
                  View
                </button>
              )}
            </div>
            {state?.status === "mismatch" && state.mismatch && (
              <div
                style={{
                  marginTop: 8,
                  padding: "10px 12px",
                  border: "1px solid var(--red-bd, #fecaca)",
                  background: "var(--red-lt, #fef2f2)",
                  borderRadius: 8,
                  fontSize: 12,
                  color: "var(--red, #991b1b)",
                }}
              >
                <div style={{ fontWeight: 700, marginBottom: 4 }}>
                  ⚠️ Patient mismatch ({(state.mismatch.mismatchedFields || []).join(" + ")})
                </div>
                <div style={{ fontSize: 11, marginBottom: 8 }}>
                  Doc: <strong>{state.mismatch.reportName || "—"}</strong>
                  {state.mismatch.reportId ? ` · #${state.mismatch.reportId}` : ""} vs Selected:{" "}
                  <strong>{state.mismatch.selectedName || "—"}</strong>
                  {state.mismatch.selectedId ? ` · #${state.mismatch.selectedId}` : ""}
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <button
                    type="button"
                    onClick={() =>
                      setMismatchReview({
                        action: "accept",
                        docId: doc.id,
                        fileName: state.fileName || doc.title || doc.doc_type,
                        category: state.category || doc.doc_type,
                        mismatch: state.mismatch,
                        pendingPayload: state.pendingPayload,
                        pendingMeta: state.pendingMeta,
                        patientId: doc.patient_id,
                      })
                    }
                    style={{
                      flex: 1,
                      padding: "8px 12px",
                      background: "#16a34a",
                      color: "#fff",
                      border: 0,
                      borderRadius: 6,
                      fontSize: 13,
                      fontWeight: 600,
                      cursor: "pointer",
                    }}
                  >
                    ✅ Accept
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      setMismatchReview({
                        action: "reject",
                        docId: doc.id,
                        fileName: state.fileName || doc.title || doc.doc_type,
                        category: state.category || doc.doc_type,
                        mismatch: state.mismatch,
                        patientId: doc.patient_id,
                      })
                    }
                    style={{
                      flex: 1,
                      padding: "8px 12px",
                      background: "var(--red, #dc2626)",
                      color: "#fff",
                      border: 0,
                      borderRadius: 6,
                      fontSize: 13,
                      fontWeight: 600,
                      cursor: "pointer",
                    }}
                  >
                    🗑️ Reject
                  </button>
                </div>
              </div>
            )}
          </div>
        );
      })}
      {mismatchReview && (
        <MismatchReviewModal
          action={mismatchReview.action}
          fileName={mismatchReview.fileName}
          category={mismatchReview.category}
          mismatch={mismatchReview.mismatch}
          selectedPatient={patientData}
          onClose={() => setMismatchReview(null)}
          onConfirm={() => {
            const r = mismatchReview;
            setMismatchReview(null);
            if (!r) return;
            if (r.action === "accept") {
              acceptMutation.mutate({
                docId: r.docId,
                opts: {
                  pendingPayload: r.pendingPayload,
                  pendingMeta: r.pendingMeta,
                  patientId: r.patientId,
                  fileName: r.fileName,
                },
              });
            } else {
              rejectMutation.mutate({
                docId: r.docId,
                opts: { patientId: r.patientId, fileName: r.fileName },
              });
            }
          }}
        />
      )}
    </div>
  );
});

const MedicationsTab = memo(function MedicationsTab({ patientData }) {
  const activeMeds = (patientData.medications || []).filter((m) => m.is_active);

  return (
    <div>
      <div className="patient__section-title">💊 Active Medications</div>
      {activeMeds.length === 0 ? (
        <div className="patient__empty-inline">No active medications</div>
      ) : (
        <div className="patient__table">
          {activeMeds.map((m, i) => {
            const con =
              (patientData.consultations || []).find((c) => c.id === m.consultation_id) || {};
            return (
              <div key={i} className="patient__med-row">
                <div className="patient__med-header">
                  <span className="patient__med-name">{m.name}</span>
                  <span className="patient__med-source">{con.con_name || ""}</span>
                </div>
                <div className="patient__med-details">
                  {m.dose} {m.frequency} {m.timing}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
});

const LabsTab = memo(function LabsTab({ patientData }) {
  const labs = patientData.lab_results || [];

  return (
    <div>
      <div className="patient__section-title">🔬 Lab Results</div>
      {labs.length === 0 ? (
        <div className="patient__empty-inline">No lab results</div>
      ) : (
        <div className="patient__table">
          {labs.slice(0, 40).map((l, i) => (
            <div key={i} className="patient__lab-row">
              <div>
                <span className="patient__lab-name">{l.test_name}</span>
                <span className="patient__lab-date">{fDate(l.test_date)}</span>
              </div>
              <span>
                <span
                  className="patient__lab-result"
                  style={{
                    color: l.flag === "HIGH" ? "#dc2626" : l.flag === "LOW" ? "#f59e0b" : "#059669",
                  }}
                >
                  {l.result}
                </span>
                <span className="patient__lab-unit">{l.unit}</span>
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
});

const VisitsTab = memo(function VisitsTab({ patientData }) {
  const visits = patientData.consultations || [];

  if (visits.length === 0) {
    return <div className="patient__empty-inline">No visits</div>;
  }

  const statusColor = (status) => {
    if (status === "completed") return { bg: "#dcfce7", color: "#059669", border: "#059669" };
    if (status === "historical") return { bg: "#f3e8ff", color: "#7c3aed", border: "#7c3aed" };
    return { bg: "#fef3c7", color: "#f59e0b", border: "#f59e0b" };
  };

  return (
    <div>
      {visits.map((con, i) => {
        const sc = statusColor(con.status);
        return (
          <div key={i} className="patient__visit-card" style={{ borderLeftColor: sc.border }}>
            <div className="patient__visit-row">
              <div>
                <div className="patient__visit-name">{con.con_name || con.mo_name || "—"}</div>
                <div className="patient__visit-meta">
                  {fDate(con.visit_date)} • {con.visit_type || "OPD"}
                </div>
              </div>
              <span
                className="patient__visit-status"
                style={{ background: sc.bg, color: sc.color }}
              >
                {con.status}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
});
