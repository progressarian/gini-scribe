import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import useAuthStore from "../stores/authStore.js";
import usePatientStore from "../stores/patientStore.js";
import useVitalsStore from "../stores/vitalsStore.js";
import useLabStore from "../stores/labStore.js";
import useClinicalStore from "../stores/clinicalStore.js";
import useVisitStore from "../stores/visitStore.js";
import useUiStore from "../stores/uiStore.js";
import useAlertStore from "../stores/alertStore.js";
import { extractLab, extractImaging } from "../services/extraction.js";
import AudioInput from "../components/AudioInput.jsx";
import "./FULoadPage.css";

export default function FULoadPage() {
  const navigate = useNavigate();
  const [continuing, setContinuing] = useState(false);
  const { dgKey, whisperKey, conName } = useAuthStore();
  const { patient, dbPatientId, getPfd } = usePatientStore();
  const { patientAlerts, patientAlertsLoading, fetchPatientAlerts } = useAlertStore();
  const { vitals, setVitals, voiceFillVitals } = useVitalsStore();

  useEffect(() => {
    if (dbPatientId) fetchPatientAlerts(dbPatientId);
  }, [dbPatientId, fetchPatientAlerts]);
  const { labData, setLabData, intakeReports, setIntakeReports, saveAllIntakeReports } =
    useLabStore();
  const { conData } = useClinicalStore();
  const saveDraft = useVisitStore((s) => s.saveDraft);

  const pfd = getPfd();

  return (
    <div>
      <div className="fu-load__header">
        <span className="fu-load__header-icon">📤</span>
        <div className="fu-load__header-info">
          <div className="fu-load__header-title">Load — {patient.name || "Patient"}</div>
          <div className="fu-load__header-sub">
            Visit #{(pfd?.consultations?.length || 0) + 1} •{" "}
            {new Date().toLocaleDateString("en-IN", {
              day: "2-digit",
              month: "short",
              year: "numeric",
            })}{" "}
            • {conName || "Dr."}
          </div>
        </div>
        <span className="fu-load__header-step">Step 1/5</span>
      </div>

      {/* Extraction in progress modal overlay */}
      {intakeReports.some((r) => r.extracting) && (
        <div
          style={{
            position: "fixed",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: "rgba(0, 0, 0, 0.5)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 9999,
          }}
        >
          <div
            style={{
              background: "#ffffff",
              borderRadius: 12,
              padding: "32px",
              textAlign: "center",
              boxShadow: "0 20px 60px rgba(0, 0, 0, 0.3)",
              maxWidth: 320,
            }}
          >
            <div style={{ fontSize: 48, marginBottom: 16, animation: "spin 2s linear infinite" }}>
              ⏳
            </div>
            <div style={{ fontSize: 16, fontWeight: 600, color: "#1a1f2e", marginBottom: 8 }}>
              Extracting Report Values
            </div>
            {intakeReports.filter((r) => r.extracting).length > 1 && (
              <div style={{ fontSize: 12, color: "#6b7280", marginBottom: 8 }}>
                Processing {intakeReports.filter((r) => r.extracting).length} reports...
              </div>
            )}
            <div style={{ fontSize: 13, color: "#6b7280" }}>
              Please wait while we extract the lab results...
            </div>
          </div>
        </div>
      )}

      {/* Patient Concerns from Mobile App */}
      {patientAlertsLoading ? (
        <div style={{ padding: "8px 16px", color: "#94a3b8", fontSize: 13 }}>
          Loading patient alerts...
        </div>
      ) : (
        patientAlerts.length > 0 && (
          <div
            style={{
              margin: "0 0 12px",
              padding: "10px 14px",
              background: "#fffbeb",
              border: "1.5px solid #fde68a",
              borderRadius: 10,
            }}
          >
            <div style={{ fontWeight: 700, fontSize: 13, color: "#92400e", marginBottom: 6 }}>
              {"\ud83d\udce2"} Patient Concerns from App ({patientAlerts.length})
            </div>
            {patientAlerts.slice(0, 5).map((a) => (
              <div
                key={a.id}
                style={{
                  padding: "6px 0",
                  borderBottom: "1px solid #fef3c7",
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "flex-start",
                }}
              >
                <div>
                  <div style={{ fontWeight: 600, fontSize: 13, color: "#78350f" }}>
                    {a.title || a.alert_type}
                  </div>
                  <div style={{ fontSize: 12, color: "#92400e" }}>{a.message}</div>
                </div>
                <div
                  style={{ fontSize: 11, color: "#b45309", whiteSpace: "nowrap", marginLeft: 8 }}
                >
                  {a.created_at
                    ? new Date(a.created_at).toLocaleDateString("en-IN", {
                        day: "2-digit",
                        month: "short",
                      })
                    : ""}
                </div>
              </div>
            ))}
          </div>
        )
      )}

      {/* Vitals */}
      <div className="fu-load__section">
        <div className="fu-load__section-title">💓 Vitals</div>
        <AudioInput
          label="Say vitals: BP 140/90, weight 80kg, muscle mass 35kg"
          dgKey={dgKey}
          whisperKey={whisperKey}
          color="#ea580c"
          compact
          onTranscript={voiceFillVitals}
        />
        <div className="fu-load__vitals-grid">
          {[
            { k: "bp_sys", l: "BP Sys", min: 60, max: 260, unit: "mmHg" },
            { k: "bp_dia", l: "BP Dia", min: 30, max: 160, unit: "mmHg" },
            { k: "pulse", l: "Pulse", min: 30, max: 220, unit: "bpm" },
            { k: "spo2", l: "SpO2", min: 50, max: 100, unit: "%" },
            { k: "weight", l: "Weight", min: 1, max: 300, unit: "kg" },
            { k: "height", l: "Height", min: 30, max: 250, unit: "cm" },
            { k: "temp", l: "Temp", min: 90, max: 110, unit: "°F" },
            { k: "waist", l: "Waist", min: 30, max: 200, unit: "cm" },
            { k: "muscle_mass", l: "Muscle Mass", min: 0, max: 150, unit: "kg" },
          ].map((v) => {
            const val = vitals[v.k] || "";
            const num = parseFloat(val);
            const outOfRange = val && !isNaN(num) && (num < v.min || num > v.max);
            return (
              <div key={v.k}>
                <label className="fu-load__vital-label">{v.l}</label>
                <input
                  type="number"
                  inputMode="decimal"
                  value={val}
                  placeholder={`${v.min}–${v.max}`}
                  onChange={(e) => {
                    const raw = e.target.value;
                    setVitals((p) => {
                      const n = { ...p, [v.k]: raw };
                      if (n.weight && n.height)
                        n.bmi = (parseFloat(n.weight) / (parseFloat(n.height) / 100) ** 2).toFixed(
                          1,
                        );
                      return n;
                    });
                  }}
                  className="fu-load__vital-input"
                  style={outOfRange ? { borderColor: "#ef4444", background: "#fef2f2" } : {}}
                />
                {outOfRange && (
                  <div style={{ fontSize: 10, color: "#ef4444", marginTop: 2 }}>
                    {num < v.min ? `Min ${v.min}${v.unit}` : `Max ${v.max}${v.unit}`}
                  </div>
                )}
              </div>
            );
          })}
        </div>
        {vitals.bmi && (
          <div
            className={`fu-load__bmi ${parseFloat(vitals.bmi) > 25 ? "fu-load__bmi--high" : "fu-load__bmi--normal"}`}
          >
            BMI: {vitals.bmi}
          </div>
        )}
      </div>

      {/* Lab Upload */}
      <div className="fu-load__section">
        <div className="fu-load__section-title fu-load__section-title--purple">
          🔬 Upload Reports
        </div>
        <div className="fu-load__upload-area">
          <label className="fu-load__upload-label">
            <input
              type="file"
              accept="image/*,.pdf"
              multiple
              hidden
              onChange={(e) => {
                [...e.target.files].forEach((file) => {
                  const reader = new FileReader();
                  reader.onload = (ev) => {
                    const base64 = ev.target.result.split(",")[1];
                    const mediaType = file.type || "image/jpeg";
                    setIntakeReports((prev) => [
                      ...prev,
                      {
                        id: "rpt_" + Date.now() + Math.random(),
                        type: "lab",
                        base64,
                        mediaType,
                        fileName: file.name,
                        data: null,
                        extracting: false,
                        error: null,
                      },
                    ]);
                  };
                  reader.readAsDataURL(file);
                });
              }}
            />
            <span className="fu-load__upload-text">🧪 Upload Lab / Imaging Reports</span>
          </label>
        </div>
        {/* Show uploaded reports */}
        {intakeReports.length > 0 && (
          <div className="fu-load__section">
            {intakeReports.map((rpt) => (
              <div
                key={rpt.id}
                className="fu-load__report-item"
                style={{
                  background: rpt.saved
                    ? "#f0fdf4"
                    : rpt.error
                      ? "#fef2f2"
                      : rpt.data
                        ? "#eff6ff"
                        : "#f8fafc",
                  border: `1px solid ${rpt.saved ? "#bbf7d0" : rpt.error ? "#fecaca" : rpt.data ? "#bfdbfe" : "#e2e8f0"}`,
                }}
              >
                <span className="fu-load__report-icon">
                  {rpt.saved
                    ? "✅"
                    : rpt.error
                      ? "❌"
                      : rpt.data
                        ? "📊"
                        : rpt.extracting
                          ? "⏳"
                          : "📎"}
                </span>
                <span className="fu-load__report-name">{rpt.fileName}</span>
                <select
                  value={rpt.type}
                  onChange={(e) =>
                    setIntakeReports((prev) =>
                      prev.map((r) => (r.id === rpt.id ? { ...r, type: e.target.value } : r)),
                    )
                  }
                  className="fu-load__report-type-select"
                >
                  <option value="lab">Lab Report</option>
                  <option value="imaging">Imaging</option>
                  <option value="rx">Other Doctor Rx</option>
                </select>
                {!rpt.data && !rpt.extracting && (
                  <button
                    onClick={async () => {
                      setIntakeReports((prev) =>
                        prev.map((r) => (r.id === rpt.id ? { ...r, extracting: true } : r)),
                      );
                      try {
                        const extFn = rpt.type === "imaging" ? extractImaging : extractLab;
                        const { data, error } = await extFn(rpt.base64, rpt.mediaType);
                        if (data) {
                          setIntakeReports((prev) =>
                            prev.map((r) =>
                              r.id === rpt.id ? { ...r, data, extracting: false } : r,
                            ),
                          );
                          if (rpt.type !== "imaging" && data.panels) {
                            const taggedPanels = data.panels.map((p) => ({
                              ...p,
                              _source: rpt.fileName,
                            }));
                            setLabData((prev) =>
                              prev
                                ? { ...prev, panels: [...(prev.panels || []), ...taggedPanels] }
                                : { ...data, panels: taggedPanels },
                            );
                          }
                        } else {
                          setIntakeReports((prev) =>
                            prev.map((r) =>
                              r.id === rpt.id
                                ? { ...r, error: error || "No data", extracting: false }
                                : r,
                            ),
                          );
                        }
                      } catch (e) {
                        setIntakeReports((prev) =>
                          prev.map((r) =>
                            r.id === rpt.id ? { ...r, error: e.message, extracting: false } : r,
                          ),
                        );
                      }
                    }}
                    className="fu-load__extract-btn"
                  >
                    Extract
                  </button>
                )}
                {rpt.extracting && <span className="fu-load__extracting">⏳</span>}
                <button
                  onClick={() => setIntakeReports((prev) => prev.filter((r) => r.id !== rpt.id))}
                  className="fu-load__remove-btn"
                >
                  ✕
                </button>
              </div>
            ))}
            {intakeReports.some((r) => !r.data && !r.extracting) && (
              <button
                onClick={async () => {
                  const toExtract = intakeReports.filter((r) => !r.data && !r.extracting);
                  // Mark all as extracting at once
                  setIntakeReports((prev) =>
                    prev.map((r) =>
                      toExtract.find((t) => t.id === r.id) ? { ...r, extracting: true } : r,
                    ),
                  );
                  // Extract all in parallel
                  await Promise.all(
                    toExtract.map(async (rpt) => {
                      try {
                        const extFn = rpt.type === "imaging" ? extractImaging : extractLab;
                        const { data, error } = await extFn(rpt.base64, rpt.mediaType);
                        if (data) {
                          setIntakeReports((prev) =>
                            prev.map((r) =>
                              r.id === rpt.id ? { ...r, data, extracting: false } : r,
                            ),
                          );
                          if (rpt.type !== "imaging" && data.panels) {
                            const taggedPanels = data.panels.map((p) => ({
                              ...p,
                              _source: rpt.fileName,
                            }));
                            setLabData((prev) =>
                              prev
                                ? { ...prev, panels: [...(prev.panels || []), ...taggedPanels] }
                                : { ...data, panels: taggedPanels },
                            );
                          }
                        } else {
                          setIntakeReports((prev) =>
                            prev.map((r) =>
                              r.id === rpt.id
                                ? { ...r, error: error || "No data", extracting: false }
                                : r,
                            ),
                          );
                        }
                      } catch (e) {
                        setIntakeReports((prev) =>
                          prev.map((r) =>
                            r.id === rpt.id ? { ...r, error: e.message, extracting: false } : r,
                          ),
                        );
                      }
                    }),
                  );
                }}
                className="fu-load__extract-all-btn"
              >
                🔬 Extract All ({intakeReports.filter((r) => !r.data && !r.extracting).length})
              </button>
            )}
            {intakeReports.some((r) => r.data && !r.saved) && dbPatientId && (
              <button
                onClick={() => saveAllIntakeReports(dbPatientId)}
                disabled={intakeReports.some((r) => r.saving)}
                className={`fu-load__save-reports-btn ${intakeReports.some((r) => r.saving) ? "fu-load__save-reports-btn--loading" : "fu-load__save-reports-btn--active"}`}
              >
                {intakeReports.some((r) => r.saving)
                  ? `⏳ Saving...`
                  : `💾 Save ${intakeReports.filter((r) => r.data && !r.saved).length} Reports`}
              </button>
            )}
          </div>
        )}
      </div>

      {/* Ordered tests checklist */}
      {(() => {
        const lastCon = pfd?.consultations?.[0];
        const lastConData = conData || lastCon?.con_data || {};
        const orderedTests =
          lastConData.follow_up?.tests_to_bring || lastConData.investigations_to_order || [];
        if (!orderedTests.length) return null;
        const loadedTests =
          labData?.panels?.flatMap((p) => p.tests.map((t) => t.test_name.toLowerCase())) || [];
        const testsDueDate = lastConData.follow_up?.tests_due_date;
        const dueDateStr = testsDueDate
          ? new Date(testsDueDate).toLocaleDateString("en-IN", {
              day: "2-digit",
              month: "short",
              year: "numeric",
            })
          : null;
        return (
          <div className="fu-load__ordered-tests">
            <div className="fu-load__ordered-tests-title">
              📋 Tests ordered last visit{dueDateStr ? ` (due: ${dueDateStr})` : ""}:
            </div>
            <div className="fu-load__ordered-tests-list">
              {orderedTests.map((t, i) => {
                const tStr = typeof t === "string" ? t : t.test || t.name || "";
                const done = loadedTests.some((lt) =>
                  lt.includes(tStr.toLowerCase().split(" ")[0]),
                );
                return (
                  <span
                    key={i}
                    className={`fu-load__ordered-test ${done ? "fu-load__ordered-test--done" : "fu-load__ordered-test--pending"}`}
                  >
                    {done ? "✅" : "⏳"} {tStr}
                  </span>
                );
              })}
            </div>
          </div>
        );
      })()}

      <button
        disabled={continuing}
        onClick={async () => {
          setContinuing(true);
          try {
            await saveDraft();
          } catch {
            /* continue anyway */
          }
          setContinuing(false);
          navigate("/fu-review");
        }}
        className="fu-load__continue-btn"
      >
        {continuing ? "Saving..." : "Continue to Review →"}
      </button>
    </div>
  );
}
