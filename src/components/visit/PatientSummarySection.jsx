import React, { useEffect, useState } from "react";
import {
  usePatientSummary,
  useSavePatientSummary,
  useGeneratePatientSummary,
} from "../../queries/hooks/usePatientSummary.js";
import useAuthStore from "../../stores/authStore";
import { toast } from "../../stores/uiStore";

const fmtDateTime = (iso) => {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    return d.toLocaleString("en-IN", {
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return String(iso);
  }
};

export default function PatientSummarySection({ patientId, appointmentId, visitPayload }) {
  const conName = useAuthStore((s) => s.conName);
  const moName = useAuthStore((s) => s.moName);
  const authorName = conName || moName || "Doctor";

  const q = usePatientSummary(patientId);
  const saveM = useSavePatientSummary(patientId);
  const genM = useGeneratePatientSummary(patientId);

  const allVersions = q.data?.versions || [];
  // When this section is rendered for a specific appointment, scope versions
  // to that appointment so the visit has its own pinned summary. Without an
  // appointment context we show all versions — this also covers
  // manually-saved summaries that have a null appointment_id.
  const versions = appointmentId
    ? allVersions.filter((v) => Number(v.appointment_id) === Number(appointmentId))
    : allVersions;
  const current = versions[0] || null;

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [showHistory, setShowHistory] = useState(false);

  useEffect(() => {
    if (editing) setDraft(current?.content || "");
  }, [editing, current]);

  if (!patientId) return null;

  const onGenerate = async () => {
    if (!visitPayload) {
      toast("Visit data not loaded yet — try again in a moment", "error");
      return;
    }
    try {
      await genM.mutateAsync({ ...visitPayload, appointment_id: appointmentId });
      toast("Patient summary generated", "success");
    } catch (err) {
      toast(`AI generation failed: ${err.message}`, "error");
    }
  };

  const onSave = async () => {
    const text = (draft || "").trim();
    if (!text) return;
    if (current && text === current.content) {
      setEditing(false);
      return;
    }
    await saveM.mutateAsync({
      content: text,
      change_note: "Manual edit",
      appointment_id: appointmentId || null,
      author_name: authorName,
    });
    setEditing(false);
  };

  return (
    <div
      id="summary-patient"
      style={{
        background: "#fff",
        border: "1px solid #e2e8f0",
        borderRadius: 10,
        padding: 14,
        marginBottom: 14,
        boxShadow: "0 1px 3px rgba(0,0,0,.05)",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 10,
          flexWrap: "wrap",
          gap: 8,
          rowGap: 6,
        }}
      >
        <div style={{ minWidth: 0, lineHeight: 1.25 }}>
          <div
            style={{
              fontWeight: 700,
              fontSize: 14,
              color: "#0f172a",
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              flexWrap: "wrap",
            }}
          >
            <span>💬 Patient Summary</span>
            <span
              title="This is what prints on the prescription — written for the patient in plain language"
              style={{
                fontSize: 9,
                fontWeight: 800,
                letterSpacing: ".06em",
                textTransform: "uppercase",
                color: "#0d9488",
                background: "#ccfbf1",
                padding: "1px 6px",
                borderRadius: 4,
                whiteSpace: "nowrap",
              }}
            >
              Prints on Rx
            </span>
          </div>
          <div style={{ fontSize: 11, color: "#64748b", marginTop: 2, lineHeight: 1.3 }}>
            {current
              ? `v${current.version} · ${fmtDateTime(current.created_at)}${
                  current.author_name ? ` · ${current.author_name}` : ""
                }`
              : "No patient summary for this visit yet — click Generate"}
          </div>
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {versions.length > 1 && (
            <button
              onClick={() => setShowHistory((v) => !v)}
              style={{
                padding: "6px 12px",
                borderRadius: 6,
                border: "1px solid #cbd5e1",
                background: showHistory ? "#eef2ff" : "#fff",
                fontSize: 11,
                fontWeight: 600,
                cursor: "pointer",
                color: "#334155",
              }}
            >
              🕘 History ({versions.length})
            </button>
          )}
          {!editing && (
            <button
              onClick={onGenerate}
              disabled={genM.isPending}
              title="Generate (or update) the patient-facing summary using AI"
              style={{
                padding: "6px 14px",
                borderRadius: 6,
                border: "1px solid #6d28d9",
                background: genM.isPending ? "#a78bfa" : "#7c3aed",
                color: "#fff",
                fontSize: 11,
                fontWeight: 700,
                cursor: genM.isPending ? "wait" : "pointer",
              }}
            >
              {genM.isPending ? "✨ Generating…" : current ? "🔄 Update with AI" : "✨ Generate"}
            </button>
          )}
          {!editing && current && (
            <button
              onClick={() => setEditing(true)}
              style={{
                padding: "6px 14px",
                borderRadius: 6,
                border: "1px solid #009e8c",
                background: "#fff",
                color: "#009e8c",
                fontSize: 11,
                fontWeight: 700,
                cursor: "pointer",
              }}
            >
              ✏️ Edit
            </button>
          )}
        </div>
      </div>

      {q.isError && (
        <div
          style={{
            background: "#fef2f2",
            border: "1px solid #fecaca",
            color: "#b91c1c",
            padding: 8,
            borderRadius: 6,
            fontSize: 12,
            marginBottom: 8,
          }}
        >
          {q.error?.message || "Failed to load patient summary"}
        </div>
      )}

      {editing ? (
        <div>
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={6}
            placeholder="Write the patient-facing summary — plain, simple, in the patient's language…"
            style={{
              width: "100%",
              padding: 10,
              borderRadius: 6,
              border: "1px solid #cbd5e1",
              fontSize: 13,
              fontFamily: "inherit",
              lineHeight: 1.5,
              resize: "vertical",
              boxSizing: "border-box",
            }}
          />
          <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
            <button
              onClick={onSave}
              disabled={saveM.isPending || !(draft || "").trim()}
              style={{
                padding: "7px 16px",
                borderRadius: 6,
                border: "none",
                background: saveM.isPending || !(draft || "").trim() ? "#94a3b8" : "#009e8c",
                color: "#fff",
                fontSize: 12,
                fontWeight: 700,
                cursor: saveM.isPending ? "wait" : "pointer",
              }}
            >
              {saveM.isPending
                ? "Saving…"
                : current
                  ? `Save as v${(current.version || 0) + 1}`
                  : "Save v1"}
            </button>
            <button
              onClick={() => {
                setEditing(false);
                setDraft("");
              }}
              disabled={saveM.isPending}
              style={{
                padding: "7px 14px",
                borderRadius: 6,
                border: "1px solid #cbd5e1",
                background: "#fff",
                fontSize: 12,
                fontWeight: 600,
                cursor: "pointer",
                color: "#475569",
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : current ? (
        <div
          style={{
            background: "#fafbfc",
            padding: 10,
            borderRadius: 6,
            border: "1px solid #eef2f6",
          }}
        >
          {(current.heading_greeting || current.heading_accent) && (
            <div
              style={{
                fontFamily:
                  '"Fraunces", "Source Serif Pro", Georgia, serif',
                fontSize: 18,
                lineHeight: 1.25,
                color: "#0f172a",
                marginBottom: 8,
                paddingBottom: 8,
                borderBottom: "1px dashed #e2e8f0",
              }}
              title="This is the heading the patient sees in the Genie app"
            >
              {(current.heading_greeting || "").replace(/[,\s]+$/, "")}
              {current.heading_accent ? (
                <>
                  {" — "}
                  <span style={{ fontStyle: "italic", color: "#b45309" }}>
                    {current.heading_accent}
                  </span>
                </>
              ) : null}
            </div>
          )}
          <div
            style={{
              whiteSpace: "pre-wrap",
              fontSize: 13,
              color: "#1e293b",
              lineHeight: 1.6,
            }}
          >
            {current.content}
          </div>
        </div>
      ) : (
        <div
          style={{
            fontSize: 13,
            color: "#94a3b8",
            fontStyle: "italic",
            padding: "8px 10px",
            background: "#fafbfc",
            border: "1px dashed #e2e8f0",
            borderRadius: 6,
          }}
        >
          No patient summary yet. Click "Generate" to create one — it will print on the
          prescription.
        </div>
      )}

      {showHistory && versions.length > 1 && (
        <div style={{ marginTop: 12, borderTop: "1px solid #e2e8f0", paddingTop: 10 }}>
          <div style={{ fontWeight: 700, fontSize: 12, color: "#334155", marginBottom: 8 }}>
            Earlier versions
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {versions.slice(1).map((v) => (
              <div
                key={v.id}
                style={{
                  border: "1px solid #e2e8f0",
                  borderRadius: 6,
                  background: "#fff",
                  padding: "8px 10px",
                }}
              >
                <div style={{ fontSize: 11, color: "#64748b", marginBottom: 4 }}>
                  v{v.version} · {fmtDateTime(v.created_at)}
                  {v.author_name ? ` · ${v.author_name}` : ""}
                  {v.source ? ` · ${v.source}` : ""}
                </div>
                <div
                  style={{
                    fontSize: 12,
                    color: "#1f2937",
                    whiteSpace: "pre-wrap",
                    lineHeight: 1.55,
                  }}
                >
                  {v.content}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
