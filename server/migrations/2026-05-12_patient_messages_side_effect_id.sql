-- Link a side-effect log message bubble back to the side-effect row it
-- represents. Lets the reception inbox UI show a "Mark resolved" button
-- inside the bubble and PATCH /api/side-effects/:id without having to
-- guess the row by symptom name.
--
-- Nullable: only side-effect bubbles populate it.

ALTER TABLE patient_messages
  ADD COLUMN IF NOT EXISTS side_effect_id UUID;

CREATE INDEX IF NOT EXISTS idx_patient_messages_side_effect_id
  ON patient_messages (side_effect_id)
  WHERE side_effect_id IS NOT NULL;
