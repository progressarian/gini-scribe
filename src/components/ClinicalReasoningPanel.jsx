import useRxReviewStore from "../stores/rxReviewStore";
import usePatientStore from "../stores/patientStore";
import { CONDITIONS_LIST } from "../config/conditions";

const REASONING_TAGS = [
  "dose_adjustment",
  "new_medication",
  "medication_switch",
  "lifestyle_change",
  "referral",
  "investigation_ordered",
  "de-escalation",
  "protocol_deviation",
];

export default function ClinicalReasoningPanel() {
  const dbPatientId = usePatientStore((s) => s.dbPatientId);
  const crExpanded = useRxReviewStore((s) => s.crExpanded);
  const crText = useRxReviewStore((s) => s.crText);
  const crCondition = useRxReviewStore((s) => s.crCondition);
  const crTags = useRxReviewStore((s) => s.crTags);
  const crSaving = useRxReviewStore((s) => s.crSaving);
  const crSaved = useRxReviewStore((s) => s.crSaved);
  const crRecording = useRxReviewStore((s) => s.crRecording);
  const crAudioBlob = useRxReviewStore((s) => s.crAudioBlob);
  const crAudioUrl = useRxReviewStore((s) => s.crAudioUrl);
  const crTranscribing = useRxReviewStore((s) => s.crTranscribing);
  const setCrExpanded = useRxReviewStore((s) => s.setCrExpanded);
  const setCrText = useRxReviewStore((s) => s.setCrText);
  const setCrCondition = useRxReviewStore((s) => s.setCrCondition);
  const setCrTags = useRxReviewStore((s) => s.setCrTags);
  const saveClinicalReasoning = useRxReviewStore((s) => s.saveClinicalReasoning);
  const startCrRecording = useRxReviewStore((s) => s.startCrRecording);
  const stopCrRecording = useRxReviewStore((s) => s.stopCrRecording);

  return (
    <div
      className="no-print"
      style={{
        marginTop: 12,
        border: `2px solid ${crSaved ? "#059669" : "#0ea5e9"}`,
        borderRadius: 10,
        overflow: "hidden",
      }}
    >
      <div
        onClick={() => setCrExpanded(!crExpanded)}
        style={{
          background: crSaved
            ? "linear-gradient(135deg,#059669,#10b981)"
            : "linear-gradient(135deg,#0ea5e9,#0284c7)",
          color: "white",
          padding: "8px 12px",
          cursor: "pointer",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ fontSize: 14 }}>🧠</span>
          <span style={{ fontWeight: 700, fontSize: 12 }}>Clinical Reasoning</span>
          {crSaved && (
            <span
              style={{
                fontSize: 9,
                background: "rgba(255,255,255,.25)",
                padding: "1px 8px",
                borderRadius: 8,
              }}
            >
              ✅ Saved
            </span>
          )}
        </div>
        <span style={{ fontSize: 11, opacity: 0.8 }}>{crExpanded ? "▲" : "▼ Capture why"}</span>
      </div>

      {crExpanded && (
        <div style={{ padding: 12, background: "#f0f9ff" }}>
          {/* Condition selector */}
          <div style={{ marginBottom: 8 }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: "#0c4a6e", marginBottom: 4 }}>
              Primary Condition
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
              {CONDITIONS_LIST.map((c) => (
                <button
                  key={c}
                  onClick={() => setCrCondition(c)}
                  style={{
                    fontSize: 9,
                    padding: "3px 8px",
                    borderRadius: 8,
                    border: `1px solid ${crCondition === c ? "#0ea5e9" : "#e2e8f0"}`,
                    background: crCondition === c ? "#e0f2fe" : "white",
                    color: crCondition === c ? "#0369a1" : "#64748b",
                    cursor: "pointer",
                    fontWeight: 600,
                  }}
                >
                  {c}
                </button>
              ))}
            </div>
          </div>

          {/* Reasoning text */}
          <textarea
            value={crText}
            onChange={(e) => setCrText(e.target.value)}
            rows={4}
            placeholder="Why did you make these treatment decisions? What factors influenced dosage, drug choice, or lifestyle recommendations?"
            style={{
              width: "100%",
              border: "1px solid #bae6fd",
              borderRadius: 8,
              padding: 10,
              fontSize: 12,
              marginBottom: 8,
              resize: "vertical",
              boxSizing: "border-box",
              lineHeight: 1.5,
            }}
          />

          {/* Audio recording */}
          <div style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 8 }}>
            {!crRecording ? (
              <button
                onClick={startCrRecording}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 4,
                  background: "#dc2626",
                  color: "white",
                  border: "none",
                  padding: "6px 12px",
                  borderRadius: 6,
                  fontSize: 11,
                  fontWeight: 700,
                  cursor: "pointer",
                }}
              >
                🎙️ Record Reasoning
              </button>
            ) : (
              <button
                onClick={stopCrRecording}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 4,
                  background: "#1e293b",
                  color: "white",
                  border: "none",
                  padding: "6px 12px",
                  borderRadius: 6,
                  fontSize: 11,
                  fontWeight: 700,
                  cursor: "pointer",
                  animation: "pulse 1.5s infinite",
                }}
              >
                ⏹️ Stop Recording
              </button>
            )}
            {crAudioUrl && <audio src={crAudioUrl} controls style={{ height: 30, flex: 1 }} />}
            {crAudioBlob && !crAudioUrl && (
              <span style={{ fontSize: 10, color: "#059669" }}>🎵 Audio ready</span>
            )}
            {crTranscribing && (
              <span style={{ fontSize: 10, color: "#0ea5e9", fontWeight: 600 }}>
                ⏳ Transcribing...
              </span>
            )}
          </div>

          {/* Reasoning tags */}
          <div style={{ marginBottom: 8 }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: "#0c4a6e", marginBottom: 4 }}>
              Decision Tags
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
              {REASONING_TAGS.map((tag) => (
                <button
                  key={tag}
                  onClick={() =>
                    setCrTags((prev) =>
                      prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag],
                    )
                  }
                  style={{
                    fontSize: 9,
                    padding: "3px 8px",
                    borderRadius: 8,
                    border: `1px solid ${crTags.includes(tag) ? "#0ea5e9" : "#e2e8f0"}`,
                    background: crTags.includes(tag) ? "#e0f2fe" : "white",
                    color: crTags.includes(tag) ? "#0369a1" : "#64748b",
                    cursor: "pointer",
                    fontWeight: 600,
                  }}
                >
                  {tag.replace(/_/g, " ")}
                </button>
              ))}
            </div>
          </div>

          {/* Save button */}
          {!crSaved ? (
            <button
              onClick={saveClinicalReasoning}
              disabled={crSaving || (!crText && !crAudioBlob)}
              style={{
                width: "100%",
                background: crSaving ? "#94a3b8" : crText || crAudioBlob ? "#0ea5e9" : "#cbd5e1",
                color: "white",
                border: "none",
                padding: "10px",
                borderRadius: 8,
                fontSize: 12,
                fontWeight: 700,
                cursor: crSaving || (!crText && !crAudioBlob) ? "not-allowed" : "pointer",
              }}
            >
              {crSaving
                ? "⏳ Saving..."
                : dbPatientId
                  ? "🧠 Save Clinical Reasoning"
                  : "🧠 Save Reasoning (standalone)"}
            </button>
          ) : (
            <div
              style={{
                textAlign: "center",
                padding: 6,
                fontSize: 11,
                fontWeight: 700,
                color: "#059669",
              }}
            >
              ✅ Clinical reasoning saved
              {!dbPatientId
                ? " (standalone — will link when patient is created)"
                : " — captured for AI training"}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
