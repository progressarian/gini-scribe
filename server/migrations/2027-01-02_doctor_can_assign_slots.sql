ALTER TABLE doctors ADD COLUMN IF NOT EXISTS can_assign_slots BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN doctors.can_assign_slots IS
  'May set the time slot on GHM call-list rows and in the GHM New Appointment form. Admins can always; this grants it to anyone else.';
