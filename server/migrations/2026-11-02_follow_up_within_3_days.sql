ALTER TABLE service_items DROP CONSTRAINT IF EXISTS service_items_visit_type_check;
ALTER TABLE service_items
  ADD CONSTRAINT service_items_visit_type_check
  CHECK (visit_type IN ('New', 'Follow Up', 'Follow Up (3 days)'));
