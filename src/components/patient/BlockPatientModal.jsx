import { useState } from "react";
import { BLOCK_REASONS, NOTE_REQUIRED_REASON } from "../../../shared/patientBlockReasons.js";
import { useBlockPatient } from "../../queries/hooks/usePatientBlocks";

// Admin-only. Blocking is a consequential, hard-to-notice action, so the modal
// states in plain words exactly what it will do before the button is live.
export default function BlockPatientModal({ patient, onClose, onBlocked }) {
  const [reasonCode, setReasonCode] = useState("");
  const [note, setNote] = useState("");
  const block = useBlockPatient();

  const noteRequired = reasonCode === NOTE_REQUIRED_REASON;
  const canSubmit = !!reasonCode && (!noteRequired || note.trim().length > 0);

  const submit = async (e) => {
    e.preventDefault();
    if (!canSubmit || block.isPending) return;
    try {
      await block.mutateAsync({
        patientId: patient.id,
        reason_code: reasonCode,
        note: note.trim() || undefined,
      });
      onBlocked?.();
      onClose?.();
    } catch {
      // error surfaced below from block.error
    }
  };

  return (
    <div style={overlay} role="dialog" aria-modal="true" aria-label="Block patient">
      <form onSubmit={submit} style={panel}>
        <h2 style={{ margin: 0, fontSize: 17, color: "#b91c1c" }}>Block patient</h2>
        <p style={{ margin: "6px 0 0", fontSize: 13, color: "#374151" }}>
          {patient?.name}
          {patient?.file_no ? ` · ${patient.file_no}` : ""}
        </p>

        <label style={label} htmlFor="block-reason">
          Reason
        </label>
        <select
          id="block-reason"
          value={reasonCode}
          onChange={(e) => setReasonCode(e.target.value)}
          style={input}
          required
        >
          <option value="">Select a reason…</option>
          {BLOCK_REASONS.map((r) => (
            <option key={r.value} value={r.value}>
              {r.label}
            </option>
          ))}
        </select>

        <label style={label} htmlFor="block-note">
          Note {noteRequired ? "(required)" : "(optional)"}
        </label>
        <textarea
          id="block-note"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={3}
          style={{ ...input, resize: "vertical" }}
          placeholder="What happened, and when"
          required={noteRequired}
        />

        <p style={consequences}>
          This patient will not be able to book new appointments, will stop receiving SMS / WhatsApp
          / push messages, and will be signed out of the patient app. Staff will see a Blocked badge
          on every screen. Only an administrator can lift this.
        </p>

        {block.isError && (
          <p style={{ color: "#b91c1c", fontSize: 12, margin: "8px 0 0" }}>
            {block.error?.response?.data?.error || "Could not block this patient."}
          </p>
        )}

        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 16 }}>
          <button type="button" onClick={onClose} style={btnGhost}>
            Cancel
          </button>
          <button
            type="submit"
            disabled={!canSubmit || block.isPending}
            style={btnDanger(canSubmit)}
          >
            {block.isPending ? "Blocking…" : "Block patient"}
          </button>
        </div>
      </form>
    </div>
  );
}

const overlay = {
  position: "fixed",
  inset: 0,
  background: "rgba(15,23,42,0.45)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 1000,
  padding: 16,
};

const panel = {
  background: "#fff",
  borderRadius: 12,
  padding: 20,
  width: "100%",
  maxWidth: 440,
  boxShadow: "0 20px 50px rgba(0,0,0,0.25)",
};

const label = {
  display: "block",
  fontSize: 12,
  fontWeight: 600,
  color: "#374151",
  margin: "14px 0 5px",
};

const input = {
  width: "100%",
  padding: "8px 10px",
  fontSize: 13,
  borderRadius: 8,
  border: "1px solid #d1d5db",
  fontFamily: "inherit",
  boxSizing: "border-box",
};

const consequences = {
  margin: "14px 0 0",
  fontSize: 12,
  lineHeight: 1.5,
  color: "#991b1b",
  background: "#fef2f2",
  border: "1px solid #fecaca",
  borderRadius: 8,
  padding: "9px 11px",
};

const btnGhost = {
  padding: "8px 14px",
  fontSize: 13,
  fontWeight: 600,
  borderRadius: 8,
  background: "#fff",
  color: "#374151",
  border: "1px solid #d1d5db",
  cursor: "pointer",
  fontFamily: "inherit",
};

const btnDanger = (enabled) => ({
  padding: "8px 14px",
  fontSize: 13,
  fontWeight: 700,
  borderRadius: 8,
  background: enabled ? "#b91c1c" : "#fca5a5",
  color: "#fff",
  border: "none",
  cursor: enabled ? "pointer" : "not-allowed",
  fontFamily: "inherit",
});
