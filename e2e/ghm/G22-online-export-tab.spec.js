import { test, expect } from "@playwright/test";

const { LIST_PREDICATES } = await import("../../shared/patientLists.js");
const { LIST_SHEETS } = await import("../../src/lib/ghmWatiExport.js");

const DAY = "2026-10-16";
const tabsOf = (row) => Object.keys(LIST_PREDICATES).filter((k) => LIST_PREDICATES[k](row, DAY));

const row = (extra) => ({
  phone: "9000000000",
  appointment_date: DAY,
  visit_type: "Follow-Up",
  status: "scheduled",
  booking_status: "booked",
  appointment_type: "Physical",
  call_status_any: null,
  call_reschedule_date: null,
  preferred_date: null,
  is_blocked: false,
  ...extra,
});

test.describe("G22 online patients get their own export tab", () => {
  test("1. the workbook has an Online tab after Follow Up", () => {
    expect(LIST_SHEETS.map((s) => s.name)).toEqual([
      "New Patients",
      "Follow Up",
      "Online",
      "Cancelled",
      "Rescheduled",
    ]);
  });

  test("2. online follow-up and online new patients are on Online only", () => {
    expect(tabsOf(row({ appointment_type: "Online" }))).toEqual(["online"]);
    expect(tabsOf(row({ appointment_type: "online", visit_type: "New Patient" }))).toEqual([
      "online",
    ]);
  });

  test("3. physical patients stay in New Patients and Follow Up", () => {
    expect(tabsOf(row({}))).toEqual(["followup"]);
    expect(tabsOf(row({ visit_type: "New Patient" }))).toEqual(["new"]);
  });

  test("4. a cancelled or rescheduled online patient stays in Cancelled or Rescheduled", () => {
    expect(tabsOf(row({ appointment_type: "Online", status: "cancelled" }))).toEqual(["cancelled"]);
    expect(tabsOf(row({ appointment_type: "Online", preferred_date: "2026-10-20" }))).toEqual([
      "rescheduled",
    ]);
  });

  test("5. a blocked online patient is on no call list", () => {
    expect(tabsOf(row({ appointment_type: "Online", is_blocked: true }))).toEqual([]);
  });
});
