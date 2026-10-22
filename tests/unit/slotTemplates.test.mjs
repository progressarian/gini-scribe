import test from "node:test";
import assert from "node:assert/strict";
import { SLOT_CATALOG_LABELS } from "./slotCatalog.fixture.mjs";
import {
  dayPlan,
  slotsFor,
  validateTemplate,
  formatTime,
  slotLabel,
  toMinutes,
  weekdayOf,
} from "../../shared/slotTemplates.js";

const TUE = "2026-10-27";
const WED = "2026-10-28";
const SUN = "2026-10-25";

const labels = (template, date = TUE) => slotsFor(template, date).map((s) => s.label);
const starts = (template, date = TUE) => slotsFor(template, date).map((s) => s.start);
const day = (weekday, start, end, slotMinutes) => ({ weekday, start, end, slotMinutes });
const weekdays = (start, end, slotMinutes) =>
  [1, 2, 3, 4, 5, 6].map((d) => day(d, start, end, slotMinutes));
const fields = (template) => validateTemplate(template).map((e) => e.field);
const messages = (template) => validateTemplate(template).map((e) => e.message);

test("times parse and format the way stored labels read", () => {
  assert.equal(toMinutes("09:30"), 570);
  assert.equal(toMinutes("09:30:00"), 570);
  assert.equal(toMinutes("24:00"), null);
  assert.equal(toMinutes("9.30"), null);
  assert.equal(formatTime(570), "9:30 AM");
  assert.equal(formatTime(720), "12 PM");
  assert.equal(formatTime(0), "12 AM");
  assert.equal(formatTime(1440), "12 AM");
  assert.equal(formatTime(680), "11:20 AM");
  assert.equal(slotLabel(570, 600), "9:30 AM to 10 AM");
  assert.equal(slotLabel(1380, 1440), "11 PM to 12 AM");
  assert.equal(slotLabel(720, 750), "12 PM to 12:30 PM");
});

test("weekday comes from the calendar date, not the clock", () => {
  assert.equal(weekdayOf(SUN), 0);
  assert.equal(weekdayOf(TUE), 2);
  assert.equal(weekdayOf("2026-10-27T23:30:00+05:30"), 2);
  assert.equal(weekdayOf("not a date"), null);
});

for (const minutes of [15, 20, 30, 45, 60]) {
  test(`a 9:30–13:30 window cuts into ${minutes}-minute slots`, () => {
    const t = { hours: weekdays("09:30", "13:30", minutes) };
    const slots = slotsFor(t, TUE);
    assert.equal(slots.length, Math.floor(240 / minutes));
    assert.equal(slots[0].start, "09:30");
    for (const s of slots) assert.equal(s.endMin - s.startMin, minutes);
  });
}

test("a day with no hours is a day off", () => {
  const plan = dayPlan({ hours: weekdays("09:30", "13:30", 30) }, SUN);
  assert.equal(plan.off, true);
  assert.deepEqual(plan.slots, []);
});

test("slots restart when a break ends", () => {
  const t = {
    hours: weekdays("09:30", "13:30", 30),
    breaks: [{ weekday: null, name: "Tea", start: "11:00", end: "11:15" }],
  };
  assert.deepEqual(starts(t), ["09:30", "10:00", "10:30", "11:15", "11:45", "12:15", "12:45"]);
  assert.deepEqual(
    dayPlan(t, TUE).breaks.map((b) => [b.name, b.start, b.end]),
    [["Tea", "11:00", "11:15"]],
  );
});

test("the short piece before a break or window end is dropped, or kept when asked", () => {
  const base = {
    hours: weekdays("09:30", "13:30", 30),
    breaks: [{ weekday: null, name: "Tea", start: "11:00", end: "11:15" }],
  };
  assert.ok(!starts(base).includes("13:15"));
  const kept = slotsFor({ ...base, partialLast: "short" }, TUE);
  const last = kept[kept.length - 1];
  assert.equal(last.start, "13:15");
  assert.equal(last.end, "13:30");
  assert.equal(last.label, "1:15 PM to 1:30 PM");
});

test("breaks at the start and end of a window only trim it", () => {
  const t = {
    hours: weekdays("09:00", "13:00", 60),
    breaks: [
      { weekday: null, name: "Round", start: "09:00", end: "10:00" },
      { weekday: null, name: "Lunch", start: "12:00", end: "13:00" },
    ],
  };
  assert.deepEqual(labels(t), ["10 AM to 11 AM", "11 AM to 12 PM"]);
});

test("a break on one weekday leaves the others alone", () => {
  const t = {
    hours: weekdays("10:00", "12:00", 30),
    breaks: [{ weekday: 3, name: "Ward round", start: "11:00", end: "11:30" }],
  };
  assert.equal(slotsFor(t, TUE).length, 4);
  assert.deepEqual(starts(t, WED), ["10:00", "10:30", "11:30"]);
});

test("two windows in a day each keep their own slot length", () => {
  const t = { hours: [day(2, "09:30", "11:30", 20), day(2, "17:00", "19:00", 60)] };
  const slots = slotsFor(t, TUE);
  assert.deepEqual(
    slots.map((s) => [s.start, s.windowIndex]),
    [
      ["09:30", 0],
      ["09:50", 0],
      ["10:10", 0],
      ["10:30", 0],
      ["10:50", 0],
      ["11:10", 0],
      ["17:00", 1],
      ["18:00", 1],
    ],
  );
  assert.equal(slots[1].label, "9:50 AM to 10:10 AM");
});

test("the 24-hour catalog — 30 min 9:00–17:00, hourly overnight — is reproduced exactly", () => {
  const catalog = SLOT_CATALOG_LABELS;
  const t = { hours: [day(2, "09:00", "17:00", 30), day(2, "17:00", "09:00", 60)] };
  assert.equal(catalog.length, 32);
  assert.deepEqual(new Set(labels(t)), new Set(catalog));
  assert.equal(labels(t).length, catalog.length);
});

test("an overnight window belongs to the day it starts and runs past midnight", () => {
  const t = { hours: [day(2, "22:00", "02:00", 60)] };
  const slots = slotsFor(t, TUE);
  assert.deepEqual(
    slots.map((s) => [s.start, s.nextDay]),
    [
      ["22:00", false],
      ["23:00", false],
      ["00:00", true],
      ["01:00", true],
    ],
  );
  assert.equal(slots[2].label, "12 AM to 1 AM");
  assert.deepEqual(slotsFor(t, WED), []);
});

test("a break after midnight cuts an overnight window", () => {
  const t = {
    hours: [day(2, "22:00", "02:00", 60)],
    breaks: [{ weekday: 2, name: "Rest", start: "00:00", end: "01:00" }],
  };
  assert.deepEqual(starts(t), ["22:00", "23:00", "01:00"]);
  assert.deepEqual(validateTemplate(t), []);
});

test("a sound template validates cleanly", () => {
  assert.deepEqual(
    validateTemplate({
      partialLast: "drop",
      hours: [...weekdays("09:30", "13:30", 30), day(2, "17:00", "20:00", 60)],
      breaks: [
        { weekday: null, name: "Lunch", start: "13:00", end: "13:30" },
        { weekday: 3, name: "Ward round", start: "11:00", end: "11:30" },
      ],
    }),
    [],
  );
});

test("validation: hours", () => {
  assert.deepEqual(fields({ hours: [] }), ["hours"]);
  assert.ok(fields({ hours: [day(9, "09:00", "10:00", 30)] }).includes("hours.0.weekday"));
  assert.ok(fields({ hours: [day(2, "", "10:00", 30)] }).includes("hours.0.start"));
  assert.ok(fields({ hours: [day(2, "10:00", "10:00", 30)] }).includes("hours.0.end"));
  for (const bad of [4, 241, 12.5, "x"])
    assert.ok(fields({ hours: [day(2, "09:00", "13:00", bad)] }).includes("hours.0.slotMinutes"));
  assert.ok(
    fields({ partialLast: "maybe", hours: weekdays("09:00", "10:00", 30) }).includes("partialLast"),
  );
});

test("validation: windows on one day must not overlap", () => {
  const errs = messages({ hours: [day(2, "09:00", "13:00", 30), day(2, "12:00", "15:00", 30)] });
  assert.equal(errs.length, 1);
  assert.match(errs[0], /Tue: 12 PM–3 PM overlaps 9 AM–1 PM/);
});

test("validation: an overnight window may not run into the next day's first window", () => {
  const errs = messages({ hours: [day(2, "20:00", "02:00", 60), day(3, "01:00", "05:00", 60)] });
  assert.equal(errs.length, 1);
  assert.match(errs[0], /Wed: 1 AM–5 AM starts before Tue's overnight hours end at 2 AM/);
  assert.deepEqual(
    validateTemplate({ hours: [day(2, "20:00", "02:00", 60), day(3, "02:00", "05:00", 60)] }),
    [],
  );
});

test("validation: at most four windows a day", () => {
  const hours = ["06:00", "08:00", "10:00", "12:00", "14:00"].map((s) =>
    day(2, s, toClockPlus(s, 60), 30),
  );
  assert.ok(messages({ hours }).some((m) => /at most 4 working windows/.test(m)));
});

function toClockPlus(time, add) {
  const m = toMinutes(time) + add;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

test("validation: breaks", () => {
  const hours = weekdays("09:30", "13:30", 30);
  assert.ok(
    fields({ hours, breaks: [{ name: " ", start: "11:00", end: "11:15" }] }).includes(
      "breaks.0.name",
    ),
  );
  assert.ok(
    fields({ hours, breaks: [{ name: "x".repeat(41), start: "11:00", end: "11:15" }] }).includes(
      "breaks.0.name",
    ),
  );
  assert.ok(
    fields({ hours, breaks: [{ name: "Tea", start: "11:00", end: "11:00" }] }).includes(
      "breaks.0.end",
    ),
  );
  assert.ok(
    fields({ hours, breaks: [{ weekday: 8, name: "Tea", start: "11:00", end: "11:15" }] }).includes(
      "breaks.0.weekday",
    ),
  );
  assert.match(
    messages({ hours, breaks: [{ weekday: 0, name: "Tea", start: "11:00", end: "11:15" }] })[0],
    /Tea: Sun is a day off/,
  );
  assert.match(
    messages({
      hours,
      breaks: [{ weekday: 3, name: "Ward round", start: "13:15", end: "13:45" }],
    })[0],
    /Ward round \(1:15 PM–1:45 PM\) runs outside the working hours 9:30 AM–1:30 PM/,
  );
  assert.match(
    messages({ hours, breaks: [{ name: "Lunch", start: "13:00", end: "14:00" }] })[0],
    /Lunch \(1 PM–2 PM\) runs past the working hours on Mon, Tue, Wed, Thu, Fri, Sat/,
  );
  assert.match(
    messages({ hours, breaks: [{ name: "Tea", start: "16:00", end: "16:15" }] })[0],
    /outside the working hours on every day/,
  );
});

test("validation: an every-day break that fits some days and misses others is fine", () => {
  const t = {
    hours: [
      ...[1, 2, 3, 4, 5].map((d) => day(d, "09:30", "17:00", 30)),
      day(6, "09:30", "12:30", 30),
    ],
    breaks: [{ name: "Lunch", start: "13:00", end: "14:00" }],
  };
  assert.deepEqual(validateTemplate(t), []);
  assert.equal(dayPlan(t, "2026-10-31").breaks.length, 0);
  assert.equal(dayPlan(t, TUE).breaks.length, 1);
});

test("validation: a working day must leave room for at least one full slot", () => {
  const errs = messages({ hours: [day(2, "09:00", "09:20", 30)] });
  assert.equal(errs.length, 1);
  assert.match(errs[0], /Tue: these hours and breaks leave no room for a full slot/);
  assert.deepEqual(
    validateTemplate({ partialLast: "short", hours: [day(2, "09:00", "09:20", 30)] }),
    [],
  );
});

test("validation: at most ten breaks a day", () => {
  const breaks = Array.from({ length: 11 }, (_, i) => ({
    weekday: 2,
    name: `B${i}`,
    start: toClockPlus("08:00", i * 30),
    end: toClockPlus("08:00", i * 30 + 5),
  }));
  assert.ok(
    messages({ hours: [day(2, "08:00", "18:00", 5)], breaks }).some((m) =>
      /at most 10 breaks/.test(m),
    ),
  );
});

test("validation: working hours are optional only when asked for", () => {
  assert.deepEqual(validateTemplate({ hours: [] }, { requireHours: false }), []);
  assert.deepEqual(fields({ hours: [] }), ["hours"]);
});
