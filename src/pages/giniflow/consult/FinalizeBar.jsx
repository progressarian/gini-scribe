import { useState } from "react";
import { useFinalize, useFinalizePreview } from "../../../queries/hooks/useGiniflowPrescription";

// Finalize — the fan-out, brief §2.3 trigger 4.
//
// Irreversible: the log only moves forward, so there is no undo and a mis-tap
// cannot be corrected by a further event. It therefore states what it is about
// to do, in the prototype's own words, before it will do it.

export default function FinalizeBar({ visitId, onDone, onToast }) {
  const [open, setOpen] = useState(false);
  const { data: preview, isLoading } = useFinalizePreview(visitId, open);
  const finalize = useFinalize(visitId);

  // A proposal the doctor has not decided blocks the fan-out (addendum v1.1 §3).
  // Not a warning: finalizing used to record every undecided proposal as
  // rejected, so the MO was told their suggestion was considered when nobody
  // had read it.
  // A severe interaction nobody has explained blocks it for the same reason
  // (§5.2): the server refuses either way, and a button that says why before
  // the click beats a toast after it.
  const unexplained = preview?.interactions?.blocking?.length ?? 0;
  const blocked = (preview?.undecidedProposals ?? 0) > 0 || unexplained > 0;

  const run = () =>
    finalize.mutate(undefined, {
      onSuccess: (r) => {
        setOpen(false);
        onDone(r);
      },
      onError: (e) => onToast(e?.response?.data?.error || "Finalize failed — nothing was written"),
    });

  return (
    <>
      <div className="fin-bar">
        <div>
          <strong>Finish this consultation</strong>
          <span>
            Sends the prescription to the pharmacy and the medicine card to the patient&apos;s app.
          </span>
        </div>
        <button type="button" className="btn-fin" onClick={() => setOpen(true)}>
          Finalize →
        </button>
      </div>

      {open && (
        <div
          className="tmodal open"
          onClick={(e) => e.target === e.currentTarget && setOpen(false)}
        >
          <div className="tbox confirm" role="alertdialog" aria-label="Confirm finalize">
            <div className="tb-hd">
              <div>
                <div className="tb-name">Finalize and send?</div>
                <div className="tb-meta">This cannot be undone from here</div>
              </div>
              <button className="tb-cls" onClick={() => setOpen(false)} aria-label="Close">
                ✕
              </button>
            </div>
            <div className="tb-body">
              {isLoading && <div className="cn-empty">Checking what will be sent…</div>}
              {preview && (
                <ul className="fin-list">
                  <li>
                    💊 <strong>{preview.medicines}</strong> medicine
                    {preview.medicines === 1 ? "" : "s"} to the pharmacy
                    {preview.stopped ? ` · ${preview.stopped} stopped` : ""}
                  </li>
                  <li>📱 Medicine card to the patient&apos;s app</li>
                  {preview.tests > 0 && (
                    <li>
                      🔬 <strong>{preview.tests}</strong> test
                      {preview.tests === 1 ? "" : "s"} to lab and reception
                    </li>
                  )}
                  {/* Named, not counted — "Ophthalmology referral" is
                      actionable, "1 referral" is not (19 §6). The letters are
                      written after the commit, so a slow render can never
                      strand the patient before pharmacy. */}
                  {preview.referrals?.map((r) => (
                    <li key={r.id}>
                      ↗ {r.label} — letter {r.hasLetter ? "already generated" : "generated now"}
                    </li>
                  ))}
                  {preview.outOfStock.length > 0 && (
                    <li className="fin-warn">
                      ⚠ Out of stock: {preview.outOfStock.join(", ")} — the pharmacy will be warned
                    </li>
                  )}
                  {/* Undecided proposals do not quietly survive: leaving them
                      "proposed" would tell the MO their suggestion is still being
                      considered after the patient has gone home. */}
                  {preview.undecidedProposals > 0 && (
                    <li className="fin-block">
                      ⛔ {preview.undecidedProposals} MO proposal
                      {preview.undecidedProposals === 1 ? "" : "s"} still to review — approve,
                      adjust or reject each one before finalizing
                    </li>
                  )}
                  {unexplained > 0 && (
                    <li className="fin-block">
                      ⛔{" "}
                      {preview.interactions.blocking.map((f) => f.medicines.join(" + ")).join("; ")}{" "}
                      — change the prescription, or record why it is intended in the interaction
                      check above
                    </li>
                  )}
                  {preview.interactions?.unchecked?.length > 0 && (
                    <li className="fin-warn">
                      ⚠ {preview.interactions.unchecked.length} medicine
                      {preview.interactions.unchecked.length === 1 ? "" : "s"} could not be
                      interaction-checked: {preview.interactions.unchecked.join(", ")}
                    </li>
                  )}
                  {preview.medicines === 0 && (
                    <li className="fin-warn">
                      ⚠ No medicines in the prescription. The patient will reach the pharmacy with
                      nothing to collect.
                    </li>
                  )}
                </ul>
              )}
              <div className="cf-actions">
                <button className="btn btn-g" onClick={() => setOpen(false)}>
                  Not yet
                </button>
                {/* The server refuses this too (finalize.js). Disabling the
                    button says why before the click rather than after it. */}
                <button
                  className="btn btn-tl"
                  disabled={finalize.isPending || blocked}
                  onClick={run}
                >
                  {finalize.isPending
                    ? "Finalizing…"
                    : unexplained > 0
                      ? `${unexplained} interaction${unexplained === 1 ? "" : "s"} to resolve`
                      : blocked
                        ? `${preview.undecidedProposals} to review`
                        : "Yes — finalize"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
