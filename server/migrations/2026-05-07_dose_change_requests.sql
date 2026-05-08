-- Medication dose-change requests (gini-only — patient_id is the scribe int FK).
-- One row per request. Patient initiates from MedCardV9 in myhealthgenie via
-- the gini_create_dose_change_request RPC over Supabase PostgREST; doctor
-- approves/rejects via Express (server/routes/doseChangeRequests.js), and on
-- approval the medications.dose is updated atomically inside the same txn.
--
-- Re-runnable: drops the previous attempt before recreating.

DROP FUNCTION IF EXISTS gini_create_dose_change_request(INTEGER, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT);
DROP FUNCTION IF EXISTS gini_get_patient_dose_change_requests(INTEGER, INT);
DROP FUNCTION IF EXISTS gini_cancel_dose_change_request(UUID, INTEGER);
DROP TABLE IF EXISTS medication_dose_change_requests;

CREATE TABLE medication_dose_change_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id INTEGER NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  medication_id TEXT NOT NULL,
  medication_name TEXT NOT NULL,
  current_dose TEXT NOT NULL,
  requested_dose TEXT NOT NULL,
  final_dose TEXT,
  dose_unit TEXT,
  patient_reason TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','approved','rejected','cancelled')),
  doctor_id TEXT,
  doctor_note TEXT,
  reject_reason TEXT,
  initiated_by TEXT NOT NULL DEFAULT 'patient'
    CHECK (initiated_by IN ('patient','doctor')),
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at TIMESTAMPTZ
);

CREATE INDEX idx_dcr_patient
  ON medication_dose_change_requests (patient_id, status, requested_at DESC);
CREATE INDEX idx_dcr_status
  ON medication_dose_change_requests (status, requested_at DESC);
CREATE INDEX idx_dcr_med
  ON medication_dose_change_requests (medication_id);

-- Only one pending request per (patient, medication) at a time.
CREATE UNIQUE INDEX idx_dcr_one_pending_per_med
  ON medication_dose_change_requests (patient_id, medication_id)
  WHERE status = 'pending';


-- Patient app calls this. Returns the new row's UUID.
CREATE OR REPLACE FUNCTION gini_create_dose_change_request(
  p_patient_id INTEGER,
  p_medication_id TEXT,
  p_medication_name TEXT,
  p_current_dose TEXT,
  p_requested_dose TEXT,
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
  IF p_requested_dose IS NULL OR length(trim(p_requested_dose)) = 0 THEN
    RAISE EXCEPTION 'p_requested_dose is required';
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
     COALESCE(p_current_dose, ''), p_requested_dose,
     p_dose_unit, p_patient_reason, 'patient')
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;


-- Patient app reads its own dose-change history via this.
CREATE OR REPLACE FUNCTION gini_get_patient_dose_change_requests(
  p_patient_id INTEGER,
  p_limit INT DEFAULT 100
) RETURNS TABLE (
  id UUID,
  patient_id INTEGER,
  medication_id TEXT,
  medication_name TEXT,
  current_dose TEXT,
  requested_dose TEXT,
  final_dose TEXT,
  dose_unit TEXT,
  patient_reason TEXT,
  status TEXT,
  doctor_id TEXT,
  doctor_note TEXT,
  reject_reason TEXT,
  initiated_by TEXT,
  requested_at TIMESTAMPTZ,
  decided_at TIMESTAMPTZ
) AS $$
BEGIN
  IF p_patient_id IS NULL THEN
    RAISE EXCEPTION 'p_patient_id is required';
  END IF;
  RETURN QUERY
    SELECT r.id, r.patient_id, r.medication_id, r.medication_name,
           r.current_dose, r.requested_dose, r.final_dose, r.dose_unit,
           r.patient_reason, r.status, r.doctor_id, r.doctor_note,
           r.reject_reason, r.initiated_by, r.requested_at, r.decided_at
      FROM medication_dose_change_requests r
     WHERE r.patient_id = p_patient_id
     ORDER BY r.requested_at DESC
     LIMIT p_limit;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;


-- Patient cancels a pending request. p_patient_id is checked so a patient can
-- only cancel their own request.
CREATE OR REPLACE FUNCTION gini_cancel_dose_change_request(
  p_request_id UUID,
  p_patient_id INTEGER
) RETURNS BOOLEAN AS $$
DECLARE
  v_count INT;
BEGIN
  UPDATE medication_dose_change_requests
     SET status = 'cancelled',
         decided_at = now()
   WHERE id = p_request_id
     AND patient_id = p_patient_id
     AND status = 'pending';
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count > 0;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
