ALTER TABLE doctors ADD COLUMN IF NOT EXISTS slot_booking BOOLEAN NOT NULL DEFAULT false;

UPDATE doctors SET slot_booking = true
 WHERE is_active
   AND role = 'consultant'
   AND (name ILIKE '%Bhansali%' OR name ILIKE '%Beant%' OR name ILIKE '%Simran%');
