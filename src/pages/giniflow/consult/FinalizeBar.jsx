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
                    <li className="fin-warn">
                      ⚠ {preview.undecidedProposals} MO proposal
                      {preview.undecidedProposals === 1 ? "" : "s"} still undecided — finalizing
                      records them as rejected
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
                <button className="btn btn-tl" disabled={finalize.isPending} onClick={run}>
                  {finalize.isPending ? "Finalizing…" : "Yes — finalize"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
