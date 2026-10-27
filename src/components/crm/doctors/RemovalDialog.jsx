import { useEffect, useState } from "react";
import api from "../../../services/api.js";
import ConfirmModal from "../../ui/ConfirmModal.jsx";
import { errorText } from "../import/importText.js";
import { DOCTOR_REMOVAL_REASONS } from "../../../../shared/crmVocab.js";

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

export default function RemovalDialog({ open, doctor, isLead, onClose, onDone }) {
  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");
  const [impact, setImpact] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  useEffect(() => {
    if (!open) return;
    setReason("");
    setNote("");
    setErr(null);
    setImpact(null);
    api
      .get(`/api/crm/doctors/${doctor.id}/removal-impact`)
      .then(({ data }) => setImpact(data))
      .catch(() => setImpact(null));
  }, [open, doctor.id]);

  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      const { data } = await api.post(`/api/crm/doctors/${doctor.id}/removal`, { reason, note });
      onDone(data);
    } catch (e) {
      setErr(errorText(e, "Unable to send the request. Please try again."));
    } finally {
      setBusy(false);
    }
  };

  const needsNote = reason === "other" && !note.trim();

  return (
    <ConfirmModal
      open={open}
      variant="danger"
      title={isLead ? `Remove ${doctor.full_name}?` : `Ask to remove ${doctor.full_name}?`}
      cancelLabel="Keep doctor"
      confirmLabel={busy ? "Sending…" : isLead ? "Remove doctor" : "Send request"}
      onCancel={onClose}
      onConfirm={submit}
      confirmDisabled={!reason || needsNote}
      busy={busy}
      error={err}
      message={
        <div className="dfm__dialog">
          <p className="dfm__ident">
            <strong>{doctor.full_name}</strong>
            {[doctor.area, doctor.mobile].filter(Boolean).length > 0 &&
              ` · ${[doctor.area, doctor.mobile].filter(Boolean).join(" · ")}`}
          </p>
          <label className="dfm__field">
            <span className="dfm__label">Reason</span>
            <select
              className="rep__input"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            >
              <option value="">Choose a reason…</option>
              {DOCTOR_REMOVAL_REASONS.map((r) => (
                <option key={r.value} value={r.value}>
                  {r.label}
                </option>
              ))}
            </select>
          </label>
          <label className="dfm__field">
            <span className="dfm__label">Note{reason === "other" ? "" : " (optional)"}</span>
            <textarea
              className="rep__notes"
              rows={2}
              maxLength={500}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </label>
          {isLead ? (
            <p>
              The doctor disappears from every list, sheet and coverage count now. Past visits and
              referrals stay in reports.
              {impact &&
                (impact.open_referrals > 0 || impact.open_tasks > 0) &&
                ` ${plural(impact.open_referrals, "open referral")} stay linked; ${plural(
                  impact.open_tasks,
                  "open task",
                )} will be cancelled.`}{" "}
              You can restore the doctor later.
            </p>
          ) : (
            <p>
              Your admin decides. Until then the doctor stays on your list and you can keep logging
              visits.
            </p>
          )}
        </div>
      }
    />
  );
}
