// How the GHM day list splits into the four tabs of the WATI export workbook.
//
// Cancelled and Rescheduled are read from where the data actually lives, not
// only from the call-status dropdown:
//   • a cancellation arrives on the appointment's own status (the HealthRay
//     sync writes 'cancelled' there) as well as from the OBT dropdown;
//   • a reschedule is usually the OBT team moving the patient to another day —
//     a preferred date that differs from the booked date — and only sometimes a
//     call logged as "Rescheduled".
const day = (v) => (v ? String(v).slice(0, 10) : "");

export const isNewVisitType = (visitType) =>
  !visitType || String(visitType).toLowerCase().startsWith("new");

export const isCancelledRow = (row) =>
  row?.status === "cancelled" ||
  row?.booking_status === "cancelled" ||
  row?.call_status_any === "cancelled";

export const isEarlierVisitDue = (row, date) =>
  !!date && !!row?.appointment_date && day(row.appointment_date) < day(date);

export const isNewOnDate = (row, date) =>
  isNewVisitType(row?.visit_type) && !isEarlierVisitDue(row, date);

const ATTENDED = ["seen", "completed", "checkedin", "in_visit", "in-progress"];

export const cameOnDate = (row, date) =>
  !!date &&
  day(row?.appointment_date) === day(date) &&
  ATTENDED.includes(String(row?.status || "").toLowerCase());

export const isRescheduledRow = (row, date) =>
  !cameOnDate(row, date) &&
  (row?.call_status_any === "rescheduled" ||
    !!row?.call_reschedule_date ||
    (!!row?.preferred_date && day(row.preferred_date) !== day(row.appointment_date)));

// A blocked patient stays visible on the day list — staff must be able to see
// why the appointment exists — but drops out of the call lists, because nobody
// should be phoning them. See docs/PATIENT_BLOCKLIST_PLAN.md §4.3
export const isBlockedRow = (row) => row?.is_blocked === true;

export const LIST_PREDICATES = {
  new: (r, date) =>
    isNewOnDate(r, date) && !isCancelledRow(r) && !isRescheduledRow(r, date) && !isBlockedRow(r),
  followup: (r, date) =>
    !isNewOnDate(r, date) && !isCancelledRow(r) && !isRescheduledRow(r, date) && !isBlockedRow(r),
  cancelled: (r) => isCancelledRow(r),
  rescheduled: (r, date) => !isCancelledRow(r) && isRescheduledRow(r, date),
};

export const LIST_IDS = Object.keys(LIST_PREDICATES);
