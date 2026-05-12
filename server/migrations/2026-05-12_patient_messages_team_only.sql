-- Team-only flag on patient_messages.
--
-- Some posts (e.g. "🩺 Side-effect marked resolved by the team") are
-- internal logs that the reception/lab team needs to see in their inbox
-- but the patient app must NOT show to the patient. Flag those rows here
-- so the patient app can filter with `team_only=false`.

ALTER TABLE patient_messages
  ADD COLUMN IF NOT EXISTS team_only BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_patient_messages_team_only
  ON patient_messages (conversation_id, team_only);
