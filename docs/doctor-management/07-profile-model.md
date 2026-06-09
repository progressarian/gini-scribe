# 07 — Revised model: "Available by default + Working Profile"

> **Status:** PLAN ONLY — supersedes the per-date marking model (docs 02–06's
> Layer 0). Decided 2026-06-09 after per-date marking proved too tedious
> ("marking availability every day for each doctor is too hard").

## 1. The idea (in the user's words)

> Make any doctor/staff **available every day except Sunday** (clinic holiday).
> If a doctor adds a **break or leave**, show unavailability on that day/time.
> By default every slot is open. A **profile page** lets a doctor set their
> working days/times and their lunch break — that makes management easy.

So availability flips from **opt-in** (mark every day) to **opt-out** (available
unless told otherwise).

## 2. Model

```
Availability is IMPLICIT. A doctor is available unless something says no.

Default (zero config):  available Mon–Sat, all slots.  Sunday = off.
Working Profile (opt.):  customize working weekdays, working slots, lunch break.
Date exceptions (opt.):  Leave / Holiday / Break / Emergency on specific dates.
```

### Resolution order — `isSlotAvailable(doctor, date, slot)`
1. **Day off** — weekday ∈ profile.off_weekdays (default `{Sunday}`) → `day_off`
2. **Clinic holiday** — `clinic_holidays` has the date → `clinic_holiday`
3. **Not a working slot** — profile.working_slots set and slot ∉ it → `not_working`
4. **Recurring lunch break** — slot ∈ profile.lunch_slots → `break`
5. **Date exception** — active `doctor_unavailability` (leave/holiday/break/emergency) covering date+slot → that type
6. **Full** — booked ≥ capacity → `full`
7. else **available**

No profile row ⇒ defaults apply (off only Sunday, all slots, no lunch). That's
the whole point: doing nothing = available Mon–Sat.

## 3. Schema changes

**Add `doctor_profile`** (one row per doctor, all optional with defaults):
```sql
CREATE TABLE doctor_profile (
  doctor_id      INTEGER PRIMARY KEY REFERENCES doctors(id) ON DELETE CASCADE,
  off_weekdays   SMALLINT[] NOT NULL DEFAULT '{0}',  -- 0=Sun..6=Sat; default Sunday off
  working_slots  TEXT[],          -- NULL = all slots; else the subset they work
  lunch_slots    TEXT[],          -- recurring daily break slots (e.g. {'1 PM to 2 PM'})
  updated_at     TIMESTAMPTZ DEFAULT NOW()
);
```

**Drop** `doctor_availability` (the per-date marking table) — no longer the
source of truth. It's empty, so the drop is clean.

**Keep** `doctor_unavailability` (leave/holiday/break/emergency), `slot_catalog`,
`clinic_holidays`, `appointment_reassignments`, `resolve_doctor_id()`,
`appointments.doctor_id`.

## 4. Resolver changes (`services/availability.js`)
- Layer 0 becomes the **profile/default** check (steps 1,3 above) instead of
  "is there a doctor_availability row".
- `getDoctorDayAvailability` enumerates **all slot_catalog slots** for the day
  (since availability is implicit), annotating each with `day_off` / `break` /
  `leave` / `full` / available.
- Steps 2, 5, 6 (holiday, date exceptions, capacity) are unchanged.
- Capacity default when none set: unlimited (NULL), same as today.

## 5. UI

### New: **Profile** tab (in Doctor Management; admin can edit any doctor)
- **Working days** — checkboxes Sun–Sat. Default: Mon–Sat on, **Sun off**.
- **Working slots** — "All slots" (default) or pick a subset (e.g. mornings only).
- **Lunch break** — pick slot(s) that repeat every working day (e.g. 1–2 PM).
- Save → `PUT /doctors/:id/profile` (upsert).

(Later, optionally expose the same form as a doctor's **self-service profile
page** so each doctor edits their own — the user's "their own profile page".
Same endpoint, just reachable by the logged-in doctor.)

### Doctor Management tabs become:
| Tab | Purpose |
|-----|---------|
| **Profile** | recurring working days/slots + lunch break (NEW) |
| **Leave / Holiday** | date-specific days off (keep) |
| **Break** | one-off break on a specific date (keep — distinct from the recurring lunch in Profile) |
| **Emergency Leave** | unplanned + reassign (keep) |
| **Day View** | resolved availability for a date (keep) |

**Removed:** the per-date "Availability marking" tab (its job is now implicit +
the Profile tab).

## 6. API
| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/doctors/:id/profile` | read profile (returns defaults if no row) |
| PUT | `/api/doctors/:id/profile` | upsert `{ off_weekdays, working_slots, lunch_slots }` |

Leave/break/emergency/reassign/day-view/slot-catalog endpoints stay as-is.
The per-date availability endpoints (`POST/GET/DELETE .../availability`) are
removed.

## 7. Migration / rollout
1. `CREATE TABLE doctor_profile`.
2. Rewrite resolver Layer 0 (profile/default).
3. Add profile GET/PUT routes + schema; remove per-date availability routes.
4. Frontend: add **Profile** tab, remove **Availability** tab; Day View now
   shows the implicit grid.
5. `DROP TABLE doctor_availability` + its migration's traces.
6. Update smoke test (profile round-trip; default Mon–Sat availability).
Enforcement flag (`SCHEDULE_ENFORCEMENT`) and booking gate are unchanged.

## 8. Why this is easier
- **Zero daily work** — available by default, Sunday auto-off.
- **Lunch once** — set in the profile, repeats forever.
- **Exceptions only** — leave/break entered only when they actually happen.
- Backwards-compatible with the booking gate, reassignment, and audit already
  built.

## 9. Open questions (confirm before building)
1. **Sunday off** — hardcode Sunday as the clinic default, or per-doctor only?
   → Recommend: default `off_weekdays = {Sunday}` per doctor (editable), so a
   doctor who works Sundays can flip it.
2. **Working hours** — keep slot-based (pick slots), or real start/end clock
   times? → Recommend slot-based for consistency with everything built.
3. **Profile editor location** — admin-only tab now, or doctor self-service page
   too? → Recommend admin tab now; self-service later (same endpoint).
4. **One-off Break tab** — keep it (date-specific) alongside the recurring lunch
   in Profile? → Recommend keep both; they're different (recurring vs one day).
