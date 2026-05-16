-- Add patient_notes column to medications.
-- The existing notes column is an internal sync-tracking key (healthray:<id>)
-- and must not be edited by doctors. patient_notes is the clean, doctor-editable
-- "Additional instruction" field shown in the UI.

ALTER TABLE medications ADD COLUMN IF NOT EXISTS patient_notes TEXT;

-- Backfill: extract any real content from the existing notes values.
--   "healthray:244357040"                  → NULL  (pure tracking id)
--   "healthray:244357040 — Take with food" → "Take with food"
--   "Take with food"  (manually entered)   → "Take with food"
UPDATE medications
SET patient_notes = CASE
  WHEN notes ~* '^healthray:[\w-]+$' THEN NULL
  WHEN notes ~* '^healthray:[\w-]+\s*[—–-]+\s*.+'
    THEN TRIM(REGEXP_REPLACE(notes, '^healthray:[\w-]+\s*[—–-]+\s*', '', 'i'))
  WHEN notes IS NOT NULL AND notes NOT LIKE 'healthray:%' THEN notes
  ELSE NULL
END
WHERE notes IS NOT NULL;
