ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS booking_status TEXT;
