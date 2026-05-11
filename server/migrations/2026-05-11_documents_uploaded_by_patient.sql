-- Flag rows in `documents` that came from the patient app (myhealthgenie)
-- rather than from a clinic capture. The patient app already sends
-- `source = 'patient_upload'`, but a dedicated boolean is far cheaper to
-- filter on in scribe dashboards and avoids matching on free-form text.

ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS uploaded_by_patient BOOLEAN NOT NULL DEFAULT FALSE;

UPDATE documents
SET uploaded_by_patient = TRUE
WHERE source = 'patient_upload'
  AND uploaded_by_patient = FALSE;

CREATE INDEX IF NOT EXISTS idx_documents_uploaded_by_patient
  ON documents(patient_id)
  WHERE uploaded_by_patient = TRUE;
