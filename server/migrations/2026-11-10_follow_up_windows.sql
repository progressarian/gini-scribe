ALTER TABLE service_items ADD COLUMN IF NOT EXISTS follow_up_within_days SMALLINT;

ALTER TABLE service_items DROP CONSTRAINT IF EXISTS service_items_follow_up_days_check;
ALTER TABLE service_items
  ADD CONSTRAINT service_items_follow_up_days_check
  CHECK (follow_up_within_days BETWEEN 1 AND 90);

ALTER TABLE service_items DROP CONSTRAINT IF EXISTS service_items_follow_up_window_check;
ALTER TABLE service_items
  ADD CONSTRAINT service_items_follow_up_window_check
  CHECK (follow_up_within_days IS NULL
         OR (kind = 'consultation' AND visit_type IN ('Follow Up', 'Follow Up (3 days)')));

DROP INDEX IF EXISTS service_items_consultation_key;
CREATE UNIQUE INDEX service_items_consultation_key
  ON service_items (
    doctor_id,
    (CASE WHEN follow_up_within_days IS NULL THEN visit_type END),
    follow_up_within_days
  ) NULLS NOT DISTINCT
  WHERE kind = 'consultation' AND is_active;
