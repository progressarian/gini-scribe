ALTER TABLE billing_requests ADD COLUMN IF NOT EXISTS reason_code TEXT;

ALTER TABLE billing_requests
  DROP CONSTRAINT IF EXISTS billing_requests_reason_code_check,
  ADD CONSTRAINT billing_requests_reason_code_check
    CHECK (reason_code IS NULL OR reason_code IN ('long_wait', 'doctor_cancelled',
           'station_unavailable', 'patient_declined', 'billed_by_mistake', 'other'));

ALTER TABLE billing_requests
  DROP CONSTRAINT IF EXISTS billing_requests_reason_code_refund_check,
  ADD CONSTRAINT billing_requests_reason_code_refund_check
    CHECK (reason_code IS NULL OR kind = 'refund');
