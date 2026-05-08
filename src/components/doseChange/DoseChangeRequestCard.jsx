import { useState } from "react";

function fmtTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  const now = new Date();
  const diff = (now - d) / 1000;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "2-digit" });
}

const STATUS_STYLE = {
  pending: { color: "#92400e", bg: "#fef3c7" },
  approved: { color: "#047857", bg: "#d1fae5" },
  rejected: { color: "#b91c1c", bg: "#fee2e2" },
  cancelled: { color: "#475569", bg: "#f1f5f9" },
};

// One request = one medication. Doctor can edit `final_dose` before approving
// (defaults to the patient's requested value) and attach a note (warning/info).
export default function DoseChangeRequestCard({ request: r, onDecide, compact = false }) {
  const [finalDose, setFinalDose] = useState(r.requested_dose || "");
  const [doctorNote, setDoctorNote] = useState("");
  const [rejecting, setRejecting] = useState(false);
  const [rejectReason, setRejectReason] = useState("");
  const [busy, setBusy] = useState(false);

  const status = r.status || "pending";
  const sStyle = STATUS_STYLE[status] || STATUS_STYLE.pending;
  const isPending = status === "pending";

  const submitApprove = async () => {
    if (busy) return;
    setBusy(true);
    await onDecide({
      status: "approved",
      final_dose: finalDose || r.requested_dose,
      doctor_note: doctorNote.trim() || undefined,
    });
    setBusy(false);
  };

  const submitReject = async () => {
    if (busy) return;
    setBusy(true);
    await onDecide({
      status: "rejected",
      reject_reason: rejectReason.trim() || undefined,
      doctor_note: doctorNote.trim() || undefined,
    });
    setBusy(false);
    setRejecting(false);
    setRejectReason("");
  };

  return (
    <div
      style={{
        background: "#fff",
        border: "1px solid #e2e8f0",
        borderRadius: 12,
        padding: compact ? 12 : 14,
        marginBottom: 10,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 10,
          marginBottom: 8,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <span
            style={{
              fontSize: 10,
              fontWeight: 800,
              padding: "2px 8px",
              borderRadius: 999,
              ...sStyle,
            }}
          >
            {status.toUpperCase()}
          </span>
          {!compact && r.patient_name && (
            <span style={{ fontSize: 13, fontWeight: 700, color: "#0f172a" }}>
              {r.patient_name}
            </span>
          )}
          {!compact && r.patient_file_no && (
            <span style={{ fontSize: 11, color: "#64748b" }}>File {r.patient_file_no}</span>
          )}
          <span style={{ fontSize: 11, color: "#64748b" }}>{fmtTime(r.requested_at)}</span>
          {r.initiated_by === "doctor" && (
            <span
              style={{
                fontSize: 9,
                fontWeight: 800,
                padding: "2px 6px",
                borderRadius: 4,
                background: "#ede9fe",
                color: "#6d28d9",
              }}
            >
              DOCTOR
            </span>
          )}
        </div>
      </div>

      <div style={{ fontSize: 14, fontWeight: 700, color: "#0f172a", marginBottom: 6 }}>
        {r.medication_name || "Medication"}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
        <span style={{ fontSize: 12, color: "#64748b" }}>Current</span>
        <span
          style={{
            fontSize: 13,
            fontWeight: 800,
            color: "#0f172a",
            background: "#f1f5f9",
            padding: "3px 8px",
            borderRadius: 6,
          }}
        >
          {r.current_dose || "—"}
          {r.dose_unit ? ` ${r.dose_unit}` : ""}
        </span>
        <span style={{ fontSize: 12, color: "#64748b" }}>→</span>
        <span style={{ fontSize: 12, color: "#64748b" }}>Requested</span>
        <span
          style={{
            fontSize: 13,
            fontWeight: 800,
            color: "#7c3aed",
            background: "#f5f3ff",
            padding: "3px 8px",
            borderRadius: 6,
          }}
        >
          {r.requested_dose}
          {r.dose_unit ? ` ${r.dose_unit}` : ""}
        </span>
      </div>

      {r.patient_reason && (
        <div
          style={{
            fontSize: 12,
            color: "#475569",
            background: "#f8fafc",
            border: "1px solid #e2e8f0",
            borderRadius: 6,
            padding: "6px 10px",
            marginBottom: 8,
          }}
        >
          <strong style={{ fontWeight: 700, color: "#334155" }}>Patient note:</strong>{" "}
          {r.patient_reason}
        </div>
      )}

      {!isPending && r.final_dose && (
        <div style={{ fontSize: 12, color: "#047857", marginBottom: 6 }}>
          Final dose: <strong>{r.final_dose}</strong>
        </div>
      )}
      {!isPending && r.doctor_note && (
        <div
          style={{
            fontSize: 12,
            color: "#1d4ed8",
            background: "#eff6ff",
            borderLeft: "3px solid #2563eb",
            borderRadius: 4,
            padding: "6px 10px",
            marginBottom: 6,
          }}
        >
          <strong>Doctor note:</strong> {r.doctor_note}
        </div>
      )}
      {status === "rejected" && r.reject_reason && (
        <div
          style={{
            fontSize: 12,
            color: "#b91c1c",
            background: "#fef2f2",
            borderLeft: "3px solid #dc2626",
            borderRadius: 4,
            padding: "6px 10px",
            marginBottom: 6,
          }}
        >
          <strong>Reason:</strong> {r.reject_reason}
        </div>
      )}

      {isPending && (
        <div
          style={{
            background: "#fafafa",
            border: "1px solid #e2e8f0",
            borderRadius: 8,
            padding: 10,
            marginTop: 8,
          }}
        >
          <div style={{ display: "flex", gap: 10, alignItems: "flex-end", flexWrap: "wrap" }}>
            <div style={{ flex: "0 0 200px" }}>
              <label style={labelStyle}>Final dose{r.dose_unit ? ` (${r.dose_unit})` : ""}</label>
              <div style={{ display: "flex", gap: 4, alignItems: "stretch" }}>
                <button
                  type="button"
                  onClick={() => setFinalDose(stepDose(finalDose, -0.25))}
                  style={stepBtnStyle}
                  title="−0.25"
                >
                  −
                </button>
                <input
                  type="text"
                  inputMode="decimal"
                  value={finalDose}
                  onChange={(e) => setFinalDose(e.target.value)}
                  style={{ ...inputStyle, textAlign: "center" }}
                />
                <button
                  type="button"
                  onClick={() => setFinalDose(stepDose(finalDose, 0.25))}
                  style={stepBtnStyle}
                  title="+0.25"
                >
                  +
                </button>
              </div>
            </div>
            <div style={{ flex: 1, minWidth: 200 }}>
              <label style={labelStyle}>Note for patient (optional)</label>
              <input
                type="text"
                value={doctorNote}
                onChange={(e) => setDoctorNote(e.target.value)}
                placeholder="e.g. monitor sugars; titrate slowly"
                style={inputStyle}
              />
            </div>
          </div>

          {!rejecting ? (
            <div style={{ display: "flex", gap: 6, marginTop: 10, justifyContent: "flex-end" }}>
              <button
                disabled={busy}
                onClick={() => setRejecting(true)}
                style={{
                  ...btnStyle("#ef4444", "#fef2f2", "#b91c1c"),
                  opacity: busy ? 0.6 : 1,
                  cursor: busy ? "not-allowed" : "pointer",
                }}
              >
                Reject
              </button>
              <button
                disabled={busy}
                onClick={submitApprove}
                style={{
                  ...btnStyle("#10b981", "#10b981", "#fff"),
                  opacity: busy ? 0.7 : 1,
                  cursor: busy ? "not-allowed" : "pointer",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                }}
              >
                {busy && <Spinner color="#fff" />}
                {busy
                  ? "Approving…"
                  : `Approve ${finalDose && finalDose !== r.requested_dose ? `as ${finalDose}` : ""}`}
              </button>
            </div>
          ) : (
            <div
              style={{
                marginTop: 10,
                padding: 10,
                borderRadius: 8,
                background: "#fef2f2",
                border: "1px solid #fecaca",
              }}
            >
              <input
                type="text"
                autoFocus
                value={rejectReason}
                onChange={(e) => setRejectReason(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") submitReject();
                  if (e.key === "Escape") setRejecting(false);
                }}
                placeholder="Reason — e.g. dose too high, see in clinic first"
                style={{ ...inputStyle, borderColor: "#fecaca" }}
              />
              <div style={{ display: "flex", gap: 6, marginTop: 8, justifyContent: "flex-end" }}>
                <button
                  disabled={busy}
                  onClick={() => setRejecting(false)}
                  style={{
                    ...btnStyle("#cbd5e1", "#fff", "#475569"),
                    opacity: busy ? 0.6 : 1,
                    cursor: busy ? "not-allowed" : "pointer",
                  }}
                >
                  Cancel
                </button>
                <button
                  disabled={busy}
                  onClick={submitReject}
                  style={{
                    ...btnStyle("#ef4444", "#ef4444", "#fff"),
                    opacity: busy ? 0.7 : 1,
                    cursor: busy ? "not-allowed" : "pointer",
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 6,
                  }}
                >
                  {busy && <Spinner color="#fff" />}
                  {busy ? "Rejecting…" : "Confirm reject"}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const labelStyle = {
  display: "block",
  fontSize: 10,
  fontWeight: 800,
  color: "#64748b",
  letterSpacing: 0.5,
  marginBottom: 4,
};

const inputStyle = {
  width: "100%",
  padding: "8px 10px",
  border: "1px solid #e2e8f0",
  borderRadius: 8,
  fontSize: 13,
  color: "#0f172a",
  background: "#fff",
  outline: "none",
  boxSizing: "border-box",
};

function stepDose(current, delta) {
  const m = String(current ?? "").match(/-?\d+(?:\.\d+)?/);
  const num = m ? parseFloat(m[0]) : 0;
  const next = Math.max(0, Math.round((num + delta) * 100) / 100);
  if (!m) return String(next);
  return String(current).replace(m[0], String(next));
}

const stepBtnStyle = {
  width: 30,
  border: "1px solid #e2e8f0",
  background: "#f8fafc",
  borderRadius: 8,
  fontSize: 16,
  fontWeight: 700,
  color: "#334155",
  cursor: "pointer",
  lineHeight: 1,
};

function Spinner({ color = "#fff", size = 12 }) {
  return (
    <span
      style={{
        display: "inline-block",
        width: size,
        height: size,
        border: `2px solid ${color}`,
        borderTopColor: "transparent",
        borderRadius: "50%",
        animation: "dcr-spin 0.7s linear infinite",
      }}
    />
  );
}

if (typeof document !== "undefined" && !document.getElementById("dcr-spin-style")) {
  const style = document.createElement("style");
  style.id = "dcr-spin-style";
  style.textContent = "@keyframes dcr-spin { to { transform: rotate(360deg); } }";
  document.head.appendChild(style);
}

function btnStyle(borderColor, bg, color) {
  return {
    fontSize: 11,
    fontWeight: 700,
    padding: "6px 14px",
    borderRadius: 6,
    border: `1px solid ${borderColor}`,
    background: bg,
    color,
    cursor: "pointer",
  };
}
