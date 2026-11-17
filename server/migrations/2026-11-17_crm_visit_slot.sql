ALTER TABLE crm.visits
  ADD COLUMN IF NOT EXISTS visit_slot text CHECK (visit_slot IS NULL OR visit_slot IN ('morning', 'evening')); -- morning | evening

CREATE INDEX IF NOT EXISTS visits_doctor_slot_idx
  ON crm.visits (doctor_id, occurred_at DESC) INCLUDE (visit_slot) WHERE deleted_at IS NULL;
