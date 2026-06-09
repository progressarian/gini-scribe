-- ============================================================
-- Doctor Management & Availability
-- 2026-06-08
-- Additive only. No changes to existing tables except an optional
-- ADD COLUMN on appointments. Idempotent / safe to re-run.
-- See docs/doctor-management/ for the full design.
-- ============================================================

-- ── 0. Name → id resolver ────────────────────────────────────
-- Bridges the legacy free-text appointments.doctor_name world to the
-- canonical doctors.id used by all schedule tables. Tolerant of name vs
-- short_name; exact full-name match wins.
CREATE OR REPLACE FUNCTION resolve_doctor_id(p_name TEXT)
RETURNS INTEGER LANGUAGE sql STABLE AS $$
  SELECT id FROM doctors
   WHERE is_active
     AND (lower(name) = lower(p_name) OR lower(short_name) = lower(p_name))
   ORDER BY (lower(name) = lower(p_name)) DESC
   LIMIT 1
$$;

-- ── 1. Slot catalog (text label ↔ real clock times) ──────────
-- Labels MUST equal the existing TIME_SLOTS strings in
-- server/routes/appointment-slots.js so legacy rows keep matching.
CREATE TABLE IF NOT EXISTS slot_catalog (
  id          SERIAL PRIMARY KEY,
  label       TEXT NOT NULL UNIQUE,
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

-- ── 2. Weekly working schedule (Layer 0 — base) ──────────────
-- weekday: 0=Sun … 6=Sat (matches Postgres EXTRACT(DOW)).
CREATE TABLE IF NOT EXISTS doctor_weekly_schedule (
  id           SERIAL PRIMARY KEY,
  doctor_id    INTEGER NOT NULL REFERENCES doctors(id) ON DELETE CASCADE,
  weekday      SMALLINT NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  slot_label   TEXT NOT NULL REFERENCES slot_catalog(label),
  capacity     INTEGER NOT NULL DEFAULT 5 CHECK (capacity >= 0),
  is_active    BOOLEAN DEFAULT TRUE,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  updated_at   TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (doctor_id, weekday, slot_label)
);
CREATE INDEX IF NOT EXISTS idx_dws_doctor_weekday
  ON doctor_weekly_schedule (doctor_id, weekday) WHERE is_active;

-- ── 3. Recurring breaks (Layer 2) ────────────────────────────
-- weekday NULL = every working day.
CREATE TABLE IF NOT EXISTS doctor_recurring_breaks (
  id          SERIAL PRIMARY KEY,
  doctor_id   INTEGER NOT NULL REFERENCES doctors(id) ON DELETE CASCADE,
  weekday     SMALLINT CHECK (weekday BETWEEN 0 AND 6),
  slot_label  TEXT NOT NULL REFERENCES slot_catalog(label),
  reason      TEXT DEFAULT 'Break',
  is_active   BOOLEAN DEFAULT TRUE,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
-- A partial unique index lets weekday be NULL (treated as "all days") without
-- the NULL-not-distinct headache of a plain UNIQUE constraint.
CREATE UNIQUE INDEX IF NOT EXISTS uq_break_doctor_weekday_slot
  ON doctor_recurring_breaks (doctor_id, COALESCE(weekday, -1), slot_label);

-- ── 4. Leave / emergency / per-doctor holiday (Layers 3 & 4) ─
CREATE TABLE IF NOT EXISTS doctor_unavailability (
  id            SERIAL PRIMARY KEY,
  doctor_id     INTEGER NOT NULL REFERENCES doctors(id) ON DELETE CASCADE,
  doctor_name   TEXT,
  type          TEXT NOT NULL DEFAULT 'leave'
                  CHECK (type IN ('leave','emergency','holiday')),
  start_date    DATE NOT NULL,
  end_date      DATE NOT NULL,
  slot_labels   TEXT[],            -- NULL = whole day(s); else only these slots
  reason        TEXT,
  status        TEXT NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active','cancelled')),
  created_by    TEXT,
  reassignment_done BOOLEAN DEFAULT FALSE,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  CHECK (end_date >= start_date)
);
CREATE INDEX IF NOT EXISTS idx_unavail_doctor_dates
  ON doctor_unavailability (doctor_id, start_date, end_date) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_unavail_dates
  ON doctor_unavailability (start_date, end_date) WHERE status = 'active';

-- ── 5. Reassignment audit trail ──────────────────────────────
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
  trigger            TEXT,
  unavailability_id  INTEGER REFERENCES doctor_unavailability(id),
  reason             TEXT,
  reassigned_by      TEXT,
  patient_notified   BOOLEAN DEFAULT FALSE,
  created_at         TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_reassign_appt ON appointment_reassignments (appointment_id);
CREATE INDEX IF NOT EXISTS idx_reassign_date ON appointment_reassignments (appointment_date);

-- ── 6. (Optional) denormalized doctor_id on appointments ─────
-- Safe + additive. Backfill maps existing names; resolver still works without it.
ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS doctor_id INTEGER REFERENCES doctors(id);
UPDATE appointments a
   SET doctor_id = resolve_doctor_id(a.doctor_name)
 WHERE a.doctor_id IS NULL AND a.doctor_name IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_appt_doctor_id ON appointments (doctor_id);
