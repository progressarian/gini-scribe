-- Tag patient_messages with a `message_type` so the website-side chat
-- can filter/highlight machine-generated rows (e.g. side-effect logs)
-- separately from regular patient chat. Re-runnable.
--
-- Default 'chat' for back-compat. The patient app sends 'side_effect_log'
-- on side-effect notification messages.

ALTER TABLE patient_messages
  ADD COLUMN IF NOT EXISTS message_type TEXT NOT NULL DEFAULT 'chat';

CREATE INDEX IF NOT EXISTS idx_patient_messages_type
  ON patient_messages (conversation_id, message_type);
