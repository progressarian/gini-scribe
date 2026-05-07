-- Add structured "common side effects" extracted from prescriptions, distinct
-- from the existing free-text `side_effects` column (which the doctor uses for
-- patient-observed side effects in EditMedicationModal).
--
-- Format: JSONB array of up to 3 entries, each:
--   { "name": "Stomach upset / loose stools",
--     "desc": "Take with food. Extended-release form helps.",
--     "severity": "common" | "uncommon" | "warn" }
--
-- Populated by the AI prescription extractor (parser.js CLINICAL_EXTRACTION_PROMPT)
-- and pushed to myhealthgenie via gini_sync_medication so the patient app can
-- render real, prescription-specific side-effect tips on each medicine card
-- instead of the static lookup in src/constants/medSideEffects.ts.

ALTER TABLE medications
  ADD COLUMN IF NOT EXISTS common_side_effects JSONB DEFAULT '[]'::jsonb;
