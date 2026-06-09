# 04 — Flows (corrected) & Edge Cases

The user's original flow, restated and corrected end-to-end. Three flows:
(A) booking with enforcement, (B) declaring leave / break ahead of time,
(C) emergency leave → reassignment.

---

## Flow A — Assign a patient (booking with availability enforcement)

```
Reception picks patient + doctor + date.
        │
        ▼
UI calls GET /api/doctors/:id/availability?date=…
        │     → renders ONLY available slots green; break/leave/holiday/full greyed with reason
        ▼
Reception picks an available slot → POST /api/appointments
        │
        ▼
Server: resolve doctor_id from doctor_name
        │
        ├─ resolves → isSlotAvailable(doctor_id, date, slot)
        │       ├─ available → INSERT appointment ✅
        │       └─ NOT available →
        │              ├─ normal user → 409 { reason }  ❌  (UI shows why, offers other slots/doctors)
        │              └─ ADMIN + force=true → INSERT + audit override ⚠️
        │
        └─ does NOT resolve (legacy/unknown name) → INSERT (v1 pass-through) + warn-log
```

**Correction vs today:** the write path currently inserts unconditionally
(`appointments.js:65`). Flow A inserts the `isSlotAvailable` gate. The UI change
(only show available slots) prevents most rejects; the server gate is the hard
backstop against race conditions and direct API calls.

---

## Flow B — Plan leave / break ahead of time

```
Admin opens Doctor Management → Leave tab → "Add leave"
        │  (date range + whole-day or specific slots + reason)
        ▼
POST /api/doctors/:id/unavailability
        │
        ▼
Server inserts doctor_unavailability(type='leave')
        │
        ├─ Are there ALREADY-booked patients in that window?  (getAffectedAssignments)
        │       ├─ none → done. Future bookings in window now blocked by Flow A. ✅
        │       └─ some → response.requires_reassignment = true + affected list
        │                  → UI prompts "N patients are booked during this leave —
        │                     reassign now?"  → goes into Flow C step 2 (the move UI)
        ▼
Recurring break: POST /api/doctors/:id/breaks (weekday+slot) — same effect for
that slot every week; no existing-patient prompt needed for *future* weeks, but
if applied to the current week with bookings, surface affected patients too.
```

---

## Flow C — Emergency leave → reassignment (the headline)

```
Doctor suddenly unavailable (sick / called away).
        │
Staff: Doctor Management → "Emergency leave" → pick window (default: rest of today)
        ▼
POST /api/doctors/:id/emergency-leave
        │
        ▼
Server:
   1. INSERT doctor_unavailability(type='emergency')   → booking now blocked (Flow A)
   2. getAffectedAssignments(doctor, window)           → every active booked patient
   3. for each: findAvailableDoctors(date, slot)       → ranked suggestions
   4. flag in_progress patients (active_visits) as NOT movable
        │
        ▼
UI: Reassignment screen — table of affected patients, each with:
        patient | slot | suggested doctors (dropdown, "same specialty" first)
        │   bulk action: "auto-fill suggestions" → pre-selects top suggestion each
        ▼
Staff confirms → POST /api/appointments/reassign  { moves:[…] }
        │
        ▼
Server per move (transaction):
   a. re-check isSlotAvailable(target)  → if filled meanwhile: report failure for that row
   b. UPDATE appointments.doctor_name/doctor_id
   c. INSERT appointment_reassignments (audit, patient_notified=false)
   d. update active_visits mirror if present
        │
        ▼
Response { moved:[…], failed:[…] }
   ├─ all moved → mark unavailability.reassignment_done=true ✅
   └─ some failed (target full / no doctor) → stay on screen, staff re-picks ⚠️
        │
        ▼
(Deferred hook) reassignment rows with patient_notified=false feed the
MSG91/push layer to tell patients about the doctor change.
```

**Patient who cannot be reassigned** (no doctor free in that slot all day):
- Offer "find next available slot/day for any suitable doctor" (resolver search
  forward), OR
- Mark the appointment `status` for CC follow-up (e.g. set a note / push to
  `cc_calling_log` / `appointment_cancellations` with `outcome='needs_reschedule'`).
- Never silently leave them on the unavailable doctor — the screen blocks
  "done" until every affected patient is either moved or explicitly parked.

---

## Edge cases & decisions

| # | Situation | Handling |
|---|-----------|----------|
| 1 | Patient mid-visit when doctor declares emergency leave | `active_visits.status='in-progress'` → listed but **not movable**; emergency window can still apply to *later* slots. |
| 2 | Doctor's name in `appointments` ≠ `doctors.name` (uses short_name) | Resolver matches `name` OR `short_name` (`resolve_doctor_id`); affected/availability queries use `doctor_name = ANY([name, short_name])`. |
| 3 | Legacy appointment with a `doctor_name` that resolves to no doctor | Booking gate passes through (v1) + warn-log; Phase-0 audit drives these to zero before strict mode. |
| 4 | Reassign target fills up between suggestion and apply | Per-row re-check in the transaction; that row returns `failed:'target_full'`, staff re-picks. |
| 5 | Two staff reassign the same patient concurrently | `UPDATE … WHERE id=$1` is atomic; second writer's audit row still records the final state. Consider `WHERE doctor_id = $fromId` guard to detect "already moved". |
| 6 | Clinic-wide holiday vs per-doctor leave overlap | Both block; resolver reports the first matching reason (`clinic_holiday` before `leave`). No double-handling. |
| 7 | Capacity bumped for one busy day | `appointment_slots.total_capacity` override wins over weekly default (resolver step 7). |
| 8 | Walk-in (`is_walkin=true`) during a break | Same gate applies; admin can `force` for genuine walk-ins. Decide per clinic policy (Doc 00 #2). |
| 9 | Leave cancelled after reassignment | Cancelling `doctor_unavailability` (`status='cancelled'`) **does not auto-revert** moves — patients stay where moved; staff manually moves back if desired (audit trail shows history). |
| 10 | Booking exactly at a slot boundary / partial leave | Slot-level granularity (v1): partial leave lists specific `slot_labels`; sub-slot precision deferred (Doc 02 §6). |
| 11 | Emergency leave `from_now=true` | Only slots whose `slot_catalog.start_time >= now()` are blocked/affected; already-passed slots untouched. |
| 12 | Doctor deactivated (`is_active=false`) | Excluded from `findAvailableDoctors`; existing appointments remain and should be surfaced for reassignment via a one-off "deactivated doctor" sweep (same affected-list mechanism). |

---

## State transitions touched

- `appointments.status`: unchanged set (`scheduled`→`completed`/`cancelled`/`no_show`).
  Reassignment changes `doctor_name`/`doctor_id`, **not** status.
- `doctor_unavailability.status`: `active` → `cancelled`.
- `doctor_unavailability.reassignment_done`: `false` → `true` when all affected
  moved/parked.
- `appointment_reassignments.patient_notified`: `false` → `true` when the
  (deferred) notification sender runs.
