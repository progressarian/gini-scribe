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
    loading,
    saveStatus,
    handleFileSelect,
    setCurrentCategory,
    setCaptureMeta,
    saveCapture,
    discardCapture,
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
                onClick={saveCapture}
                disabled={!currentCategory || loading}
                className={`capture__action-extract ${!currentCategory || loading ? "capture__action-extract--disabled" : ""}`}
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
