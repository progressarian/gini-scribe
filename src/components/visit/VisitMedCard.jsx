import { memo, useRef, useCallback, useMemo } from "react";
import { MED_COLORS } from "./helpers";
import { TIME_SLOTS, groupMedsBySlot, printMedCard } from "./medCardPrint";
import { cleanNote } from "../../utils/cleanNote";

const VisitMedCard = memo(function VisitMedCard({ patient, activeMeds }) {
  const cardRef = useRef(null);

  const mainMeds = useMemo(
    () => (activeMeds || []).filter((m) => !m.parent_medication_id),
    [activeMeds],
  );

  const { grouped, slotsWithMeds } = groupMedsBySlot(mainMeds);

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
                <div key={m.id || m._idx} className="mtr" style={{ marginTop: 5 }}>
                  <div className="mmain">
                    <div
                      className="mdot"
                      style={{ background: MED_COLORS[m._idx % MED_COLORS.length] }}
                    />
                    <div>
                      <div className="mbrand">{m.name}</div>
                      <div className="mgen">{m.composition || cleanNote(m.notes) || ""}</div>
                    </div>
                  </div>
                  <div className="mtd">{m.dose || "1 tablet"}</div>
                  <div className="mtd">
                    {m.frequency || "OD"}
                    {m.timing ? ` · ${m.timing}` : ""}
                  </div>
                  <div>{m.indication && <span className="mfor">{m.indication}</span>}</div>
                  <div />
                </div>
              ))}
            </div>
          ))}

          {slotsWithMeds.length === 0 &&
            mainMeds.length > 0 &&
            mainMeds.map((m, i) => (
              <div key={m.id || i} className="mtr" style={{ marginBottom: 5 }}>
                <div className="mmain">
                  <div className="mdot" style={{ background: MED_COLORS[i % MED_COLORS.length] }} />
                  <div>
                    <div className="mbrand">{m.name}</div>
                    <div className="mgen">{m.composition || ""}</div>
                  </div>
                </div>
                <div className="mtd">{m.dose || ""}</div>
                <div className="mtd">
                  {m.frequency || "OD"}
                  {m.timing ? ` · ${m.timing}` : ""}
                </div>
                <div>{m.indication && <span className="mfor">{m.indication}</span>}</div>
                <div />
              </div>
            ))}

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
