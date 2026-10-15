CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_appointments_attended_person_key
  ON appointments ((CASE
    WHEN length(regexp_replace(COALESCE(phone, ''), '\D', '', 'g')) >= 10
     AND NULLIF(TRIM(patient_name), '') IS NOT NULL
    THEN RIGHT(regexp_replace(phone, '\D', '', 'g'), 10) || '|' ||
         regexp_replace(
           regexp_replace(LOWER(patient_name), '^\s*(mr|mrs|ms|miss|dr|master|baby)\.?\s+', ''),
           '[^a-z]', '', 'g')
  END), appointment_date)
  WHERE status IN ('seen', 'completed', 'checkedin', 'in_visit', 'in-progress');
