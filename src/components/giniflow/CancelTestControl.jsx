import { useState } from "react";
import {
  NOTE_REQUIRED_CANCEL_REASON,
  REFUND_REASON,
  TEST_CANCEL_REASONS,
} from "../../../shared/testCancelReasons.js";

export default function CancelTestControl({
  what = "test",
  onCancel,
  busy = false,
  cases = [],
  full = false,
}) {
  const [form, setForm] = useState(null);

  if (!form) {
    return (
      <button
        type="button"
        className={`st-btn st-btn-red${full ? " btn-full" : ""}`}
        disabled={busy}
        onClick={() =>
          setForm({ reason: "", note: "", refund: "", cases: cases.map((c) => c.caseNo) })
        }
      >
        ✕ Cancel {what}
      </button>
    );
  }

  const needsNote = form.reason === NOTE_REQUIRED_CANCEL_REASON;
  const ready = !!form.reason && (!needsNote || form.note.trim().length >= 3);
  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));
  const toggleCase = (caseNo) =>
    setForm((f) => ({
      ...f,
      cases: f.cases.includes(caseNo) ? f.cases.filter((c) => c !== caseNo) : [...f.cases, caseNo],
    }));

  const submit = (e) => {
    e.preventDefault();
    if (!ready || busy) return;
    onCancel(
      {
        reason: form.reason,
        note: form.note.trim() || undefined,
        refundAmount:
          form.reason === REFUND_REASON && form.refund !== "" ? Number(form.refund) : undefined,
        caseNos: cases.length ? form.cases : undefined,
      },
      () => setForm(null),
    );
  };

  return (
    <form className="ar-reason" onSubmit={submit} aria-label={`Cancel ${what}`}>
      <select
        className="ar-reason-input"
        autoFocus
        required
        value={form.reason}
        onChange={set("reason")}
        aria-label="Reason"
      >
        <option value="">Why cancel {what}?</option>
        {TEST_CANCEL_REASONS.map((r) => (
          <option key={r.value} value={r.value}>
            {r.label}
          </option>
        ))}
      </select>
      {form.reason === REFUND_REASON && (
        <input
          type="number"
          min="0"
          step="0.01"
          className="ar-reason-input"
          placeholder="Refund ₹ (optional)"
          value={form.refund}
          onChange={set("refund")}
          aria-label="Refund amount"
        />
      )}
      <input
        className="ar-reason-input"
        maxLength={160}
        placeholder={needsNote ? "Say why (required)" : "Note (optional)"}
        value={form.note}
        onChange={set("note")}
        aria-label="Note"
      />
      {cases.map((c) => (
        <label key={c.caseNo} className="dp-hint">
          <input
            type="checkbox"
            checked={form.cases.includes(c.caseNo)}
            onChange={() => toggleCase(c.caseNo)}
          />{" "}
          Also cancel HealthRay case {c.caseNo}
          {c.tests?.length ? ` (${c.tests.join(", ")})` : ""}
        </label>
      ))}
      <button className="st-btn st-btn-red" type="submit" disabled={!ready || busy}>
        Cancel {what}
      </button>
      <button className="st-btn st-btn-g" type="button" onClick={() => setForm(null)}>
        Back
      </button>
    </form>
  );
}
