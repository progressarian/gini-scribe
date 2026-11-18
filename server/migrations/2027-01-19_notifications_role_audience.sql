ALTER TABLE notifications
  ADD COLUMN IF NOT EXISTS role TEXT CHECK (role IS NULL OR role ~ '^[a-z_]{2,40}$');

ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_audience;

UPDATE notifications
   SET role = 'pharmacy_admin', capability = NULL
 WHERE capability LIKE 'PHARMACY\_%' AND doctor_id IS NULL;

ALTER TABLE notifications
  ADD CONSTRAINT notifications_audience CHECK (num_nonnulls(capability, doctor_id, role) = 1);

CREATE INDEX IF NOT EXISTS notifications_role_idx
  ON notifications (role, created_at DESC) WHERE resolved_at IS NULL AND role IS NOT NULL;
