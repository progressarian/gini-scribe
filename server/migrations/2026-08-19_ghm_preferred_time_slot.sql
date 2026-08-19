ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS preferred_time_slot TEXT;
