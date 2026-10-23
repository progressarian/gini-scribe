import { useMemo, useState } from "react";
import {
  CAP_KEYS,
  PATIENT_TYPES,
  PATIENT_TYPE_LABELS,
  hasCaps,
} from "../../../shared/slotCapacity";
import { WEEKDAY_NAMES, dayPlan, formatTime } from "../../../shared/slotTemplates";
import SlotLimitsPanel from "./SlotLimitsPanel";

const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];
const REFERENCE_SUNDAY = Date.UTC(2026, 0, 4);
const dateOfWeekday = (weekday) =>
  new Date(REFERENCE_SUNDAY + weekday * 86400000).toISOString().slice(0, 10);

const SHORT = { walkin: "W", new: "N", followup: "F", within3: "3D" };

export const plansByWeekday = (template) =>
  new Map(WEEK_ORDER.map((w) => [w, dayPlan(template, dateOfWeekday(w))]));

export const liveSlotCaps = (template) => {
  const plans = plansByWeekday(template);
  return (template.slotCaps || []).filter((c) =>
    plans.get(Number(c.weekday))?.slots.some((s) => s.start === c.start),
  );
};

const capsText = (caps) =>
  hasCaps(caps)
    ? PATIENT_TYPES.filter((t) => caps[t] != null)
        .map((t) => `${SHORT[t]} ${caps[t]}`)
        .join(" · ")
    : "No limit";

const capsSpoken = (caps) =>
  hasCaps(caps)
    ? PATIENT_TYPES.filter((t) => caps[t] != null)
        .map((t) => `${PATIENT_TYPE_LABELS[t]} ${caps[t]}`)
        .join(", ")
    : "no limit";

const toRow = (weekday, start, caps) => ({
  weekday,
  start,
  ...Object.fromEntries(PATIENT_TYPES.map((t) => [CAP_KEYS[t], caps[t]])),
});

export default function SlotGrid({ template, onChange, readOnly = false, doctorName }) {
  const [open, setOpen] = useState(null);
  const plans = useMemo(() => plansByWeekday(template), [template]);
  const days = WEEK_ORDER.filter((w) => !plans.get(w).off);
  const starts = useMemo(() => {
    const byStart = new Map();
    for (const w of days)
      for (const s of plans.get(w).slots)
        if (!byStart.has(s.start)) byStart.set(s.start, { start: s.start, at: s.startMin });
    return [...byStart.values()].sort((a, b) => a.at - b.at);
  }, [plans]);

  if (!days.length)
    return <p className="docmgmt-empty">Tick at least one working day to see its slots.</p>;

  const slotAt = (weekday, start) => plans.get(weekday).slots.find((s) => s.start === start);
  const cell = open && slotAt(open.weekday, open.start);
  const title = cell ? `${WEEKDAY_NAMES[open.weekday]} ${cell.label}` : "";
  const day = open && WEEKDAY_NAMES[open.weekday];
  const at = cell && formatTime(cell.startMin);

  const targets = (scope) => {
    if (scope === "slot") return [[open.weekday, open.start]];
    if (scope === "day") return plans.get(open.weekday).slots.map((s) => [open.weekday, s.start]);
    if (scope === "time")
      return days.filter((w) => slotAt(w, open.start)).map((w) => [w, open.start]);
    return days.flatMap((w) => plans.get(w).slots.map((s) => [w, s.start]));
  };

  const write = (scope, caps) => {
    const hit = new Set(targets(scope).map(([w, s]) => `${w}|${s}`));
    const kept = (template.slotCaps || []).filter((c) => !hit.has(`${c.weekday}|${c.start}`));
    const added = caps ? targets(scope).map(([w, s]) => toRow(w, s, caps)) : [];
    onChange([...kept, ...added]);
    setOpen(null);
  };

  return (
    <div className="docmgmt-slotgrid">
      <p className="docmgmt-hint">
        W Walk-in · N New · F Follow-up · 3D Within 3 days.{" "}
        {readOnly ? "" : "Click a slot to set how many patients of each type it can take."}
      </p>
      <div className="docmgmt-hourswrap">
        <table className="docmgmt-gridtable" aria-label="Patients per slot, by day">
          <thead>
            <tr>
              <th scope="col">Slot</th>
              {days.map((w) => (
                <th key={w} scope="col">
                  {WEEKDAY_NAMES[w]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {starts.map(({ start, at: minute }) => (
              <tr key={start}>
                <th scope="row">{formatTime(minute)}</th>
                {days.map((w) => {
                  const s = slotAt(w, start);
                  if (!s)
                    return (
                      <td key={w} className="docmgmt-gridnone">
                        —
                      </td>
                    );
                  const own = s.capSource === "slot";
                  const text = capsText(s.caps);
                  const name = `${WEEKDAY_NAMES[w]} ${s.label}: ${capsSpoken(s.caps)}`;
                  return (
                    <td key={w}>
                      {readOnly ? (
                        <span className={`docmgmt-gridcell${own ? " is-own" : ""}`} title={name}>
                          {text}
                        </span>
                      ) : (
                        <button
                          type="button"
                          className={`docmgmt-gridcell${own ? " is-own" : ""}`}
                          aria-label={`Set patients per slot for ${name}`}
                          aria-pressed={open?.weekday === w && open?.start === start}
                          onClick={() => setOpen({ weekday: w, start })}
                        >
                          {text}
                        </button>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!readOnly && cell && (
        <SlotLimitsPanel
          key={title}
          title={title}
          context={doctorName}
          note="Weekly schedule · repeats every week once saved"
          caps={cell.caps}
          scopes={[
            ["slot", "This slot only", 1],
            ["day", `Every slot on ${day}`, targets("day").length],
            ["time", `${at} on every day`, targets("time").length],
            ["week", "Every slot this week", targets("week").length],
          ]}
          resetLabel="Reset to the hours default"
          onReset={(scope) => write(scope, null)}
          onApply={({ caps, scope }) => write(scope, caps)}
          onCancel={() => setOpen(null)}
        />
      )}
    </div>
  );
}
