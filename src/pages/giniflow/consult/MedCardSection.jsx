import { useMedicineCard } from "../../../queries/hooks/useGiniflowPrescription";

// Medicine card — gini-doctor-final.html `s-medcard`.
//
// A computed view, never a table: active medications grouped by timing and
// sorted by the clock. The same `buildCard` powers the consultant's card, the
// pharmacy's, the printed one and the patient's MHG card — four implementations
// of a dosing schedule would be four chances to tell a patient the wrong time.

export default function MedCardSection({ visitId, onToast }) {
  const { data, isLoading } = useMedicineCard(visitId);

  return (
    <section className="csec" id="s-medcard">
      <div className="cs-head">
        <h2>🗒 Medicine card</h2>
        <span className="cs-sub">
          {data
            ? `${data.counts.gini} Gini · ${data.counts.external} from other doctors`
            : "daily schedule"}
        </span>
        <div className="cs-head-r">
          <button
            type="button"
            className="btn-sm"
            disabled={!data?.groups?.length}
            onClick={() => window.print()}
          >
            Print
          </button>
          {/* Sending the card is a message to a patient, so it is not wired to a
              silent click: the card reaches them through the MHG sync that
              Finalize already performs (plan §6). */}
          <button
            type="button"
            className="btn-sm"
            disabled={!data?.groups?.length}
            onClick={() =>
              onToast?.("The card reaches the patient on MyHealth Genie when you finalize.")
            }
          >
            Send to patient
          </button>
        </div>
      </div>

      {isLoading && <div className="cn-empty">Building the card…</div>}
      {!isLoading && !data?.groups?.length && (
        <div className="cn-empty">
          No active medicines — the card appears once the prescription is finalized.
        </div>
      )}

      {(data?.groups || []).map((g) => (
        <div className="mc-slot" key={g.key}>
          <div className="mc-when">
            <strong>{g.label}</strong>
            {g.timeLabel && <em>{g.timeLabel}</em>}
          </div>
          <div className="mc-meds">
            {g.medicines.map((m) => (
              <div className={`mc-med${m.external ? " mc-ext" : ""}`} key={m.medicationId}>
                <span className="mc-name">{m.name}</span>
                {m.dose && <span className="mc-dose">{m.dose}</span>}
                {m.frequency && <span className="mc-freq">{m.frequency}</span>}
                {m.changeType === "new" && <span className="mc-tag mc-new">NEW</span>}
                {m.changeType === "changed" && (
                  <span className="mc-tag mc-chg">
                    {m.previousDose && m.dose ? `↑ ${m.previousDose}→${m.dose}` : "CHANGED"}
                  </span>
                )}
                {m.external && <span className="mc-tag mc-extt">Ext · {m.prescriber}</span>}
                {m.stock?.out && <span className="mc-tag mc-out">out of stock</span>}
                {m.stock?.low && !m.stock.out && <span className="mc-tag mc-low">low stock</span>}
              </div>
            ))}
          </div>
        </div>
      ))}

      {data?.counts?.unslotted > 0 && (
        <div className="cn-empty">
          {data.counts.unslotted} medicine{data.counts.unslotted === 1 ? " has" : "s have"} no
          timing set — they appear under &ldquo;Timing not set&rdquo; rather than being guessed into
          a slot.
        </div>
      )}
      {data?.counts?.external > 0 && (
        <div className="mc-legend">
          <span className="mc-legend-ico">🏥</span>
          <span>
            Medicines tagged <span className="mc-tag mc-extt">Ext</span> are from other doctors —
            shown for reference, not dispensed by the Gini pharmacy.
          </span>
        </div>
      )}
    </section>
  );
}
