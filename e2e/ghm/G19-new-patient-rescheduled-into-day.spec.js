import { test, expect } from "@playwright/test";

const { LIST_PREDICATES, isEarlierVisitDue, isNewOnDate } =
  await import("../../shared/patientLists.js");

const DAY = "2026-10-16";
const tabsOf = (row, date = DAY) =>
  Object.keys(LIST_PREDICATES).filter((k) => LIST_PREDICATES[k](row, date));

const row = (extra) => ({
  phone: "9000000000",
  visit_type: "New",
  status: "scheduled",
  booking_status: "booked",
  call_status_any: null,
  call_reschedule_date: null,
  preferred_date: null,
  is_blocked: false,
  ...extra,
});

test.describe("G19 a new patient moved to this day is a new patient on this day", () => {
  test("1. booked the day before, never came, asked for this day: New Patients only", () => {
    const deepti = row({
      appointment_date: "2026-10-15",
      preferred_date: DAY,
      call_status_any: "rescheduled",
    });
    expect(isEarlierVisitDue(deepti, DAY)).toBe(false);
    expect(isNewOnDate(deepti, DAY)).toBe(true);
    expect(tabsOf(deepti)).toEqual(["new"]);
  });

  test("2. a call that rescheduled them to this day counts the same", () => {
    const viaCall = row({
      appointment_date: "2026-10-14",
      call_status_any: "rescheduled",
      call_reschedule_date: DAY,
    });
    expect(tabsOf(viaCall)).toEqual(["new"]);
  });

  test("3. a new patient moved AWAY from this day stays on Rescheduled", () => {
    const away = row({ appointment_date: DAY, preferred_date: "2026-10-20" });
    expect(tabsOf(away)).toEqual(["rescheduled"]);
  });

  test("4. a patient who already came earlier is a follow-up, and its reschedule stays put", () => {
    const came = row({
      visit_type: "New Patient",
      status: "completed",
      appointment_date: "2026-09-23",
      preferred_date: DAY,
    });
    expect(isEarlierVisitDue(came, DAY)).toBe(true);
    expect(isNewOnDate(came, DAY)).toBe(false);
    expect(tabsOf(came)).toEqual(["rescheduled"]);
  });

  test("5. follow-up patients moved to this day are unchanged: still Rescheduled", () => {
    const fu = row({
      visit_type: "Follow-Up",
      status: "completed",
      appointment_date: "2026-07-08",
      preferred_date: DAY,
    });
    expect(tabsOf(fu)).toEqual(["rescheduled"]);
  });

  test("6. cancelled and blocked patients never reach New Patients", () => {
    const base = { appointment_date: "2026-10-15", preferred_date: DAY };
    expect(tabsOf(row({ ...base, booking_status: "cancelled" }))).toEqual(["cancelled"]);
    expect(tabsOf(row({ ...base, is_blocked: true }))).toEqual([]);
  });

  test("7. an ordinary new booking on this day is still New Patients", () => {
    expect(tabsOf(row({ appointment_date: DAY }))).toEqual(["new"]);
  });

  test("8. a missed earlier booking alone does not make anyone a follow-up", () => {
    const missed = row({ appointment_date: "2026-10-10", status: "no_show" });
    expect(isEarlierVisitDue(missed, DAY)).toBe(false);
  });
});
