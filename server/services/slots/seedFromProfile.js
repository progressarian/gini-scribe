import { dayPlan, toClock, toMinutes, validateTemplate } from "../../../shared/slotTemplates.js";
import { profileSlotState } from "./profileRules.js";

export const SEED_BREAK_NAME = "Lunch";

const REFERENCE_SUNDAY = Date.UTC(2026, 0, 4);
const dateForWeekday = (weekday) =>
  new Date(REFERENCE_SUNDAY + weekday * 86400000).toISOString().slice(0, 10);

const lengthOf = (slot) => (slot.end - slot.start + 1440) % 1440 || 1440;

const asSlots = (catalog) =>
  catalog
    .map((c) => ({ label: c.label, start: toMinutes(c.start_time), end: toMinutes(c.end_time) }))
    .filter((c) => c.start != null && c.end != null)
    .sort((a, b) => a.start - b.start);

const runs = (slots) => {
  const out = [];
  for (const s of slots) {
    const last = out[out.length - 1];
    if (last && last.end % 1440 === s.start && last.minutes === lengthOf(s)) last.end = s.end;
    else out.push({ start: s.start, end: s.end, minutes: lengthOf(s) });
  }
  return out;
};

const stateOn = (profile, weekday, slots) =>
  slots.map((s) => ({ ...s, state: profileSlotState(profile, weekday, toClock(s.start)) }));

export function seedTemplateFromProfile(profile, catalog) {
  const slots = asSlots(catalog);
  const hours = [];
  let breakRuns = null;

  for (let weekday = 0; weekday < 7; weekday += 1) {
    const marked = stateOn(profile, weekday, slots);
    const working = marked.filter((s) => s.state === null || s.state === "break");
    for (const r of runs(working))
      hours.push({ weekday, start: toClock(r.start), end: toClock(r.end), slotMinutes: r.minutes });
    if (working.length && !breakRuns) breakRuns = runs(marked.filter((s) => s.state === "break"));
  }

  return {
    partialLast: "drop",
    hours,
    breaks: (breakRuns || []).map((r) => ({
      weekday: null,
      name: SEED_BREAK_NAME,
      start: toClock(r.start),
      end: toClock(r.end),
    })),
  };
}

export function compareWithProfile(profile, catalog, template) {
  const slots = asSlots(catalog);
  const mismatches = [];
  for (let weekday = 0; weekday < 7; weekday += 1) {
    const marked = stateOn(profile, weekday, slots);
    const before = marked.filter((s) => s.state === null).map((s) => s.label);
    const beforeBreak = marked.filter((s) => s.state === "break").map((s) => s.label);
    const plan = dayPlan(template, dateForWeekday(weekday));
    const after = plan.slots.map((s) => s.label);
    const afterBreak = slots
      .filter((s) =>
        plan.breaks.some((b) =>
          [s.start, s.start + 1440].some((t) => t >= b.startMin && t < b.endMin),
        ),
      )
      .map((s) => s.label);
    const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
    const sortedBefore = [...before].sort();
    const sortedAfter = [...after].sort();
    if (!same(sortedBefore, sortedAfter))
      mismatches.push({
        weekday,
        kind: "slots",
        onlyBefore: before.filter((l) => !after.includes(l)),
        onlyAfter: after.filter((l) => !before.includes(l)),
      });
    if (!same([...beforeBreak].sort(), [...afterBreak].sort()))
      mismatches.push({ weekday, kind: "break", before: beforeBreak, after: afterBreak });
  }
  return mismatches;
}

export function planSeed(profile, catalog) {
  const template = seedTemplateFromProfile(profile, catalog);
  const errors = validateTemplate(template, { requireHours: false });
  const mismatches = errors.length ? [] : compareWithProfile(profile, catalog, template);
  return { template, errors, mismatches, ok: !errors.length && !mismatches.length };
}
