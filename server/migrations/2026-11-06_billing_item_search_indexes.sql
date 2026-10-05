CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS service_items_name_trgm_idx
  ON service_items USING gin (name gin_trgm_ops);

CREATE INDEX IF NOT EXISTS service_items_code_trgm_idx
  ON service_items USING gin (code gin_trgm_ops);

CREATE INDEX IF NOT EXISTS bill_lines_item_created_idx
  ON bill_lines (service_item_id, created_at);
