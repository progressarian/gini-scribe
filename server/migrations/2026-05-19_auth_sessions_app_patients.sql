-- Make auth_sessions able to track app-DB (UUID-keyed) patients alongside
-- hospital (integer-keyed) patients. Drops the patient_id FK so we can
-- store either kind; adds patient_db + patient_ref as the canonical
-- (db, id-as-text) tuple. patient_id INTEGER is kept for existing doctor
-- session writers; for new patient sessions we leave it NULL.

ALTER TABLE auth_sessions DROP CONSTRAINT IF EXISTS auth_sessions_patient_id_fkey;
ALTER TABLE auth_sessions ADD COLUMN IF NOT EXISTS patient_db  TEXT;
ALTER TABLE auth_sessions ADD COLUMN IF NOT EXISTS patient_ref TEXT;

UPDATE auth_sessions
   SET patient_db  = COALESCE(patient_db,
                              CASE WHEN patient_id IS NULL THEN NULL ELSE 'hospital' END),
       patient_ref = COALESCE(patient_ref, patient_id::text);
