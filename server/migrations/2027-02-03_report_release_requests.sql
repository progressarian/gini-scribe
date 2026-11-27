ALTER TABLE billing_requests
  DROP CONSTRAINT IF EXISTS billing_requests_kind_check,
  ADD CONSTRAINT billing_requests_kind_check
    CHECK (kind IN ('new_item', 'repeat_item', 'refund', 'deposit_refund', 'test_cancel',
                    'report_release'));

ALTER TABLE billing_requests
  DROP CONSTRAINT IF EXISTS billing_requests_report_release_check,
  ADD CONSTRAINT billing_requests_report_release_check
    CHECK (kind <> 'report_release'
           OR (visit_id IS NOT NULL AND patient_id IS NOT NULL
               AND service_item_id IS NULL AND proposed_name IS NULL));

CREATE UNIQUE INDEX IF NOT EXISTS billing_requests_pending_report_release
  ON billing_requests (visit_id)
  WHERE kind = 'report_release' AND status = 'pending';

CREATE INDEX IF NOT EXISTS billing_requests_report_release_visit
  ON billing_requests (visit_id, status)
  WHERE kind = 'report_release';
