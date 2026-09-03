import { useState } from "react";
import { useFastFinalize } from "../../../queries/hooks/useGiniflowPrescription";

// The 30-second visit — addendum v1.1 §2.
//
// Shown only for a green-category patient, and only as an ADDITION: the whole
// consult renders below it and the doctor can scroll into any section. That is
// what makes the button safe to press — nothing is hidden behind it.
//
// Roughly 28% of visits are `in_control`, so this is the largest single time
// saving in the system. It is also the one control that finishes a consultation
// without the doctor reading anything, so it states what it is about to do.

export default function FastPathBar({ visitId, consult, draft, onDone, onToast }) {
  const [confirming, setConfirming] = useState(false);
  const fast = useFastFinalize(visitId);

  if (consult.category !== "in_control" || consult.finalized) return null;

  const medicines = (draft?.items || []).filter((i) => i.change_type !== "stopped").length;
  const pending = (draft?.items || []).filter((i) => i.approval_status === "pending").length;
  // Nothing to continue, or something to read first — either way this is not a
  // 30-second visit, and offering the button would be a lie about the patient.
  if (!medicines || pending) return null;

  const run = () =>
    fast.mutate(undefined, {
      onSuccess: (r) => {
        setConfirming(false);
        onDone(r);
      },
      onError: (e) => onToast(e?.response?.data?.error || "The fast path did not run"),
    });

  return (
    <div className="fastpath">
      <span className="fp-ico">⚡</span>
      <div className="fp-body">
        <strong>Stable patient — fast path available</strong>
        <span>
          Continues all {medicines} medicine{medicines === 1 ? "" : "s"} unchanged · repeats
          today&apos;s panel at the next visit · next visit in 3 months · sends to pharmacy and the
          patient&apos;s app
        </span>
      </div>
      {confirming ? (
        <div className="fp-acts">
          <button type="button" className="btn-sm" onClick={() => setConfirming(false)}>
            Not yet
          </button>
          <button type="button" className="btn-sm on" disabled={fast.isPending} onClick={run}>
            {fast.isPending ? "Finishing…" : "Yes — finish the visit"}
          </button>
        </div>
      ) : (
        <button type="button" className="fp-btn" onClick={() => setConfirming(true)}>
          ✓ Continue all · Repeat panel · Finalize
        </button>
      )}
    </div>
  );
}
