import { useRef } from "react";
import { useNavigate } from "react-router-dom";
import useAuthStore from "../stores/authStore.js";
import useVitalsStore from "../stores/vitalsStore.js";
import useLabStore from "../stores/labStore.js";
import useUiStore from "../stores/uiStore.js";
import AudioInput from "../components/AudioInput.jsx";
import Err from "../components/Err.jsx";
import "./VitalsPage.css";

export default function VitalsPage() {
  const navigate = useNavigate();
  const labRef = useRef(null);
  const { dgKey, whisperKey } = useAuthStore();
  const { vitals, updateVital, voiceFillVitals } = useVitalsStore();
  const {
    labData,
    labImageData,
    labMismatch,
    imagingFiles,
    handleLabUpload,
    processLab,
    handleImagingUpload,
    processImaging,
    removeImaging,
  } = useLabStore();
  const { loading, errors, clearErr } = useUiStore();

  return (
    <div>
      <div className="vitals__layout">
        <div className="vitals__col">
          <div className="vitals__section-title">📊 Vitals</div>
          <AudioInput
            label="Say vitals: BP 140 over 90, weight 80kg"
            dgKey={dgKey}
            whisperKey={whisperKey}
            color="#ea580c"
            compact
            onTranscript={voiceFillVitals}
          />
          {loading.vv && <div className="vitals__filling">🔬 Filling...</div>}
          <Err msg={errors.vv} onDismiss={() => clearErr("vv")} />
          <div className="vitals__grid">
            {[
              { k: "bp_sys", l: "BP Sys" },
              { k: "bp_dia", l: "BP Dia" },
              { k: "pulse", l: "Pulse" },
              { k: "temp", l: "Temp °F" },
              { k: "spo2", l: "SpO2 %" },
              { k: "weight", l: "Wt kg" },
              { k: "height", l: "Ht cm" },
              { k: "bmi", l: "BMI", disabled: true },
              { k: "waist", l: "Waist cm" },
              { k: "body_fat", l: "Body Fat %" },
              { k: "muscle_mass", l: "Muscle kg" },
            ].map((v) => (
              <div key={v.k}>
                <label className="vitals__label">{v.l}</label>
                <input
                  type="number"
                  value={vitals[v.k]}
                  onChange={(e) => updateVital(v.k, e.target.value)}
                  disabled={v.disabled}
                  className={`vitals__input ${v.disabled ? "vitals__input--disabled" : ""}`}
                />
              </div>
            ))}
          </div>
        </div>
        <div className="vitals__col">
          <div className="vitals__section-title vitals__section-title--purple">🔬 Lab Reports</div>
          <div onClick={() => labRef.current?.click()} className="vitals__lab-upload">
            <input
              ref={labRef}
              type="file"
              accept="image/*,.pdf,.heic,.heif"
              onChange={handleLabUpload}
              style={{ display: "none" }}
            />
            {labImageData ? (
              <div className="vitals__lab-file-name">📋 {labImageData.fileName}</div>
            ) : (
              <div>
                <div className="vitals__lab-upload-icon">📋</div>
                <div className="vitals__lab-upload-text">Upload Report</div>
              </div>
            )}
          </div>
          {labImageData && !labData && (
            <button
              onClick={processLab}
              disabled={loading.lab}
              className={`vitals__extract-btn ${loading.lab ? "vitals__extract-btn--loading" : "vitals__extract-btn--active"}`}
            >
              {loading.lab ? "🔬 Extracting..." : "🔬 Extract Labs"}
            </button>
          )}
          <Err msg={errors.lab} onDismiss={() => clearErr("lab")} />
          {labMismatch && <div className="vitals__lab-mismatch">⚠️ {labMismatch}</div>}
          {labData && (
            <div className="vitals__lab-success">
              ✅ {labData.panels?.reduce((a, p) => a + p.tests.length, 0)} tests extracted
            </div>
          )}
        </div>
      </div>
      {labData &&
        (labData.panels || []).map((panel, pi) => (
          <div key={pi} className="vitals__panel">
            <div className="vitals__panel-header">{panel.panel_name}</div>
            <table className="vitals__panel-table">
              <tbody>
                {panel.tests.map((t, ti) => (
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
                    <td className="vitals__panel-cell">{t.test_name}</td>
                    <td
                      className="vitals__panel-cell vitals__panel-cell--right"
                      style={{
                        color: t.flag === "H" ? "#dc2626" : t.flag === "L" ? "#2563eb" : "#1e293b",
                      }}
                    >
                      {t.result_text || t.result} {t.unit}
                    </td>
                    <td className="vitals__panel-cell vitals__panel-cell--center">
                      {t.flag === "H" ? "↑ HIGH" : t.flag === "L" ? "↓ LOW" : "✓"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}

      <div className="vitals__imaging">
        <div className="vitals__section-title vitals__section-title--blue">
          🩻 Imaging & Diagnostic Reports
        </div>
        <div className="vitals__imaging-types">
          {[
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
          ].map((type) => (
            <label key={type} className="vitals__imaging-type-label">
              📎 {type}
              <input
                type="file"
                accept="image/*,.pdf,.heic,.heif"
                multiple
                onChange={(e) => handleImagingUpload(e, type)}
                style={{ display: "none" }}
              />
            </label>
          ))}
        </div>

        {imagingFiles.map((file) => (
          <div
            key={file.id}
            className={`vitals__imaging-file ${file.data ? "vitals__imaging-file--extracted" : "vitals__imaging-file--default"}`}
          >
            <div
              className="vitals__imaging-file-header"
              style={{ marginBottom: file.data ? 6 : 0 }}
            >
              <span className="vitals__imaging-file-type">🩻 {file.type}</span>
              <span className="vitals__imaging-file-name">{file.fileName}</span>
              <div style={{ flex: 1 }} />
              {!file.data && !file.extracting && (
                <button
                  onClick={() => processImaging(file.id)}
                  className="vitals__imaging-extract-btn"
                >
                  🔬 Extract
                </button>
              )}
              {file.extracting && (
                <span className="vitals__imaging-extracting">⏳ Analyzing...</span>
              )}
              {file.data && <span className="vitals__imaging-extracted">✅ Extracted</span>}
              <button onClick={() => removeImaging(file.id)} className="vitals__imaging-remove-btn">
                ✕
              </button>
            </div>
            {file.error && <div className="vitals__imaging-error">❌ {file.error}</div>}
            {file.data && (
              <div>
                {file.data.impression && (
                  <div className="vitals__imaging-impression">💡 {file.data.impression}</div>
                )}
                {(file.data.findings || []).length > 0 && (
                  <table className="vitals__imaging-table">
                    <thead>
                      <tr className="vitals__imaging-table-head">
                        <th className="vitals__imaging-table-th">Parameter</th>
                        <th className="vitals__imaging-table-th vitals__imaging-table-th--right">
                          Value
                        </th>
                        <th className="vitals__imaging-table-th vitals__imaging-table-th--center">
                          Status
                        </th>
                        <th className="vitals__imaging-table-th">Detail</th>
                      </tr>
                    </thead>
                    <tbody>
                      {file.data.findings.map((f, i) => (
                        <tr
                          key={i}
                          style={{
                            background:
                              f.interpretation === "Abnormal"
                                ? "#fef2f2"
                                : f.interpretation === "Borderline"
                                  ? "#fefce8"
                                  : i % 2
                                    ? "#fafafa"
                                    : "white",
                          }}
                        >
                          <td className="vitals__imaging-table-cell vitals__imaging-table-cell--name">
                            {f.parameter}
                          </td>
                          <td
                            className="vitals__imaging-table-cell vitals__imaging-table-cell--right"
                            style={{
                              fontWeight: 700,
                              color: f.interpretation === "Abnormal" ? "#dc2626" : "#1e293b",
                            }}
                          >
                            {f.value} {f.unit || ""}
                          </td>
                          <td className="vitals__imaging-table-cell vitals__imaging-table-cell--center">
                            <span
                              className="vitals__imaging-status-badge"
                              style={{
                                background:
                                  f.interpretation === "Abnormal"
                                    ? "#dc2626"
                                    : f.interpretation === "Borderline"
                                      ? "#f59e0b"
                                      : "#059669",
                              }}
                            >
                              {f.interpretation}
                            </span>
                          </td>
                          <td className="vitals__imaging-table-cell vitals__imaging-table-cell--detail">
                            {f.detail || ""}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
                {file.data.recommendations && (
                  <div className="vitals__imaging-recommendations">
                    📋 {file.data.recommendations}
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
      </div>

      <button onClick={() => navigate("/mo")} className="vitals__next-btn">
        Next: MO Recording →
      </button>
    </div>
  );
}
