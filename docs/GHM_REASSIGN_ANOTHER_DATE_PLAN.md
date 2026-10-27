# GHM Reassign Needed — move to another date

## Problem

`/ghm?tab=reassign` lists patients whose doctor is unavailable (leave, break,
day off) at their booked or preferred date and time. The only action is
**Reassign**: same date, same slot, a different doctor. The **Reassign to**
list only holds doctors free at that exact time
(`GET /api/appointments/conflicts` → `suggested_doctors`), and
`PUT /api/appointments/:id/reassign` (`reassignSingleSchema`) accepts only
`to_doctor_id` / `to_doctor_name`.

Most follow-up patients want **their own doctor on another day**, not a
different doctor at the same time. Today the desk has to leave the tab, find the
patient in Patient Lookup and edit Preferred Date / Time Slot by hand. The
reassignment is then not recorded as one.

## What the desk gets

Each row gets a choice in the **Reassign to** cell:

```text
( ) Same time, another doctor      [— choose doctor —]            [Reassign]
( ) Another date                   [Date ▾] [Slot ▾] [Doctor ▾]   [Move]
```

- **Same time, another doctor**: what the tab does today, unchanged.
- **Another date**:
  - **Date**: the same `DatePicker` the other tabs use. It starts from today,
    Sundays are closed (`CLOSED_WEEKDAYS`), and it opens on the row's current
    date.
  - **Slot**: the slot list for the chosen doctor and date, with how full each
    slot is. It reuses `preferredTimeOptions` / `useScheduleSlotsFor` /
    `useGhmSlotCounts`, the same dropdown as the Time Slot column.
  - **Doctor**: the previous doctor comes first and is selected by default
    (keep their own doctor). Below them, `GET /api/availability/doctors-for-slot`
    lists the doctors free at the picked date and slot, with "(same specialty)"
    as today. A doctor who is not free at the picked slot is shown disabled with
    the reason (on leave, full, not working).
  - **Move** stays disabled until date, slot and doctor are all chosen. Its
    tooltip says what is missing.
- After the move the row leaves the list (the conflict is gone). The green
  message line reads, for example, "PARAMJIT Kaur moved to Mon, 2 Nov, 10 AM to
  11 AM with Dr. Anil Bhansali".
- Over-limit slots go through the existing `useOverLimitConfirm` dialog, the
  same as booking.

## Server

`PUT /api/appointments/:id/reassign` (`server/routes/doctorSchedule.js`):

- `reassignSingleSchema` gets optional `to_date` (YYYY-MM-DD) and
  `to_time_slot`. Leaving both out keeps today's behaviour exactly.
- In the same transaction:
  1. Lock the appointment (`FOR UPDATE`).
  2. Refuse with a clear message if the date is a Sunday, in the past, or the
     visit already happened.
  3. Re-check `isSlotAvailable(to_doctor_id, to_date, to_time_slot)`. If the
     slot filled up meanwhile, return 409 "That slot just filled — pick another".
  4. Write the move (see the question below about real bookings).
  5. Call `holdIfOverLimit`.
  6. Record it in `logFieldChanges`, so it shows on the Status Changes tab.
  7. Insert an `appointment_reassignments` row.
- `movePreferredPlan` already writes `preferred_doctor` and
  `preferred_time_slot`. It also writes `preferred_date` when `to_date` is
  given.
- Migration (additive): `appointment_reassignments` gets `to_appointment_date
  DATE` and `to_time_slot TEXT`, so the history keeps both where the patient was
  and where they went. Today's rows leave them NULL (same date).

## Decisions needed (asked separately)

1. **Real bookings that came from HealthRay.** HealthRay owns those
   appointments, and the sync writes the date and slot back. The options are:
   - (a) The move only sets the preferred plan (date, slot, doctor) and marks
     the booking *Rescheduled*. The desk then books it in HealthRay, and the row
     drops off once the new booking syncs in.
   - (b) Change the Scribe booking's date and slot directly. The next HealthRay
     sync can undo it unless it is booked there too.

   Scribe-only bookings (no `healthray_id`) can move directly either way.
2. **Patient message.** Should moving a patient send the usual
   booking-confirmation WhatsApp, or nothing? `appointment_reassignments.patient_notified`
   exists but nothing sets it today.
3. **Who can move.** Reassign is `RECEPTION_OPS` today. Should OBT
   (`OBT_OPS`) also get this tab, since they make the calls?

## Not in scope

- Bulk "move all of Dr X's patients on a day to another day". The bulk
  reassign (`POST /appointments/reassign`) stays doctor-only.
- Any change to the other GHM tabs or to how HealthRay sync handles dates.

## Tests

`e2e/ghm/G28-reassign-another-date.spec.js`, run on the local test DB:

1. A Scribe booking with an on-leave doctor moves to another date and slot with
   the same doctor. The appointment, the `appointment_reassignments` row (from
   and to) and the Status Changes entry are all correct, and the row leaves the
   Reassign Needed list.
2. A preferred-plan row moves its preferred date, slot and doctor. The booking
   itself is unchanged.
3. Sunday, a past date and a slot where the doctor is on leave are each refused
   with their own message, and nothing is written.
4. A slot that fills between opening the row and pressing Move returns 409, and
   nothing is written.
5. A body without `to_date` behaves exactly as today (same-time reassign).
6. A HealthRay booking follows the answer to decision 1.
7. UI: Move stays disabled with the right tooltip until date, slot and doctor
   are all chosen, and the doctor list defaults to the previous doctor.
