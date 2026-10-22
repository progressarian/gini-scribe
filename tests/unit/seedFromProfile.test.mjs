import test from "node:test";
import assert from "node:assert/strict";
import { slotStartTime } from "../../shared/slotHour.js";
import { SLOT_CATALOG_LABELS } from "./slotCatalog.fixture.mjs";
import { slotsFor, validateTemplate } from "../../shared/slotTemplates.js";
import { planSeed } from "../../server/services/slots/seedFromProfile.js";
import { profileFromRow } from "../../server/services/slots/profileRules.js";

const CATALOG = SLOT_CATALOG_LABELS.map((label) => {
  const [from, to] = label.split(" to ");
  return { label, start_time: slotStartTime(from), end_time: slotStartTime(to) };
});

const TUE = "2026-10-27";
const SUN = "2026-10-25";
const SAT = "2026-10-31";

const seed = (row) => planSeed(profileFromRow(row), CATALOG);

const assertSound = (result) => {
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.mismatches, []);
  assert.equal(result.ok, true);
};

test("the catalog fixture is today's 32 slots with real times", () => {
  assert.equal(CATALOG.length, 32);
  assert.ok(CATALOG.every((c) => c.start_time && c.end_time));
});

test("no profile row: 24 hours, Sunday off, every catalog slot — same as today", () => {
  const r = seed(null);
  assertSound(r);
  assert.equal(slotsFor(r.template, TUE).length, 32);
  assert.equal(slotsFor(r.template, SUN).length, 0);
  assert.deepEqual(
    r.template.hours.filter((h) => h.weekday === 2),
    [
      { weekday: 2, start: "00:00", end: "09:00", slotMinutes: 60 },
      { weekday: 2, start: "09:00", end: "17:00", slotMinutes: 30 },
      { weekday: 2, start: "17:00", end: "00:00", slotMinutes: 60 },
    ],
  );
  assert.deepEqual(r.template.breaks, []);
});

test("clinic hours with a lunch: the lunch becomes a named break", () => {
  const r = seed({
    off_weekdays: [0],
    work_start: "09:30:00",
    work_end: "17:00:00",
    lunch_start: "13:00:00",
    lunch_end: "14:00:00",
  });
  assertSound(r);
  assert.deepEqual(r.template.breaks, [
    { weekday: null, name: "Lunch", start: "13:00", end: "14:00" },
  ]);
  const labels = slotsFor(r.template, TUE).map((s) => s.label);
  assert.equal(labels[0], "9:30 AM to 10 AM");
  assert.ok(!labels.includes("1 PM to 1:30 PM"));
  assert.ok(!labels.includes("1:30 PM to 2 PM"));
  assert.equal(labels[labels.length - 1], "4:30 PM to 5 PM");
});

test("custom off days carry over", () => {
  const r = seed({ off_weekdays: [0, 6], work_start: "10:00", work_end: "14:00" });
  assertSound(r);
  assert.equal(slotsFor(r.template, SAT).length, 0);
  assert.equal(slotsFor(r.template, TUE).length, 8);
});

test("an odd start time snaps to the catalog slots it already offered", () => {
  const r = seed({ off_weekdays: [0], work_start: "09:45", work_end: "13:15" });
  assertSound(r);
  const labels = slotsFor(r.template, TUE).map((s) => s.label);
  assert.equal(labels[0], "10 AM to 10:30 AM");
  assert.equal(labels[labels.length - 1], "1 PM to 1:30 PM");
});

test("a night shift past midnight keeps the early-morning slots on the same date", () => {
  const r = seed({ off_weekdays: [0], work_start: "17:00", work_end: "01:00" });
  assertSound(r);
  const labels = slotsFor(r.template, TUE).map((s) => s.label);
  assert.deepEqual(labels.sort(), [
    "10 PM to 11 PM",
    "11 PM to 12 AM",
    "12 AM to 1 AM",
    "5 PM to 6 PM",
    "6 PM to 7 PM",
    "7 PM to 8 PM",
    "8 PM to 9 PM",
    "9 PM to 10 PM",
  ]);
});

test("a lunch across the 30-minute / hourly boundary splits into two breaks", () => {
  const r = seed({
    off_weekdays: [0],
    work_start: "09:00",
    work_end: "20:00",
    lunch_start: "16:30",
    lunch_end: "18:00",
  });
  assertSound(r);
  assert.deepEqual(
    r.template.breaks.map((b) => [b.start, b.end]),
    [
      ["16:30", "17:00"],
      ["17:00", "18:00"],
    ],
  );
});

test("only a start time set: the old rule treats it as all day, and so does the seed", () => {
  const r = seed({ off_weekdays: [0], work_start: "10:00", work_end: null });
  assertSound(r);
  assert.equal(slotsFor(r.template, TUE).length, 32);
});

test("hours that leave no full slot are reported, not seeded", () => {
  const r = seed({
    off_weekdays: [0],
    work_start: "13:00",
    work_end: "14:00",
    lunch_start: "13:00",
    lunch_end: "14:00",
  });
  assert.equal(r.ok, false);
  assert.ok(r.errors.length > 0);
});

test("every seeded template passes the same validation the editor will use", () => {
  for (const row of [
    null,
    {
      off_weekdays: [0, 3],
      work_start: "08:00",
      work_end: "18:30",
      lunch_start: "12:30",
      lunch_end: "13:30",
    },
    { off_weekdays: [], work_start: "18:00", work_end: "06:00" },
  ]) {
    const r = seed(row);
    assert.deepEqual(validateTemplate(r.template), []);
    assertSound(r);
  }
});

test("the before/after check catches a template that differs from the profile", async () => {
  const { compareWithProfile } = await import("../../server/services/slots/seedFromProfile.js");
  const profile = profileFromRow({
    off_weekdays: [0],
    work_start: "09:30",
    work_end: "17:00",
    lunch_start: "13:00",
    lunch_end: "14:00",
  });
  const good = planSeed(profile, CATALOG).template;
  const shorter = {
    ...good,
    hours: good.hours.map((h) => (h.weekday === 2 ? { ...h, end: "16:00" } : h)),
  };
  const noLunch = { ...good, breaks: [] };
  const extraDay = {
    ...good,
    hours: [...good.hours, { weekday: 0, start: "10:00", end: "11:00", slotMinutes: 30 }],
  };
  const tue = compareWithProfile(profile, CATALOG, shorter).find((m) => m.weekday === 2);
  assert.deepEqual(tue.onlyBefore, ["4 PM to 4:30 PM", "4:30 PM to 5 PM"]);
  assert.ok(compareWithProfile(profile, CATALOG, noLunch).some((m) => m.kind === "slots"));
  assert.ok(compareWithProfile(profile, CATALOG, noLunch).some((m) => m.kind === "break"));
  assert.ok(compareWithProfile(profile, CATALOG, extraDay).some((m) => m.weekday === 0));
});

test("a doctor marked off every day seeds an empty schedule instead of failing", () => {
  const r = seed({ off_weekdays: [0, 1, 2, 3, 4, 5, 6] });
  assertSound(r);
  assert.deepEqual(r.template.hours, []);
  assert.equal(slotsFor(r.template, TUE).length, 0);
});
