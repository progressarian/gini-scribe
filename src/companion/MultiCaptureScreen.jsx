import "./MultiCaptureScreen.css";
import { useRef, useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import useCompanionStore from "../stores/companionStore";
import { docCategories } from "./constants";
import MismatchReviewModal from "../components/companion/MismatchReviewModal.jsx";
import PdfViewerModal from "../components/visit/PdfViewerModal.jsx";

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
    pendingExtractions,
    acceptMismatchedExtraction,
    rejectMismatchedExtraction,
  } = useCompanionStore();

  const [mismatchReview, setMismatchReview] = useState(null);
  // Holds { item, blobUrl }. Chromium blocks data: URIs for PDF in iframes,
  // so we convert the item's data URI to a blob URL before passing it to the
  // viewer modal.
  const [viewingItem, setViewingItem] = useState(null);

  const { step, items, error, saveProgress } = multiCapture;

  useEffect(() => {
    if (id && !selectedPatient) loadPatientData(parseInt(id, 10));
  }, [id]);

  useEffect(() => {
    return () => multiReset();
  }, []);

  // Revoke the preview blob URL when the modal closes or the component unmounts.
  useEffect(() => {
    const url = viewingItem?.blobUrl;
    if (!url) return;
    return () => URL.revokeObjectURL(url);
  }, [viewingItem?.blobUrl]);

  const openViewingItem = (item) => {
    try {
      const base64 = item.base64 || (item.preview || "").split(",")[1];
      const mediaType = item.mediaType || "application/octet-stream";
      if (!base64) return;
      const bin = atob(base64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const blob = new Blob([bytes], { type: mediaType });
      const blobUrl = URL.createObjectURL(blob);
      setViewingItem({ item, blobUrl });
    } catch (e) {
      console.warn("Preview failed:", e);
    }
  };

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
                  pending={item.docId ? pendingExtractions[item.docId] : null}
                  onOpen={() => openViewingItem(item)}
                  onRemove={() => multiRemoveItem(item.id)}
                  onCategoryChange={(cat) => multiSetItemCategory(item.id, cat)}
                  onMetaChange={(patch) => multiSetItemMeta(item.id, patch)}
                  onAccept={() =>
                    setMismatchReview({
                      action: "accept",
                      docId: item.docId,
                      fileName: item.fileName,
                      category: item.category,
                      mismatch: pendingExtractions[item.docId]?.mismatch,
                    })
                  }
                  onReject={() =>
                    setMismatchReview({
                      action: "reject",
                      docId: item.docId,
                      fileName: item.fileName,
                      category: item.category,
                      mismatch: pendingExtractions[item.docId]?.mismatch,
                    })
                  }
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

        {viewingItem && (
          <PdfViewerModal
            src={{
              url: viewingItem.blobUrl,
              mimeType: viewingItem.item.mediaType || "application/pdf",
              fileName: viewingItem.item.fileName,
              title: viewingItem.item.fileName,
            }}
            onClose={() => setViewingItem(null)}
          />
        )}

        {mismatchReview && (
          <MismatchReviewModal
            action={mismatchReview.action}
            fileName={mismatchReview.fileName}
            category={mismatchReview.category}
            mismatch={mismatchReview.mismatch}
            selectedPatient={selectedPatient}
            onClose={() => setMismatchReview(null)}
            onConfirm={async () => {
              if (mismatchReview.action === "accept") {
                await acceptMismatchedExtraction(mismatchReview.docId);
              } else {
                await rejectMismatchedExtraction(mismatchReview.docId);
              }
              setMismatchReview(null);
            }}
          />
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

function ItemCard({
  item,
  pending,
  onOpen,
  onRemove,
  onCategoryChange,
  onMetaChange,
  onAccept,
  onReject,
}) {
  const meta = item.meta || {};
  const isRx = item.category === "prescription";
  const needsCategory = !item.category;
  const isMismatch = pending?.status === "mismatch";

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
      {item.classifyError && !item.category && !item.classifying && (
        <div
          style={{
            fontSize: 11,
            color: "#b45309",
            padding: "2px 4px 6px",
          }}
        >
          ⚠️ Couldn't auto-detect — please pick one
        </div>
      )}
      {isMismatch && pending?.mismatch && (
        <div
          style={{
            marginTop: 8,
            padding: "8px 10px",
            border: "1px solid var(--red-bd, #fecaca)",
            background: "var(--red-lt, #fef2f2)",
            borderRadius: 8,
            fontSize: 12,
            color: "var(--red, #991b1b)",
          }}
        >
          <div style={{ fontWeight: 700, marginBottom: 4 }}>
            ⚠️ Patient mismatch —{" "}
            {pending.mismatch.mismatchedFields?.includes("name") ? "name" : ""}
            {pending.mismatch.mismatchedFields?.length > 1 ? " & " : ""}
            {pending.mismatch.mismatchedFields?.includes("id") ? "id" : ""}
          </div>
          <div style={{ fontSize: 11, marginBottom: 6 }}>
            Doc: {pending.mismatch.reportName || "—"}
            {pending.mismatch.reportId ? ` · #${pending.mismatch.reportId}` : ""}
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            <button
              type="button"
              onClick={onAccept}
              style={{
                flex: 1,
                padding: "6px 10px",
                background: "#16a34a",
                color: "#fff",
                border: 0,
                borderRadius: 6,
                fontSize: 12,
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              ✅ Accept
            </button>
            <button
              type="button"
              onClick={onReject}
              style={{
                flex: 1,
                padding: "6px 10px",
                background: "var(--red, #dc2626)",
                color: "#fff",
                border: 0,
                borderRadius: 6,
                fontSize: 12,
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              🗑️ Reject
            </button>
          </div>
        </div>
      )}

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

      <button
        type="button"
        onClick={onRemove}
        style={{
          marginTop: 10,
          width: "100%",
          padding: "8px 12px",
          border: "1px solid #fecaca",
          background: "#fef2f2",
          color: "#b91c1c",
          borderRadius: 8,
          fontSize: 13,
          fontWeight: 600,
          cursor: "pointer",
        }}
      >
        🗑️ Remove Doc
      </button>
    </div>
  );
}
