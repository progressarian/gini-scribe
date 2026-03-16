import "./LabPortalPage.css";
import { useNavigate } from "react-router-dom";
import useAuthStore from "../stores/authStore.js";
import usePatientStore from "../stores/patientStore.js";
import useLabPortalStore from "../stores/labPortalStore.js";
import api from "../services/api.js";

export default function LabPortalPage() {
  const { currentDoctor } = useAuthStore();
  const { patient, dbPatientId, getPfd, newPatient } = usePatientStore();
  const {
    labPortalFiles,
    labPortalDate,
    setLabPortalDate,
    handleLabPortalUpload,
    processLabPortalFile,
    removeLabPortalFile,
  } = useLabPortalStore();
  const navigate = useNavigate();

  const pfd = getPfd();

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
      <div className="lab-portal__header">
        <div className="lab-portal__title">🔬 Report Upload Portal</div>
        <div className="lab-portal__spacer" />
        {currentDoctor && <span className="lab-portal__user-badge">👤 {currentDoctor.name}</span>}
      </div>

      {!dbPatientId ? (
        <div className="lab-portal__find-patient">
          <div className="lab-portal__find-icon">🔍</div>
          <div className="lab-portal__find-title">Step 1: Find Patient</div>
          <div className="lab-portal__find-hint">Search by name, phone, or file number</div>
          <button onClick={() => navigate("/find")} className="lab-portal__find-btn">
            🔍 Find Patient
          </button>
        </div>
      ) : (
        <div>
          <div className="lab-portal__patient-bar">
            <div className="lab-portal__patient-avatar">
              {(patient.name || "?").charAt(0).toUpperCase()}
            </div>
            <div className="lab-portal__patient-info">
              <div className="lab-portal__patient-name">{patient.name}</div>
              <div className="lab-portal__patient-details">
                {patient.age}Y / {patient.sex} {patient.fileNo && `| ${patient.fileNo}`}{" "}
                {patient.phone && `| ${patient.phone}`}
              </div>
            </div>
            <button onClick={newPatient} className="lab-portal__change-btn">
              Change
            </button>
          </div>

          <div className="lab-portal__date-row">
            <label className="lab-portal__date-label">📅 Report Date:</label>
            <input
              type="date"
              value={labPortalDate}
              onChange={(e) => setLabPortalDate(e.target.value)}
              className="lab-portal__date-input"
            />
            <button
              onClick={() => setLabPortalDate(new Date().toISOString().slice(0, 10))}
              className="lab-portal__today-btn"
            >
              Today
            </button>
          </div>

          <div className="lab-portal__upload-section">
            <div className="lab-portal__upload-title lab-portal__upload-title--lab">
              🔬 Blood Work & Lab Reports
            </div>
            <div className="lab-portal__upload-types">
              {[
                "Blood Test",
                "Thyroid Panel",
                "Lipid Profile",
                "Kidney Function",
                "Liver Function",
                "HbA1c",
                "CBC",
                "Urine",
                "Other Lab",
              ].map((type) => (
                <label key={type} className="lab-portal__upload-label--lab">
                  📎 {type}
                  <input
                    type="file"
                    accept="image/*,.pdf,.heic,.heif"
                    multiple
                    onChange={(e) => handleLabPortalUpload(e, type)}
                    className="lab-portal__hidden-input"
                  />
                </label>
              ))}
            </div>
          </div>

          <div className="lab-portal__upload-section--imaging">
            <div className="lab-portal__upload-title lab-portal__upload-title--imaging">
              🩻 Imaging & Diagnostic Tests
            </div>
            <div className="lab-portal__upload-types">
              {[
                "X-Ray",
                "ECG",
                "ABI",
                "VPT",
                "Ultrasound",
                "DEXA",
                "MRI",
                "CT",
                "Echo",
                "Fundus",
                "PFT",
                "NCS",
              ].map((type) => (
                <label key={type} className="lab-portal__upload-label--imaging">
                  📎 {type}
                  <input
                    type="file"
                    accept="image/*,.pdf,.heic,.heif"
                    multiple
                    onChange={(e) => handleLabPortalUpload(e, type)}
                    className="lab-portal__hidden-input"
                  />
                </label>
              ))}
            </div>
          </div>

          {labPortalFiles.length > 0 && (
            <div>
              <div className="lab-portal__files-header">
                <div className="lab-portal__files-label">UPLOADED ({labPortalFiles.length})</div>
                <div className="lab-portal__spacer" />
                {labPortalFiles.filter((f) => !f.extracted && !f.extracting && f.base64).length >
                  1 && (
                  <button
                    onClick={async () => {
                      for (const f of labPortalFiles.filter(
                        (f) => !f.extracted && !f.extracting && f.base64,
                      )) {
                        await processLabPortalFile(f.id);
                      }
                    }}
                    className="lab-portal__extract-all-btn"
                  >
                    🔬 Extract All (
                    {labPortalFiles.filter((f) => !f.extracted && !f.extracting && f.base64).length}
                    )
                  </button>
                )}
              </div>
              {labPortalFiles.map((file) => (
                <div
                  key={file.id}
                  className={`lab-portal__file-card ${file.saved ? "lab-portal__file-card--saved" : file.error ? "lab-portal__file-card--error" : ""}`}
                >
                  <div className="lab-portal__file-header">
                    <span
                      className={`lab-portal__file-type ${file.category === "lab" ? "lab-portal__file-type--lab" : "lab-portal__file-type--imaging"}`}
                    >
                      {file.category === "lab" ? "🔬" : "🩻"} {file.type}
                    </span>
                    <span className="lab-portal__file-name">{file.fileName}</span>
                    <span className="lab-portal__file-date">{file.date}</span>
                    <div className="lab-portal__spacer" />
                    {!file.extracted && !file.extracting && (
                      <button
                        onClick={() => processLabPortalFile(file.id)}
                        className="lab-portal__file-extract-btn"
                        style={{ background: file.category === "lab" ? "#7c3aed" : "#0369a1" }}
                      >
                        🔬 Extract & Save
                      </button>
                    )}
                    {file.extracting && (
                      <span className="lab-portal__file-extracting">⏳ Processing...</span>
                    )}
                    {file.saved && <span className="lab-portal__file-saved">✅ Saved</span>}
                    {file.error && <span className="lab-portal__file-error">❌ {file.error}</span>}
                    <button
                      onClick={() => removeLabPortalFile(file.id)}
                      className="lab-portal__file-remove-btn"
                    >
                      ✕
                    </button>
                  </div>
                  {file.data &&
                    file.category === "lab" &&
                    (file.data.panels || []).map((panel, pi) => (
                      <div key={pi} className="lab-portal__panel">
                        <div className="lab-portal__panel-name">{panel.panel_name}</div>
                        <table className="lab-portal__panel-table">
                          <tbody>
                            {(panel.tests || []).map((t, ti) => (
                              <tr
                                key={ti}
                                style={{
                                  background:
                                    t.flag === "H"
                                      ? "#fef2f2"
                                      : t.flag === "L"
                                        ? "#eff6ff"
                                        : ti % 2
                                          ? "#fafafa"
                                          : "white",
                                }}
                              >
                                <td className="lab-portal__panel-cell">{t.test_name}</td>
                                <td
                                  className="lab-portal__panel-cell--result"
                                  style={{
                                    color:
                                      t.flag === "H"
                                        ? "#dc2626"
                                        : t.flag === "L"
                                          ? "#2563eb"
                                          : "#1e293b",
                                  }}
                                >
                                  {t.result_text || t.result} {t.unit || ""}
                                </td>
                                <td className="lab-portal__panel-cell--ref">{t.ref_range || ""}</td>
                                <td className="lab-portal__panel-cell--flag">
                                  {t.flag === "H" ? "↑ HIGH" : t.flag === "L" ? "↓ LOW" : "✓"}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    ))}
                  {file.data && file.category === "imaging" && (
                    <div className="lab-portal__imaging-data">
                      {file.data.impression && (
                        <div className="lab-portal__imaging-impression">
                          💡 {file.data.impression}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {pfd?.documents?.length > 0 && (
            <div className="lab-portal__prev-docs">
              <div className="lab-portal__prev-docs-title">
                📂 PREVIOUS DOCUMENTS ({pfd?.documents?.length || 0})
              </div>
              {(pfd?.documents || []).slice(0, 10).map((doc) => (
                <div key={doc.id} className="lab-portal__prev-doc-row">
                  <span>
                    {doc.doc_type === "lab_report"
                      ? "🔬"
                      : doc.doc_type === "prescription"
                        ? "📄"
                        : "🩻"}
                  </span>
                  <span className="lab-portal__prev-doc-title">{doc.title || doc.doc_type}</span>
                  {doc.doc_date && (
                    <span className="lab-portal__prev-doc-date">
                      {(() => {
                        const d = new Date(String(doc.doc_date).slice(0, 10) + "T12:00:00");
                        return d.toLocaleDateString("en-IN", {
                          day: "2-digit",
                          month: "short",
                          year: "2-digit",
                        });
                      })()}
                    </span>
                  )}
                  {doc.storage_path && (
                    <button
                      onClick={() => viewDocumentFile(doc.id)}
                      className="lab-portal__prev-doc-view-btn"
                    >
                      📄 View
                    </button>
                  )}
                  <span className="lab-portal__prev-doc-source">{doc.source || ""}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
