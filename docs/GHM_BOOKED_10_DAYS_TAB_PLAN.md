# GHM — "Booked 10+ Days Ago" tab (plan, for review — no code yet)

## 1. Purpose

A patient who booked weeks ago is the one most likely to forget. The OBT team wants
one list of **upcoming patients whose booking was taken 10 or more days ago**, so they
can call and reconfirm before the day.

Tab name: **Booked 10+ Days Ago** — after "Follow-up in 3 Days", before "Missed".
URL: `/ghm?tab=booked10&date=2026-10-31`.

**Main use (29 Oct 2026):** when a patient booked for tomorrow drops out, OBT calls
the patients on this list (booked 10+ days ago for the day after tomorrow) and offers
them tomorrow's slot. A patient who accepts is moved by setting Preferred Date + Time
Slot to tomorrow; they then appear on tomorrow's list and drop off this one. Sorted by
the booking-to-appointment gap, smallest first.

## 2. Decisions (agreed 29 Oct 2026)

1. **Upcoming only.** The appointment is in the future; the booking was taken 10 or
   more days before today.
2. **All bookings count**, whatever the source. The booking time is
   `appointments.created_at`:
   - GHM sheet / booking sheet / Appointments page: the moment the booking was taken.
   - HealthRay-only bookings: the moment Scribe **first saw** the booking. HealthRay
     sends no booking time, so this can be later than the real booking — such a
     patient can be missing from the list even though they booked long ago. The tab
     says so in its help text.
   - `booking_date` is **not** used: the GHM form fills it with the appointment date
     when left empty, so it can name a day nobody booked on.
3. **Appointment day = tomorrow + 1** (the day after tomorrow) by default, the same way
   "Tomorrow" defaults to tomorrow. The date picker on the tab still lets the team
   pick another future day.
4. **Same table and actions as the day lists**: call button, Call Status, Booking
   Status, preferred date/time, notes, summary pills, doctor filter, export.

## 3. Who is listed

For the chosen appointment date `D` (default today + 2):

| Rule | SQL (added to the existing `/ghm-appointments` day query) |
|---|---|
| Appointment on `D` | existing `a.appointment_date = D` |
| Booked 10+ days ago | `a.created_at < (IST today − 9 days)` i.e. booked on or before IST today − 10 |
| Not cancelled / no-show | existing day-list status rules |
| Not lab-only, not blocked | existing day-list rules |

"10 days" is counted in IST calendar days: on 29 Oct, a booking taken on or before
19 Oct is listed; one taken on 20 Oct is not.

## 4. Screen

Identical to the Tomorrow tab, plus:

- A **"Booked on"** column (date + time of `created_at`, "first seen in Scribe" in
  the tooltip for HealthRay bookings — `booking_source` is empty for those).
- Help line under the tab bar: *"Patients booked 10 or more days ago. HealthRay
  bookings count from when Scribe first saw them."*
- Empty state: *"No patients on <date> were booked 10 or more days ago."*

## 5. Changes

**Server — `server/routes/ghm-appointments.js`**

- `GET /ghm-appointments`: new query param `booked_before_days` (integer 1–60). When
  present, add `AND (a.created_at AT TIME ZONE 'Asia/Kolkata')::date <= IST today − n`
  to the day query. The summary pills use the same `where`, so they match the list.
- No new table, no migration, no change to how bookings are written.

**Client — `src/pages/GHMPage.jsx`**

- `VIEW_TABS`: `{ id: "booked10", label: "Booked 10+ Days Ago", Icon: CalendarClock,
  offset: 2 }`.
- Request params for this tab add `booked_before_days=10` (no `mode=followup`).
- "Booked on" column shown only on this tab; date picker `minDate` = tomorrow.
- WhatsApp template: none (reuses the day list's).

**RBAC**: none — the tab lives inside `/ghm`, which OBT, reception and coordinator
already reach.

## 6. Tests (`e2e/ghm/`)

1. A booking created 12 days ago for today + 2 is listed; one created 5 days ago is
   not; one created exactly 10 days ago is listed.
2. A cancelled booking and a lab-only (Hospital Admin) booking are not listed.
3. The pills and slot counts on the tab match the rows.
4. Call status / booking status edits from the tab save and show on the Tomorrow tab
   for the same patient.
5. Changing the date picker to another future day reloads with the same rule.

## 7. Settled on review (29 Oct 2026)

- **Every booking**, new and follow-up — built on the Today tab's booked-appointments
  query, not the follow-up-due query the Tomorrow / 3-day tabs use.
- **Only the day after tomorrow** by default (today + 2), with the date picker for
  other future days.
- Slot counts and the per-category capacity badges are **not** filtered: they count
  every booking on the day, as capacity must.

## Change — 31 Oct 2026 (replaces §2.1, §2.3 and §3)

- **No date filter.** The tab lists every upcoming appointment, from tomorrow on any date,
  oldest booking first, then the sooner visit (`/ghm-appointments?booked_before_days=10&upcoming=1`).
- **Who is listed:** the booking was taken **10 or more days before today** (IST calendar days;
  on 31 Oct, booked on or before 21 Oct), for any appointment from tomorrow on. Example: booked
  12 Oct for 23 Nov is listed; booked yesterday for 20 Nov is not.
- The Appointment column is shown; the Gap (days) column is removed. "Booked On" stays.
- Without `upcoming=1` the old one-date rule still answers, so nothing else that calls it breaks.
- Test: `e2e/ghm/G28-booked-10-days-all-upcoming.spec.js`.
