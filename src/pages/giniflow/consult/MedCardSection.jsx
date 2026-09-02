import { useState } from "react";
import api from "../../../services/api";
import { useMedicineCard } from "../../../queries/hooks/useGiniflowPrescription";

// Medicine card — gini-doctor-final.html `s-medcard`.
//
// A computed view, never a table: active medications grouped by timing and
// sorted by the clock. The same `buildCard` powers the consultant's card, the
// pharmacy's, the printed one and the patient's MHG card — four implementations
// of a dosing schedule would be four chances to tell a patient the wrong time.

// The prototype colours each pill by therapeutic group — BP amber, lipids
// purple, diabetes blue. `medications.med_group` carries that, and it is
// populated on 6 rows out of 124,000, so colouring by it would be a guess
// dressed as information. These are the three things the card actually knows,
// and they are the three a patient needs to see: whose medicine it is, whether
// it changed today, and whether the pharmacy has it.
const pillClass = (m) => {
  if (m.external) return "mcp-ext";
  if (m.changeType === "new") return "mcp-s";
  if (m.changeType === "changed") return "mcp-b";
  if (m.stock?.out) return "mcp-out";
  return "mcp-p";
};

export default function MedCardSection({ visitId, onToast }) {
  const { data, isLoading } = useMedicineCard(visitId);
  const [printing, setPrinting] = useState(false);

  // Rendered on the server from the same `buildCard` this screen uses, so the
  // printed card and the screen cannot disagree about when to take a medicine.
  // Fetched through the authenticated client and opened as a blob — a PDF URL
  // carrying a token would put the session in the browser's history.
  const print = async () => {
    setPrinting(true);
    try {
      const res = await api.get(`/api/giniflow/stations/doctor/${visitId}/medicine-card.pdf`, {
        responseType: "blob",
      });
      const url = URL.createObjectURL(new Blob([res.data], { type: "application/pdf" }));
      const win = window.open(url, "_blank", "noopener");
      if (!win) onToast?.("Allow pop-ups to open the printable card.");
      // Revoked late: too early and the new tab has nothing to load.
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch {
      onToast?.("Could not build the printable card.");
    } finally {
      setPrinting(false);
    }
  };

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
            disabled={!data?.groups?.length || printing}
            onClick={print}
          >
            {printing ? "Building…" : "Print"}
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

      {(data?.groups || []).length > 0 && (
        <div className="med-card">
          {(data?.groups || []).map((g) => (
            <div className="mc-row" key={g.key}>
              <div className="mc-time">
                <div className="mc-tl">{g.label}</div>
                {g.timeLabel && <div className="mc-ts">{g.timeLabel}</div>}
              </div>
              <div className="mc-pills">
                {g.medicines.map((m) => (
                  <div className={`mc-pill ${pillClass(m)}`} key={m.medicationId}>
                    {m.name}
                    {m.external && <span className="ptag ptag-ext">Ext · {m.prescriber}</span>}
                    {m.changeType === "new" && <span className="ptag ptag-new">NEW</span>}
                    {m.changeType === "changed" && (
                      <span className="ptag ptag-ch">
                        {m.previousDose && m.dose ? `↑${m.dose}` : "CHANGED"}
                      </span>
                    )}
                    <span className="pnote">
                      {[m.dose, m.frequency].filter(Boolean).join(" · ")}
                      {m.stock?.out ? " · ✗ out of stock" : m.stock?.low ? " · ⚠ low stock" : ""}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

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
