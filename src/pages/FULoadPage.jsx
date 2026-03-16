import { useNavigate } from "react-router-dom";
import useAuthStore from "../stores/authStore.js";
import usePatientStore from "../stores/patientStore.js";
import useVitalsStore from "../stores/vitalsStore.js";
import useLabStore from "../stores/labStore.js";
import useClinicalStore from "../stores/clinicalStore.js";
import { extractLab, extractImaging } from "../services/extraction.js";
import AudioInput from "../components/AudioInput.jsx";
import "./FULoadPage.css";

export default function FULoadPage() {
  const navigate = useNavigate();
  const { dgKey, whisperKey, conName } = useAuthStore();
  const { patient, dbPatientId, getPfd } = usePatientStore();
  const { vitals, setVitals, voiceFillVitals } = useVitalsStore();
  const { labData, setLabData, intakeReports, setIntakeReports, saveAllIntakeReports } =
    useLabStore();
  const { conData } = useClinicalStore();

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

      {/* Vitals */}
      <div className="fu-load__section">
        <div className="fu-load__section-title">💓 Vitals</div>
        <AudioInput
          label="Say vitals: BP 140/90, weight 80kg"
          dgKey={dgKey}
          whisperKey={whisperKey}
          color="#ea580c"
          compact
          onTranscript={voiceFillVitals}
        />
        <div className="fu-load__vitals-grid">
          {[
            { k: "bp_sys", l: "BP Sys" },
            { k: "bp_dia", l: "BP Dia" },
            { k: "pulse", l: "Pulse" },
            { k: "spo2", l: "SpO2" },
            { k: "weight", l: "Weight" },
            { k: "height", l: "Height" },
            { k: "temp", l: "Temp" },
            { k: "waist", l: "Waist" },
          ].map((v) => (
            <div key={v.k}>
              <label className="fu-load__vital-label">{v.l}</label>
              <input
                value={vitals[v.k] || ""}
                onChange={(e) => {
                  const val = e.target.value;
                  setVitals((p) => {
                    const n = { ...p, [v.k]: val };
                    if (n.weight && n.height)
                      n.bmi = (parseFloat(n.weight) / (parseFloat(n.height) / 100) ** 2).toFixed(1);
                    return n;
                  });
                }}
                className="fu-load__vital-input"
              />
            </div>
          ))}
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
                  for (const rpt of intakeReports.filter((r) => !r.data && !r.extracting)) {
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
                  }
                }}
                className="fu-load__extract-all-btn"
              >
                🔬 Extract All ({intakeReports.filter((r) => !r.data && !r.extracting).length})
              </button>
            )}
            {intakeReports.some((r) => r.data && !r.saved) && dbPatientId && (
              <button
                onClick={saveAllIntakeReports}
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
        return (
          <div className="fu-load__ordered-tests">
            <div className="fu-load__ordered-tests-title">📋 Tests ordered last visit:</div>
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

      <button onClick={() => navigate("/fu-review")} className="fu-load__continue-btn">
        Continue to Review →
      </button>
    </div>
  );
}
