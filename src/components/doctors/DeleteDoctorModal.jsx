import { useEffect, useState } from "react";
import api from "../../services/api";
import { toast } from "../../stores/uiStore";
import "../../pages/DoctorManagementPage.css";

export default function DeleteDoctorModal({ doctor, onClose, onDone }) {
  const [counts, setCounts] = useState(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .get(`/api/doctors/${doctor.id}/removal`)
      .then((r) => setCounts(r.data))
      .catch((e) =>
        toast(e.response?.data?.error || "Could not check this doctor's bookings", "error"),
      );
  }, [doctor.id]);

  const remove = async () => {
    setBusy(true);
    try {
      await api.post(`/api/doctors/${doctor.id}/removal`, { reason: reason.trim() });
      toast(`${doctor.name} was deleted and signed out`, "success");
      await onDone();
    } catch (e) {
      toast(e.response?.data?.error || e.response?.data?.details?.[0] || "Delete failed", "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="docmgmt-modal-bg" onClick={onClose}>
      <div
        className="docmgmt-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="docmgmt-delete-title"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="docmgmt-delete-title">Delete {doctor.name}?</h2>
        <p className="docmgmt-hint">
          They are signed out at once and can't log in. Their consultation items are switched off,
          so nothing more can be billed under them. Past visits, bills and reports keep their name.
          You can restore them later from Removed doctors.
        </p>
        {counts ? (
          <ul className="docmgmt-counts">
            <li>
              <strong>{counts.future_appointments}</strong> future appointment
              {counts.future_appointments === 1 ? "" : "s"} still booked with them
            </li>
            <li>
              <strong>{counts.open_drafts}</strong> open draft bill
              {counts.open_drafts === 1 ? "" : "s"} still charging their consultation
            </li>
          </ul>
        ) : (
          <p className="docmgmt-empty">Checking their bookings…</p>
        )}
        <label className="docmgmt-reason">
          Reason (required)
          <textarea
            value={reason}
            maxLength={500}
            rows={3}
            placeholder="e.g. Left the hospital on 30 September"
            onChange={(e) => setReason(e.target.value)}
          />
        </label>
        <div className="docmgmt-modal-actions">
          <div className="spacer" />
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="docmgmt-danger"
            disabled={busy || !counts || !reason.trim()}
            onClick={remove}
          >
            {busy ? "Deleting…" : "Delete doctor"}
          </button>
        </div>
      </div>
    </div>
  );
}
