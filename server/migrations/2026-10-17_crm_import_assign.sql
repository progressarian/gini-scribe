ALTER TABLE crm.import_batches
  ADD COLUMN IF NOT EXISTS headers jsonb;

ALTER TABLE crm.import_rows
  ADD COLUMN IF NOT EXISTS outcome        text CHECK (outcome IN ('create', 'possible_duplicate', 'duplicate', 'error', 'assign', 'unchanged', 'failed')), -- create | possible_duplicate | duplicate | error | assign | unchanged | failed
  ADD COLUMN IF NOT EXISTS flags          jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS doctor_match   text CHECK (doctor_match IN ('id', 'mobile', 'name', 'new')), -- id | mobile | name | new
  ADD COLUMN IF NOT EXISTS assignee_typed text,
  ADD COLUMN IF NOT EXISTS assignee_id    uuid REFERENCES crm.users(id),
  ADD COLUMN IF NOT EXISTS assignee_note  text,
  ADD COLUMN IF NOT EXISTS assign_status  text CHECK (assign_status IN ('pending', 'assigned', 'unchanged', 'skipped', 'failed')), -- pending | assigned | unchanged | skipped | failed
  ADD COLUMN IF NOT EXISTS fail_reason    text,
  ADD COLUMN IF NOT EXISTS suggested_assignee_id uuid REFERENCES crm.users(id);

CREATE INDEX IF NOT EXISTS import_rows_outcome_idx ON crm.import_rows (batch_id, outcome);
DROP INDEX IF EXISTS crm.import_rows_assign_status_idx;
