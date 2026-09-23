import { useState } from "react";
import {
  usePhoneFamily,
  useRelinkFamilyMember,
  useUnlinkFamilyMember,
} from "../../queries/hooks/usePatientAppUnlinks";

const when = (iso) =>
  iso
    ? new Date(iso).toLocaleString("en-IN", {
        day: "2-digit",
        month: "short",
        year: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
        timeZone: "Asia/Kolkata",
      })
    : "";

export default function PhoneFamilyModal({ patient, onClose }) {
  const family = usePhoneFamily(patient?.id);
  const unlink = useUnlinkFamilyMember();
  const relink = useRelinkFamilyMember();
  const [removing, setRemoving] = useState(null);
  const [reason, setReason] = useState("");
  const [requestedBy, setRequestedBy] = useState("");

  const members = family.data?.members || [];
  const linkedCount = members.filter((m) => !m.unlinked).length;
  const canSubmit = reason.trim().length >= 3 && requestedBy.trim().length >= 2;
  const busy = unlink.isPending || relink.isPending;
  const error =
    unlink.error?.response?.data?.error ||
    relink.error?.response?.data?.error ||
    family.error?.response?.data?.error;

  const startRemoving = (m) => {
    unlink.reset();
    setRemoving(m);
    setReason("");
    setRequestedBy("");
  };

  const submit = async (e) => {
    e.preventDefault();
    if (!removing || !canSubmit || busy) return;
    try {
      await unlink.mutateAsync({
        patientId: patient.id,
        source: removing.source,
        memberId: removing.id,
        reason: reason.trim(),
        requestedBy: requestedBy.trim(),
      });
      setRemoving(null);
    } catch {
      return;
    }
  };

  return (
    <div style={overlay} role="dialog" aria-modal="true" aria-label="Family on this phone">
      <div style={panel}>
        <h2 style={{ margin: 0, fontSize: 17, color: "#0f172a" }}>Family on this phone</h2>
        <p style={{ margin: "6px 0 0", fontSize: 13, color: "#374151" }}>
          {family.data?.phone || patient?.phone || "No phone on file"} · MyHealth Genie app account
        </p>

        {family.isLoading && <p style={muted}>Loading…</p>}
        {!family.isLoading && !members.length && (
          <p style={muted}>No app profiles share this phone.</p>
        )}

        <ul style={list}>
          {members.map((m) => (
            <li key={`${m.source}-${m.id}`} style={row(m.unlinked)}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: "#111827" }}>
                  {m.name || "Unnamed"}
                  {m.isViewed && <span style={tag("#1e40af", "#dbeafe")}>This patient</span>}
                  {m.unlinked && <span style={tag("#991b1b", "#fee2e2")}>Removed</span>}
                </div>
                <div style={{ fontSize: 12, color: "#6b7280", marginTop: 2 }}>
                  {[m.fileNo || (m.source === "app" ? "App only" : null), m.sex]
                    .filter(Boolean)
                    .join(" · ")}
                </div>
                {m.lastChange && m.unlinked && (
                  <div style={{ fontSize: 11, color: "#6b7280", marginTop: 4 }}>
                    Removed {when(m.lastChange.unlinkedAt)}
                    {m.lastChange.unlinkedBy ? ` by ${m.lastChange.unlinkedBy}` : ""} · asked by{" "}
                    {m.lastChange.requestedBy} · {m.lastChange.reason}
                  </div>
                )}
              </div>
              {m.unlinked ? (
                <button
                  type="button"
                  style={btnGhost}
                  disabled={busy}
                  onClick={() => relink.mutate(m.lastChange.id)}
                >
                  Restore
                </button>
              ) : (
                <button
                  type="button"
                  style={btnDangerSmall(linkedCount > 1)}
                  disabled={busy || linkedCount <= 1}
                  title={linkedCount <= 1 ? "The only profile on a phone cannot be removed" : ""}
                  onClick={() => startRemoving(m)}
                >
                  Remove from app
                </button>
              )}
            </li>
          ))}
        </ul>

        {removing && (
          <form onSubmit={submit} style={confirmBox}>
            <div style={{ fontSize: 13, fontWeight: 600, color: "#991b1b" }}>
              Remove {removing.name || "this profile"} from this phone&apos;s app account
            </div>
            <label style={label} htmlFor="unlink-requested-by">
              Requested by
            </label>
            <input
              id="unlink-requested-by"
              value={requestedBy}
              onChange={(e) => setRequestedBy(e.target.value)}
              style={input}
              placeholder="Who asked — name and relation"
              required
            />
            <label style={label} htmlFor="unlink-reason">
              Reason
            </label>
            <textarea
              id="unlink-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={2}
              style={{ ...input, resize: "vertical" }}
              placeholder="Why they should no longer be on this account"
              required
            />
            <p style={consequences}>
              Their medical record is not changed. They stop appearing in the app for this phone and
              are signed out of it. An open app session can take up to an hour to drop.
            </p>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 10 }}>
              <button type="button" style={btnGhost} onClick={() => setRemoving(null)}>
                Cancel
              </button>
              <button type="submit" disabled={!canSubmit || busy} style={btnDanger(canSubmit)}>
                {unlink.isPending ? "Removing…" : "Remove from app account"}
              </button>
            </div>
          </form>
        )}

        {error && <p style={{ color: "#b91c1c", fontSize: 12, margin: "10px 0 0" }}>{error}</p>}

        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 16 }}>
          <button type="button" onClick={onClose} style={btnGhost}>
            Close
          </button>
        </div>
      </div>
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
  maxWidth: 520,
  maxHeight: "calc(100vh - 32px)",
  overflowY: "auto",
  boxSizing: "border-box",
  boxShadow: "0 20px 50px rgba(0,0,0,0.25)",
};

const muted = { fontSize: 13, color: "#6b7280", margin: "14px 0 0" };

const list = { listStyle: "none", margin: "14px 0 0", padding: 0, display: "grid", gap: 8 };

const row = (unlinked) => ({
  display: "flex",
  alignItems: "center",
  gap: 10,
  padding: "10px 12px",
  border: "1px solid #e5e7eb",
  borderRadius: 8,
  background: unlinked ? "#f9fafb" : "#fff",
  opacity: unlinked ? 0.85 : 1,
});

const tag = (color, background) => ({
  marginLeft: 6,
  padding: "1px 6px",
  fontSize: 10,
  fontWeight: 700,
  borderRadius: 999,
  color,
  background,
});

const confirmBox = {
  marginTop: 14,
  padding: 12,
  border: "1px solid #fecaca",
  borderRadius: 8,
  background: "#fffafa",
};

const label = {
  display: "block",
  fontSize: 12,
  fontWeight: 600,
  color: "#374151",
  margin: "10px 0 5px",
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
  margin: "10px 0 0",
  fontSize: 12,
  lineHeight: 1.5,
  color: "#991b1b",
  background: "#fef2f2",
  border: "1px solid #fecaca",
  borderRadius: 8,
  padding: "9px 11px",
};

const btnGhost = {
  padding: "7px 12px",
  fontSize: 12,
  fontWeight: 600,
  borderRadius: 8,
  background: "#fff",
  color: "#374151",
  border: "1px solid #d1d5db",
  cursor: "pointer",
  fontFamily: "inherit",
  whiteSpace: "nowrap",
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

const btnDangerSmall = (enabled) => ({
  padding: "7px 12px",
  fontSize: 12,
  fontWeight: 600,
  borderRadius: 8,
  background: "#fff",
  color: enabled ? "#b91c1c" : "#fca5a5",
  border: `1px solid ${enabled ? "#fecaca" : "#fee2e2"}`,
  cursor: enabled ? "pointer" : "not-allowed",
  fontFamily: "inherit",
  whiteSpace: "nowrap",
});
