import "./HistoryPage.css";
import useAuthStore from "../stores/authStore";
import usePatientStore from "../stores/patientStore";
import useReportsStore from "../stores/reportsStore";
import useHistoryStore from "../stores/historyStore";
import AudioInput from "../components/AudioInput.jsx";
import { cleanNote } from "../utils/cleanNote.js";

export default function HistoryPage() {
  const dgKey = useAuthStore((s) => s.dgKey);
  const whisperKey = useAuthStore((s) => s.whisperKey);
  const doctorsList = useAuthStore((s) => s.doctorsList);
  const patient = usePatientStore((s) => s.patient);
  const dbPatientId = usePatientStore((s) => s.dbPatientId);
  const setPatientFullData = usePatientStore((s) => s.setPatientFullData);
  const patientFullData = usePatientStore((s) => s.patientFullData);
  const fetchOutcomes = useReportsStore((s) => s.fetchOutcomes);
  const historyForm = useHistoryStore((s) => s.historyForm);
  const setHistoryForm = useHistoryStore((s) => s.setHistoryForm);
  const storeHistoryList = useHistoryStore((s) => s.historyList);
  const historyList =
    storeHistoryList.length > 0 ? storeHistoryList : patientFullData?.consultations || [];
  const historySaving = useHistoryStore((s) => s.historySaving);
  const rxText = useHistoryStore((s) => s.rxText);
  const setRxText = useHistoryStore((s) => s.setRxText);
  const rxExtracting = useHistoryStore((s) => s.rxExtracting);
  const rxExtracted = useHistoryStore((s) => s.rxExtracted);
  const reports = useHistoryStore((s) => s.reports);
  const hxMode = useHistoryStore((s) => s.hxMode);
  const setHxMode = useHistoryStore((s) => s.setHxMode);
  const bulkText = useHistoryStore((s) => s.bulkText);
  const setBulkText = useHistoryStore((s) => s.setBulkText);
  const bulkParsing = useHistoryStore((s) => s.bulkParsing);
  const bulkVisits = useHistoryStore((s) => s.bulkVisits);
  const setBulkVisits = useHistoryStore((s) => s.setBulkVisits);
  const bulkSaving = useHistoryStore((s) => s.bulkSaving);
  const bulkProgress = useHistoryStore((s) => s.bulkProgress);
  const setBulkProgress = useHistoryStore((s) => s.setBulkProgress);
  const bulkSaved = useHistoryStore((s) => s.bulkSaved);
  const addHistoryRow = useHistoryStore((s) => s.addHistoryRow);
  const removeHistoryRow = useHistoryStore((s) => s.removeHistoryRow);
  const extractPrescription = useHistoryStore((s) => s.extractPrescription);
  const handleReportFile = useHistoryStore((s) => s.handleReportFile);
  const extractReport = useHistoryStore((s) => s.extractReport);
  const removeReport = useHistoryStore((s) => s.removeReport);
  const processBulkImport = useHistoryStore((s) => s.processBulkImport);
  const saveBulkVisits = useHistoryStore((s) => s.saveBulkVisits);
  const saveHistoryEntry = useHistoryStore((s) => s.saveHistoryEntry);

  return (
    <div>
      {!dbPatientId ? (
        <div style={{ textAlign: "center", padding: 30, color: "#94a3b8" }}>
          <div style={{ fontSize: 28, marginBottom: 8 }}>📜</div>
          <div style={{ fontSize: 13, fontWeight: 600 }}>
            Load a patient from the database first
          </div>
          <div style={{ fontSize: 11, marginTop: 4 }}>
            Use 🔍 Find to search and select a patient, or save a consultation first
          </div>
        </div>
      ) : (
        <div>
          <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 8, color: "#1e293b" }}>
            📜 Add Past Record — {patient.name}
          </div>

          {/* Past consultations list */}
          {historyList.length > 0 && (
            <div
              style={{
                marginBottom: 10,
                background: "#f8fafc",
                borderRadius: 8,
                padding: 8,
                border: "1px solid #e2e8f0",
              }}
            >
              <div style={{ fontSize: 10, fontWeight: 700, color: "#64748b", marginBottom: 4 }}>
                VISIT HISTORY ({historyList.length})
              </div>
              {historyList.slice(0, 20).map((c, i) => (
                <div
                  key={i}
                  style={{
                    display: "flex",
                    gap: 8,
                    padding: "3px 0",
                    fontSize: 10,
                    borderBottom:
                      i < Math.min(historyList.length, 20) - 1 ? "1px solid #f1f5f9" : "none",
                  }}
                >
                  <span style={{ fontWeight: 600, color: "#2563eb", minWidth: 70 }}>
                    {(() => {
                      const s = String(c.visit_date || "");
                      const dt =
                        s.length >= 10 ? new Date(s.slice(0, 10) + "T12:00:00") : new Date(s);
                      return dt.toLocaleDateString("en-IN", {
                        day: "2-digit",
                        month: "short",
                        year: "numeric",
                      });
                    })()}
                  </span>
                  <span style={{ color: "#64748b" }}>{c.visit_type || "OPD"}</span>
                  <span style={{ color: "#374151" }}>{c.con_name || c.mo_name || ""}</span>
                  <span
                    style={{
                      marginLeft: "auto",
                      fontSize: 8,
                      color:
                        c.status === "completed"
                          ? "#059669"
                          : c.status === "historical"
                            ? "#64748b"
                            : "#f59e0b",
                      fontWeight: 600,
                    }}
                  >
                    {c.status}
                  </span>
                </div>
              ))}
            </div>
          )}

          {/* Mode tabs */}
          <div
            style={{
              display: "flex",
              gap: 0,
              marginBottom: 8,
              borderRadius: 6,
              overflow: "hidden",
              border: "1px solid #e2e8f0",
            }}
          >
            {[
              ["rx", "📝 Prescription"],
              ["report", "🧪 Reports"],
              ["manual", "📋 Manual"],
              ["bulk", "📦 Bulk Import"],
            ].map(([id, label]) => (
              <button
                key={id}
                onClick={() => setHxMode(id)}
                style={{
                  flex: 1,
                  padding: "6px",
                  fontSize: 10,
                  fontWeight: 700,
                  border: "none",
                  cursor: "pointer",
                  background: hxMode === id ? "#2563eb" : "white",
                  color: hxMode === id ? "white" : "#64748b",
                }}
              >
                {label}
              </button>
            ))}
          </div>

          {/* Visit Info — always visible */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr 1fr 1fr",
              gap: 4,
              marginBottom: 8,
            }}
          >
            <div>
              <label style={{ fontSize: 8, fontWeight: 600, color: "#64748b" }}>Date *</label>
              <input
                type="date"
                value={historyForm.visit_date}
                onChange={(e) => setHistoryForm((p) => ({ ...p, visit_date: e.target.value }))}
                style={{
                  width: "100%",
                  padding: "3px 5px",
                  border: "1px solid #e2e8f0",
                  borderRadius: 4,
                  fontSize: 10,
                  boxSizing: "border-box",
                }}
              />
            </div>
            <div>
              <label style={{ fontSize: 8, fontWeight: 600, color: "#64748b" }}>Type</label>
              <select
                value={historyForm.visit_type}
                onChange={(e) => setHistoryForm((p) => ({ ...p, visit_type: e.target.value }))}
                style={{
                  width: "100%",
                  padding: "3px 5px",
                  border: "1px solid #e2e8f0",
                  borderRadius: 4,
                  fontSize: 10,
                  boxSizing: "border-box",
                }}
              >
                <option>OPD</option>
                <option>IPD</option>
                <option>Follow-up</option>
                <option>Emergency</option>
              </select>
            </div>
            <div>
              <label style={{ fontSize: 8, fontWeight: 600, color: "#64748b" }}>Specialty</label>
              <select
                value={historyForm.specialty}
                onChange={(e) => setHistoryForm((p) => ({ ...p, specialty: e.target.value }))}
                style={{
                  width: "100%",
                  padding: "3px 5px",
                  border: "1px solid #e2e8f0",
                  borderRadius: 4,
                  fontSize: 10,
                  boxSizing: "border-box",
                }}
              >
                <option value="">Select...</option>
                <option>Endocrinology</option>
                <option>Cardiology</option>
                <option>Nephrology</option>
                <option>Neurology</option>
                <option>General Medicine</option>
                <option>Orthopedics</option>
                <option>Ophthalmology</option>
                <option>Pulmonology</option>
                <option>Gastroenterology</option>
                <option>Dermatology</option>
                <option>Psychiatry</option>
                <option>Gynecology</option>
                <option>Urology</option>
                <option>ENT</option>
                <option>Surgery</option>
                <option>Other</option>
              </select>
            </div>
            <div>
              <label style={{ fontSize: 8, fontWeight: 600, color: "#64748b" }}>Doctor</label>
              {doctorsList.length > 0 ? (
                <select
                  value={historyForm.doctor_name}
                  onChange={(e) => setHistoryForm((p) => ({ ...p, doctor_name: e.target.value }))}
                  style={{
                    width: "100%",
                    padding: "3px 5px",
                    border: "1px solid #e2e8f0",
                    borderRadius: 4,
                    fontSize: 10,
                    boxSizing: "border-box",
                    background: "white",
                  }}
                >
                  <option value="">Select Doctor</option>
                  {doctorsList.map((d) => (
                    <option key={d.id} value={d.short_name}>
                      {d.name}
                    </option>
                  ))}
                  <option value="_other">— Other/External —</option>
                </select>
              ) : (
                <input
                  value={historyForm.doctor_name}
                  onChange={(e) => setHistoryForm((p) => ({ ...p, doctor_name: e.target.value }))}
                  placeholder="Dr. Name"
                  style={{
                    width: "100%",
                    padding: "3px 5px",
                    border: "1px solid #e2e8f0",
                    borderRadius: 4,
                    fontSize: 10,
                    boxSizing: "border-box",
                  }}
                />
              )}
            </div>
          </div>

          {/* ===== PRESCRIPTION MODE ===== */}
          {hxMode === "rx" && (
            <div
              style={{
                background: "white",
                borderRadius: 8,
                padding: 10,
                border: "1px solid #e2e8f0",
              }}
            >
              <div style={{ fontSize: 10, fontWeight: 700, color: "#2563eb", marginBottom: 4 }}>
                📝 PASTE OR DICTATE OLD PRESCRIPTION
              </div>
              <div style={{ fontSize: 9, color: "#94a3b8", marginBottom: 6 }}>
                Paste prescription text, type from the slip, or use voice recording. Claude will
                auto-extract diagnoses, medications, vitals.
              </div>
              <AudioInput
                label="Dictate prescription"
                dgKey={dgKey}
                whisperKey={whisperKey}
                color="#2563eb"
                compact
                onTranscript={(t) => setRxText(rxText ? rxText + "\n" + t : t)}
              />
              <textarea
                value={rxText}
                onChange={(e) => setRxText(e.target.value)}
                placeholder={
                  "Paste prescription here...\n\nExample:\nDr. Sharma - Endocrinology\nDx: Type 2 DM (uncontrolled), HTN\nBP: 150/90, Wt: 78kg\nRx:\n1. Tab Metformin 500mg BD\n2. Tab Glimepiride 2mg OD before breakfast\n3. Tab Telmisartan 40mg OD morning\nAdv: HbA1c after 3 months\nF/U: 6 weeks"
                }
                style={{
                  width: "100%",
                  minHeight: 120,
                  padding: 8,
                  border: "1px solid #e2e8f0",
                  borderRadius: 6,
                  fontSize: 11,
                  fontFamily: "monospace",
                  resize: "vertical",
                  marginTop: 6,
                  boxSizing: "border-box",
                }}
              />
              <button
                onClick={extractPrescription}
                disabled={rxExtracting || !rxText.trim()}
                style={{
                  marginTop: 6,
                  width: "100%",
                  padding: "8px",
                  background: rxExtracting ? "#6b7280" : rxExtracted ? "#059669" : "#2563eb",
                  color: "white",
                  border: "none",
                  borderRadius: 6,
                  fontWeight: 700,
                  fontSize: 12,
                  cursor: rxExtracting ? "wait" : "pointer",
                }}
              >
                {rxExtracting
                  ? "🔬 Extracting..."
                  : rxExtracted
                    ? "✅ Extracted — Re-extract"
                    : "🔬 Extract from Prescription"}
              </button>

              {/* Show extracted data */}
              {rxExtracted && (
                <div
                  style={{
                    marginTop: 8,
                    background: "#f0fdf4",
                    borderRadius: 6,
                    padding: 8,
                    border: "1px solid #bbf7d0",
                  }}
                >
                  <div style={{ fontSize: 9, fontWeight: 700, color: "#059669", marginBottom: 4 }}>
                    ✅ EXTRACTED — Review & edit below, then Save
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ===== REPORT MODE ===== */}
          {hxMode === "report" && (
            <div
              style={{
                background: "white",
                borderRadius: 8,
                padding: 10,
                border: "1px solid #e2e8f0",
              }}
            >
              <div style={{ fontSize: 10, fontWeight: 700, color: "#7c3aed", marginBottom: 4 }}>
                🧪 UPLOAD TEST REPORTS
              </div>
              <div style={{ fontSize: 9, color: "#94a3b8", marginBottom: 8 }}>
                Upload photos or PDFs of test reports. Claude will extract values automatically.
              </div>

              {/* Upload area */}
              <div style={{ display: "flex", gap: 4, marginBottom: 8, alignItems: "center" }}>
                <select
                  id="reportType"
                  defaultValue="Blood Test"
                  style={{
                    flex: 1,
                    padding: "6px 8px",
                    border: "1px solid #e2e8f0",
                    borderRadius: 6,
                    fontSize: 11,
                    fontWeight: 600,
                  }}
                >
                  <option>Blood Test</option>
                  <option>HbA1c</option>
                  <option>Thyroid Panel</option>
                  <option>Lipid Profile</option>
                  <option>Kidney Function</option>
                  <option>Liver Function</option>
                  <option>CBC</option>
                  <option>Urine</option>
                  <option>X-Ray</option>
                  <option>Ultrasound</option>
                  <option>MRI</option>
                  <option>DEXA</option>
                  <option>ABI</option>
                  <option>VPT</option>
                  <option>ECG</option>
                  <option>Doppler</option>
                  <option>Retinopathy</option>
                  <option>Other</option>
                </select>
                <label
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 4,
                    padding: "6px 12px",
                    background: "#7c3aed",
                    color: "white",
                    borderRadius: 6,
                    cursor: "pointer",
                    fontSize: 11,
                    fontWeight: 700,
                    whiteSpace: "nowrap",
                  }}
                >
                  📷 Upload
                  <input
                    type="file"
                    accept="image/*,.pdf,.heic,.heif"
                    style={{ display: "none" }}
                    onChange={(e) =>
                      handleReportFile(e, document.getElementById("reportType").value)
                    }
                  />
                </label>
              </div>

              {/* Uploaded reports */}
              {reports.map((r, i) => (
                <div
                  key={i}
                  style={{
                    marginBottom: 8,
                    background: r.extracted ? "#f0fdf4" : "#f8fafc",
                    borderRadius: 6,
                    padding: 8,
                    border: `1px solid ${r.extracted ? "#bbf7d0" : r.error ? "#fecaca" : "#e2e8f0"}`,
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      marginBottom: 4,
                    }}
                  >
                    <div style={{ fontSize: 11, fontWeight: 700 }}>
                      <span
                        style={{
                          background: "#7c3aed",
                          color: "white",
                          padding: "1px 6px",
                          borderRadius: 3,
                          fontSize: 9,
                          marginRight: 6,
                        }}
                      >
                        {r.type}
                      </span>
                      {r.fileName}
                    </div>
                    <div style={{ display: "flex", gap: 4 }}>
                      {!r.extracted && !r.extracting && (
                        <button
                          onClick={() => extractReport(i)}
                          style={{
                            fontSize: 9,
                            padding: "2px 8px",
                            background: "#7c3aed",
                            color: "white",
                            border: "none",
                            borderRadius: 4,
                            fontWeight: 700,
                            cursor: "pointer",
                          }}
                        >
                          🔬 Extract
                        </button>
                      )}
                      <button
                        onClick={() => removeReport(i)}
                        style={{
                          fontSize: 10,
                          padding: "2px 6px",
                          background: "none",
                          border: "1px solid #fecaca",
                          borderRadius: 3,
                          cursor: "pointer",
                          color: "#dc2626",
                        }}
                      >
                        ×
                      </button>
                    </div>
                  </div>
                  {r.extracting && (
                    <div style={{ fontSize: 10, color: "#7c3aed", fontWeight: 600 }}>
                      🔬 Extracting values...
                    </div>
                  )}
                  {r.error && <div style={{ fontSize: 10, color: "#dc2626" }}>❌ {r.error}</div>}
                  {r.extracted && (
                    <div>
                      <div
                        style={{ fontSize: 9, color: "#059669", fontWeight: 600, marginBottom: 2 }}
                      >
                        ✅ {r.extracted.tests?.length || 0} tests extracted
                        {r.extracted.report_date && ` • ${r.extracted.report_date}`}
                        {r.extracted.lab_name && ` • ${r.extracted.lab_name}`}
                      </div>
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 3 }}>
                        {(r.extracted.tests || []).slice(0, 12).map((t, ti) => (
                          <span
                            key={ti}
                            style={{
                              fontSize: 8,
                              padding: "1px 5px",
                              borderRadius: 3,
                              fontWeight: 600,
                              background:
                                t.flag === "HIGH"
                                  ? "#fef2f2"
                                  : t.flag === "LOW"
                                    ? "#eff6ff"
                                    : "#f0fdf4",
                              color:
                                t.flag === "HIGH"
                                  ? "#dc2626"
                                  : t.flag === "LOW"
                                    ? "#2563eb"
                                    : "#059669",
                              border: `1px solid ${t.flag === "HIGH" ? "#fecaca" : t.flag === "LOW" ? "#bfdbfe" : "#bbf7d0"}`,
                            }}
                          >
                            {t.test_name}: {t.result}
                            {t.unit} {t.flag || "✓"}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* ═══ BULK IMPORT MODE ═══ */}
          {hxMode === "bulk" && (
            <div
              style={{
                background: "white",
                borderRadius: 8,
                padding: 10,
                border: "1px solid #e2e8f0",
                marginTop: 8,
              }}
            >
              <div style={{ fontSize: 11, fontWeight: 700, color: "#1e40af", marginBottom: 4 }}>
                📦 PASTE ALL VISIT HISTORY
              </div>
              <div style={{ fontSize: 9, color: "#64748b", marginBottom: 4 }}>
                Paste the full EMR dump — all visits, all dates. AI will split into individual
                visits and save each one separately.
              </div>
              <textarea
                value={bulkText}
                onChange={(e) => setBulkText(e.target.value)}
                placeholder={
                  "Paste all visit history here...\n\nExample:\nFOLLOW UP ON 16/9/25\nHT 159.8 WT 81.7 BMI 32.3\nFBG 69 HBA1C 5.3 TG 268\nTREATMENT: TAB THYRONORM 75MCG...\n\nFOLLOW UP ON 16/5/25\nHT 159.5 WT 83.1 BF 34.75\nHBA1C 5.1 FBG 87.5 TG 287.2..."
                }
                style={{
                  width: "100%",
                  minHeight: 150,
                  padding: 8,
                  fontSize: 11,
                  borderRadius: 6,
                  border: "1px solid #d1d5db",
                  fontFamily: "monospace",
                  resize: "vertical",
                  boxSizing: "border-box",
                }}
              />
              <div
                style={{
                  display: "flex",
                  gap: 6,
                  marginTop: 6,
                  alignItems: "center",
                  flexWrap: "wrap",
                }}
              >
                <button
                  onClick={processBulkImport}
                  disabled={bulkParsing || !bulkText.trim()}
                  style={{
                    padding: "8px 16px",
                    fontSize: 11,
                    fontWeight: 700,
                    background: bulkParsing ? "#94a3b8" : "#2563eb",
                    color: "white",
                    border: "none",
                    borderRadius: 6,
                    cursor: bulkParsing ? "wait" : "pointer",
                  }}
                >
                  {bulkParsing ? "⏳ Parsing..." : "🔍 Parse Visits"}
                </button>
                {bulkVisits.length > 0 && !bulkSaving && (
                  <button
                    onClick={() => saveBulkVisits(dbPatientId, setPatientFullData, fetchOutcomes)}
                    disabled={!dbPatientId}
                    style={{
                      padding: "8px 16px",
                      fontSize: 11,
                      fontWeight: 700,
                      background: "#16a34a",
                      color: "white",
                      border: "none",
                      borderRadius: 6,
                      cursor: "pointer",
                    }}
                  >
                    💾 Save All {bulkVisits.length} Visits
                  </button>
                )}
                {bulkVisits.length > 0 && (
                  <button
                    onClick={() => {
                      setBulkVisits([]);
                      setBulkProgress("");
                      setBulkText("");
                    }}
                    style={{
                      padding: "8px 16px",
                      fontSize: 11,
                      fontWeight: 600,
                      background: "#fef2f2",
                      color: "#dc2626",
                      border: "1px solid #fca5a5",
                      borderRadius: 6,
                      cursor: "pointer",
                    }}
                  >
                    🗑️ Clear
                  </button>
                )}
                {bulkProgress && (
                  <span
                    style={{
                      fontSize: 10,
                      color: bulkProgress.includes("❌") ? "#dc2626" : "#16a34a",
                      fontWeight: 600,
                    }}
                  >
                    {bulkProgress}
                  </span>
                )}
              </div>
              {bulkSaving && (
                <div
                  style={{
                    marginTop: 6,
                    background: "#f0fdf4",
                    borderRadius: 6,
                    overflow: "hidden",
                    height: 6,
                  }}
                >
                  <div
                    style={{
                      height: "100%",
                      background: "#16a34a",
                      width: `${(bulkSaved / Math.max(bulkVisits.length, 1)) * 100}%`,
                      transition: "width 0.3s",
                    }}
                  />
                </div>
              )}
              {bulkVisits.length > 0 && (
                <div style={{ marginTop: 8, maxHeight: 300, overflowY: "auto" }}>
                  {bulkVisits.map((v, i) => (
                    <div
                      key={i}
                      style={{
                        padding: 8,
                        marginBottom: 4,
                        background: i % 2 === 0 ? "#f8fafc" : "#f1f5f9",
                        borderRadius: 6,
                        fontSize: 10,
                        border: "1px solid #e2e8f0",
                      }}
                    >
                      <div
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          marginBottom: 4,
                        }}
                      >
                        <span style={{ fontWeight: 800, color: "#1e40af" }}>📅 {v.visit_date}</span>
                        <span style={{ color: "#64748b" }}>{v.doctor_name || ""}</span>
                      </div>
                      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", fontSize: 9 }}>
                        {v.vitals?.weight && <span>⚖️ {v.vitals.weight}kg</span>}
                        {v.vitals?.bp_sys && (
                          <span>
                            🩸 {v.vitals.bp_sys}/{v.vitals.bp_dia}
                          </span>
                        )}
                        {v.vitals?.bmi && <span>📊 BMI {v.vitals.bmi}</span>}
                      </div>
                      {(v.labs || []).length > 0 && (
                        <div style={{ marginTop: 3, display: "flex", flexWrap: "wrap", gap: 3 }}>
                          {v.labs.map((l, li) => (
                            <span
                              key={li}
                              style={{
                                fontSize: 8,
                                padding: "1px 5px",
                                borderRadius: 3,
                                fontWeight: 600,
                                background:
                                  l.flag === "H"
                                    ? "#fef2f2"
                                    : l.flag === "L"
                                      ? "#eff6ff"
                                      : "#f0fdf4",
                                color:
                                  l.flag === "H"
                                    ? "#dc2626"
                                    : l.flag === "L"
                                      ? "#2563eb"
                                      : "#059669",
                              }}
                            >
                              {l.test_name}: {l.result}
                              {l.unit || ""}
                            </span>
                          ))}
                        </div>
                      )}
                      {(v.medications || []).length > 0 && (
                        <div style={{ marginTop: 3, fontSize: 9, color: "#475569" }}>
                          💊 {v.medications.map((m) => m.name).join(", ")}
                        </div>
                      )}
                      {(v.diagnoses || []).length > 0 && (
                        <div style={{ marginTop: 3, display: "flex", flexWrap: "wrap", gap: 2 }}>
                          {v.diagnoses.map((d, di) => (
                            <span
                              key={di}
                              style={{
                                fontSize: 8,
                                padding: "1px 5px",
                                borderRadius: 3,
                                fontWeight: 600,
                                background:
                                  d.status === "Controlled"
                                    ? "#f0fdf4"
                                    : d.status === "Uncontrolled"
                                      ? "#fef2f2"
                                      : "#f1f5f9",
                                color:
                                  d.status === "Controlled"
                                    ? "#059669"
                                    : d.status === "Uncontrolled"
                                      ? "#dc2626"
                                      : "#475569",
                              }}
                            >
                              {d.label}
                            </span>
                          ))}
                        </div>
                      )}
                      {cleanNote(v.notes) && (
                        <div
                          style={{
                            marginTop: 3,
                            fontSize: 9,
                            color: "#64748b",
                            fontStyle: "italic",
                          }}
                        >
                          {cleanNote(v.notes)}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* ===== EXTRACTED / MANUAL DATA ===== */}
          {hxMode !== "bulk" && (
            <div
              style={{
                background: "white",
                borderRadius: 8,
                padding: 10,
                border: "1px solid #e2e8f0",
                marginTop: 8,
              }}
            >
              <div style={{ fontSize: 10, fontWeight: 700, color: "#64748b", marginBottom: 6 }}>
                {hxMode === "manual" ? "📋 MANUAL ENTRY" : "📋 REVIEW EXTRACTED DATA"}
              </div>

              {/* Vitals */}
              <div style={{ fontSize: 9, fontWeight: 700, color: "#94a3b8", marginBottom: 3 }}>
                VITALS
              </div>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 1fr 1fr 1fr 1fr",
                  gap: 3,
                  marginBottom: 8,
                }}
              >
                {[
                  ["bp_sys", "BP Sys"],
                  ["bp_dia", "BP Dia"],
                  ["pulse", "Pulse"],
                  ["weight", "Wt (kg)"],
                  ["height", "Ht (cm)"],
                ].map(([k, l]) => (
                  <div key={k}>
                    <label style={{ fontSize: 7, color: "#94a3b8" }}>{l}</label>
                    <input
                      value={historyForm.vitals[k] || ""}
                      onChange={(e) =>
                        setHistoryForm((p) => ({
                          ...p,
                          vitals: { ...p.vitals, [k]: e.target.value },
                        }))
                      }
                      style={{
                        width: "100%",
                        padding: "2px 4px",
                        border: "1px solid #e2e8f0",
                        borderRadius: 3,
                        fontSize: 10,
                        boxSizing: "border-box",
                      }}
                    />
                  </div>
                ))}
              </div>

              {/* Diagnoses */}
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  marginBottom: 3,
                }}
              >
                <div style={{ fontSize: 9, fontWeight: 700, color: "#94a3b8" }}>DIAGNOSES</div>
                <button
                  onClick={() => addHistoryRow("diagnoses")}
                  style={{
                    fontSize: 8,
                    padding: "1px 5px",
                    border: "1px solid #e2e8f0",
                    borderRadius: 3,
                    cursor: "pointer",
                    background: "white",
                  }}
                >
                  +
                </button>
              </div>
              {historyForm.diagnoses.map((d, i) => (
                <div
                  key={i}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "70px 1fr 85px 20px",
                    gap: 3,
                    marginBottom: 2,
                  }}
                >
                  <input
                    value={d.id}
                    onChange={(e) => {
                      const v = e.target.value;
                      setHistoryForm((p) => {
                        const n = { ...p };
                        n.diagnoses = [...n.diagnoses];
                        n.diagnoses[i] = { ...n.diagnoses[i], id: v };
                        return n;
                      });
                    }}
                    placeholder="dm2"
                    style={{
                      padding: "2px 4px",
                      border: "1px solid #e2e8f0",
                      borderRadius: 3,
                      fontSize: 9,
                      boxSizing: "border-box",
                    }}
                  />
                  <input
                    value={d.label}
                    onChange={(e) => {
                      const v = e.target.value;
                      setHistoryForm((p) => {
                        const n = { ...p };
                        n.diagnoses = [...n.diagnoses];
                        n.diagnoses[i] = { ...n.diagnoses[i], label: v };
                        return n;
                      });
                    }}
                    placeholder="Type 2 DM (since 2015)"
                    style={{
                      padding: "2px 4px",
                      border: "1px solid #e2e8f0",
                      borderRadius: 3,
                      fontSize: 9,
                      boxSizing: "border-box",
                    }}
                  />
                  <select
                    value={d.status}
                    onChange={(e) => {
                      const v = e.target.value;
                      setHistoryForm((p) => {
                        const n = { ...p };
                        n.diagnoses = [...n.diagnoses];
                        n.diagnoses[i] = { ...n.diagnoses[i], status: v };
                        return n;
                      });
                    }}
                    style={{
                      padding: "2px 4px",
                      border: "1px solid #e2e8f0",
                      borderRadius: 3,
                      fontSize: 8,
                      boxSizing: "border-box",
                    }}
                  >
                    <option>New</option>
                    <option>Controlled</option>
                    <option>Uncontrolled</option>
                  </select>
                  <button
                    onClick={() => removeHistoryRow("diagnoses", i)}
                    style={{
                      fontSize: 11,
                      cursor: "pointer",
                      border: "none",
                      background: "none",
                      color: "#dc2626",
                      padding: 0,
                    }}
                  >
                    ×
                  </button>
                </div>
              ))}

              {/* Medications */}
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  marginBottom: 3,
                  marginTop: 6,
                }}
              >
                <div style={{ fontSize: 9, fontWeight: 700, color: "#94a3b8" }}>MEDICATIONS</div>
                <button
                  onClick={() => addHistoryRow("medications")}
                  style={{
                    fontSize: 8,
                    padding: "1px 5px",
                    border: "1px solid #e2e8f0",
                    borderRadius: 3,
                    cursor: "pointer",
                    background: "white",
                  }}
                >
                  +
                </button>
              </div>
              {historyForm.medications.map((m, i) => (
                <div
                  key={i}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "1fr 60px 50px 70px 20px",
                    gap: 3,
                    marginBottom: 2,
                  }}
                >
                  <input
                    value={m.name}
                    onChange={(e) => {
                      const v = e.target.value;
                      setHistoryForm((p) => {
                        const n = { ...p };
                        n.medications = [...n.medications];
                        n.medications[i] = { ...n.medications[i], name: v };
                        return n;
                      });
                    }}
                    placeholder="THYRONORM 88MCG"
                    style={{
                      padding: "2px 4px",
                      border: "1px solid #e2e8f0",
                      borderRadius: 3,
                      fontSize: 9,
                      boxSizing: "border-box",
                    }}
                  />
                  <input
                    value={m.dose}
                    onChange={(e) => {
                      const v = e.target.value;
                      setHistoryForm((p) => {
                        const n = { ...p };
                        n.medications = [...n.medications];
                        n.medications[i] = { ...n.medications[i], dose: v };
                        return n;
                      });
                    }}
                    placeholder="88mcg"
                    style={{
                      padding: "2px 4px",
                      border: "1px solid #e2e8f0",
                      borderRadius: 3,
                      fontSize: 9,
                      boxSizing: "border-box",
                    }}
                  />
                  <input
                    value={m.frequency}
                    onChange={(e) => {
                      const v = e.target.value;
                      setHistoryForm((p) => {
                        const n = { ...p };
                        n.medications = [...n.medications];
                        n.medications[i] = { ...n.medications[i], frequency: v };
                        return n;
                      });
                    }}
                    placeholder="OD"
                    style={{
                      padding: "2px 4px",
                      border: "1px solid #e2e8f0",
                      borderRadius: 3,
                      fontSize: 9,
                      boxSizing: "border-box",
                    }}
                  />
                  <input
                    value={m.timing}
                    onChange={(e) => {
                      const v = e.target.value;
                      setHistoryForm((p) => {
                        const n = { ...p };
                        n.medications = [...n.medications];
                        n.medications[i] = { ...n.medications[i], timing: v };
                        return n;
                      });
                    }}
                    placeholder="Morning"
                    style={{
                      padding: "2px 4px",
                      border: "1px solid #e2e8f0",
                      borderRadius: 3,
                      fontSize: 9,
                      boxSizing: "border-box",
                    }}
                  />
                  <button
                    onClick={() => removeHistoryRow("medications", i)}
                    style={{
                      fontSize: 11,
                      cursor: "pointer",
                      border: "none",
                      background: "none",
                      color: "#dc2626",
                      padding: 0,
                    }}
                  >
                    ×
                  </button>
                </div>
              ))}

              {/* Lab Results */}
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  marginBottom: 3,
                  marginTop: 6,
                }}
              >
                <div style={{ fontSize: 9, fontWeight: 700, color: "#94a3b8" }}>LAB RESULTS</div>
                <button
                  onClick={() => addHistoryRow("labs")}
                  style={{
                    fontSize: 8,
                    padding: "1px 5px",
                    border: "1px solid #e2e8f0",
                    borderRadius: 3,
                    cursor: "pointer",
                    background: "white",
                  }}
                >
                  +
                </button>
              </div>
              {historyForm.labs.map((l, i) => (
                <div
                  key={i}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "1fr 55px 40px 45px 70px 20px",
                    gap: 3,
                    marginBottom: 2,
                  }}
                >
                  <input
                    value={l.test_name}
                    onChange={(e) => {
                      const v = e.target.value;
                      setHistoryForm((p) => {
                        const n = { ...p };
                        n.labs = [...n.labs];
                        n.labs[i] = { ...n.labs[i], test_name: v };
                        return n;
                      });
                    }}
                    placeholder="HbA1c"
                    style={{
                      padding: "2px 4px",
                      border: "1px solid #e2e8f0",
                      borderRadius: 3,
                      fontSize: 9,
                      boxSizing: "border-box",
                    }}
                  />
                  <input
                    value={l.result}
                    onChange={(e) => {
                      const v = e.target.value;
                      setHistoryForm((p) => {
                        const n = { ...p };
                        n.labs = [...n.labs];
                        n.labs[i] = { ...n.labs[i], result: v };
                        return n;
                      });
                    }}
                    placeholder="8.2"
                    style={{
                      padding: "2px 4px",
                      border: "1px solid #e2e8f0",
                      borderRadius: 3,
                      fontSize: 9,
                      boxSizing: "border-box",
                    }}
                  />
                  <input
                    value={l.unit}
                    onChange={(e) => {
                      const v = e.target.value;
                      setHistoryForm((p) => {
                        const n = { ...p };
                        n.labs = [...n.labs];
                        n.labs[i] = { ...n.labs[i], unit: v };
                        return n;
                      });
                    }}
                    placeholder="%"
                    style={{
                      padding: "2px 4px",
                      border: "1px solid #e2e8f0",
                      borderRadius: 3,
                      fontSize: 9,
                      boxSizing: "border-box",
                    }}
                  />
                  <select
                    value={l.flag}
                    onChange={(e) => {
                      const v = e.target.value;
                      setHistoryForm((p) => {
                        const n = { ...p };
                        n.labs = [...n.labs];
                        n.labs[i] = { ...n.labs[i], flag: v };
                        return n;
                      });
                    }}
                    style={{
                      padding: "2px 4px",
                      border: "1px solid #e2e8f0",
                      borderRadius: 3,
                      fontSize: 8,
                      boxSizing: "border-box",
                    }}
                  >
                    <option value="">OK</option>
                    <option>HIGH</option>
                    <option>LOW</option>
                  </select>
                  <input
                    value={l.ref_range}
                    onChange={(e) => {
                      const v = e.target.value;
                      setHistoryForm((p) => {
                        const n = { ...p };
                        n.labs = [...n.labs];
                        n.labs[i] = { ...n.labs[i], ref_range: v };
                        return n;
                      });
                    }}
                    placeholder="<6.5"
                    style={{
                      padding: "2px 4px",
                      border: "1px solid #e2e8f0",
                      borderRadius: 3,
                      fontSize: 9,
                      boxSizing: "border-box",
                    }}
                  />
                  <button
                    onClick={() => removeHistoryRow("labs", i)}
                    style={{
                      fontSize: 11,
                      cursor: "pointer",
                      border: "none",
                      background: "none",
                      color: "#dc2626",
                      padding: 0,
                    }}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Save button - hidden in bulk mode */}
          {hxMode !== "bulk" && (
            <button
              onClick={() => saveHistoryEntry(dbPatientId, setPatientFullData, fetchOutcomes)}
              disabled={historySaving || !historyForm.visit_date}
              style={{
                marginTop: 8,
                width: "100%",
                padding: "10px",
                background: historyForm.visit_date ? "#2563eb" : "#e2e8f0",
                color: historyForm.visit_date ? "white" : "#94a3b8",
                border: "none",
                borderRadius: 6,
                fontWeight: 700,
                fontSize: 13,
                cursor: historyForm.visit_date ? "pointer" : "default",
              }}
            >
              {historySaving ? "💾 Saving..." : "💾 Save Historical Visit"}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
