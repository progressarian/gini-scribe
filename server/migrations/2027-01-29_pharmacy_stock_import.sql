ALTER TABLE pharmacy_vendors ALTER COLUMN phone DROP NOT NULL;

ALTER TABLE pharmacy_purchase_lines
  ADD COLUMN IF NOT EXISTS vendor_id INT REFERENCES pharmacy_vendors(id);
