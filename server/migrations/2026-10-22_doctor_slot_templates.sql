CREATE TABLE IF NOT EXISTS doctor_slot_templates (
  id              SERIAL PRIMARY KEY,
  doctor_id       INTEGER NOT NULL REFERENCES doctors(id) ON DELETE CASCADE,
  effective_from  DATE NOT NULL,
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'withdrawn')),
  partial_last    TEXT NOT NULL DEFAULT 'drop' CHECK (partial_last IN ('drop', 'short')),
  note            TEXT,
  created_by      INTEGER REFERENCES doctors(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  withdrawn_by    INTEGER REFERENCES doctors(id) ON DELETE SET NULL,
  withdrawn_at    TIMESTAMPTZ,
  CHECK ((status = 'withdrawn') = (withdrawn_at IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_doctor_slot_templates_active_from
  ON doctor_slot_templates (doctor_id, effective_from)
  WHERE status = 'active';

CREATE TABLE IF NOT EXISTS doctor_slot_template_hours (
  id            SERIAL PRIMARY KEY,
  template_id   INTEGER NOT NULL REFERENCES doctor_slot_templates(id) ON DELETE CASCADE,
  weekday       SMALLINT NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  start_time    TIME NOT NULL,
  end_time      TIME NOT NULL,
  slot_minutes  SMALLINT NOT NULL CHECK (slot_minutes BETWEEN 5 AND 240),
  CHECK (start_time <> end_time)
);

CREATE INDEX IF NOT EXISTS idx_doctor_slot_template_hours_template
  ON doctor_slot_template_hours (template_id);

CREATE TABLE IF NOT EXISTS doctor_slot_template_breaks (
  id           SERIAL PRIMARY KEY,
  template_id  INTEGER NOT NULL REFERENCES doctor_slot_templates(id) ON DELETE CASCADE,
  weekday      SMALLINT CHECK (weekday BETWEEN 0 AND 6),
  name         TEXT NOT NULL CHECK (btrim(name) <> '' AND char_length(name) <= 40),
  start_time   TIME NOT NULL,
  end_time     TIME NOT NULL,
  CHECK (start_time <> end_time)
);

CREATE INDEX IF NOT EXISTS idx_doctor_slot_template_breaks_template
  ON doctor_slot_template_breaks (template_id);

CREATE OR REPLACE FUNCTION doctor_slot_templates_append_only()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'active'
     AND NEW.status = 'withdrawn'
     AND NEW.id = OLD.id
     AND NEW.doctor_id = OLD.doctor_id
     AND NEW.effective_from = OLD.effective_from
     AND NEW.partial_last = OLD.partial_last
     AND NEW.note IS NOT DISTINCT FROM OLD.note
     AND NEW.created_by IS NOT DISTINCT FROM OLD.created_by
     AND NEW.created_at = OLD.created_at THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'doctor_slot_templates is append-only: save a new version, or withdraw this one';
END;
$$;

DROP TRIGGER IF EXISTS trg_doctor_slot_templates_append_only ON doctor_slot_templates;
CREATE TRIGGER trg_doctor_slot_templates_append_only
  BEFORE UPDATE ON doctor_slot_templates
  FOR EACH ROW EXECUTE FUNCTION doctor_slot_templates_append_only();

CREATE OR REPLACE FUNCTION doctor_slot_template_parts_frozen()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% rows are part of a saved schedule version and cannot be changed', TG_TABLE_NAME;
END;
$$;

DROP TRIGGER IF EXISTS trg_doctor_slot_template_hours_frozen ON doctor_slot_template_hours;
CREATE TRIGGER trg_doctor_slot_template_hours_frozen
  BEFORE UPDATE ON doctor_slot_template_hours
  FOR EACH ROW EXECUTE FUNCTION doctor_slot_template_parts_frozen();

DROP TRIGGER IF EXISTS trg_doctor_slot_template_breaks_frozen ON doctor_slot_template_breaks;
CREATE TRIGGER trg_doctor_slot_template_breaks_frozen
  BEFORE UPDATE ON doctor_slot_template_breaks
  FOR EACH ROW EXECUTE FUNCTION doctor_slot_template_parts_frozen();

ALTER TABLE doctor_unavailability
  ADD COLUMN IF NOT EXISTS start_time TIME,
  ADD COLUMN IF NOT EXISTS end_time   TIME;

ALTER TABLE doctor_unavailability
  DROP CONSTRAINT IF EXISTS doctor_unavailability_time_range_check;
ALTER TABLE doctor_unavailability
  ADD CONSTRAINT doctor_unavailability_time_range_check
  CHECK ((start_time IS NULL) = (end_time IS NULL) AND (start_time IS NULL OR start_time <> end_time));

ALTER TABLE doctor_slot_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE doctor_slot_templates FORCE ROW LEVEL SECURITY;
REVOKE ALL ON doctor_slot_templates FROM anon, authenticated;

ALTER TABLE doctor_slot_template_hours ENABLE ROW LEVEL SECURITY;
ALTER TABLE doctor_slot_template_hours FORCE ROW LEVEL SECURITY;
REVOKE ALL ON doctor_slot_template_hours FROM anon, authenticated;

ALTER TABLE doctor_slot_template_breaks ENABLE ROW LEVEL SECURITY;
ALTER TABLE doctor_slot_template_breaks FORCE ROW LEVEL SECURITY;
REVOKE ALL ON doctor_slot_template_breaks FROM anon, authenticated;
