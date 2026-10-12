ALTER TABLE bills ADD COLUMN IF NOT EXISTS consultant_id INT REFERENCES doctors(id) ON DELETE SET NULL;

COMMENT ON COLUMN bills.consultant_id IS
  'Consultant reception chose for this bill (Consult Name). NULL means derived: consultation line doctor, then the visit doctor, then Hospital Admin for a tests-only bill.';
