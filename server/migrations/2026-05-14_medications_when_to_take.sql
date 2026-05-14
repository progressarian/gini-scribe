-- Add a dedicated, patient-friendly "when to take" field on medications.
-- Stores comma-separated values from the EditMedicationModal pill vocabulary:
-- Fasting, Before breakfast, After breakfast, Before lunch, After lunch,
-- Before dinner, After dinner, At bedtime, With milk, SOS only, Any time.
-- The legacy `timing` column is preserved as the consultant-facing free-text.
ALTER TABLE medications
  ADD COLUMN IF NOT EXISTS when_to_take TEXT;

-- Backfill from `timing` so existing rows show something to the patient
-- immediately. Future writes from the AI extractor / EditMedicationModal
-- will overwrite with the canonical pill vocabulary.
UPDATE medications
   SET when_to_take = timing
 WHERE when_to_take IS NULL
   AND timing IS NOT NULL
   AND timing <> '';
