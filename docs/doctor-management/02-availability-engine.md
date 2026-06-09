# 02 — Availability Resolver (the core engine)

> One service, `server/services/availability.js`, answers every availability
> question. Booking, the GHM page, the OPD queue, and the patient app all go
> through it so the rule lives in exactly one place.

---

## 1. Public API of the service

```js
// server/services/availability.js  (proposed)

/**
 * Is a doctor available for a specific date + slot?
 * Returns { available: boolean, reason?: string, capacity, booked }.
 */
export async function isSlotAvailable(doctorId, dateISO, slotLabel, { client = pool } = {})

/**
 * All slots for a doctor on a date, each annotated with availability.
 * Returns [{ slot_label, start_time, end_time, available, booked, capacity,
 *            blocked_by }]  // blocked_by ∈ 'not_working'|'clinic_holiday'|
 *                           //   'break'|'leave'|'emergency'|'manual_block'|'full'|null
 */
export async function getDoctorDayAvailability(doctorId, dateISO, { client = pool } = {})

/**
 * Across all active doctors, who is available for date+slot (for reassignment
 * suggestions). Returns ranked [{ doctor_id, doctor_name, role, free_capacity }].
 */
export async function findAvailableDoctors(dateISO, slotLabel, { excludeDoctorId, role } = {})

/**
 * Patients currently booked to a doctor inside an unavailability window.
 * Returns [{ appointment_id, patient_id, patient_name, file_no, phone,
 *            appointment_date, time_slot, status }]
 */
export async function getAffectedAssignments(doctorId, { startDate, endDate, slotLabels } = {})
```

Every booking write path calls `isSlotAvailable`; the UI calls
`getDoctorDayAvailability`; the reassignment flow calls `getAffectedAssignments`
+ `findAvailableDoctors`.

---

## 2. The resolution algorithm

`isSlotAvailable(doctorId, date, slot)` evaluates the layers from Doc 00 §4 in
short-circuit order (cheapest / most-blocking first):

```
1. weekday = dayOfWeek(date)                         // 0=Sun … 6=Sat

2. WORKS?     row in doctor_weekly_schedule
              WHERE doctor_id=D AND weekday=W AND slot_label=S AND is_active
              → if none: { available:false, reason:'not_working' }

3. CLINIC?    row in clinic_holidays WHERE holiday_date=date
              → { available:false, reason:'clinic_holiday', detail:remarks }

4. BREAK?     row in doctor_recurring_breaks
              WHERE doctor_id=D AND (weekday=W OR weekday IS NULL)
                AND slot_label=S AND is_active
              → { available:false, reason:'break' }

5. UNAVAIL?   row in doctor_unavailability
              WHERE doctor_id=D AND status='active'
                AND date BETWEEN start_date AND end_date
                AND (slot_labels IS NULL OR S = ANY(slot_labels))
              → { available:false, reason: type }      // 'leave'|'emergency'|'holiday'

6. BLOCK?     row in appointment_slots
              WHERE doctor_name=resolve(D) AND slot_date=date AND time_slot=S
                AND is_blocked=true
              → { available:false, reason:'manual_block', detail:block_reason }

7. CAPACITY:  capacity = appointment_slots.total_capacity (if a row exists)
                       ELSE doctor_weekly_schedule.capacity (default)
              booked   = COUNT(appointments WHERE doctor_name=resolve(D)
                              AND appointment_date=date AND time_slot=S
                              AND status NOT IN ('cancelled','no_show'))
              → booked >= capacity ? { available:false, reason:'full' }
                                   : { available:true, capacity, booked }
```

Notes:
- Steps 2–5 use `doctor_id`; steps 6–7 bridge to the legacy text world via
  `resolve_doctor_id` (a doctor's name/short_name). Compute the resolved
  name(s) once and reuse.
- Capacity precedence: an explicit `appointment_slots` row for that date wins
  over the weekly default (lets reception bump capacity for one busy day).
- "Booked" deliberately matches the existing availability endpoint's exclusion
  set (`status NOT IN ('cancelled','no_show')`) so counts agree everywhere.

### Single-query variant (for the day view)

`getDoctorDayAvailability` should compute all slots in **one round-trip per
layer**, not N queries per slot. Sketch:

```sql
WITH cal AS (SELECT $1::date AS d, EXTRACT(DOW FROM $1::date)::int AS w),
sched AS (  -- Layer 0: the doctor's working slots that weekday
  SELECT sc.label, sc.start_time, sc.end_time, dws.capacity
    FROM doctor_weekly_schedule dws
    JOIN slot_catalog sc ON sc.label = dws.slot_label
   WHERE dws.doctor_id=$2 AND dws.weekday=(SELECT w FROM cal) AND dws.is_active
),
brk AS (SELECT slot_label FROM doctor_recurring_breaks
         WHERE doctor_id=$2 AND is_active
           AND (weekday=(SELECT w FROM cal) OR weekday IS NULL)),
unav AS (SELECT slot_labels FROM doctor_unavailability
          WHERE doctor_id=$2 AND status='active'
            AND (SELECT d FROM cal) BETWEEN start_date AND end_date),
hol AS (SELECT 1 FROM clinic_holidays WHERE holiday_date=(SELECT d FROM cal)),
slotcfg AS (SELECT time_slot, total_capacity, is_blocked, block_reason
              FROM appointment_slots
             WHERE doctor_name = ANY($3) AND slot_date=(SELECT d FROM cal)),
booked AS (SELECT time_slot, COUNT(*)::int n
             FROM appointments
            WHERE doctor_name = ANY($3) AND appointment_date=(SELECT d FROM cal)
              AND status NOT IN ('cancelled','no_show')
            GROUP BY time_slot)
SELECT s.label, s.start_time, s.end_time,
       COALESCE(cfg.total_capacity, s.capacity) AS capacity,
       COALESCE(b.n,0) AS booked,
       CASE
         WHEN EXISTS(SELECT 1 FROM hol)                              THEN 'clinic_holiday'
         WHEN s.label IN (SELECT slot_label FROM brk)                THEN 'break'
         WHEN EXISTS(SELECT 1 FROM unav u
                      WHERE u.slot_labels IS NULL OR s.label = ANY(u.slot_labels)) THEN 'unavailable'
         WHEN cfg.is_blocked                                         THEN 'manual_block'
         WHEN COALESCE(b.n,0) >= COALESCE(cfg.total_capacity,s.capacity) THEN 'full'
         ELSE NULL
       END AS blocked_by
  FROM sched s
  LEFT JOIN slotcfg cfg ON cfg.time_slot = s.label
  LEFT JOIN booked  b   ON b.time_slot   = s.label
  ORDER BY s.start_time;
-- $3 = array of the doctor's matching names (name + short_name)
```
`available = (blocked_by IS NULL)`. Slots the doctor doesn't work simply don't
appear (or are added as `not_working` if the UI wants the full grid).

---

## 3. `findAvailableDoctors` (reassignment suggestions)

Given a date + slot (and the doctor being vacated), return other doctors who are
available, ranked so the human picks fast:

```
candidates = active doctors WHERE id != excludeDoctorId
for each candidate:
    a = isSlotAvailable(candidate.id, date, slot)
    if a.available: keep with free_capacity = a.capacity - a.booked
rank by:
    1. same role/specialty as vacated doctor   (clinical continuity)
    2. highest free_capacity                    (least likely to overflow)
    3. name (stable tiebreak)
```

Expose `role`/`specialty` of the source doctor so the UI can show "same
specialty" badges. Return empty list cleanly — the UI must handle "no doctor
available this slot" (offer next-slot / next-day search).

---

## 4. `getAffectedAssignments` (who is impacted)

When a doctor goes unavailable for `[startDate,endDate]` (optionally limited to
`slotLabels`), list every still-active assignment to move:

```sql
SELECT a.id AS appointment_id, a.patient_id, a.patient_name, a.file_no, a.phone,
       a.appointment_date, a.time_slot, a.status
  FROM appointments a
 WHERE a.doctor_name = ANY($names)              -- doctor's name + short_name
   AND a.appointment_date BETWEEN $start AND $end
   AND LOWER(COALESCE(a.status,'')) NOT IN
       ('cancelled','no_show','completed','seen','in_visit','checkedin')
   AND ($slotLabels IS NULL OR a.time_slot = ANY($slotLabels))
 ORDER BY a.appointment_date, a.time_slot;
```

> ⚠️ **Verified:** the live status vocabulary is wider and case-inconsistent than
> `appointmentUpdateSchema`'s enum (`scheduled|in-progress|completed|cancelled|
> no_show`). `opd.js` also queries `'seen'`, `'in_visit'`, `'checkedin'` via
> `LOWER(...)`. So the affected-list exclusion uses `LOWER(...)` and excludes all
> "done / in-progress" variants — otherwise an already-seen patient would be
> offered for reassignment. (The *booked-count* query in §2 step 7 deliberately
> keeps the existing `status NOT IN ('cancelled','no_show')` so counts still
> agree with the current availability endpoint.)

Include in-progress? → check `active_visits`: if a patient is mid-visit
(`active_visits.status='in-progress'`) flag them as "in progress — do not move"
rather than offering reassignment.

---

## 5. Caching & performance

- Reads are small (one doctor/day). For the booking write path, a single
  `isSlotAvailable` call is fine uncached.
- The GHM day grid (many doctors × a day) should call
  `getDoctorDayAvailability` per doctor in parallel, or a batched variant
  keyed by `doctor_name = ANY(...)`.
- Indices from Doc 01 (`idx_dws_doctor_weekday`, `idx_unavail_doctor_dates`,
  existing `idx_slots_date_doctor`, `idx_clinic_holidays_date`) cover every
  lookup above.
- No materialized "slots for the next 30 days" table in v1 — derive on read.
  Revisit only if profiling shows the day grid is hot.

---

## 6. Future: sub-slot (clock-time) precision

If a break or early-leave must fall *inside* a slot (e.g. leaves at 2:15 within
the "2 PM to 2:30 PM" slot), v1's slot-level model rounds to the whole slot. To
go finer later:
- Add `start_time`/`end_time TIME` to `doctor_recurring_breaks` and
  `doctor_unavailability` (nullable; NULL = whole slot).
- Resolver step 4/5 then tests time-range overlap with `slot_catalog` times
  instead of `slot_label` equality.
This is intentionally deferred — see Doc 00 decision #1.

---

## 7. Test matrix for the resolver (unit tests to write)

| Case | Setup | Expect |
|------|-------|--------|
| Not a working day | doctor has no Sunday rows | `not_working` |
| Working slot, free | has row, no overrides, 0 booked | `available` |
| Clinic holiday | `clinic_holidays` has the date | `clinic_holiday` |
| Recurring lunch break | break row for the slot | `break` |
| Planned full-day leave | unavailability whole-day | `leave` |
| Partial leave (afternoon) | unavailability with `slot_labels` PM only | AM `available`, PM `leave` |
| Emergency now | emergency unavailability | `emergency` + appears in affected list |
| Manual block | `appointment_slots.is_blocked` | `manual_block` |
| At capacity | booked == capacity | `full` |
| Capacity override | `appointment_slots.total_capacity` > weekly default | uses override |
| Name/short_name mismatch | appt uses short_name | counts still match via `ANY(names)` |
| Cancelled doesn't count | a cancelled appt in slot | not counted toward booked |
