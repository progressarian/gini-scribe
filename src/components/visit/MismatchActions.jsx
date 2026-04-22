import { memo } from "react";
import MismatchReviewModal from "../companion/MismatchReviewModal.jsx";
import {
  useMismatchReviewActions,
  parseExtractedData,
} from "../../hooks/useMismatchReviewActions.js";

// Inline Accept / Reject buttons for a mismatch-review document, plus the
// shared confirmation modal. Drop-in replacement for the "review in the
// Companion app" hint on doctor-facing pages (Docs, Visit/docs, Visit/labs).
const MismatchActions = memo(function MismatchActions({ doc, patient, compact = false }) {
  const patientId = patient?.id || doc.patient_id;
  const { review, openReview, closeReview, confirmReview } = useMismatchReviewActions(patientId);

  const ext = parseExtractedData(doc.extracted_data);
  if (ext?.extraction_status !== "mismatch_review") return null;

  const fileName = ext?.file_name || doc.file_name || doc.title;
  const category = ext?.category || doc.doc_type;

  // Normalize patient to the shape MismatchReviewModal expects
  // ({ name, file_no, age, sex }). The doctor-facing store uses `fileNo`.
  const normalizedPatient = patient
    ? {
        id: patient.id || patientId,
        name: patient.name,
        file_no: patient.file_no || patient.fileNo,
        age: patient.age,
        sex: patient.sex,
      }
    : null;

  const stop = (e) => e.stopPropagation();

  return (
    <>
      <div
        onClick={stop}
        style={{
          display: "flex",
          gap: 6,
          marginTop: compact ? 4 : 6,
          flexWrap: "wrap",
        }}
      >
        <button
          type="button"
          onClick={(e) => {
            stop(e);
            openReview(doc, "accept");
          }}
          style={{
            padding: compact ? "4px 10px" : "6px 12px",
            background: "#16a34a",
            color: "#fff",
            border: 0,
            borderRadius: 6,
            fontSize: compact ? 11 : 12,
            fontWeight: 700,
            cursor: "pointer",
          }}
        >
          ✅ Accept
        </button>
        <button
          type="button"
          onClick={(e) => {
            stop(e);
            openReview(doc, "reject");
          }}
          style={{
            padding: compact ? "4px 10px" : "6px 12px",
            background: "#dc2626",
            color: "#fff",
            border: 0,
            borderRadius: 6,
            fontSize: compact ? 11 : 12,
            fontWeight: 700,
            cursor: "pointer",
          }}
        >
          🗑️ Reject
        </button>
      </div>
      {review && (
        <MismatchReviewModal
          action={review.action}
          fileName={fileName}
          category={category}
          mismatch={ext?.mismatch}
          selectedPatient={normalizedPatient}
          onClose={closeReview}
          onConfirm={confirmReview}
        />
      )}
    </>
  );
});

export default MismatchActions;
