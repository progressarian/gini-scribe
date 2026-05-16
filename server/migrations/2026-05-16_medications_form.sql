-- Add form column to medications (Tablet, Capsule, Injection, Syrup, etc.)
-- Extracted from the dosage-form prefix of the medicine name during sync.

ALTER TABLE medications ADD COLUMN IF NOT EXISTS form TEXT;

-- Backfill from existing name prefixes (Tab Cilacar M → Tablet, etc.)
UPDATE medications SET form = CASE
  WHEN name ~* '^(tablets?|tab\.?)\s+'      THEN 'Tablet'
  WHEN name ~* '^(capsules?|cap\.?)\s+'     THEN 'Capsule'
  WHEN name ~* '^(injections?|inj\.?)\s+'   THEN 'Injection'
  WHEN name ~* '^(syrups?|syp\.?)\s+'       THEN 'Syrup'
  WHEN name ~* '^(suspensions?|susp\.?)\s+' THEN 'Suspension'
  WHEN name ~* '^sachets?\s+'               THEN 'Sachet'
  WHEN name ~* '^(ointments?|oint\.?)\s+'   THEN 'Ointment'
  WHEN name ~* '^(creams?)\s+'              THEN 'Cream'
  WHEN name ~* '^(drops?)\s+'               THEN 'Drops'
  WHEN name ~* '^(inhalers?)\s+'            THEN 'Inhaler'
  WHEN route IN ('SC', 'IM', 'IV')          THEN 'Injection'
  ELSE NULL
END
WHERE form IS NULL;
