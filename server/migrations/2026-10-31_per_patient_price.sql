ALTER TABLE service_items ADD COLUMN IF NOT EXISTS price_per_patient BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE service_items DROP CONSTRAINT IF EXISTS service_items_price_per_patient_check;
ALTER TABLE service_items
  ADD CONSTRAINT service_items_price_per_patient_check
  CHECK (NOT price_per_patient OR kind NOT IN ('test', 'consultation'));

ALTER TABLE bill_lines ADD COLUMN IF NOT EXISTS agreed_rate NUMERIC(12,2);
ALTER TABLE bill_lines ADD COLUMN IF NOT EXISTS agreed_by INTEGER REFERENCES doctors(id) ON DELETE SET NULL;
ALTER TABLE bill_lines ADD COLUMN IF NOT EXISTS agreed_at TIMESTAMPTZ;

ALTER TABLE bill_lines DROP CONSTRAINT IF EXISTS bill_lines_agreed_rate_check;
ALTER TABLE bill_lines
  ADD CONSTRAINT bill_lines_agreed_rate_check CHECK (agreed_rate IS NULL OR agreed_rate >= 0);

ALTER TABLE bill_lines DROP CONSTRAINT IF EXISTS bill_lines_source_check;
ALTER TABLE bill_lines
  ADD CONSTRAINT bill_lines_source_check
  CHECK (source IN ('visit', 'lab_order', 'added', 'lab_case', 'ordered'));
