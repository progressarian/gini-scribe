import "./CaptureScreen.css";
import { useRef, useEffect } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { docCategories } from "./constants";
import useCompanionStore from "../stores/companionStore";

export default function CaptureScreen() {
  const { id } = useParams();
  const navigate = useNavigate();
  const {
    selectedPatient,
    captureStep,
    captureCount,
    currentCapture,
    currentCategory,
    captureMeta,
    extractedData,
    captureError,
    nameMismatch,
    categoryMismatch,
    loading,
    saveStatus,
    handleFileSelect,
    setCurrentCategory,
    changeCategory,
    setCaptureMeta,
    extractDocument,
    saveCapture,
    discardCapture,
    retryCapture,
    loadPatientData,
  } = useCompanionStore();

  useEffect(() => {
    if (id && !selectedPatient) loadPatientData(parseInt(id));
  }, [id]);

  const cameraRef = useRef(null);
  const fileRef = useRef(null);

  const patient = selectedPatient;

  return (
    <div>
      <div className="capture__header">
        <button
          onClick={() => {
            discardCapture();
            navigate("/companion");
          }}
          className="capture__back"
        >
          ←
        </button>
        <div className="capture__info">
          <div className="capture__name">{patient?.name || "Patient"}</div>
          <div className="capture__sub">
            Capture Documents{captureCount > 0 ? ` • ${captureCount} saved` : ""}
          </div>
        </div>
      </div>

      <div className="capture__body">
        {captureStep === "camera" && (
          <div>
            <div className="capture__btns">
              <button
                onClick={() => cameraRef.current?.click()}
                className="capture__btn capture__btn--camera"
              >
                <span className="capture__btn-icon">📷</span>Take Photo
              </button>
              <button
                onClick={() => fileRef.current?.click()}
                className="capture__btn capture__btn--file"
              >
                <span className="capture__btn-icon">📁</span>Upload File
              </button>
            </div>
            <input
              ref={cameraRef}
              type="file"
              accept="image/*"
              capture="environment"
              onChange={(e) => {
                handleFileSelect(e);
                e.target.value = null;
              }}
              style={{ display: "none" }}
            />
            <input
              ref={fileRef}
              type="file"
              accept="image/*,.pdf"
              onChange={(e) => {
                handleFileSelect(e);
                e.target.value = null;
              }}
              style={{ display: "none" }}
            />
            {captureCount > 0 && (
              <div className="capture__success">
                <div className="capture__success-icon">✅</div>
                <div className="capture__success-text">
                  {captureCount} document{captureCount > 1 ? "s" : ""} saved
                </div>
              </div>
            )}
          </div>
        )}

        {captureStep === "categorize" && currentCapture && (
          <div>
            {/* {currentCapture.preview && (
              <div className="capture__preview">
                <img src={currentCapture.preview} alt="Captured" className="capture__preview-img" />
              </div>
            )} */}
            {currentCapture?.preview && (
              <div className="capture__preview">
                {currentCapture.mediaType === "application/pdf" ? (
                  <iframe
                    src={currentCapture.preview}
                    title="PDF Preview"
                    className="capture__preview-pdf"
                  />
                ) : (
                  <img
                    src={currentCapture.preview}
                    alt="Captured"
                    className="capture__preview-img"
                  />
                )}
              </div>
            )}
            <div className="capture__cat-label">What type of document is this?</div>
            <div className="capture__cat-grid">
              {docCategories.map((cat) => (
                <button
                  key={cat.id}
                  onClick={() => setCurrentCategory(cat.id)}
                  className="capture__cat-btn"
                  style={{
                    background: currentCategory === cat.id ? cat.color : "white",
                    color: currentCategory === cat.id ? "white" : cat.color,
                    borderColor: currentCategory === cat.id ? cat.color : "#e2e8f0",
                  }}
                >
                  {cat.label}
                </button>
              ))}
            </div>
            {currentCategory && (
              <div className="capture__meta-grid">
                <input
                  type="date"
                  value={captureMeta.date}
                  onChange={(e) => setCaptureMeta((p) => ({ ...p, date: e.target.value }))}
                  className="capture__meta-input"
                  placeholder="Report date"
                  style={{ flex: "1 1 45%" }}
                />
                <input
                  value={captureMeta.hospital}
                  onChange={(e) => setCaptureMeta((p) => ({ ...p, hospital: e.target.value }))}
                  placeholder={currentCategory === "prescription" ? "Hospital" : "Lab name"}
                  className="capture__meta-input"
                  style={{ flex: "1 1 45%" }}
                />
                {currentCategory === "prescription" && (
                  <>
                    <input
                      value={captureMeta.doctor}
                      onChange={(e) => setCaptureMeta((p) => ({ ...p, doctor: e.target.value }))}
                      placeholder="Doctor name"
                      className="capture__meta-input"
                    />
                    <input
                      value={captureMeta.specialty}
                      onChange={(e) => setCaptureMeta((p) => ({ ...p, specialty: e.target.value }))}
                      placeholder="Specialty"
                      className="capture__meta-input"
                    />
                  </>
                )}
              </div>
            )}
            <div className="capture__actions">
              <button onClick={discardCapture} className="capture__action-cancel">
                ✕ Cancel
              </button>
              <button
                onClick={extractDocument}
                disabled={!currentCategory}
                className={`capture__action-extract ${!currentCategory ? "capture__action-extract--disabled" : ""}`}
              >
                🧠 Extract with AI
              </button>
            </div>
          </div>
        )}

        {captureStep === "extracting" && (
          <div className="capture__extracting">
            <div className="capture__extracting-icon">🧠</div>
            <div className="capture__extracting-title">AI is reading the document...</div>
            <div className="capture__extracting-sub">
              Extracting diagnoses, medications, lab values
            </div>
          </div>
        )}

        {captureStep === "review" && (
          <div>
            {nameMismatch && (
              <div className="capture__mismatch">
                <div className="capture__mismatch-title">⚠️ Name Mismatch</div>
                <div className="capture__mismatch-body">
                  Report says: <b>{nameMismatch.reportName}</b>
                  <br />
                  Selected patient: <b>{nameMismatch.selectedName}</b>
                </div>
                <div className="capture__mismatch-hint">
                  Please verify this is the correct patient before saving.
                </div>
              </div>
            )}
            {categoryMismatch && (
              <div
                className="capture__mismatch"
                style={{ borderColor: "#f59e0b", background: "#fffbeb" }}
              >
                <div className="capture__mismatch-title">📋 Category Check</div>
                <div className="capture__mismatch-body">{categoryMismatch.msg}</div>
                {categoryMismatch.detected === "prescription" && (
                  <button
                    onClick={() => changeCategory("prescription")}
                    style={{
                      marginTop: 8,
                      padding: "6px 16px",
                      borderRadius: 8,
                      border: "none",
                      background: "#7c3aed",
                      color: "#fff",
                      fontSize: 13,
                      cursor: "pointer",
                    }}
                  >
                    Change to Prescription
                  </button>
                )}
                {categoryMismatch.detected === "lab" && (
                  <button
                    onClick={() => changeCategory("blood_test")}
                    style={{
                      marginTop: 8,
                      padding: "6px 16px",
                      borderRadius: 8,
                      border: "none",
                      background: "#0369a1",
                      color: "#fff",
                      fontSize: 13,
                      cursor: "pointer",
                    }}
                  >
                    Change to Lab Report
                  </button>
                )}
                {categoryMismatch.detected === "both" && (
                  <div style={{ marginTop: 6, fontSize: 12, color: "#92400e" }}>
                    Both medications and lab values will be saved automatically.
                  </div>
                )}
              </div>
            )}
            {captureError && (
              <div className="capture__error">
                <div className="capture__error-text">⚠️ {captureError}</div>
              </div>
            )}
            {currentCapture?.preview && (
              <div className="capture__preview">
                {currentCapture.mediaType === "application/pdf" ? (
                  <iframe
                    src={currentCapture.preview}
                    title="PDF Preview"
                    className="capture__preview-pdf"
                  />
                ) : (
                  <img
                    src={currentCapture.preview}
                    alt="Captured"
                    className="capture__preview-img"
                  />
                )}
              </div>
            )}
            {extractedData && (
              <div>
                {extractedData.doctor_name && (
                  <div className="capture__doctor-card">
                    <div className="capture__doctor-name">
                      {extractedData.doctor_name}{" "}
                      {extractedData.specialty ? `(${extractedData.specialty})` : ""}
                    </div>
                    {extractedData.hospital_name && (
                      <div className="capture__doctor-hospital">{extractedData.hospital_name}</div>
                    )}
                  </div>
                )}
                {extractedData.diagnoses?.length > 0 && (
                  <div className="capture__section">
                    <div className="capture__section-title">DIAGNOSES</div>
                    <div className="capture__diagnoses">
                      {extractedData.diagnoses.map((d, i) => (
                        <span key={i} className="capture__diagnosis-tag">
                          {typeof d === "string" ? d : d.label || d.id || ""}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
                {extractedData.medications?.length > 0 && (
                  <div className="capture__section">
                    <div className="capture__section-title">
                      MEDICATIONS ({extractedData.medications.length})
                    </div>
                    {extractedData.medications.map((m, i) => (
                      <div key={i} className="capture__med-row">
                        <span className="capture__med-name">{m.name}</span>
                        <span className="capture__med-details">
                          {m.dose} {m.frequency} {m.timing}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
                {extractedData.labs?.length > 0 && (
                  <div className="capture__section">
                    <div className="capture__section-title">
                      LAB VALUES ({extractedData.labs.length})
                    </div>
                    <div className="capture__labs-table">
                      {extractedData.labs.map((l, i) => (
                        <div key={i} className="capture__lab-row">
                          <span className="capture__lab-name">{l.test_name}</span>
                          <span>
                            <span
                              className="capture__lab-result"
                              style={{
                                color:
                                  l.flag === "HIGH"
                                    ? "#dc2626"
                                    : l.flag === "LOW"
                                      ? "#f59e0b"
                                      : "#059669",
                              }}
                            >
                              {l.result}
                            </span>
                            <span className="capture__lab-unit">{l.unit}</span>
                          </span>
                        </div>
                      ))}
                    </div>
                    {extractedData.summary && (
                      <div className="capture__summary">💡 {extractedData.summary}</div>
                    )}
                  </div>
                )}
                {extractedData.findings && (
                  <div className="capture__findings">
                    <div className="capture__findings-title">FINDINGS</div>
                    {extractedData.findings}
                  </div>
                )}
              </div>
            )}
            <div className="capture__review-actions">
              <button onClick={discardCapture} className="capture__review-discard">
                ✕ Discard
              </button>
              <button onClick={retryCapture} className="capture__review-retry">
                🔄 Retry
              </button>
              <button
                onClick={saveCapture}
                disabled={loading}
                className={`capture__review-save ${loading ? "capture__review-save--loading" : ""}`}
              >
                {loading ? saveStatus || "Saving..." : "✅ Save"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
