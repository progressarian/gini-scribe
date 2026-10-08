ALTER TABLE doctors ADD COLUMN IF NOT EXISTS can_assign_calls BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN doctors.can_assign_calls IS
  'May assign and unassign GHM call-list patients to OBT staff. Admins can always; this grants it to anyone else.';

UPDATE doctors SET can_assign_calls = TRUE WHERE id = 60;
