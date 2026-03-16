import "./DocsPage.css";
import usePatientStore from "../stores/patientStore";
import useLabPortalStore from "../stores/labPortalStore";
import { ts } from "../config/constants.js";
import api from "../services/api.js";

export default function DocsPage() {
  const patient = usePatientStore((s) => s.patient);
  const dbPatientId = usePatientStore((s) => s.dbPatientId);
  const pfd = usePatientStore((s) => s.getPfd());
  const expandedDocId = useLabPortalStore((s) => s.expandedDocId);
  const setExpandedDocId = useLabPortalStore((s) => s.setExpandedDocId);
  const viewDocumentFile = async (documentId) => {
    try {
      const resp = await api.get(`/api/documents/${documentId}/file-url`);
      if (resp.data.url) window.open(resp.data.url, "_blank");
      else alert("No file attached to this document");
    } catch (e) {
      alert("Failed to load file: " + (e.response?.data?.error || e.message));
    }
  };

  return (
    <div>
      <div className="docs__title">📎 Patient Documents</div>
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
                💊 Active Medications ({pfd.medications.filter((m) => m.is_active !== false).length}
                )
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
                  const ed = doc.extracted_data;
                  return (
                    <div key={doc.id} className="docs__doc-card">
                      <div className="docs__doc-header">
                        <div>
                          <strong className="docs__doc-title">{doc.title || doc.doc_type}</strong>
                          {doc.file_name && (
                            <span className="docs__doc-filename">{doc.file_name}</span>
                          )}
                        </div>
                        <div className="docs__doc-date-area">
                          {doc.doc_date && (
                            <div className="docs__doc-date">
                              {(() => {
                                const d = new Date(String(doc.doc_date).slice(0, 10) + "T12:00:00");
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
                                    color: f.interpretation === "Abnormal" ? "#dc2626" : "#475569",
                                  }}
                                >
                                  {f.parameter}: {f.value} {f.unit || ""} ({f.interpretation})
                                </span>
                              ))}
                            </div>
                          )}
                        </div>
                      )}
                      {doc.notes && !ed && <div className="docs__doc-notes">{doc.notes}</div>}
                      <div className="docs__doc-actions">
                        {doc.storage_path && (
                          <button
                            onClick={() => viewDocumentFile(doc.id)}
                            className="docs__btn--view"
                          >
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
  );
}
