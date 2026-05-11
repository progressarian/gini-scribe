-- Dose change note flow.
--
-- Patient now sends a free-text note to their doctor (no proposed dose value);
-- the doctor reads the note and types in the new dose during approval. The
-- old required `requested_dose` becomes optional, and we make sure the
-- `medications` table has an `updated_at` column so the approval transaction
-- can stamp it without erroring (and silently rolling back the write).

-- 1. Make requested_dose optional on the request table (note-only requests).
ALTER TABLE medication_dose_change_requests
  ALTER COLUMN requested_dose DROP NOT NULL;

-- 2. Make sure medications has updated_at so the approval txn can stamp it
--    without erroring on installs that never ran the dedup script.
ALTER TABLE medications
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

-- 3. Recreate the create-RPC so requested_dose is optional. Patient app now
--    passes the note via p_patient_reason; p_requested_dose may be NULL.
DROP FUNCTION IF EXISTS gini_create_dose_change_request(INTEGER, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT);

CREATE OR REPLACE FUNCTION gini_create_dose_change_request(
  p_patient_id INTEGER,
  p_medication_id TEXT,
  p_medication_name TEXT,
  p_current_dose TEXT,
  p_requested_dose TEXT DEFAULT NULL,
  p_dose_unit TEXT DEFAULT NULL,
  p_patient_reason TEXT DEFAULT NULL
) RETURNS UUID AS $$
DECLARE
  v_id UUID;
  v_exists BOOLEAN;
BEGIN
  IF p_patient_id IS NULL THEN
    RAISE EXCEPTION 'p_patient_id is required';
  END IF;
  IF p_medication_id IS NULL OR length(trim(p_medication_id)) = 0 THEN
    RAISE EXCEPTION 'p_medication_id is required';
  END IF;
  IF (p_patient_reason IS NULL OR length(trim(p_patient_reason)) = 0)
     AND (p_requested_dose IS NULL OR length(trim(p_requested_dose)) = 0) THEN
    RAISE EXCEPTION 'either a note or a requested dose is required';
  END IF;
  SELECT EXISTS(SELECT 1 FROM patients WHERE id = p_patient_id) INTO v_exists;
  IF NOT v_exists THEN
    RAISE EXCEPTION 'patient % not found', p_patient_id;
  END IF;

  INSERT INTO medication_dose_change_requests
    (patient_id, medication_id, medication_name, current_dose,
     requested_dose, dose_unit, patient_reason, initiated_by)
  VALUES
    (p_patient_id, p_medication_id, COALESCE(p_medication_name, ''),
     COALESCE(p_current_dose, ''),
     NULLIF(trim(COALESCE(p_requested_dose, '')), ''),
     p_dose_unit, p_patient_reason, 'patient')
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
