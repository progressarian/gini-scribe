ALTER TABLE payments
  DROP CONSTRAINT IF EXISTS payments_upi_app_check,
  ADD CONSTRAINT payments_upi_app_check
    CHECK (upi_app IS NULL
           OR (upi_app IN ('bharatpe', 'phonepe', 'gpay', 'paytm', 'bhim', 'amazonpay', 'cred',
                           'bank', 'other')
               AND (mode = 'upi' OR (mode = 'healthray' AND paid_via = 'upi'))));
