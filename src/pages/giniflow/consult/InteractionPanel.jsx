import { useState } from "react";
import { SEVERITY_UI } from "../../../../shared/giniflowInteractions.js";
import { useInteractions, useAckInteraction } from "../../../queries/hooks/useGiniflowPrescription";

// The interaction check over the combined list (24-ADDENDUM-V11-PLAN.md §5.2).
//
// Two things this panel must never do, both of them ways of turning an absence
// of information into an assurance:
//
//   1. Say "no interactions" over a list it could only half read. The count of
//      what was checked is on the screen whenever anything was not, and the
//      unreadable names are printed, because "Erly" being unresolvable is
//      something the consultant can act on and a silent omission is not.
//   2. Hide a severe finding behind a dismiss button. The way past one is a
//      recorded reason — the sentence the whole check exists to produce.

function Finding({ finding, onAck, readOnly, canAck }) {
  const [acking, setAcking] = useState(false);
  const [reason, setReason] = useState("");
  const ui = SEVERITY_UI[finding.severity];

  return (
    <div className={`inter-row inter-${ui.tone}${finding.acknowledged ? " inter-acked" : ""}`}>
      <div className="inter-main">
        <div className="inter-meds">
          <span className="inter-sev">
            {ui.icon} {ui.label}
          </span>
          {finding.medicines.join("  +  ")}
        </div>
        <div className="inter-note">{finding.note}</div>
        {finding.acknowledged && (
          <div className="inter-acked-note">
            ✓ Prescribed deliberately — {finding.acknowledgedReason}
          </div>
        )}
      </div>
      {!readOnly && canAck && !finding.acknowledged && finding.severity === "severe" && (
        <div className="inter-act">
          {acking ? (
            <form
              className="inter-form"
              onSubmit={(e) => {
                e.preventDefault();
                onAck({ ruleKey: finding.key, reason });
              }}
            >
              <input
                className="cp-inp"
                autoFocus
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Why is this intended? e.g. dual antiplatelet, 6 months post-stent"
              />
              <button type="submit" className="btn-sm" disabled={reason.trim().length < 4}>
                Record
              </button>
              <button type="button" className="btn-sm" onClick={() => setAcking(false)}>
                Cancel
              </button>
            </form>
          ) : (
            <button type="button" className="btn-sm" onClick={() => setAcking(true)}>
              This is intended
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export default function InteractionPanel({ visitId, readOnly, onToast, station = "doctor" }) {
  const { data, isLoading } = useInteractions(visitId, station);
  const ack = useAckInteraction(visitId);

  if (isLoading || !data) return null;
  if (data.status === "empty") return null;

  const findings = [...data.severe, ...data.moderate];
  const blocking = data.blocking?.length || 0;

  return (
    <div className="inter-panel">
      <div className="cs-head">
        <h3>🔬 Interaction check</h3>
        <span className="cs-sub">
          this prescription and the medicines other doctors started · {data.checked} of {data.total}{" "}
          medicines identified
        </span>
      </div>

      {findings.map((f) => (
        <Finding
          key={f.key}
          finding={f}
          readOnly={readOnly}
          canAck={station === "doctor"}
          onAck={(payload) =>
            ack.mutate(payload, {
              onError: (e) => onToast?.(e?.response?.data?.error || "Not recorded — try again"),
            })
          }
        />
      ))}

      {!findings.length && data.status === "checked" && (
        <div className="inter-clear">
          ✓ Nothing found between the {data.total} medicines on this list.
        </div>
      )}

      {/* The honest half. A partial check is not a clean one, and this line is
          the difference between the two. */}
      {data.unchecked.length > 0 && (
        <div className="inter-unchecked">
          <strong>Not checked:</strong> {data.unchecked.join(", ")} —{" "}
          {data.unchecked.length === 1 ? "this medicine is" : "these medicines are"} not in the drug
          list, so nothing can be said about {data.unchecked.length === 1 ? "it" : "them"}.
        </div>
      )}

      {blocking > 0 && station === "doctor" && !readOnly && (
        <div className="inter-block">
          ⛔ Finalize is held until {blocking === 1 ? "this is" : "these are"} either changed or
          recorded as intended.
        </div>
      )}
    </div>
  );
}
