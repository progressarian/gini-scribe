import { useEffect, useState } from "react";
import api from "../../../services/api.js";
import ConfirmModal from "../../ui/ConfirmModal.jsx";
import { errorText } from "../import/importText.js";
import { VISIT_FORM_STATUSES, VISIT_OUTCOMES, VISIT_TYPES } from "../../../../shared/crmVocab.js";

const ddmmyyyy = (day) => (day ? day.split("-").reverse().join("-") : "");

export default function VisitChangeDialog({ mode, visit, doctor, viewerId, onClose, onDone }) {
  const open = Boolean(mode && visit);
  const [form, setForm] = useState(null);
  const [range, setRange] = useState(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const needsReason = Boolean(visit) && !(visit.executive_id === viewerId && visit.logged_today);

  useEffect(() => {
    if (!open) return;
    setErr(null);
    setReason("");
    setForm({
      status: visit.outcome === "doctor_unavailable" ? "doctor_unavailable" : "completed",
      visit_date: visit.visit_day,
      visit_type: visit.visit_type || "in_person",
      outcome: visit.outcome === "doctor_unavailable" ? "" : visit.outcome || "",
      discussion_notes: visit.discussion_notes || "",
      next_visit_date: visit.next_visit_date || "",
    });
    if (mode === "edit") {
      api
        .get(`/api/crm/doctors/${doctor.id}/visit-days`)
        .then(({ data }) => setRange(data.window))
        .catch(() => setRange(null));
    }
  }, [open, mode, visit, doctor.id]);

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      if (mode === "undo") {
        await api.post(`/api/crm/visits/${visit.id}/undo`, { reason });
      } else {
        await api.put(`/api/crm/visits/${visit.id}`, {
          status: form.status,
          visit_date: form.visit_date !== visit.visit_day ? form.visit_date : undefined,
          visit_type: form.visit_type,
          outcome: form.status === "doctor_unavailable" ? null : form.outcome || null,
          discussion_notes: form.discussion_notes,
          next_visit_date:
            form.next_visit_date !== (visit.next_visit_date || "")
              ? form.next_visit_date || null
              : undefined,
          reason,
        });
      }
      onDone(mode);
    } catch (e) {
      setErr(errorText(e, "Unable to change this visit. Please try again."));
    } finally {
      setBusy(false);
    }
  };

  if (!open || !form) return null;

  const dateLabel = ddmmyyyy(visit.visit_day);
  const reasonField = needsReason && (
    <label className="dfm__field">
      <span className="dfm__label">Reason for the change</span>
      <input
        className="rep__input"
        value={reason}
        maxLength={300}
        onChange={(e) => setReason(e.target.value)}
        placeholder="Wrong doctor, wrong date…"
      />
    </label>
  );

  if (mode === "undo") {
    return (
      <ConfirmModal
        open
        variant="danger"
        title={`Undo the visit to ${doctor.full_name} on ${dateLabel}?`}
        cancelLabel="Keep the visit"
        confirmLabel={busy ? "Undoing…" : "Undo visit"}
        onCancel={onClose}
        onConfirm={submit}
        confirmDisabled={needsReason && !reason.trim()}
        busy={busy}
        error={err}
        message={
          <div className="dfm__dialog">
            <p>
              The visit is removed from today, week and month counts and from progress reports. It
              stays in the audit record.
            </p>
            {reasonField}
          </div>
        }
      />
    );
  }

  return (
    <ConfirmModal
      open
      variant="primary"
      title={`Change the visit to ${doctor.full_name}`}
      cancelLabel="Cancel"
      confirmLabel={busy ? "Saving…" : "Save changes"}
      onCancel={onClose}
      onConfirm={submit}
      confirmDisabled={needsReason && !reason.trim()}
      busy={busy}
      error={err}
      message={
        <div className="dfm__dialog">
          <label className="dfm__field">
            <span className="dfm__label">Status</span>
            <select className="rep__input" value={form.status} onChange={set("status")}>
              {VISIT_FORM_STATUSES.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>
          <label className="dfm__field">
            <span className="dfm__label">Visit date</span>
            <input
              className="rep__input"
              type="date"
              value={form.visit_date}
              min={range?.from}
              max={range?.to}
              onChange={set("visit_date")}
            />
          </label>
          <label className="dfm__field">
            <span className="dfm__label">Visit type</span>
            <select className="rep__input" value={form.visit_type} onChange={set("visit_type")}>
              {VISIT_TYPES.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
          </label>
          {form.status === "completed" && (
            <label className="dfm__field">
              <span className="dfm__label">Outcome</span>
              <select className="rep__input" value={form.outcome} onChange={set("outcome")}>
                <option value="">No outcome</option>
                {VISIT_OUTCOMES.filter((o) => o.value !== "doctor_unavailable").map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="dfm__field">
            <span className="dfm__label">Notes</span>
            <textarea
              className="rep__notes"
              rows={2}
              maxLength={4000}
              value={form.discussion_notes}
              onChange={set("discussion_notes")}
            />
          </label>
          <label className="dfm__field">
            <span className="dfm__label">Next visit date</span>
            <input
              className="rep__input"
              type="date"
              value={form.next_visit_date}
              min={form.visit_date}
              onChange={set("next_visit_date")}
            />
          </label>
          {reasonField}
        </div>
      }
    />
  );
}
