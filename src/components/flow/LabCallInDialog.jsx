import { useEffect, useState } from "react";
import api from "../../services/api";

const REASONS = [
  "Bill not generated yet",
  "Paying at the counter after the test",
  "Credit / company patient",
  "Camp or free scheme",
];

export default function LabCallInDialog({ step, busy, onCancel, onConfirm }) {
  const [billing, setBilling] = useState(null);
  const [loading, setLoading] = useState(true);
  const [manualPaid, setManualPaid] = useState(false);
  const [reason, setReason] = useState("");
  const [otherText, setOtherText] = useState("");
  const [sent, setSent] = useState(false);
  const [labName, setLabName] = useState("");
  const [expectedOn, setExpectedOn] = useState("");
  const [mode, setMode] = useState("patient_goes");

  useEffect(() => {
    let live = true;
    const load = async () => {
      try {
        const { data } = await api.get(
          `/api/flow/patient-billing?patient_db_id=${step.patient_db_id || ""}&file_no=${encodeURIComponent(step.file_no || "")}`,
        );
        if (live) setBilling(data?.billing || null);
      } catch {
        if (live) setBilling(null);
      } finally {
        if (live) setLoading(false);
      }
    };
    load();
    return () => {
      live = false;
    };
  }, [step.patient_db_id, step.file_no]);

  const note = reason === "__other" ? otherText : reason;
  const due = Number(billing?.due) || 0;
  const healthrayPaid = !!billing && due <= 0;
  const status = healthrayPaid || manualPaid ? "paid" : billing ? "due" : "unbilled";
  // An outside test is paid to that lab directly, so our bill is not the
  // question — asking would only invite a wrong answer.
  const needsNote = !sent && status !== "paid";
  const blocked = sent ? !labName.trim() : needsNote && !note.trim();
  // Our lab only touches the sample when we draw it, so only then is this a
  // call-in. Otherwise the patient is being sent away, not brought in.
  const draws = !sent || mode === "courier";

  const submit = (e) => {
    e.preventDefault();
    if (blocked || busy) return;
    onConfirm({
      payment: sent
        ? undefined
        : {
            status,
            due_amount: due,
            note: needsNote ? note.trim() : "",
            source: manualPaid ? "manual" : "healthray",
          },
      outside: {
        sent,
        mode: sent ? mode : undefined,
        lab_name: labName.trim(),
        expected_on: expectedOn || null,
      },
      handsOff: sent && mode === "patient_goes",
    });
  };

  return (
    <div className="flow-dialog-backdrop" onClick={onCancel} role="presentation">
      <form
        className="flow-card lab-callin"
        onClick={(e) => e.stopPropagation()}
        onSubmit={submit}
        aria-label="Confirm before collecting"
      >
        <h2 className="lab-callin-title">
          {step.patient_name} — {step.step_name}
        </h2>
        <p className="flow-muted lab-callin-sub">
          Confirm where the test is going, then call the patient in.
        </p>

        <fieldset className="lab-callin-sec">
          <legend>1 · Where is this test done?</legend>
          <label className="lab-callin-check">
            <input
              type="radio"
              name="lab-destination"
              checked={!sent}
              onChange={() => setSent(false)}
            />
            In-house lab
          </label>
          <label className="lab-callin-check">
            <input
              type="radio"
              name="lab-destination"
              checked={sent}
              onChange={() => setSent(true)}
            />
            Sent to an outside lab
          </label>
          {sent && (
            <>
              <label className="lab-callin-check lab-callin-sub-choice">
                <input
                  type="radio"
                  name="lab-outside-mode"
                  checked={mode === "patient_goes"}
                  onChange={() => setMode("patient_goes")}
                />
                Patient goes there — we do nothing
              </label>
              <label className="lab-callin-check lab-callin-sub-choice">
                <input
                  type="radio"
                  name="lab-outside-mode"
                  checked={mode === "courier"}
                  onChange={() => setMode("courier")}
                />
                We draw the sample here and courier it
              </label>
              <div className="flow-field">
                <label htmlFor="lab-outside-name">Outside lab name</label>
                <input
                  id="lab-outside-name"
                  type="text"
                  value={labName}
                  autoFocus
                  placeholder="e.g. SRL, Dr Lal PathLabs"
                  onChange={(e) => setLabName(e.target.value)}
                />
              </div>
              <div className="flow-field">
                <label htmlFor="lab-outside-date">Report expected on (optional)</label>
                <input
                  id="lab-outside-date"
                  type="date"
                  value={expectedOn}
                  onChange={(e) => setExpectedOn(e.target.value)}
                />
              </div>
              <p className="flow-muted">
                Paid to that lab directly, so no payment check here. Results never sync from
                HealthRay, so &ldquo;reports available&rdquo; moves to the Assistant Station, who
                mark it when the report arrives.
                {!draws &&
                  " The patient is not called in — this test leaves your queue and the courier and processing stages are dropped."}
              </p>
            </>
          )}
        </fieldset>

        {!sent && (
          <fieldset className="lab-callin-sec">
            <legend>2 · Payment</legend>
            {loading ? (
              <p className="flow-muted">Checking HealthRay…</p>
            ) : healthrayPaid ? (
              <p className="lab-callin-line lab-callin-line--ok">
                ✓ Paid{billing.invoice_no ? ` · invoice ${billing.invoice_no}` : ""}
                {billing.total ? ` · ₹${billing.total}` : ""}
              </p>
            ) : billing ? (
              <p className="lab-callin-line lab-callin-line--bad">⚠ Due ₹{due} — not yet paid</p>
            ) : (
              <p className="lab-callin-line lab-callin-line--warn">
                ⚠ No bill found in HealthRay for today
              </p>
            )}

            {!loading && !healthrayPaid && (
              <>
                <label className="lab-callin-check">
                  <input
                    type="checkbox"
                    checked={manualPaid}
                    onChange={(e) => setManualPaid(e.target.checked)}
                  />
                  Paid at the counter — HealthRay has not caught up
                </label>
                {!manualPaid && (
                  <div className="flow-field">
                    <label htmlFor="lab-pay-note">Why are we collecting before payment?</label>
                    <select
                      id="lab-pay-note"
                      value={reason}
                      onChange={(e) => setReason(e.target.value)}
                    >
                      <option value="">Choose a reason…</option>
                      {REASONS.map((r) => (
                        <option key={r} value={r}>
                          {r}
                        </option>
                      ))}
                      <option value="__other">Other…</option>
                    </select>
                    {reason === "__other" && (
                      <input
                        type="text"
                        value={otherText}
                        autoFocus
                        placeholder="Type the reason"
                        onChange={(e) => setOtherText(e.target.value)}
                      />
                    )}
                  </div>
                )}
              </>
            )}
          </fieldset>
        )}

        <div className="lab-callin-actions">
          <button type="button" className="flow-btn flow-btn-ghost" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="flow-btn flow-btn-primary" disabled={blocked || busy}>
            {busy ? "Saving…" : draws ? "Call in" : "Send outside"}
          </button>
        </div>
      </form>
    </div>
  );
}
