ALTER TABLE crm.import_batches
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'doctors' CHECK (kind IN ('doctors', 'visits')); -- doctors | visits

ALTER TABLE crm.visits
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'app' CHECK (source IN ('app', 'sheet')), -- app | sheet
  ADD COLUMN IF NOT EXISTS import_batch_id uuid REFERENCES crm.import_batches(id);

ALTER TABLE crm.import_rows
  ADD COLUMN IF NOT EXISTS visit_date    date,
  ADD COLUMN IF NOT EXISTS visit_status  text CHECK (visit_status IN ('completed', 'doctor_unavailable', 'not_visited')), -- completed | doctor_unavailable | not_visited
  ADD COLUMN IF NOT EXISTS visit_type    text,
  ADD COLUMN IF NOT EXISTS visit_outcome text,
  ADD COLUMN IF NOT EXISTS visit_notes   text,
  ADD COLUMN IF NOT EXISTS visit_state   text CHECK (visit_state IN ('ready', 'already_logged', 'failed', 'not_visited', 'not_filled', 'imported', 'undone')), -- ready | already_logged | failed | not_visited | not_filled | imported | undone
  ADD COLUMN IF NOT EXISTS visit_id      uuid REFERENCES crm.visits(id);

CREATE INDEX IF NOT EXISTS import_rows_visit_state_idx ON crm.import_rows (batch_id, visit_state);
CREATE INDEX IF NOT EXISTS import_batches_uploader_kind_idx ON crm.import_batches (uploaded_by, kind, created_at DESC);
CREATE INDEX IF NOT EXISTS visits_exec_doctor_day_idx ON crm.visits (executive_id, doctor_id, occurred_at) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS visits_import_batch_idx ON crm.visits (import_batch_id) WHERE import_batch_id IS NOT NULL;
