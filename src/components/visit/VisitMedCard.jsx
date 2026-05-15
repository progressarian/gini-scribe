import { memo, useRef, useCallback, useMemo } from "react";
import { MED_COLORS } from "./helpers";
import { TIME_SLOTS, printMedCard, getTimeSlots } from "./medCardPrint";
import { formatWhenToTake } from "../../config/medicationTimings";
import { cleanNote } from "../../utils/cleanNote";

// Groups pre-indexed meds by time slot without overwriting _idx
function groupBySlot(meds) {
  const g = {};
  meds.forEach((m) => {
    getTimeSlots(m).forEach((slot) => {
      (g[slot] ||= []).push(m);
    });
  });
  return {
    grouped: g,
    slotsWithMeds: TIME_SLOTS.filter((s) => g[s.key]?.length > 0),
  };
}

function MedRow({ m }) {
  return (
    <div className="mtr" style={{ marginTop: 5 }}>
      <div className="mmain">
        <div className="mdot" style={{ background: MED_COLORS[m._idx % MED_COLORS.length] }} />
        <div>
          <div className="mbrand">{m.name}</div>
          <div className="mgen">{m.composition || cleanNote(m.notes) || ""}</div>
        </div>
      </div>
      <div className="mtd">{m.dose || "1 tablet"}</div>
      <div className="mtd">
        {m.frequency || "OD"}
        {(() => {
          const wt = formatWhenToTake(m.when_to_take);
          // Patient-facing pills take precedence; fall back to the doctor's
          // free-text timing note so meds with no canonical pills still
          // show *something* useful on the card.
          const display = wt || m.timing || "";
          return display ? ` · ${display}` : "";
        })()}
        {m.instructions ? (
          <div style={{ fontSize: 11, color: "var(--t3)", marginTop: 2 }}>{m.instructions}</div>
        ) : null}
      </div>
      <div>{m.indication && <span className="mfor">{m.indication}</span>}</div>
    </div>
  );
}

const VisitMedCard = memo(function VisitMedCard({ patient, activeMeds }) {
  const cardRef = useRef(null);

  const mainMeds = useMemo(
    () =>
      (activeMeds || []).filter((m) => !m.parent_medication_id && m.visit_status !== "previous"),
    [activeMeds],
  );

  const indexedMeds = useMemo(() => mainMeds.map((m, i) => ({ ...m, _idx: i })), [mainMeds]);

  const { grouped, slotsWithMeds } = useMemo(() => groupBySlot(indexedMeds), [indexedMeds]);

  const handlePrint = useCallback(() => {
    printMedCard(patient, mainMeds);
  }, [patient, mainMeds]);

  return (
    <div className="panel-body">
      <div className="sc">
        <div className="sch">
          <div className="sct">
            <div className="sci ic-g">💊</div>Medicine Card — Patient Language
          </div>
          <button className="btn" onClick={handlePrint}>
            🖨 Print Card
          </button>
        </div>
        <div className="scb" ref={cardRef}>
          {mainMeds.length > 1 && (
            <div style={{ fontSize: 13, fontWeight: 600, color: "var(--t2)", marginBottom: 14 }}>
              {patient.name} ji, apni dawaiyan roz iss tarah leni hain:
            </div>
          )}

          {slotsWithMeds.map((slot) => (
            <div key={slot.key} className="mc-mg" style={{ marginBottom: 12 }}>
              <div
                style={{
                  fontSize: 10,
                  fontWeight: 700,
                  color: `var(${slot.colorVar})`,
                  textTransform: "uppercase",
                  letterSpacing: ".5px",
                  marginBottom: 6,
                  padding: "5px 10px",
                  background: `var(--${slot.bgCls})`,
                  borderRadius: 6,
                  display: "inline-block",
                  ...(slot.border ? { border: "1px solid var(--border)" } : {}),
                }}
              >
                {slot.emoji} {slot.label}
              </div>
              {grouped[slot.key].map((m) => (
                <MedRow key={m.id || m._idx} m={m} />
              ))}
            </div>
          ))}

          {slotsWithMeds.length === 0 &&
            indexedMeds.map((m) => <MedRow key={m.id || m._idx} m={m} />)}

          {mainMeds.length === 0 && (
            <div style={{ fontSize: 13, color: "var(--t3)", padding: 20, textAlign: "center" }}>
              No active medications
            </div>
          )}

          <div className="noticebar pri" style={{ marginTop: 10 }}>
            <span>📞</span>
            <span className="ni pri">
              Koi problem ho? Gini Health se contact karein: +91 8146320100 (WhatsApp available)
            </span>
          </div>
        </div>
      </div>
    </div>
  );
});

// Re-export util members so existing callers (e.g. VisitPlan.jsx) keep working
export { TIME_SLOTS, groupMedsBySlot, printMedCard } from "./medCardPrint";
export { getTimeSlots, getTimeSlot, buildMedCardPrintHTML } from "./medCardPrint";

export default VisitMedCard;
