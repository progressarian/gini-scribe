import { useEffect, useRef, useState } from "react";
import { VoiceButton } from "../../../components/giniflow/VoiceInput";
import ReferralChips from "./ReferralChips";

// Care plan — gini-doctor-final.html care-plan block.
//
// Five parts: treatment this visit, diet & lifestyle, referrals, next visit and
// goals. Referrals were the missing quarter — the prototype's care plan says
// "treatment · diet · tests · referrals · next visit" (19 §5).
// Goals are structured rather than prose because they are what the NEXT visit's
// in-control / worse classifier measures against (plan §8).
//
// Everything autosaves. A consultation interrupted by a phone call must lose
// nothing — the same rule Scribe's active_visits established.

const INTERVALS = ["2 weeks", "1 month", "~3 months", "6 months", "1 year"];

const emptyGoal = () => ({ test: "", target: "", unit: "" });

export default function CarePlanSection({
  consult,
  visitId,
  onSave,
  saving,
  readOnly,
  onToast,
  flushRef,
}) {
  // getConsult always sends an object, never null — but a blank consult screen
  // mid-clinic is a bad way to find out that changed.
  const saved = consult.carePlan || {};
  const [plan, setPlan] = useState(() => ({
    treatment: saved.treatment || "",
    lifestyle: saved.lifestyle || "",
    internalNote: saved.internal_note || saved.internalNote || "",
    nextVisitDate: saved.next_visit_date || "",
    nextVisitInterval: saved.next_visit_interval || "",
    goals: saved.goals?.length ? saved.goals : [emptyGoal()],
  }));
  const [savedAt, setSavedAt] = useState(null);
  const dirty = useRef(false);
  // Edits typed but not yet sent. The debounce clears it; leaving the page
  // flushes on it.
  const unsent = useRef(false);
  const payload = {
    ...plan,
    nextVisitDate: plan.nextVisitDate || null,
    goals: plan.goals.filter((g) => g.test.trim() && g.target.trim()),
  };
  const flush = useRef(null);
  flush.current = () => {
    if (readOnly || !unsent.current) return;
    unsent.current = false;
    onSave(payload);
  };

  // Debounced autosave rather than save-on-blur: a doctor who closes the tab
  // mid-sentence has still said something worth keeping.
  useEffect(() => {
    if (readOnly || !dirty.current) return undefined;
    const id = setTimeout(() => {
      unsent.current = false;
      onSave(payload, () => setSavedAt(Date.now()));
    }, 900);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plan, onSave, readOnly]);

  // Stepping out unmounts this section, and the pending timer died with it —
  // the last sentence typed was lost while the screen still read "Draft".
  useEffect(() => () => flush.current?.(), []);

  // "Save & step out" saves BEFORE it releases the room rather than relying on
  // the unmount above, so the order is the one the button promises.
  if (flushRef) flushRef.current = () => flush.current?.();

  const set = (field) => (e) => {
    dirty.current = true;
    unsent.current = true;
    setPlan((p) => ({ ...p, [field]: e.target.value }));
  };

  const setGoal = (i, field) => (e) => {
    dirty.current = true;
    unsent.current = true;
    setPlan((p) => {
      const goals = p.goals.map((g, gi) => (gi === i ? { ...g, [field]: e.target.value } : g));
      // Keep exactly one blank row at the end so adding a goal needs no button.
      if (i === goals.length - 1 && (goals[i].test || goals[i].target)) goals.push(emptyGoal());
      return { ...p, goals };
    });
  };

  return (
    <section className="csec" id="s-plan">
      <div className="cs-head">
        <h2>📝 Care plan</h2>
        <span className="cs-sub">
          treatment · diet · referrals · next visit
          {saving ? " · saving…" : savedAt ? " · saved" : ""}
        </span>
        {!readOnly && (
          <div className="cs-head-r">
            <VoiceButton
              small
              label="🎤 Dictate"
              title="Dictate the treatment plan"
              onText={(text) => {
                dirty.current = true;
                unsent.current = true;
                setPlan((prev) => ({
                  ...prev,
                  treatment: prev.treatment ? `${prev.treatment.trim()} ${text}` : text,
                }));
              }}
            />
          </div>
        )}
      </div>

      <label className="cp-lab" htmlFor="cp-treat">
        Treatment plan this visit
      </label>
      <textarea
        id="cp-treat"
        className="cp-text"
        rows={3}
        disabled={readOnly}
        value={plan.treatment}
        placeholder="e.g. Atchol 20→40mg — LDL 127 above target"
        onChange={set("treatment")}
      />

      <label className="cp-lab" htmlFor="cp-life">
        Diet &amp; lifestyle
      </label>
      <textarea
        id="cp-life"
        className="cp-text"
        rows={3}
        disabled={readOnly}
        value={plan.lifestyle}
        placeholder="What the patient should change before the next visit"
        onChange={set("lifestyle")}
      />

      <ReferralChips visitId={visitId} readOnly={readOnly} onToast={onToast} />

      <div className="cp-row">
        <div>
          <label className="cp-lab" htmlFor="cp-date">
            Next visit
          </label>
          <input
            id="cp-date"
            type="date"
            className="cp-inp"
            disabled={readOnly}
            value={plan.nextVisitDate || ""}
            onChange={set("nextVisitDate")}
          />
        </div>
        <div>
          <span className="cp-lab">Interval</span>
          <div className="cp-chips">
            {INTERVALS.map((iv) => (
              <button
                type="button"
                key={iv}
                disabled={readOnly}
                className={plan.nextVisitInterval === iv ? "on" : ""}
                onClick={() => {
                  dirty.current = true;
                  unsent.current = true;
                  setPlan((p) => ({ ...p, nextVisitInterval: iv }));
                }}
              >
                {iv}
              </button>
            ))}
          </div>
        </div>
      </div>

      <span className="cp-lab">
        Goals for next visit
        <em> — what the next visit measures against</em>
      </span>
      <div className="cp-goals">
        {plan.goals.map((g, i) => (
          <div className="cp-goal" key={i}>
            <input
              className="cp-inp"
              placeholder="HbA1c"
              aria-label="Test"
              disabled={readOnly}
              value={g.test}
              onChange={setGoal(i, "test")}
            />
            <input
              className="cp-inp"
              placeholder="<7.0"
              aria-label="Target"
              disabled={readOnly}
              value={g.target}
              onChange={setGoal(i, "target")}
            />
            <input
              className="cp-inp cp-unit"
              placeholder="%"
              aria-label="Unit"
              disabled={readOnly}
              value={g.unit || ""}
              onChange={setGoal(i, "unit")}
            />
          </div>
        ))}
      </div>

      <label className="cp-lab" htmlFor="cp-note">
        Doctor's internal note
        <em> — not shown to the patient</em>
      </label>
      <textarea
        id="cp-note"
        className="cp-text"
        rows={2}
        disabled={readOnly}
        value={plan.internalNote}
        onChange={set("internalNote")}
      />
    </section>
  );
}
