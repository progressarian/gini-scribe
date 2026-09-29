ALTER TABLE billing_settings
  ADD COLUMN IF NOT EXISTS auto_add_lab_case_tests BOOLEAN NOT NULL DEFAULT TRUE;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'bill_lines'::regclass
       AND conname = 'bill_lines_source_check'
       AND pg_get_constraintdef(oid) LIKE '%lab_case%'
  ) THEN
    ALTER TABLE bill_lines DROP CONSTRAINT IF EXISTS bill_lines_source_check;
    ALTER TABLE bill_lines ADD CONSTRAINT bill_lines_source_check
      CHECK (source IN ('visit', 'lab_order', 'added', 'lab_case'));
  END IF;
END $$;
