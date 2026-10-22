import test from "node:test";
import assert from "node:assert/strict";
import { templateDay, bookingMinute, labelSpan } from "../../server/services/slots/dayView.js";

const TUE = "2026-10-27";
const SUN = "2026-10-25";
const clinic = {
  partialLast: "drop",
  hours: [1, 2, 3, 4, 5, 6].map((weekday) => ({
    weekday,
    start: "09:30",
    end: "13:30",
    slotMinutes: 30,
  })),
  breaks: [{ weekday: null, name: "Tea", start: "11:00", end: "11:30" }],
};
const CATALOG = [
  { label: "9:30 AM to 10 AM", start_time: "09:30:00", end_time: "10:00:00" },
  { label: "10 AM to 10:30 AM", start_time: "10:00:00", end_time: "10:30:00" },
];
const day = (over = {}) => templateDay({ template: clinic, date: TUE, catalog: CATALOG, ...over });
const slot = (d, label) => d.slots.find((s) => s.slot_label === label);

test("booking times are read from every stored format", () => {
  assert.equal(bookingMinute("10 AM to 10:30 AM"), 600);
  assert.equal(bookingMinute("10:15"), 615);
  assert.equal(bookingMinute("05. 1-2PM"), 780);
  assert.equal(bookingMinute("02. 10-11AM"), 600);
  assert.equal(bookingMinute("call later"), null);
  assert.deepEqual(labelSpan("11 PM to 12 AM"), { s: 1380, e: 1440 });
});

test("slots come from the template, with the break listed by name", () => {
  const d = day();
  assert.deepEqual(
    d.slots.map((s) => [s.slot_label, s.blocked_by]),
    [
      ["9:30 AM to 10 AM", null],
      ["10 AM to 10:30 AM", null],
      ["10:30 AM to 11 AM", null],
      ["11 AM to 11:30 AM", "break"],
      ["11:30 AM to 12 PM", null],
      ["12 PM to 12:30 PM", null],
      ["12:30 PM to 1 PM", null],
      ["1 PM to 1:30 PM", null],
    ],
  );
  assert.equal(slot(d, "11 AM to 11:30 AM").detail, "Tea");
  assert.equal(slot(d, "9:30 AM to 10 AM").start_time, "09:30:00");
  assert.equal(d.fromTemplate, true);
});

test("bookings count by time, whatever format they were stored in", () => {
  const d = day({
    bookings: [
      { time_slot: "10 AM to 10:30 AM", healthray: false, n: 2 },
      { time_slot: "10:15", healthray: true, n: 1 },
      { time_slot: "02. 10-11AM", healthray: false, n: 1 },
      { time_slot: "12:45", healthray: true, n: 1 },
      { time_slot: "no time given", healthray: false, n: 3 },
    ],
  });
  assert.equal(slot(d, "10 AM to 10:30 AM").booked, 4);
  assert.equal(slot(d, "12:30 PM to 1 PM").booked, 1);
  assert.equal(d.unreadable, 3);
});

test("a per-date cap from reception still fills a slot", () => {
  const d = day({
    overrides: [{ time_slot: "10 AM to 10:30 AM", total_capacity: 2, is_blocked: false }],
    bookings: [{ time_slot: "10:05", healthray: true, n: 2 }],
  });
  const s = slot(d, "10 AM to 10:30 AM");
  assert.equal(s.capacity, 2);
  assert.equal(s.blocked_by, "full");
});

test("a manual block and an override that no longer matches a slot are both kept visible", () => {
  const d = day({
    overrides: [
      { time_slot: "12 PM to 12:30 PM", is_blocked: true, block_reason: "Meeting" },
      { time_slot: "4 PM to 4:30 PM", is_blocked: true },
    ],
  });
  assert.equal(slot(d, "12 PM to 12:30 PM").blocked_by, "manual_block");
  assert.equal(slot(d, "12 PM to 12:30 PM").detail, "Meeting");
  assert.deepEqual(d.orphanOverrides, [
    { time_slot: "4 PM to 4:30 PM", is_blocked: true, total_capacity: null },
  ]);
});

test("time off blocks by time range, old slot labels, or the whole day; emergency wins", () => {
  const byTime = day({
    unavailability: [
      { type: "break", reason: "Ward", start_time: "12:00:00", end_time: "13:00:00" },
    ],
  });
  assert.equal(slot(byTime, "12 PM to 12:30 PM").blocked_by, "break");
  assert.equal(slot(byTime, "12:30 PM to 1 PM").blocked_by, "break");
  assert.equal(slot(byTime, "1 PM to 1:30 PM").blocked_by, null);

  const byOldLabel = day({ unavailability: [{ type: "leave", slot_labels: ["12 PM to 1 PM"] }] });
  assert.equal(slot(byOldLabel, "12 PM to 12:30 PM").blocked_by, "leave");
  assert.equal(slot(byOldLabel, "12:30 PM to 1 PM").blocked_by, "leave");
  assert.equal(slot(byOldLabel, "1 PM to 1:30 PM").blocked_by, null);

  const wholeDay = day({
    unavailability: [
      { type: "leave", slot_labels: null },
      { type: "emergency", slot_labels: null, reason: "Unwell" },
    ],
  });
  assert.ok(
    wholeDay.slots
      .filter((s) => s.blocked_by !== "break")
      .every((s) => s.blocked_by === "emergency"),
  );
  assert.equal(slot(wholeDay, "9:30 AM to 10 AM").detail, "Unwell");
});

test("a clinic holiday blocks everything, breaks included", () => {
  const d = day({ isHoliday: true });
  assert.ok(d.slots.every((s) => s.blocked_by === "clinic_holiday"));
});

test("a day off returns the catalog marked day_off, so screens still read it as a day off", () => {
  const d = templateDay({ template: clinic, date: SUN, catalog: CATALOG });
  assert.equal(d.off, true);
  assert.deepEqual(
    d.slots.map((s) => s.blocked_by),
    ["day_off", "day_off"],
  );
});

test("HealthRay bookings outside hours, in a break, or on a day off are warned about; others are not", () => {
  const bookings = [
    { time_slot: "11:10", healthray: true, n: 2 },
    { time_slot: "15:00", healthray: true, n: 1 },
    { time_slot: "10:00", healthray: true, n: 1 },
    { time_slot: "16:00", healthray: false, n: 1 },
  ];
  assert.deepEqual(
    day({ bookings }).warnings.map((w) => w.message),
    [
      "Booked in HealthRay at 11:10 AM — inside Tea (2 patients)",
      "Booked in HealthRay at 3 PM — outside working hours",
    ],
  );
  assert.deepEqual(
    templateDay({ template: clinic, date: SUN, catalog: CATALOG, bookings }).warnings.map(
      (w) => w.reason,
    ),
    ["on a day off", "on a day off", "on a day off"],
  );
});

test("a booking counts once, even when an early window and an overnight window share its clock time", () => {
  const t = {
    hours: [
      { weekday: 2, start: "00:00", end: "01:00", slotMinutes: 60 },
      { weekday: 2, start: "22:00", end: "02:00", slotMinutes: 60 },
    ],
  };
  const d = templateDay({ template: t, date: TUE, bookings: [{ time_slot: "00:30", n: 1 }] });
  assert.equal(
    d.slots.reduce((n, s) => n + s.booked, 0),
    1,
  );
  assert.equal(
    d.slots.find((s) => s.start_time === "00:00:00" && s.slot_label === "12 AM to 1 AM").booked,
    1,
  );
});

test("a booking inside a break counts against the break only", () => {
  const d = day({ bookings: [{ time_slot: "11:15", n: 1 }] });
  assert.equal(slot(d, "11 AM to 11:30 AM").booked, 1);
  assert.equal(
    d.slots.reduce((n, s) => n + s.booked, 0),
    1,
  );
});

test("whole-day leave covers the break rows too, so the day reads as fully off", () => {
  const d = day({ unavailability: [{ type: "leave", slot_labels: null, reason: "Conference" }] });
  assert.ok(d.slots.every((s) => s.blocked_by === "leave"));
  assert.equal(slot(d, "11 AM to 11:30 AM").detail, "Conference");
  const partial = day({
    unavailability: [{ type: "break", start_time: "10:00", end_time: "12:00", reason: "Ward" }],
  });
  assert.equal(slot(partial, "11 AM to 11:30 AM").blocked_by, "break");
  assert.equal(slot(partial, "11 AM to 11:30 AM").detail, "Tea");
});

test("each slot carries its block's per-type limits and counts bookings by type, pending included", () => {
  const capped = {
    ...clinic,
    hours: clinic.hours.map((h) => ({ ...h, capNew: 3, capFollowup: 2, capWalkin: null })),
  };
  const d = templateDay({
    template: capped,
    date: TUE,
    bookings: [
      { time_slot: "10 AM to 10:30 AM", patient_type: "new", n: 2 },
      { time_slot: "10:10", healthray: true, patient_type: "followup", n: 1 },
      { time_slot: "10:20", patient_type: "new", pending: true, n: 1 },
      { time_slot: "10:25", patient_type: "walkin", n: 4 },
    ],
  });
  const s = slot(d, "10 AM to 10:30 AM");
  assert.deepEqual(s.caps, { new: 3, followup: 2, walkin: null });
  assert.deepEqual(s.counts, { new: 3, followup: 1, walkin: 4, pending: 1 });
  assert.equal(s.booked, 8);
  assert.equal(s.available, true);
  assert.deepEqual(slot(day(), "10 AM to 10:30 AM").caps, {
    new: null,
    followup: null,
    walkin: null,
  });
});
