# Doctor Management & Availability — Overview

> **Status:** PLAN ONLY — nothing in this folder is implemented yet.
> **Owner:** _TBD_  ·  **Created:** 2026-06-08  ·  **Target module:** `gini-scribe`

This folder is the full design for **managing doctor availability** and enforcing
it across appointment booking. Read the docs in order:

| # | Doc | What it covers |
|---|-----|----------------|
| 00 | [overview](00-overview.md) | Problem, goals, current-state, gap analysis, glossary, open decisions |
| 01 | [data-model](01-data-model.md) | New tables + migrations, `doctor_name`→`doctor_id` reconciliation |
| 02 | [availability-engine](02-availability-engine.md) | The core "is this doctor free at date+slot?" resolver |
| 03 | [api-endpoints](03-api-endpoints.md) | REST endpoints for schedules, leaves, breaks, availability, reassignment |
| 04 | [booking-flows](04-booking-flows.md) | Corrected booking flow + emergency-leave reassignment flow + edge cases |
| 05 | [frontend-ui](05-frontend-ui.md) | Doctor Management page, weekly grid, calendar, reassignment modal |
| 06 | [rollout-plan](06-rollout-plan.md) | Phased delivery, migration safety, testing, acceptance criteria |

---

## 1. The problem (in the user's words)

> Manage doctor availability — leave days / holidays for a doctor, break times,
> etc. During those times **no patient can be assigned** to that doctor. If a
> doctor who already has assigned patients goes on **emergency leave / break**,
> the system must **show all those assigned patients** so they can be
> **reassigned to other doctors**. Patients can only be assigned within a
> doctor's available times.

Breaking that into concrete capabilities:

1. **Recurring availability** — each doctor has weekly working hours (e.g. Dr. X
   works Mon–Fri 9:30 AM–4 PM, not Sun).
2. **Leave / holiday (per doctor)** — full-day or multi-day off for a specific
   doctor, distinct from the existing *clinic-wide* `clinic_holidays`.
3. **Break time** — recurring (daily lunch 1–2 PM) or one-off blocks within a
   working day.
4. **Booking enforcement** — a patient can be assigned to a doctor **only** when
   that doctor is available (working hours ∧ not on leave ∧ not on break ∧ not a
   clinic holiday ∧ slot has capacity).
5. **Emergency unavailability + reassignment** — mark a doctor unavailable for a
   window (now/today/date-range), surface every patient already booked in that
   window, and bulk-reassign them to other available doctors.

---

## 2. Goals & non-goals

### Goals
- A single source of truth for "when is doctor D available?" usable by booking,
  OPD queue, GHM page, and the patient app.
- Hard enforcement at the booking API (not just a UI hint).
- A reassignment workflow that never silently drops a patient.
- Backward compatible: existing `appointments`, `appointment_slots`, and
  `clinic_holidays` keep working during and after rollout.

### Non-goals (explicitly out of scope for v1)
- Multi-clinic / multi-location scheduling (single clinic assumed).
- Per-procedure slot durations (we reuse the existing slot catalog).
- Auto-rebalancing / load-balancing across doctors without human confirmation.
- Patient-facing self-rescheduling driven by doctor leave (notification only).

---

## 3. Current-state analysis (what the code does today)

Grounded in the actual repo (`server/`, `src/`, `shared/`):

| Concern | Today | File |
|---------|-------|------|
| Doctor identity | `doctors(id, name, short_name, role, specialty, is_active, …)`. **No schedule fields.** | `server/schema.sql:56` |
| Patient ↔ doctor link | `appointments.doctor_name` is **free TEXT**, not an FK to `doctors.id`. | `server/routes/appointments.js` |
| Slot labels | Hardcoded `TIME_SLOTS` array of text ranges ("10 AM to 11 AM"). | `server/routes/appointment-slots.js:8` |
| Per-day capacity / blocking | `appointment_slots(doctor_name, slot_date, time_slot, total_capacity, is_blocked, block_reason)`. Manual, one day at a time. | migration `2026-06-01_ghm_cc_system.sql:55` |
| Clinic holidays | `clinic_holidays(holiday_date UNIQUE, remarks)` — **clinic-wide, not per doctor**. | same migration `:44` |
| Availability check (read) | `GET /appointment-slots/availability` = holiday ∧ slot config ∧ booked count. | `appointment-slots.js:62` |
| Availability enforcement (write) | **NONE.** `POST /appointments` inserts any doctor/slot with no availability check. | `appointments.js:65` |
| In-progress visits | `active_visits(doctor_id, doctor_name, appointment_id, status, …)`. | `server/schema.sql:312` |
| Scheduling hints | `patient_special_alerts(avoid_booking, preferred_slots, additional_doctor, …)`. | migration `:` (section 10) |
| RBAC | `shared/permissions.js` — `CAPABILITIES.ADMIN` = "manage doctors/roles"; `RECEPTION_OPS` = appointments/GHM. `GRANT_ALL_CAPABILITIES = true` today. | `shared/permissions.js` |

### Key structural problems to correct

1. **`doctor_name` as the join key.** Schedules must attach to a stable
   `doctor_id`. Renames, short-name vs full-name mismatches, and typos will
   silently bypass availability rules if we key schedules off text. → Doc 01
   defines a reconciliation strategy (resolve name→id, store `doctor_id` on new
   tables, keep `doctor_name` as a denormalized convenience).

2. **Slots are text ranges, not times.** Break-time math ("is 1:30 PM inside a
   break?") needs real `start_time`/`end_time`. → Doc 01 adds canonical TIME
   columns to a slot catalog while preserving the text labels.

3. **No recurring layer.** `appointment_slots` is per-date; nobody wants to
   configure every day by hand. → Doc 02's resolver derives a day's slots from a
   weekly template, then applies overrides (leave/break/holiday/manual block).

4. **Booking doesn't enforce.** The availability endpoint exists but the write
   path ignores it. → Doc 04 makes `POST /appointments` (and PUT reassign) call
   the resolver and reject unavailable assignments (with an override path for
   admins).

---

### Verification status (2026-06-08)

Every claim in these docs was checked against the live code. Confirmed correct:
doctor/`active_visits`/`appointment_slots`/`clinic_holidays` schemas; booked-count
exclusion `status NOT IN ('cancelled','no_show')`; the booking write path does
**not** enforce availability; `requireCapability(CAPABILITIES.ADMIN)` guard;
reused components (`DatePicker`, `Toast`, `RequireCapability`) all present.
Four discrepancies were found and corrected in-line (look for ⚠️ **Verified**):

1. The `force` override can't ride in the request body — `validate()` strips
   unknown keys (Zod). Must add `force` to the appointment schemas. (Doc 03 §7/§9)
2. The "already done" status set is wider/case-inconsistent (`seen`, `in_visit`,
   `checkedin`, not just `completed`) — affected-list query fixed. (Doc 02 §4)
3. The `appointments` `CREATE TABLE` + its `ON CONFLICT` index live in the prod
   DB, not in this repo. (Doc 01 §6, Doc 06 Phase 0)
4. `appointments.js` never touches `active_visits` today — the reassignment
   "mirror" step is net-new wiring. (Doc 03 §6b)

## 4. Conceptual model (layers of truth)

Availability is computed by stacking layers, highest precedence last:

```
  ┌─ Layer 5  Manual per-slot block        (appointment_slots.is_blocked)        ── overrides ─┐
  ├─ Layer 4  Emergency unavailability      (doctor_unavailability, type=emergency)            │
  ├─ Layer 3  Planned leave (per doctor)    (doctor_unavailability, type=leave)                │
  ├─ Layer 2  Recurring break               (doctor_schedule_breaks / weekly template)         │
  ├─ Layer 1  Clinic holiday (all doctors)  (clinic_holidays)                                  │
  └─ Layer 0  Weekly working hours          (doctor_weekly_schedule)            ── base ────────┘

  effective_available(doctor, date, slot) =
        slot ∈ Layer0(date.weekday)            -- doctor works that weekday+slot
    AND date ∉ Layer1                          -- not a clinic holiday
    AND slot ∉ Layer2(date.weekday)            -- not in a recurring break
    AND (date,slot) ∉ Layer3                   -- not on planned leave
    AND (date,slot) ∉ Layer4                   -- not on emergency leave
    AND NOT Layer5(doctor,date,slot).is_blocked
    AND booked_count(doctor,date,slot) < capacity(doctor,date,slot)
```

The resolver (Doc 02) is the single function every caller uses. Booking, the GHM
page, the OPD queue, and the patient app all ask the same question through it.

---

## 5. Glossary

| Term | Meaning |
|------|---------|
| **Slot** | A bookable time window from the slot catalog, e.g. "10 AM to 11 AM". Has a text `label` and canonical `start_time`/`end_time`. |
| **Weekly schedule** | A doctor's recurring working slots per weekday (the base layer). |
| **Break** | A recurring (weekly) or one-off non-working window inside a working day (lunch, admin time). |
| **Leave** | A planned full-day / multi-day / partial-day absence for one doctor. |
| **Emergency unavailability** | An unplanned absence created "now", typically starting immediately, that triggers the reassignment flow. |
| **Clinic holiday** | Existing clinic-wide closed day (`clinic_holidays`). Affects all doctors. |
| **Assignment** | A patient booked to a doctor = an `appointments` row with that `doctor_name` + date + slot. |
| **Reassignment** | Moving an existing assignment from an unavailable doctor to an available one (updates `doctor_name`/`doctor_id`, writes an audit trail). |
| **Resolver** | `availability.js` service — the single function computing effective availability and free slots. |

---

## 6. Open product decisions (recommendation in **bold**)

These change the design; resolve before Phase 1. Defaults chosen are documented
so implementation can proceed without blocking.

1. **Time granularity for breaks/leave** — slot-level only, or true clock-time?
   → **Recommendation: slot-level for v1** (reuse the existing slot catalog;
   partial-day leave = list of slots). Add clock-time precision later only if
   real overlaps demand it. Keeps math and UI simple.

2. **Enforcement strictness** — hard-block unavailable bookings, or warn +
   allow-with-reason? → **Recommendation: hard-block for normal staff, allow an
   `ADMIN`/override flag** (`force=true` + reason, audited). Reception cannot
   silently overbook a doctor on leave.

3. **Reassignment target selection** — auto-pick best available doctor, or
   always human-choose? → **Recommendation: system *suggests* ranked available
   doctors (same role/specialty first), human confirms each (or bulk-applies).**
   Never auto-move without confirmation.

4. **Patient notification on reassignment** — notify via existing MSG91 /
   push? → **Recommendation: out of scope for v1 logic, but every reassignment
   sets a flag the CC/notification layer can pick up.** (Hook documented, sender
   deferred.)

5. **Schedule scope** — is a "doctor" the only resource, or also rooms/CCs?
   → **Recommendation: doctors only in v1.** Schema leaves room (`resource_type`)
   to generalize later.

See Doc 06 §"Decisions to confirm" for the checklist owner sign-off.
