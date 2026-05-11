import "./DocsPage.css";
import { useState } from "react";
import usePatientStore from "../stores/patientStore";
import useLabPortalStore from "../stores/labPortalStore";
import { ts } from "../config/constants.js";
import PdfViewerModal from "../components/visit/PdfViewerModal.jsx";
import { getDocStatus } from "../utils/docStatus.js";
import { usePatientFullData } from "../queries/hooks/usePatientFullData.js";
import DocStatusPill from "../components/ui/DocStatusPill.jsx";
import MismatchActions from "../components/visit/MismatchActions.jsx";
import { cleanNote } from "../utils/cleanNote.js";

export default function DocsPage() {
  const patient = usePatientStore((s) => s.patient);
  const dbPatientId = usePatientStore((s) => s.dbPatientId);
  const expandedDocId = useLabPortalStore((s) => s.expandedDocId);
  const setExpandedDocId = useLabPortalStore((s) => s.setExpandedDocId);
  const [viewingDoc, setViewingDoc] = useState(null);

  // Refetches on mount (every time user navigates to /docs), on window
  // focus, and polls every 5s while any doc is still extracting so status
  // pills update live.
  const { data: pfd, isFetching } = usePatientFullData(dbPatientId);

  return (
    <>
      {viewingDoc && <PdfViewerModal doc={viewingDoc} onClose={() => setViewingDoc(null)} />}
      <div>
        <div className="docs__title" style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span>📎 Patient Documents</span>
          {isFetching && (
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                fontSize: 11,
                fontWeight: 600,
                color: "#7c3aed",
              }}
            >
              <span
                style={{
                  width: 12,
                  height: 12,
                  border: "2px solid currentColor",
                  borderTopColor: "transparent",
                  borderRadius: "50%",
                  display: "inline-block",
                  animation: "docs-spin 0.7s linear infinite",
                }}
              />
              Refreshing…
            </span>
          )}
        </div>
        {!dbPatientId ? (
          <div className="docs__empty">
            <div className="docs__empty-icon">📎</div>
            <div className="docs__empty-text">Load a patient first</div>
          </div>
        ) : !pfd?.documents?.length && !(pfd?.consultations?.length > 0) ? (
          <div>
            <div className="docs__no-docs">
              <div className="docs__no-docs-icon">📂</div>
              <div className="docs__no-docs-text">No uploaded documents yet</div>
              <div className="docs__no-docs-hint">
                Upload reports from the Visit Workflow or Lab Portal
              </div>
            </div>

            {(pfd?.lab_results || []).length > 0 && (
              <div className="docs__section">
                <div className="docs__section-title docs__section-title--purple">
                  🔬 Lab Results ({pfd.lab_results.length})
                </div>
                <table className="docs__table">
                  <thead>
                    <tr className="docs__table-head">
                      <th className="docs__table-th docs__table-th--left">Test</th>
                      <th className="docs__table-th docs__table-th--right">Result</th>
                      <th className="docs__table-th docs__table-th--center">Flag</th>
                      <th className="docs__table-th docs__table-th--left">Ref</th>
                      <th className="docs__table-th docs__table-th--right">Date</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pfd.lab_results.slice(0, 50).map((l, i) => (
                      <tr
                        key={i}
                        className="docs__table-row"
                        style={{
                          background:
                            l.flag === "H"
                              ? "#fef2f2"
                              : l.flag === "L"
                                ? "#eff6ff"
                                : i % 2
                                  ? "#fafafa"
                                  : "white",
                        }}
                      >
                        <td className="docs__table-cell docs__table-cell--name">{l.test_name}</td>
                        <td
                          className="docs__table-cell docs__table-cell--result"
                          style={{
                            color:
                              l.flag === "H" ? "#dc2626" : l.flag === "L" ? "#2563eb" : "#1e293b",
                          }}
                        >
                          {l.result} {l.unit || ""}
                        </td>
                        <td className="docs__table-cell docs__table-cell--flag">
                          {l.flag === "H" ? "↑ HIGH" : l.flag === "L" ? "↓ LOW" : "✓"}
                        </td>
                        <td className="docs__table-cell docs__table-cell--ref">
                          {l.ref_range || ""}
                        </td>
                        <td className="docs__table-cell docs__table-cell--date">
                          {l.test_date
                            ? new Date(
                                String(l.test_date).slice(0, 10) + "T12:00:00",
                              ).toLocaleDateString("en-IN", {
                                day: "2-digit",
                                month: "short",
                                year: "2-digit",
                              })
                            : ""}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {(pfd?.medications || []).length > 0 && (
              <div className="docs__section">
                <div className="docs__section-title docs__section-title--green">
                  💊 Active Medications (
                  {pfd.medications.filter((m) => m.is_active !== false).length})
                </div>
                {pfd.medications
                  .filter((m) => m.is_active !== false)
                  .map((m, i) => (
                    <div key={i} className="docs__med-row">
                      <span className="docs__med-name">{m.name}</span>
                      <span className="docs__med-dose">{m.dose}</span>
                      <span className="docs__med-freq">
                        {m.frequency} {m.timing || ""}
                      </span>
                      <span className="docs__med-new">{m.is_new ? "🆕" : ""}</span>
                    </div>
                  ))}
              </div>
            )}

            {(pfd?.diagnoses || []).length > 0 && (
              <div className="docs__section">
                <div className="docs__section-title docs__section-title--amber">
                  🩺 Diagnoses ({pfd.diagnoses.length})
                </div>
                <div className="docs__dx-list">
                  {pfd.diagnoses.map((d, i) => (
                    <span
                      key={i}
                      className="docs__dx-chip"
                      style={{
                        background:
                          d.status === "Controlled" || d.status === "Active-Controlled"
                            ? "#f0fdf4"
                            : d.status === "Resolved"
                              ? "#f8fafc"
                              : "#fef2f2",
                        color:
                          d.status === "Controlled" || d.status === "Active-Controlled"
                            ? "#059669"
                            : d.status === "Resolved"
                              ? "#94a3b8"
                              : "#dc2626",
                        border: `1px solid ${d.status === "Controlled" || d.status === "Active-Controlled" ? "#bbf7d0" : d.status === "Resolved" ? "#e2e8f0" : "#fecaca"}`,
                      }}
                    >
                      {d.label} <span className="docs__dx-status">({d.status})</span>
                    </span>
                  ))}
                </div>
              </div>
            )}

            {(pfd?.consultations || []).length > 0 && (
              <div>
                <div className="docs__section-title docs__section-title--blue">
                  📋 Visit History ({pfd.consultations.length})
                </div>
                {pfd.consultations.slice(0, 20).map((c, i) => (
                  <div key={i} className="docs__visit-row">
                    <span className="docs__visit-date">
                      {c.visit_date
                        ? new Date(
                            String(c.visit_date).slice(0, 10) + "T12:00:00",
                          ).toLocaleDateString("en-IN", {
                            day: "2-digit",
                            month: "short",
                            year: "numeric",
                          })
                        : ""}
                    </span>
                    <span className="docs__visit-type">{c.visit_type || "OPD"}</span>
                    <span className="docs__visit-doctor">{c.con_name || c.mo_name || ""}</span>
                    <span
                      className="docs__visit-status"
                      style={{ color: c.status === "completed" ? "#059669" : "#f59e0b" }}
                    >
                      {c.status}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : (
          <div>
            {(() => {
              const docConsultIds = new Set(
                (pfd?.documents || []).map((d) => d.consultation_id).filter(Boolean),
              );
              const synthRx = (pfd?.consultations || [])
                .filter(
                  (c) =>
                    c.con_data &&
                    !docConsultIds.has(c.id) &&
                    (c.con_data.medications_confirmed || []).length > 0,
                )
                .map((c) => {
                  const cd = c.con_data;
                  const vd = c.visit_date
                    ? new Date(String(c.visit_date).slice(0, 10) + "T12:00:00").toLocaleDateString(
                        "en-IN",
                        { day: "2-digit", month: "short", year: "numeric" },
                      )
                    : "";
                  return {
                    id: `consult_rx_${c.id}`,
                    doc_type: "prescription",
                    title: `Prescription — ${c.con_name || "Dr. Bhansali"} — ${vd}`,
                    doc_date: c.visit_date,
                    source: "consultation",
                    extracted_data: {
                      doctor: c.con_name || "Dr. Bhansali",
                      mo: c.mo_name || null,
                      diagnoses: cd.diagnoses || [],
                      chief_complaints: cd.chief_complaints || [],
                      medications: (cd.medications_confirmed || []).map((m) => ({
                        name: m.name,
                        dose: m.dose,
                        frequency: m.frequency,
                        timing: m.timing,
                        route: m.route || "Oral",
                        composition: m.composition,
                        forDiagnosis: m.forDiagnosis || [],
                        isNew: m.isNew || false,
                      })),
                      goals: cd.goals || [],
                      diet_lifestyle: cd.diet_lifestyle || [],
                      assessment_summary: cd.assessment_summary || null,
                      follow_up: cd.follow_up || null,
                    },
                  };
                });
              const docs = [...(pfd?.documents || []), ...synthRx].sort(
                (a, b) => new Date(b.doc_date || 0) - new Date(a.doc_date || 0),
              );
              const groups = {};
              docs.forEach((d) => {
                const cat = [
                  "lab_report",
                  "Blood Test",
                  "Thyroid Panel",
                  "Lipid Profile",
                  "HbA1c",
                  "CBC",
                  "Urine",
                  "Kidney Function",
                  "Liver Function",
                ].includes(d.doc_type)
                  ? "🔬 Lab Reports"
                  : d.doc_type === "prescription"
                    ? "📄 Prescriptions"
                    : [
                          "X-Ray",
                          "MRI",
                          "Ultrasound",
                          "DEXA",
                          "ECG",
                          "Echo",
                          "CT",
                          "ABI",
                          "VPT",
                          "Fundus",
                          "PFT",
                          "NCS",
                        ].includes(d.doc_type)
                      ? "🩻 Imaging & Diagnostics"
                      : "📋 Other Documents";
                if (!groups[cat]) groups[cat] = [];
                groups[cat].push(d);
              });
              return Object.entries(groups).map(([cat, items]) => (
                <div key={cat} className="docs__section">
                  <div className="docs__section-title">
                    {cat} ({items.length})
                  </div>
                  {items.map((doc) => {
                    let ed = doc.extracted_data;
                    if (typeof ed === "string") {
                      try {
                        ed = JSON.parse(ed);
                      } catch {
                        ed = null;
                      }
                    }
                    const status = getDocStatus(doc);
                    const needsReview = status.kind === "mismatch";
                    const isPending = status.kind === "pending";
                    return (
                      <div
                        key={doc.id}
                        className="docs__doc-card"
                        style={
                          needsReview
                            ? { border: "1px solid #fecaca", background: "#fef2f2" }
                            : isPending
                              ? { border: "1px solid #c4b5fd", background: "#f5f3ff" }
                              : undefined
                        }
                      >
                        <div className="docs__doc-header">
                          <div>
                            <strong className="docs__doc-title">{doc.title || doc.doc_type}</strong>
                            {doc.file_name && (
                              <span className="docs__doc-filename">{doc.file_name}</span>
                            )}
                            {doc.uploaded_by_patient ? (
                              <span
                                title="Uploaded by patient from the myhealthgenie app"
                                style={{
                                  marginLeft: 8,
                                  fontSize: 9,
                                  fontWeight: 700,
                                  letterSpacing: 0.3,
                                  textTransform: "uppercase",
                                  color: "#5b21b6",
                                  background: "#ede9fe",
                                  border: "1px solid #ddd6fe",
                                  borderRadius: 999,
                                  padding: "1px 6px",
                                  verticalAlign: "middle",
                                }}
                              >
                                Patient
                              </span>
                            ) : null}
                            {status.label && (
                              <span style={{ marginLeft: 8, display: "inline-flex" }}>
                                <DocStatusPill doc={doc} patientId={dbPatientId} size="sm" />
                              </span>
                            )}
                          </div>
                          <div className="docs__doc-date-area">
                            {doc.doc_date && (
                              <div className="docs__doc-date">
                                {(() => {
                                  const d = new Date(
                                    String(doc.doc_date).slice(0, 10) + "T12:00:00",
                                  );
                                  return d.toLocaleDateString("en-IN", {
                                    day: "2-digit",
                                    month: "short",
                                    year: "numeric",
                                  });
                                })()}
                              </div>
                            )}
                            {doc.source && <div className="docs__doc-source">{doc.source}</div>}
                          </div>
                        </div>
                        {ed && cat.includes("Lab") && ed.panels && (
                          <div className="docs__doc-data">
                            {(ed.panels || []).map((panel, pi) => (
                              <div key={pi} className="docs__panel-block">
                                <div className="docs__panel-name">{panel.panel_name}</div>
                                <div className="docs__panel-tests">
                                  {(panel.tests || []).map((t, ti) => (
                                    <span
                                      key={ti}
                                      className="docs__panel-test"
                                      style={{
                                        background:
                                          t.flag === "H"
                                            ? "#fef2f2"
                                            : t.flag === "L"
                                              ? "#eff6ff"
                                              : "#f1f5f9",
                                        color:
                                          t.flag === "H"
                                            ? "#dc2626"
                                            : t.flag === "L"
                                              ? "#2563eb"
                                              : "#475569",
                                        fontWeight: t.flag ? 700 : 400,
                                      }}
                                    >
                                      {t.test_name}: {t.result_text || t.result} {t.unit || ""}
                                    </span>
                                  ))}
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                        {ed && cat.includes("Imaging") && (
                          <div className="docs__imaging-data">
                            {ed.impression && (
                              <div className="docs__imaging-impression">💡 {ed.impression}</div>
                            )}
                            {(ed.findings || []).length > 0 && (
                              <div className="docs__imaging-findings">
                                {ed.findings.map((f, i) => (
                                  <span
                                    key={i}
                                    className="docs__imaging-finding"
                                    style={{
                                      background:
                                        f.interpretation === "Abnormal"
                                          ? "#fef2f2"
                                          : f.interpretation === "Borderline"
                                            ? "#fefce8"
                                            : "#f1f5f9",
                                      color:
                                        f.interpretation === "Abnormal" ? "#dc2626" : "#475569",
                                    }}
                                  >
                                    {f.parameter}: {f.value} {f.unit || ""} ({f.interpretation})
                                  </span>
                                ))}
                              </div>
                            )}
                          </div>
                        )}
                        {cleanNote(doc.notes) && !ed && (
                          <div className="docs__doc-notes">{cleanNote(doc.notes)}</div>
                        )}
                        {needsReview && (
                          <div
                            style={{
                              marginTop: 6,
                              padding: "8px 10px",
                              background: "#fff",
                              border: "1px solid #fecaca",
                              borderRadius: 6,
                            }}
                          >
                            <div
                              style={{
                                fontSize: 12,
                                color: "#b91c1c",
                                fontWeight: 600,
                                marginBottom: 6,
                              }}
                            >
                              ⚠️ Patient name on document doesn't match — extraction not applied
                              yet.
                            </div>
                            <MismatchActions
                              doc={{ ...doc, patient_id: doc.patient_id || dbPatientId }}
                              patient={patient}
                            />
                          </div>
                        )}
                        <div className="docs__doc-actions">
                          {(doc.storage_path || doc.source === "healthray") && (
                            <button onClick={() => setViewingDoc(doc)} className="docs__btn--view">
                              📄 View File
                            </button>
                          )}
                          {doc.doc_type === "prescription" && ed && (
                            <button
                              onClick={() =>
                                setExpandedDocId(expandedDocId === doc.id ? null : doc.id)
                              }
                              className="docs__btn--plan"
                            >
                              {expandedDocId === doc.id ? "▲ Hide Plan" : "📋 View Plan"}
                            </button>
                          )}
                        </div>
                        {expandedDocId === doc.id && doc.doc_type === "prescription" && ed && (
                          <div className="docs__plan">
                            {ed.assessment_summary && (
                              <div className="docs__plan-summary">{ed.assessment_summary}</div>
                            )}
                            {ed.diagnoses?.length > 0 && (
                              <div className="docs__plan-section">
                                <div className="docs__plan-label">DIAGNOSES</div>
                                <div className="docs__plan-dx-list">
                                  {ed.diagnoses.map((d, i) => (
                                    <span
                                      key={i}
                                      className="docs__plan-dx-chip"
                                      style={{
                                        background:
                                          d.status === "Uncontrolled"
                                            ? "#fef2f2"
                                            : d.status === "Controlled"
                                              ? "#f0fdf4"
                                              : "#f1f5f9",
                                        color:
                                          d.status === "Uncontrolled"
                                            ? "#dc2626"
                                            : d.status === "Controlled"
                                              ? "#059669"
                                              : "#475569",
                                        border: `1px solid ${d.status === "Uncontrolled" ? "#fecaca" : d.status === "Controlled" ? "#bbf7d0" : "#e2e8f0"}`,
                                      }}
                                    >
                                      {d.label} ({d.status})
                                    </span>
                                  ))}
                                </div>
                              </div>
                            )}
                            {ed.medications?.length > 0 && (
                              <div className="docs__plan-section">
                                <div className="docs__plan-label">MEDICATIONS</div>
                                {ed.medications.map((m, i) => (
                                  <div key={i} className="docs__plan-med-row">
                                    <strong className="docs__plan-med-name">{m.name}</strong>
                                    <span className="docs__plan-med-detail">
                                      {m.dose} {m.frequency} {m.timing}
                                    </span>
                                  </div>
                                ))}
                              </div>
                            )}
                            {ed.goals?.length > 0 && (
                              <div className="docs__plan-section">
                                <div className="docs__plan-label">GOALS</div>
                                {ed.goals.map((g, i) => (
                                  <div key={i} className="docs__plan-goal">
                                    🎯 {g.marker}: {g.current} → {g.target} ({g.timeline})
                                  </div>
                                ))}
                              </div>
                            )}
                            {ed.diet_lifestyle?.length > 0 && (
                              <div className="docs__plan-section">
                                <div className="docs__plan-label">DIET & LIFESTYLE</div>
                                {ed.diet_lifestyle.map((d, i) => (
                                  <div key={i} className="docs__plan-diet">
                                    ✅ {d.advice}
                                    {d.detail ? ` — ${d.detail}` : ""}
                                  </div>
                                ))}
                              </div>
                            )}
                            {ed.follow_up && (
                              <div className="docs__plan-followup">
                                📅 Follow-up: {ed.follow_up.duration}{" "}
                                {ed.follow_up.tests_to_bring?.length
                                  ? `| Bring: ${ed.follow_up.tests_to_bring.map(ts).join(", ")}`
                                  : ""}
                              </div>
                            )}
                            {ed.doctor && (
                              <div className="docs__plan-doctor">
                                Doctor: {ed.doctor} {ed.mo ? `| MO: ${ed.mo}` : ""}
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              ));
            })()}
          </div>
        )}
      </div>
    </>
  );
}
