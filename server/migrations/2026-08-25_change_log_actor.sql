ALTER TABLE appointment_change_log
  ADD COLUMN IF NOT EXISTS changed_by TEXT,
  ADD COLUMN IF NOT EXISTS changed_by_id INTEGER;
