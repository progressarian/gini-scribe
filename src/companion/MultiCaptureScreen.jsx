import "./MultiCaptureScreen.css";
import { useRef, useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import useCompanionStore from "../stores/companionStore";
import { docCategories, fDate } from "./constants";

const CATEGORY_ICON = {
  prescription: "💊",
  blood_test: "🩸",
  thyroid: "🦋",
  lipid: "🫀",
  kidney: "🫘",
  hba1c: "📊",
  urine: "🧪",
  xray: "🩻",
  usg: "📡",
  mri: "🧲",
  dexa: "🦴",
  ecg: "💓",
  ncs: "⚡",
  eye: "👁️",
  other: "📄",
};

const STATUS_CHIP = {
  pending: { label: "Queued", color: "#94a3b8" },
  classifying: { label: "Classifying…", color: "#f59e0b" },
  classified: { label: "Classified", color: "#2563eb" },
  extracting: { label: "Reading…", color: "#7c3aed" },
  extracted: { label: "Ready", color: "#059669" },
  saving: { label: "Saving…", color: "#f59e0b" },
  saved: { label: "Saved", color: "#059669" },
  failed: { label: "Failed", color: "#dc2626" },
};

function getCategoryLabel(catId) {
  const c = docCategories.find((x) => x.id === catId);
  return c?.label || catId;
}

function getCategoryColor(catId) {
  const c = docCategories.find((x) => x.id === catId);
  return c?.color || "#64748b";
}

function summaryForItem(item) {
  const ext = item.extraction;
  if (!ext) return "";
  if (ext._rawExtraction?.panels?.length) {
    const tests = ext._rawExtraction.panels.reduce((n, p) => n + (p.tests?.length || 0), 0);
    const date = ext.report_date ? fDate(ext.report_date) : "—";
    const lab = ext.lab_name || "Lab";
    return `${lab} · ${date} · ${tests} value${tests === 1 ? "" : "s"}`;
  }
  if (ext.medications?.length) {
    const date = ext.visit_date ? fDate(ext.visit_date) : "";
    const parts = [];
    if (ext.doctor_name) parts.push(ext.doctor_name);
    if (date) parts.push(date);
    parts.push(`${ext.medications.length} med${ext.medications.length === 1 ? "" : "s"}`);
    return parts.join(" · ");
  }
  if (ext.findings) {
    const date = ext.date ? fDate(ext.date) : "";
    return `${date ? date + " · " : ""}${ext.findings.slice(0, 60)}${ext.findings.length > 60 ? "…" : ""}`;
  }
  return "Extracted";
}

function StatusIcon({ status }) {
  const map = {
    pending: "⏳",
    classifying: "🧠",
    classified: "✓",
    extracting: "🔄",
    extracted: "✅",
    saving: "💾",
    saved: "✅",
    failed: "⚠️",
  };
  return <span className="mcap__status-icon">{map[status] || "•"}</span>;
}

export default function MultiCaptureScreen() {
  const { id } = useParams();
  const navigate = useNavigate();
  const {
    selectedPatient,
    multiCapture,
    activeAppointmentId,
    multiHandleFilesSelect,
    multiRemoveItem,
    multiToggleExpand,
    multiClassifyAll,
    multiOverrideCategory,
    multiRetryExtract,
    multiSaveAll,
    multiReset,
    loadPatientData,
  } = useCompanionStore();

  const { step, items, error, saveProgress } = multiCapture;

  useEffect(() => {
    if (id && !selectedPatient) loadPatientData(parseInt(id, 10));
  }, [id]);

  // Cleanup on unmount
  useEffect(() => {
    return () => multiReset();
  }, []);

  const cameraRef = useRef(null);
  const galleryRef = useRef(null);
  const addMoreRef = useRef(null);

  const [overrideOpenFor, setOverrideOpenFor] = useState(null);
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

  // Items savable now: have extraction data, not yet saved successfully.
  const pendingSave = items.filter((it) => it.extraction && it.status !== "saved");
  const savableCount = pendingSave.length;
  const canSave = savableCount > 0;

  return (
    <div className="mcap">
      {/* ── Header ──────────────────────────────────────── */}
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

        {/* ── Step: PICK ─────────────────────────────────── */}
        {step === "pick" && (
          <div>
            <div className="mcap__pick-title">
              Upload multiple reports — we'll classify & extract each automatically
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
              ✨ Supports lab reports, prescriptions, X-rays, ECG, and more.
              <br />
              Each image is automatically classified and routed to the right section.
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

        {/* ── Step: PREVIEW ──────────────────────────────── */}
        {step === "preview" && (
          <div>
            <div className="mcap__section-title">
              {items.length} file{items.length === 1 ? "" : "s"} selected
            </div>
            <div className="mcap__grid">
              {items.map((item) => (
                <div key={item.id} className="mcap__thumb">
                  <button
                    type="button"
                    onClick={() => setPreviewItem(item)}
                    className="mcap__thumb-open"
                    title="Tap to preview"
                  >
                    {item.mediaType === "application/pdf" ? (
                      <div className="mcap__thumb-pdf">
                        <div className="mcap__thumb-pdf-icon">📄</div>
                        <div className="mcap__thumb-pdf-label">PDF</div>
                        <div className="mcap__thumb-pdf-hint">Tap to preview</div>
                      </div>
                    ) : (
                      <img src={item.preview} alt="" className="mcap__thumb-img" />
                    )}
                  </button>
                  <button
                    type="button"
                    className="mcap__thumb-remove"
                    onClick={() => multiRemoveItem(item.id)}
                    title="Remove"
                  >
                    ✕
                  </button>
                  <div className="mcap__thumb-name">{item.fileName}</div>
                </div>
              ))}
              <button
                onClick={() => addMoreRef.current?.click()}
                className="mcap__thumb mcap__thumb--add"
              >
                <span className="mcap__thumb-add-icon">+</span>
                <span className="mcap__thumb-add-label">Add more</span>
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
              <button onClick={multiClassifyAll} className="mcap__action mcap__action--primary">
                🧠 Classify & Extract →
              </button>
            </div>
          </div>
        )}

        {/* ── Step: CLASSIFYING / EXTRACTING ─────────────── */}
        {(step === "classifying" || step === "extracting") && (
          <div>
            <div className="mcap__process-header">
              <div className="mcap__process-icon">{step === "classifying" ? "🧠" : "🔬"}</div>
              <div className="mcap__process-title">
                {step === "classifying"
                  ? "Identifying document types..."
                  : "Extracting data from each document..."}
              </div>
              <div className="mcap__process-sub">
                {step === "classifying"
                  ? "Fast classification with AI"
                  : "Reading panels, medications, findings"}
              </div>
            </div>
            <div className="mcap__process-list">
              {items.map((item) => {
                const chip = STATUS_CHIP[item.status] || STATUS_CHIP.pending;
                return (
                  <div key={item.id} className="mcap__process-row">
                    {item.mediaType === "application/pdf" ? (
                      <div className="mcap__process-thumb mcap__process-thumb--pdf">📄</div>
                    ) : (
                      <img src={item.preview} alt="" className="mcap__process-thumb" />
                    )}
                    <div className="mcap__process-info">
                      <div className="mcap__process-name">{item.fileName}</div>
                      <div className="mcap__process-meta">
                        {item.category ? (
                          <>
                            {CATEGORY_ICON[item.category] || "📄"}{" "}
                            {getCategoryLabel(item.category).replace(/^[^\s]+\s/, "")}
                          </>
                        ) : (
                          "—"
                        )}
                      </div>
                    </div>
                    <div
                      className="mcap__process-chip"
                      style={{ color: chip.color, borderColor: chip.color }}
                    >
                      <StatusIcon status={item.status} />
                      {chip.label}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* ── Step: REVIEW ───────────────────────────────── */}
        {step === "review" && (
          <div>
            <div className="mcap__section-title">
              Review {items.length} document{items.length === 1 ? "" : "s"}
            </div>
            <div className="mcap__review-list">
              {items.map((item) => {
                const chip = STATUS_CHIP[item.status] || STATUS_CHIP.pending;
                const catColor = getCategoryColor(item.category);
                const catLabel = getCategoryLabel(item.category).replace(/^[^\s]+\s/, "");
                const lowConf = item.classification && item.classification.confidence < 0.6;
                const overrideOpen = overrideOpenFor === item.id;

                return (
                  <div key={item.id} className="mcap__review-row">
                    <div className="mcap__review-head" onClick={() => multiToggleExpand(item.id)}>
                      {item.mediaType === "application/pdf" ? (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setPreviewItem(item);
                          }}
                          className="mcap__review-thumb mcap__review-thumb--pdf mcap__review-thumb--btn"
                          title="Preview PDF"
                        >
                          📄
                        </button>
                      ) : (
                        <img
                          src={item.preview}
                          alt=""
                          className="mcap__review-thumb mcap__review-thumb--btn"
                          onClick={(e) => {
                            e.stopPropagation();
                            setPreviewItem(item);
                          }}
                        />
                      )}
                      <div className="mcap__review-info">
                        <div className="mcap__review-head-top">
                          <span className="mcap__review-cat-chip" style={{ background: catColor }}>
                            {CATEGORY_ICON[item.category] || "📄"} {catLabel}
                          </span>
                          {lowConf && (
                            <span
                              className="mcap__review-warn"
                              title={item.classification?.rationale}
                            >
                              ⚠ Uncertain
                            </span>
                          )}
                          <span
                            className="mcap__review-status"
                            style={{ color: chip.color, borderColor: chip.color }}
                          >
                            <StatusIcon status={item.status} />
                            {chip.label}
                          </span>
                        </div>
                        <div className="mcap__review-summary">
                          {item.extractError ? (
                            <span style={{ color: "#dc2626" }}>⚠ {item.extractError}</span>
                          ) : item.saveError ? (
                            <span style={{ color: "#dc2626" }}>
                              ⚠ Save failed: {item.saveError}
                            </span>
                          ) : (
                            summaryForItem(item)
                          )}
                        </div>
                      </div>
                      <span className="mcap__review-chevron">{item.expanded ? "▲" : "▼"}</span>
                    </div>

                    {item.expanded && (
                      <div className="mcap__review-detail">
                        {/* Category override */}
                        <div className="mcap__detail-row">
                          <label className="mcap__detail-label">Category</label>
                          <div className="mcap__detail-cat">
                            <button
                              className="mcap__detail-cat-btn"
                              onClick={() => setOverrideOpenFor(overrideOpen ? null : item.id)}
                            >
                              {CATEGORY_ICON[item.category] || "📄"} {catLabel}
                              <span className="mcap__detail-cat-caret">
                                {overrideOpen ? "▲" : "▼"}
                              </span>
                            </button>
                            {overrideOpen && (
                              <div className="mcap__detail-cat-grid">
                                {docCategories.map((c) => (
                                  <button
                                    key={c.id}
                                    onClick={() => {
                                      setOverrideOpenFor(null);
                                      if (c.id !== item.category) {
                                        multiOverrideCategory(item.id, c.id);
                                      }
                                    }}
                                    className="mcap__detail-cat-option"
                                    style={{
                                      background: c.id === item.category ? c.color : "white",
                                      color: c.id === item.category ? "white" : c.color,
                                      borderColor: c.id === item.category ? c.color : "#e2e8f0",
                                    }}
                                  >
                                    {c.label}
                                  </button>
                                ))}
                              </div>
                            )}
                          </div>
                        </div>

                        {/* Extracted details */}
                        {item.extraction && !item.extractError && (
                          <ExtractionDetail extraction={item.extraction} />
                        )}

                        {/* Row actions */}
                        <div className="mcap__detail-actions">
                          {(item.status === "failed" || item.status === "extracted") && (
                            <button
                              onClick={() => multiRetryExtract(item.id)}
                              className="mcap__detail-action mcap__detail-action--retry"
                            >
                              🔄 Re-extract
                            </button>
                          )}
                          <button
                            onClick={() => multiRemoveItem(item.id)}
                            className="mcap__detail-action mcap__detail-action--remove"
                          >
                            ✕ Remove
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            <div className="mcap__actions mcap__actions--sticky">
              <button onClick={multiReset} className="mcap__action mcap__action--cancel">
                ✕ Discard
              </button>
              <button
                onClick={multiSaveAll}
                disabled={!canSave}
                className={`mcap__action mcap__action--save ${!canSave ? "mcap__action--disabled" : ""}`}
              >
                💾 Save {savableCount} Document{savableCount === 1 ? "" : "s"}
              </button>
            </div>
          </div>
        )}

        {/* ── Step: SAVING ───────────────────────────────── */}
        {step === "saving" && (
          <div className="mcap__saving">
            <div className="mcap__saving-icon">💾</div>
            <div className="mcap__saving-title">Saving documents…</div>
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

        {/* ── Preview modal ───────────────────────────────── */}
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

        {/* ── Step: DONE ─────────────────────────────────── */}
        {step === "done" && (
          <div className="mcap__done">
            <div className="mcap__done-icon">✅</div>
            <div className="mcap__done-title">
              Saved {items.filter((it) => it.status === "saved").length} document
              {items.filter((it) => it.status === "saved").length === 1 ? "" : "s"}
            </div>
            <div className="mcap__done-sub">
              Lab values, medications, and documents are in the patient's record.
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

function ExtractionDetail({ extraction }) {
  const ext = extraction;
  const panels = ext._rawExtraction?.panels || [];

  return (
    <div className="mcap__extract">
      {ext.doctor_name && (
        <div className="mcap__extract-doctor">
          🩺 <b>{ext.doctor_name}</b>
          {ext.specialty ? ` · ${ext.specialty}` : ""}
          {ext.hospital_name ? ` · ${ext.hospital_name}` : ""}
        </div>
      )}
      {ext.lab_name && !ext.doctor_name && (
        <div className="mcap__extract-doctor">
          🔬 <b>{ext.lab_name}</b>
        </div>
      )}
      {(ext.report_date || ext.visit_date || ext.date) && (
        <div className="mcap__extract-date">
          📅 {fDate(ext.report_date || ext.visit_date || ext.date)}
        </div>
      )}

      {ext.diagnoses?.length > 0 && (
        <div className="mcap__extract-section">
          <div className="mcap__extract-label">DIAGNOSES</div>
          <div className="mcap__extract-dx">
            {ext.diagnoses.map((d, i) => (
              <span key={i} className="mcap__extract-dx-tag">
                {typeof d === "string" ? d : d.label || d.id}
              </span>
            ))}
          </div>
        </div>
      )}

      {ext.medications?.length > 0 && (
        <div className="mcap__extract-section">
          <div className="mcap__extract-label">MEDICATIONS ({ext.medications.length})</div>
          {ext.medications.map((m, i) => (
            <div key={i} className="mcap__extract-med">
              <span className="mcap__extract-med-name">{m.name}</span>
              <span className="mcap__extract-med-detail">
                {m.dose} {m.frequency} {m.timing}
              </span>
            </div>
          ))}
        </div>
      )}

      {panels.length > 0 && (
        <div className="mcap__extract-section">
          <div className="mcap__extract-label">
            LAB VALUES ({panels.reduce((n, p) => n + (p.tests?.length || 0), 0)})
          </div>
          {panels.map((panel, pi) => (
            <div key={pi} className="mcap__extract-panel">
              <div className="mcap__extract-panel-name">{panel.panel_name}</div>
              {(panel.tests || []).map((t, ti) => (
                <div key={ti} className="mcap__extract-test">
                  <span className="mcap__extract-test-name">{t.test_name}</span>
                  <span
                    className="mcap__extract-test-val"
                    style={{
                      color: t.flag === "H" ? "#dc2626" : t.flag === "L" ? "#f59e0b" : "#059669",
                    }}
                  >
                    {t.result ?? t.result_text} {t.unit || ""}
                  </span>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}

      {ext.labs?.length > 0 && panels.length === 0 && (
        <div className="mcap__extract-section">
          <div className="mcap__extract-label">LAB VALUES ({ext.labs.length})</div>
          {ext.labs.map((l, i) => (
            <div key={i} className="mcap__extract-test">
              <span className="mcap__extract-test-name">{l.test_name}</span>
              <span
                className="mcap__extract-test-val"
                style={{
                  color:
                    l.flag === "HIGH" || l.flag === "H"
                      ? "#dc2626"
                      : l.flag === "LOW" || l.flag === "L"
                        ? "#f59e0b"
                        : "#059669",
                }}
              >
                {l.result} {l.unit || ""}
              </span>
            </div>
          ))}
        </div>
      )}

      {ext.findings && (
        <div className="mcap__extract-section">
          <div className="mcap__extract-label">FINDINGS</div>
          <div className="mcap__extract-findings">{ext.findings}</div>
        </div>
      )}

      {ext.classification?.rationale && (
        <div className="mcap__extract-rationale">🧠 {ext.classification.rationale}</div>
      )}
    </div>
  );
}
