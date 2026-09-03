import { useState } from "react";

// The MO's medicine proposals, reviewed by the consultant.
//
// This is the second half of the two-step review the MO station was built for:
// giniflow_rx_proposals has carried `status` / `decided_by` / `decided_at` since
// that station shipped, and nothing has ever written them. This does.
//
// Plan: docs/gini-flow/14-CONSULTANT-PRESCRIPTION-PLAN.md §2.5.
//
// Addendum v1.1 §3 moved proposals onto the draft rows themselves, so this is
// now two things at once, deliberately:
//
//   1. the review UI for the OLD `giniflow_rx_proposals` table, which still
//      holds undecided rows on real visits and is the only place they can be
//      cleared — finalize blocks until they are;
//   2. a pointer to the new ones, which are reviewed on the prescription row
//      itself. It counts them and scrolls there. It does not offer a second
//      set of Approve/Reject buttons: two places to approve the same thing is
//      how a thing gets approved twice.
//
// It disappears when the old table is empty (24-ADDENDUM-V11-PLAN.md §4.1).

const STATUS_LABEL = {
  proposed: "Awaiting your decision",
  approved: "✓ Approved",
  adjusted: "✎ Adjusted",
  rejected: "✕ Rejected",
};

export default function ProposalsStrip({ proposals, onDecide, readOnly, draftItems = [] }) {
  const [open, setOpen] = useState(null); // { id, mode: 'adjust' | 'reject' }
  const [value, setValue] = useState("");

  const proposedRows = draftItems.filter((i) => i.approval_status === "pending");
  if (!proposals.length && !proposedRows.length) return null;
  const pending = proposals.filter((p) => p.status === "proposed");

  const submit = (proposal, status) => {
    if (status === "approved") return onDecide({ proposalId: proposal.id, status });
    if (!value.trim()) return;
    onDecide({
      proposalId: proposal.id,
      status,
      ...(status === "adjusted" ? { adjustedDose: value.trim() } : { note: value.trim() }),
    });
    setOpen(null);
    setValue("");
  };

  return (
    <section className="csec" id="s-proposals">
      {proposedRows.length > 0 && (
        <div className="prop-pointer">
          <span>
            🩺 <strong>{proposedRows.length}</strong> proposed change
            {proposedRows.length === 1 ? "" : "s"} —{" "}
            {proposedRows.map((i) => i.medicine_name).join(", ")}
          </span>
          <button
            type="button"
            className="btn-sm on"
            onClick={() => document.getElementById("s-rx")?.scrollIntoView({ behavior: "smooth" })}
          >
            Review in the prescription →
          </button>
        </div>
      )}

      {proposals.length === 0 ? null : (
        <>
          <div className="cs-head">
            <h2>🩺 MO proposed</h2>
            <span className="cs-sub">
              {pending.length
                ? `${pending.length} awaiting your decision`
                : "all decided — nothing waiting"}
            </span>
          </div>

          {proposals.map((p) => {
            const decided = p.status !== "proposed";
            return (
              <div className={`prop${decided ? " decided" : ""}`} key={p.id}>
                <div className="prop-main">
                  <strong>{p.medicine_name}</strong>
                  {p.from_dose || p.to_dose ? (
                    <span className="prop-dose">
                      {p.from_dose || "—"} → {p.to_dose || "—"}
                    </span>
                  ) : null}
                  <span className={`prop-state prop-${p.status}`}>{STATUS_LABEL[p.status]}</span>
                  {p.reason && <div className="prop-why">{p.reason}</div>}
                  {p.proposed_by_name && (
                    <div className="prop-by">proposed by {p.proposed_by_name}</div>
                  )}
                </div>

                {!decided && !readOnly && (
                  <div className="prop-acts">
                    {open?.id === p.id ? (
                      <div className="prop-form">
                        <input
                          className="cp-inp"
                          autoFocus
                          value={value}
                          placeholder={
                            open.mode === "adjusted" ? "Dose you want instead" : "Why not?"
                          }
                          onChange={(e) => setValue(e.target.value)}
                          onKeyDown={(e) => e.key === "Enter" && submit(p, open.mode)}
                        />
                        <button
                          type="button"
                          className="btn-sm on"
                          onClick={() => submit(p, open.mode)}
                        >
                          Save
                        </button>
                        <button
                          type="button"
                          className="btn-sm"
                          onClick={() => {
                            setOpen(null);
                            setValue("");
                          }}
                        >
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <>
                        <button
                          type="button"
                          className="btn-sm on"
                          onClick={() => submit(p, "approved")}
                        >
                          Approve
                        </button>
                        <button
                          type="button"
                          className="btn-sm"
                          onClick={() => {
                            setOpen({ id: p.id, mode: "adjusted" });
                            setValue(p.to_dose || "");
                          }}
                        >
                          Adjust
                        </button>
                        {/* A rejection carries a reason for the same reason a block
                        does: the MO who proposed it has to see why. */}
                        <button
                          type="button"
                          className="btn-sm"
                          onClick={() => {
                            setOpen({ id: p.id, mode: "rejected" });
                            setValue("");
                          }}
                        >
                          Reject
                        </button>
                      </>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </>
      )}
    </section>
  );
}
