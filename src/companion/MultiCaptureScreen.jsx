import "./MultiCaptureScreen.css";
import { useRef, useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import useCompanionStore from "../stores/companionStore";
import { docCategories } from "./constants";

export default function MultiCaptureScreen() {
  const { id } = useParams();
  const navigate = useNavigate();
  const {
    selectedPatient,
    multiCapture,
    activeAppointmentId,
    multiHandleFilesSelect,
    multiRemoveItem,
    multiSetItemCategory,
    multiSetItemMeta,
    multiAutoClassify,
    multiSaveAll,
    multiReset,
    loadPatientData,
  } = useCompanionStore();

  const { step, items, error, saveProgress } = multiCapture;

  useEffect(() => {
    if (id && !selectedPatient) loadPatientData(parseInt(id, 10));
  }, [id]);

  useEffect(() => {
    return () => multiReset();
  }, []);

  // Auto-classify in background whenever we enter or add to the preview step.
  // Safe to call repeatedly — it skips items that already have a category.
  useEffect(() => {
    if (step === "preview" && items.some((it) => !it.category && !it.classifying)) {
      multiAutoClassify();
    }
  }, [step, items.length]);

  const cameraRef = useRef(null);
  const galleryRef = useRef(null);
  const addMoreRef = useRef(null);

  const [previewItem, setPreviewItem] = useState(null);

  useEffect(() => {
    if (!previewItem) return;
    const onKey = (e) => {
      if (e.key === "Escape") setPreviewItem(null);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [previewItem]);

  const handleBack = () => {
    if (step === "saving") return;
    multiReset();
    navigate(-1);
  };

  const handleFilePick = (e, refEl) => {
    const files = e.target.files;
    if (files?.length) multiHandleFilesSelect(files);
    if (refEl) refEl.value = null;
  };

  const missingCategory = items.filter((it) => !it.category).length;
  const canSave = items.length > 0 && missingCategory === 0;

  return (
    <div className="mcap">
      <div className="mcap__header">
        <button onClick={handleBack} className="mcap__back" disabled={step === "saving"}>
          ←
        </button>
        <div className="mcap__header-info">
          <div className="mcap__header-name">{selectedPatient?.name || "Patient"}</div>
          <div className="mcap__header-sub">
            Batch Upload
            {items.length > 0 ? ` · ${items.length} file${items.length === 1 ? "" : "s"}` : ""}
            {activeAppointmentId ? ` · Appt #${activeAppointmentId}` : ""}
          </div>
        </div>
      </div>

      <div className="mcap__body">
        {error && (
          <div className="mcap__error">
            <span>⚠️</span> {error}
          </div>
        )}

        {step === "pick" && (
          <div>
            <div className="mcap__pick-title">
              Upload multiple reports — set category per file, save, extract in background
            </div>
            <div className="mcap__pick-btns">
              <button
                onClick={() => cameraRef.current?.click()}
                className="mcap__pick-btn mcap__pick-btn--camera"
              >
                <span className="mcap__pick-btn-icon">📷</span>
                Take Photos
                <span className="mcap__pick-btn-hint">Multiple captures</span>
              </button>
              <button
                onClick={() => galleryRef.current?.click()}
                className="mcap__pick-btn mcap__pick-btn--file"
              >
                <span className="mcap__pick-btn-icon">📁</span>
                Upload Files
                <span className="mcap__pick-btn-hint">Images or PDFs</span>
              </button>
            </div>
            <div className="mcap__pick-help">
              ✨ On the next screen, confirm the type and details for each file, then save. Data
              extraction runs silently after save.
            </div>
            <input
              ref={cameraRef}
              type="file"
              accept="image/*"
              capture="environment"
              multiple
              onChange={(e) => handleFilePick(e, cameraRef.current)}
              style={{ display: "none" }}
            />
            <input
              ref={galleryRef}
              type="file"
              accept="image/*,.pdf"
              multiple
              onChange={(e) => handleFilePick(e, galleryRef.current)}
              style={{ display: "none" }}
            />
          </div>
        )}

        {step === "preview" && (
          <div>
            <div className="mcap__section-title">
              {items.length} file{items.length === 1 ? "" : "s"} · set category & details per file
            </div>

            <div className="mcap__cards">
              {items.map((item) => (
                <ItemCard
                  key={item.id}
                  item={item}
                  onOpen={() => setPreviewItem(item)}
                  onRemove={() => multiRemoveItem(item.id)}
                  onCategoryChange={(cat) => multiSetItemCategory(item.id, cat)}
                  onMetaChange={(patch) => multiSetItemMeta(item.id, patch)}
                />
              ))}
              <button
                onClick={() => addMoreRef.current?.click()}
                className="mcap__card mcap__card--add"
              >
                <span className="mcap__thumb-add-icon">+</span>
                <span className="mcap__thumb-add-label">Add more files</span>
              </button>
            </div>

            <input
              ref={addMoreRef}
              type="file"
              accept="image/*,.pdf"
              multiple
              onChange={(e) => handleFilePick(e, addMoreRef.current)}
              style={{ display: "none" }}
            />

            <div className="mcap__actions mcap__actions--sticky">
              <button onClick={multiReset} className="mcap__action mcap__action--cancel">
                ✕ Discard
              </button>
              <button
                onClick={multiSaveAll}
                disabled={!canSave}
                className={`mcap__action mcap__action--save ${!canSave ? "mcap__action--disabled" : ""}`}
                title={
                  missingCategory > 0
                    ? `Pick a category for ${missingCategory} file${missingCategory === 1 ? "" : "s"}`
                    : ""
                }
              >
                💾 Save {items.length} File{items.length === 1 ? "" : "s"}
                {missingCategory > 0 ? ` (${missingCategory} need category)` : ""}
              </button>
            </div>
          </div>
        )}

        {step === "saving" && (
          <div className="mcap__saving">
            <div className="mcap__saving-icon">💾</div>
            <div className="mcap__saving-title">Saving files…</div>
            <div className="mcap__saving-sub">
              {saveProgress.done} of {saveProgress.total}
              {saveProgress.currentLabel ? ` · ${saveProgress.currentLabel}` : ""}
            </div>
            <div className="mcap__progress">
              <div
                className="mcap__progress-bar"
                style={{
                  width: `${saveProgress.total ? (saveProgress.done / saveProgress.total) * 100 : 0}%`,
                }}
              />
            </div>
          </div>
        )}

        {previewItem && (
          <div className="mcap__preview-modal" onClick={() => setPreviewItem(null)}>
            <div className="mcap__preview-box" onClick={(e) => e.stopPropagation()}>
              <div className="mcap__preview-header">
                <div className="mcap__preview-title">{previewItem.fileName}</div>
                <button
                  type="button"
                  onClick={() => setPreviewItem(null)}
                  className="mcap__preview-close"
                  aria-label="Close preview"
                >
                  ✕
                </button>
              </div>
              <div className="mcap__preview-body">
                {previewItem.mediaType === "application/pdf" ? (
                  <iframe
                    src={previewItem.preview}
                    title={previewItem.fileName}
                    className="mcap__preview-pdf"
                  />
                ) : (
                  <img
                    src={previewItem.preview}
                    alt={previewItem.fileName}
                    className="mcap__preview-img"
                  />
                )}
              </div>
            </div>
          </div>
        )}

        {step === "done" && (
          <div className="mcap__done">
            <div className="mcap__done-icon">✅</div>
            <div className="mcap__done-title">
              Saved {items.filter((it) => it.status === "saved").length} file
              {items.filter((it) => it.status === "saved").length === 1 ? "" : "s"}
            </div>
            <div className="mcap__done-sub">
              Extraction is running in the background. Results appear on the patient record as each
              file finishes.
            </div>
            <div className="mcap__actions">
              <button
                onClick={() => {
                  multiReset();
                  navigate(`/companion/record/${id}`);
                }}
                className="mcap__action mcap__action--primary"
              >
                👤 View Patient
              </button>
              <button onClick={() => multiReset()} className="mcap__action mcap__action--cancel">
                📤 Upload More
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function ItemCard({ item, onOpen, onRemove, onCategoryChange, onMetaChange }) {
  const meta = item.meta || {};
  const isRx = item.category === "prescription";
  const needsCategory = !item.category;

  return (
    <div className={`mcap__card ${needsCategory ? "mcap__card--needs-cat" : ""}`}>
      <div className="mcap__card-top">
        <button type="button" onClick={onOpen} className="mcap__card-thumb" title="Tap to preview">
          {item.mediaType === "application/pdf" ? (
            <div className="mcap__thumb-pdf">
              <div className="mcap__thumb-pdf-icon">📄</div>
              <div className="mcap__thumb-pdf-label">PDF</div>
            </div>
          ) : (
            <img src={item.preview} alt="" className="mcap__thumb-img" />
          )}
        </button>
        <div className="mcap__card-head">
          <div className="mcap__card-name" title={item.fileName}>
            {item.fileName}
          </div>
          <button type="button" className="mcap__thumb-remove" onClick={onRemove} title="Remove">
            ✕
          </button>
        </div>
      </div>

      <div className="mcap__card-row">
        <label className="mcap__card-label">Category</label>
        <select
          className="mcap__card-select"
          value={item.category || ""}
          onChange={(e) => onCategoryChange(e.target.value || null)}
        >
          <option value="" disabled>
            {item.classifying ? "Classifying…" : "Select category"}
          </option>
          {docCategories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </select>
      </div>

      <div className="mcap__card-grid">
        <input
          type="date"
          value={meta.date || ""}
          onChange={(e) => onMetaChange({ date: e.target.value })}
          className="mcap__card-input"
          placeholder="Date"
        />
        <input
          value={meta.hospital || ""}
          onChange={(e) => onMetaChange({ hospital: e.target.value })}
          className="mcap__card-input"
          placeholder={isRx ? "Hospital" : "Lab name"}
        />
        {isRx && (
          <>
            <input
              value={meta.doctor || ""}
              onChange={(e) => onMetaChange({ doctor: e.target.value })}
              className="mcap__card-input"
              placeholder="Doctor"
            />
            <input
              value={meta.specialty || ""}
              onChange={(e) => onMetaChange({ specialty: e.target.value })}
              className="mcap__card-input"
              placeholder="Specialty"
            />
          </>
        )}
      </div>
    </div>
  );
}
