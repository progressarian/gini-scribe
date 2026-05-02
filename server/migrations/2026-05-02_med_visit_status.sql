-- Persist the "current vs previous visit" bucket on the medications row so
-- the scribe UI, AI summary, and patient-app screens stop re-deriving it
-- from `last_prescribed_date` at render time. Bucket is recomputed on every
-- write path that touches an active row (see markMedicationVisitStatus).
ALTER TABLE medications
  ADD COLUMN IF NOT EXISTS visit_status TEXT
  CHECK (visit_status IN ('current', 'previous'));

CREATE INDEX IF NOT EXISTS idx_medications_patient_visit_status
  ON medications (patient_id, visit_status)
  WHERE is_active = true;

-- Initial backfill: any active row whose last_prescribed_date matches the
-- patient's max becomes 'current', the rest become 'previous'. Inactive
-- rows leave visit_status NULL.
WITH latest AS (
  SELECT patient_id, MAX(last_prescribed_date::date) AS d
    FROM medications
   WHERE is_active = true
   GROUP BY patient_id
)
UPDATE medications m
   SET visit_status = CASE
         WHEN l.d IS NULL
           OR m.last_prescribed_date IS NULL
           OR m.last_prescribed_date::date = l.d THEN 'current'
         ELSE 'previous'
       END
  FROM latest l
 WHERE m.patient_id = l.patient_id
   AND m.is_active = true
   AND m.visit_status IS NULL;
