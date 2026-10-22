import { useState } from "react";
import {
  useCancelConsultEdit,
  useOpenConsultEdit,
  useSaveConsultEdit,
} from "../../../queries/hooks/useGiniflowPrescription";

const hhmm = (iso) =>
  iso
    ? new Date(iso).toLocaleTimeString("en-IN", {
        hour: "2-digit",
        minute: "2-digit",
        timeZone: "Asia/Kolkata",
      })
    : "";

const listed = (names) => (names?.length ? names.join(", ") : "");

export function EditPrescriptionButton({ visitId, onToast, station = "doctor" }) {
  const open = useOpenConsultEdit(visitId, station);
  return (
    <button
      type="button"
      className="btn-fin"
      disabled={open.isPending}
      onClick={() =>
        open.mutate(undefined, {
          onSuccess: () => onToast("✎ Editing — the patient stays where they are until you save"),
          onError: (e) => onToast(e?.response?.data?.error || "Could not open this for editing"),
        })
      }
    >
      {open.isPending ? "Opening…" : "✎ Edit prescription"}
    </button>
  );
}

export function AmendedNote({ amendedAt }) {
  if (!amendedAt) return null;
  return <span className="fin-gap">Prescription last updated at {hhmm(amendedAt)}.</span>;
}

export default function ConsultEditBar({
  visitId,
  consult,
  onToast,
  onSaved,
  station = "doctor",
  needsNextVisit = false,
}) {
  const [confirming, setConfirming] = useState(false);
  const [reason, setReason] = useState("");
  const cancel = useCancelConsultEdit(visitId, station);
  const save = useSaveConsultEdit(visitId, station);

  const run = () =>
    save.mutate(reason.trim() ? { reason: reason.trim() } : {}, {
      onSuccess: (r) => {
        setConfirming(false);
        setReason("");
        const parts = [
          r.added?.length ? `+ ${listed(r.added)}` : "",
          r.removed?.length ? `− ${listed(r.removed)}` : "",
          r.changed?.length ? `~ ${listed(r.changed)}` : "",
        ].filter(Boolean);
        onToast(`✓ Prescription updated${parts.length ? ` — ${parts.join(" · ")}` : ""}`);
        onSaved?.(r);
      },
      onError: (e) => onToast(e?.response?.data?.error || "The changes were not saved"),
    });

  return (
    <>
      <div className="fin-bar fin-editing">
        <div>
          <strong>✎ Editing after finalize</strong>
          <span>
            {consult.statusLabel ? `The patient stays at ${consult.statusLabel}. ` : ""}
            Changes go out only when you save — the prescription PDF is then replaced.
          </span>
          {needsNextVisit && (
            <span className="fin-edit-need">📅 Set the next visit before saving.</span>
          )}
        </div>
        <div className="fin-edit-acts">
          <button
            type="button"
            className="btn btn-g"
            disabled={cancel.isPending || save.isPending}
            onClick={() =>
              cancel.mutate(undefined, {
                onSuccess: () =>
                  onToast("Edit cancelled — the finalized prescription is unchanged"),
                onError: (e) => onToast(e?.response?.data?.error || "Could not cancel the edit"),
              })
            }
          >
            Cancel edit
          </button>
          <button
            type="button"
            className="btn-fin"
            disabled={needsNextVisit}
            title={needsNextVisit ? "Set the next visit in the Care plan first" : undefined}
            onClick={() => setConfirming(true)}
          >
            Save changes →
          </button>
        </div>
      </div>

      {confirming && (
        <div
          className="tmodal open"
          onClick={(e) => e.target === e.currentTarget && setConfirming(false)}
        >
          <div className="tbox confirm" role="alertdialog" aria-label="Save prescription changes">
            <div className="tb-hd">
              <div>
                <div className="tb-name">Save the changes?</div>
                <div className="tb-meta">
                  {consult.name} · {consult.fileNo}
                </div>
              </div>
              <button className="tb-cls" onClick={() => setConfirming(false)} aria-label="Close">
                ✕
              </button>
            </div>
            <div className="tb-body">
              <ul className="fin-list">
                <li>💊 The medicines are updated in the same consultation</li>
                <li>📄 The prescription PDF is replaced with the new one</li>
                <li>🧾 The Rx desk and pharmacy see that the prescription was updated</li>
              </ul>
              <label className="cp-lab" htmlFor="edit-reason">
                Reason <em>— optional</em>
              </label>
              <textarea
                id="edit-reason"
                className="cp-text"
                rows={2}
                maxLength={300}
                value={reason}
                placeholder="e.g. Missed Vit D supplement"
                onChange={(e) => setReason(e.target.value)}
              />
              <div className="cf-actions">
                <button className="btn btn-g" onClick={() => setConfirming(false)}>
                  Keep editing
                </button>
                <button className="btn-fin" disabled={save.isPending} onClick={run}>
                  {save.isPending ? "Saving…" : "Save changes"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
