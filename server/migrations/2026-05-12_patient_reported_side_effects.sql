-- Patient-reported side effects (gini-only — patient_id is the scribe int FK).
--
-- Patients tap "Side FX" on MedCardV9 in myhealthgenie and can:
--   • Mark a curated common side-effect as "I'm experiencing this"
--   • Add a custom side-effect they're feeling
--   • Edit severity / notes / resolution state
--   • Delete an entry
--
-- Each create / update fires a system message into the patient's reception
-- conversation (gini-scribe inbox) via the patient_messages pipeline so the
-- reception team can follow up.
--
-- Re-runnable: drops previous attempts before recreating.

DROP FUNCTION IF EXISTS gini_upsert_patient_side_effect(UUID, INTEGER, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT);
DROP FUNCTION IF EXISTS gini_delete_patient_side_effect(UUID, INTEGER);
DROP FUNCTION IF EXISTS gini_get_patient_side_effects(INTEGER, TEXT, INT);
DROP TABLE IF EXISTS patient_reported_side_effects;

CREATE TABLE patient_reported_side_effects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id INTEGER NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  medication_id TEXT,
  medication_name TEXT,
  name TEXT NOT NULL,
  description TEXT,
  severity TEXT NOT NULL DEFAULT 'common'
    CHECK (severity IN ('common','uncommon','warn')),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','resolved')),
  source TEXT NOT NULL DEFAULT 'custom'
    CHECK (source IN ('curated','custom')),
  patient_note TEXT,
  reported_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_prse_patient
  ON patient_reported_side_effects (patient_id, reported_at DESC);
CREATE INDEX idx_prse_patient_med
  ON patient_reported_side_effects (patient_id, medication_id);

-- One row per (patient, medication, name) — re-tapping toggles the same row.
CREATE UNIQUE INDEX idx_prse_unique_per_med_name
  ON patient_reported_side_effects (patient_id, COALESCE(medication_id, ''), lower(name));


-- Patient app upsert. If p_id is NULL, inserts a new row; otherwise updates
-- the named row (patient_id must match — soft check, enforced via WHERE).
CREATE OR REPLACE FUNCTION gini_upsert_patient_side_effect(
  p_id UUID,
  p_patient_id INTEGER,
  p_medication_id TEXT,
  p_medication_name TEXT,
  p_name TEXT,
  p_description TEXT DEFAULT NULL,
  p_severity TEXT DEFAULT 'common',
  p_status TEXT DEFAULT 'active',
  p_source TEXT DEFAULT 'custom',
  p_patient_note TEXT DEFAULT NULL
) RETURNS UUID AS $$
DECLARE
  v_id UUID;
  v_exists BOOLEAN;
BEGIN
  IF p_patient_id IS NULL THEN
    RAISE EXCEPTION 'p_patient_id is required';
  END IF;
  IF p_name IS NULL OR length(trim(p_name)) = 0 THEN
    RAISE EXCEPTION 'p_name is required';
  END IF;
  SELECT EXISTS(SELECT 1 FROM patients WHERE id = p_patient_id) INTO v_exists;
  IF NOT v_exists THEN
    RAISE EXCEPTION 'patient % not found', p_patient_id;
  END IF;

  IF p_id IS NULL THEN
    -- Insert with ON CONFLICT on the (patient, med, lower(name)) unique
    -- index so re-tapping the same effect re-activates it instead of erroring.
    INSERT INTO patient_reported_side_effects
      (patient_id, medication_id, medication_name, name, description,
       severity, status, source, patient_note)
    VALUES
      (p_patient_id, p_medication_id, COALESCE(p_medication_name, ''),
       trim(p_name), p_description,
       COALESCE(p_severity, 'common'),
       COALESCE(p_status, 'active'),
       COALESCE(p_source, 'custom'),
       p_patient_note)
    ON CONFLICT (patient_id, COALESCE(medication_id, ''), lower(name))
    DO UPDATE SET
      description = EXCLUDED.description,
      severity = EXCLUDED.severity,
      status = EXCLUDED.status,
      patient_note = EXCLUDED.patient_note,
      updated_at = now()
    RETURNING id INTO v_id;
  ELSE
    UPDATE patient_reported_side_effects
       SET name = trim(p_name),
           description = p_description,
           severity = COALESCE(p_severity, severity),
           status = COALESCE(p_status, status),
           patient_note = p_patient_note,
           medication_id = p_medication_id,
           medication_name = COALESCE(p_medication_name, medication_name),
           updated_at = now()
     WHERE id = p_id
       AND patient_id = p_patient_id
    RETURNING id INTO v_id;
    IF v_id IS NULL THEN
      RAISE EXCEPTION 'side-effect row % not found for patient %', p_id, p_patient_id;
    END IF;
  END IF;

  RETURN v_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;


CREATE OR REPLACE FUNCTION gini_delete_patient_side_effect(
  p_id UUID,
  p_patient_id INTEGER
) RETURNS BOOLEAN AS $$
DECLARE
  v_count INT;
BEGIN
  DELETE FROM patient_reported_side_effects
   WHERE id = p_id AND patient_id = p_patient_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count > 0;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;


CREATE OR REPLACE FUNCTION gini_get_patient_side_effects(
  p_patient_id INTEGER,
  p_medication_id TEXT DEFAULT NULL,
  p_limit INT DEFAULT 200
) RETURNS TABLE (
  id UUID,
  patient_id INTEGER,
  medication_id TEXT,
  medication_name TEXT,
  name TEXT,
  description TEXT,
  severity TEXT,
  status TEXT,
  source TEXT,
  patient_note TEXT,
  reported_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ
) AS $$
BEGIN
  IF p_patient_id IS NULL THEN
    RAISE EXCEPTION 'p_patient_id is required';
  END IF;
  RETURN QUERY
    SELECT r.id, r.patient_id, r.medication_id, r.medication_name,
           r.name, r.description, r.severity, r.status, r.source,
           r.patient_note, r.reported_at, r.updated_at
      FROM patient_reported_side_effects r
     WHERE r.patient_id = p_patient_id
       AND (p_medication_id IS NULL OR r.medication_id = p_medication_id)
     ORDER BY r.reported_at DESC
     LIMIT p_limit;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
