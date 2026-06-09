# 01 — Data Model & Migrations

> Adds the schedule layer. **Additive only** — no destructive changes to
> `doctors`, `appointments`, `appointment_slots`, or `clinic_holidays`.
> Follows the repo convention: dated files in `server/migrations/`, idempotent
> (`IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`), safe to re-run.

---

## 0. The `doctor_name` → `doctor_id` reconciliation (read first)

Everything bookings touch keys off `appointments.doctor_name` (free TEXT). All
*new* schedule tables key off **`doctor_id` (FK → `doctors.id`)** because that is
stable across renames. The two worlds are bridged like this:

- New tables store **both** `doctor_id` (authoritative) and a denormalized
  `doctor_name` snapshot (for display + to match legacy rows).
- A helper resolves a free-text name to a doctor id, tolerant of `name` vs
  `short_name`:

```sql
-- server/migrations: helper used by the resolver and backfills
CREATE OR REPLACE FUNCTION resolve_doctor_id(p_name TEXT)
RETURNS INTEGER LANGUAGE sql STABLE AS $$
  SELECT id FROM doctors
   WHERE is_active
     AND (lower(name) = lower(p_name) OR lower(short_name) = lower(p_name))
   ORDER BY (lower(name) = lower(p_name)) DESC   -- exact full-name wins
   LIMIT 1
$$;
```

> ⚠️ **Data-hygiene precondition.** Before enforcement goes live, audit
> `appointments.doctor_name` values that do **not** resolve to a doctor:
> ```sql
> SELECT DISTINCT doctor_name
>   FROM appointments
>  WHERE doctor_name IS NOT NULL
>    AND resolve_doctor_id(doctor_name) IS NULL;
> ```
> Each unresolved name is a doctor whose schedule will never match. Fix by
> adding the doctor, adding a `short_name`, or normalizing the appointment text.
> This audit is a Phase-0 gate (Doc 06).

---

## 1. Slot catalog — give text slots real clock times

Today slots are a hardcoded JS array of labels. Break/leave math needs times.
Introduce a catalog table seeded from the existing `TIME_SLOTS`, **keeping the
exact same label strings** so existing `appointment_slots`/`appointments` rows
keep matching.

```sql
-- migrations/2026-06-XX_slot_catalog.sql
CREATE TABLE IF NOT EXISTS slot_catalog (
  id          SERIAL PRIMARY KEY,
  label       TEXT NOT NULL UNIQUE,   -- MUST equal existing TIME_SLOTS text
  start_time  TIME NOT NULL,
  end_time    TIME NOT NULL,
  sort_order  INTEGER NOT NULL,
  is_active   BOOLEAN DEFAULT TRUE
);

INSERT INTO slot_catalog (label, start_time, end_time, sort_order) VALUES
  ('9:30 AM to 10 AM', '09:30', '10:00', 1),
  ('10 AM to 11 AM',   '10:00', '11:00', 2),
  ('11 AM to 12 PM',   '11:00', '12:00', 3),
  ('12 PM to 1 PM',    '12:00', '13:00', 4),
  ('1 PM to 2 PM',     '13:00', '14:00', 5),
  ('2 PM to 2:30 PM',  '14:00', '14:30', 6),
  ('2:30 PM to 3 PM',  '14:30', '15:00', 7),
  ('3 PM to 3:30 PM',  '15:00', '15:30', 8),
  ('3:30 PM to 4 PM',  '15:30', '16:00', 9)
ON CONFLICT (label) DO NOTHING;
```

`appointment-slots.js` should later import labels from this table instead of the
hardcoded array (Doc 03), but the array stays as a fallback during rollout.

---

## 2. Weekly working schedule (Layer 0 — base)

One row per doctor × weekday × slot the doctor normally works.

```sql
-- migrations/2026-06-XX_doctor_weekly_schedule.sql
CREATE TABLE IF NOT EXISTS doctor_weekly_schedule (
  id           SERIAL PRIMARY KEY,
  doctor_id    INTEGER NOT NULL REFERENCES doctors(id) ON DELETE CASCADE,
  weekday      SMALLINT NOT NULL CHECK (weekday BETWEEN 0 AND 6),  -- 0=Sun … 6=Sat
  slot_label   TEXT NOT NULL REFERENCES slot_catalog(label),
  capacity     INTEGER NOT NULL DEFAULT 5 CHECK (capacity >= 0),
  is_active    BOOLEAN DEFAULT TRUE,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  updated_at   TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (doctor_id, weekday, slot_label)
);
CREATE INDEX IF NOT EXISTS idx_dws_doctor_weekday
  ON doctor_weekly_schedule (doctor_id, weekday) WHERE is_active;
```

- Absence of a row = doctor does **not** work that weekday/slot.
- `capacity` here is the *default* capacity; a per-date `appointment_slots` row
  (Layer 5) can override it for a specific day.

> **Optional "effective from/to" versioning** (defer to v2): to change a
> doctor's standing hours without losing history, add `effective_from DATE` /
> `effective_to DATE` and resolve the row valid for the target date. v1 keeps it
> simple — editing the schedule changes future and past resolution alike (past
> appointments are already concrete rows, so this is acceptable).

---

## 3. Recurring breaks (Layer 2)

Weekly breaks (lunch, admin block) expressed as slots removed from working days.
Two ways to model; pick one:

**Chosen (slot-based, matches v1 granularity decision):**

```sql
-- migrations/2026-06-XX_doctor_breaks.sql
CREATE TABLE IF NOT EXISTS doctor_recurring_breaks (
  id          SERIAL PRIMARY KEY,
  doctor_id   INTEGER NOT NULL REFERENCES doctors(id) ON DELETE CASCADE,
  weekday     SMALLINT CHECK (weekday BETWEEN 0 AND 6),  -- NULL = every working day
  slot_label  TEXT NOT NULL REFERENCES slot_catalog(label),
  reason      TEXT DEFAULT 'Break',
  is_active   BOOLEAN DEFAULT TRUE,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (doctor_id, weekday, slot_label)
);
```

A break makes a slot unavailable even though Layer 0 includes it. (Modeling
breaks as *removed slots* rather than clock ranges keeps it consistent with the
slot-level decision; a true clock-time `time_range` variant is noted in Doc 02
§"Future: sub-slot precision".)

---

## 4. Leave & emergency unavailability (Layers 3 & 4)

One table covers planned leave **and** emergency unavailability — they differ
only by `type` and by whether they trigger reassignment.

```sql
-- migrations/2026-06-XX_doctor_unavailability.sql
CREATE TABLE IF NOT EXISTS doctor_unavailability (
  id            SERIAL PRIMARY KEY,
  doctor_id     INTEGER NOT NULL REFERENCES doctors(id) ON DELETE CASCADE,
  doctor_name   TEXT,                         -- denormalized snapshot (display + legacy match)
  type          TEXT NOT NULL DEFAULT 'leave' -- 'leave' | 'emergency' | 'holiday'
                  CHECK (type IN ('leave','emergency','holiday')),
  start_date    DATE NOT NULL,
  end_date      DATE NOT NULL,                -- inclusive; = start_date for single day
  -- Partial-day support: NULL slot_labels = WHOLE day(s) off.
  -- Non-NULL = only these slots are off (e.g. left early at 2 PM).
  slot_labels   TEXT[],                       -- subset of slot_catalog.label, or NULL
  reason        TEXT,
  status        TEXT NOT NULL DEFAULT 'active' -- 'active' | 'cancelled'
                  CHECK (status IN ('active','cancelled')),
  created_by    TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  -- Reassignment bookkeeping (for emergency)
  reassignment_done  BOOLEAN DEFAULT FALSE,
  CHECK (end_date >= start_date)
);
CREATE INDEX IF NOT EXISTS idx_unavail_doctor_dates
  ON doctor_unavailability (doctor_id, start_date, end_date) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_unavail_dates
  ON doctor_unavailability (start_date, end_date) WHERE status = 'active';
```

Semantics:
- `type='leave'` — planned, created ahead of time. Booking is blocked for the
  window. Usually no existing patients to move (none could be booked once the
  leave exists), but if leave is entered *after* bookings exist, the
  reassignment flow can still be invoked.
- `type='emergency'` — created now. **Always** runs the reassignment flow
  (Doc 04) because patients are already booked.
- `type='holiday'` — a per-doctor full holiday (distinct from clinic-wide
  `clinic_holidays`). Optional; lets one doctor be off while clinic is open.

> **Why not reuse `clinic_holidays`?** That table is intentionally clinic-wide
> (`holiday_date UNIQUE`, no doctor column) and is consumed by the existing
> availability endpoint and CC sheets. We leave it untouched and add the
> per-doctor table alongside. The resolver checks both.

---

## 5. Reassignment audit trail

Every move of an existing patient is recorded — never silently overwrite.

```sql
-- migrations/2026-06-XX_appointment_reassignments.sql
CREATE TABLE IF NOT EXISTS appointment_reassignments (
  id                 SERIAL PRIMARY KEY,
  appointment_id     INTEGER REFERENCES appointments(id) ON DELETE SET NULL,
  patient_id         INTEGER REFERENCES patients(id),
  file_no            TEXT,
  appointment_date   DATE,
  time_slot          TEXT,
  from_doctor_name   TEXT,
  from_doctor_id     INTEGER REFERENCES doctors(id),
  to_doctor_name     TEXT,
  to_doctor_id       INTEGER REFERENCES doctors(id),
  trigger            TEXT,        -- 'emergency_leave' | 'planned_leave' | 'manual'
  unavailability_id  INTEGER REFERENCES doctor_unavailability(id),
  reason             TEXT,
  reassigned_by      TEXT,
  patient_notified   BOOLEAN DEFAULT FALSE,   -- hook for MSG91/push (deferred sender)
  created_at         TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_reassign_appt ON appointment_reassignments (appointment_id);
CREATE INDEX IF NOT EXISTS idx_reassign_date ON appointment_reassignments (appointment_date);
```

---

## 6. (Optional) Add `doctor_id` to `appointments` — deferred, non-blocking

Long-term it's worth denormalizing a real FK onto `appointments`:

```sql
ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS doctor_id INTEGER REFERENCES doctors(id);
-- Backfill (safe, idempotent):
UPDATE appointments a
   SET doctor_id = resolve_doctor_id(a.doctor_name)
 WHERE a.doctor_id IS NULL AND a.doctor_name IS NOT NULL;
```

**Not required for v1** — the resolver can map names on the fly. Listed so the
team can decide whether to adopt it now (cleaner joins) or later. If adopted,
keep `doctor_name` populated too; the ON CONFLICT index in `appointments` and
many reads still use it.

> ⚠️ **Verified — the `appointments` base table is NOT defined in this repo.**
> `schema.sql` and the `migrations/` folder contain only `ALTER TABLE
> appointments ADD COLUMN …` and index statements; the `CREATE TABLE
> appointments` and its unique partial index
> (`idx_appt_patient_day_slot_doc_status`, referenced by the `ON CONFLICT` in
> `appointments.js`) live **directly in the production database**, outside
> version control. Implications:
> - The `ADD COLUMN IF NOT EXISTS doctor_id` above is still safe and the right
>   pattern (matches how every existing appointments column was added).
> - Do **not** assume you can read the full appointments column list from the
>   repo — derive it from the `INSERT` in `appointments.js:136` plus the GHM
>   migration `ALTER`s. Known columns: `patient_id, patient_name, file_no,
>   phone, doctor_name, appointment_date, time_slot, visit_type, notes,
>   category, is_walkin, status` (+ the GHM/CC fields).
> - Coordinate any new index with whoever manages the prod schema.

---

## 7. Migration order & rollback

Apply in this order (each idempotent, additive):

1. `resolve_doctor_id()` function
2. `slot_catalog` (+ seed)
3. `doctor_weekly_schedule`
4. `doctor_recurring_breaks`
5. `doctor_unavailability`
6. `appointment_reassignments`
7. *(optional)* `appointments.doctor_id` + backfill

**Rollback** = `DROP TABLE` the new tables + `DROP FUNCTION resolve_doctor_id`.
Because nothing existing is altered (except the optional additive column),
rollback cannot corrupt current booking behavior. Enforcement is gated behind a
feature flag (Doc 06), so even with tables present the old flow runs until the
flag flips.

---

## 8. Entity-relationship summary

```
doctors ──1:N── doctor_weekly_schedule ──N:1── slot_catalog
   │  │  │
   │  │  └─1:N── doctor_recurring_breaks ──N:1── slot_catalog
   │  └────1:N── doctor_unavailability  (leave / emergency / per-doctor holiday)
   │
appointments ──1:N── appointment_reassignments ──N:1── doctors (from/to)
clinic_holidays  (unchanged, clinic-wide, consulted by resolver)
appointment_slots (unchanged, per-date capacity/block override = Layer 5)
```
