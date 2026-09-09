-- Typed lab values for a case Gini Flow does not own (32-LAB-TYPED-RESULTS-PLAN).
--
-- That feature was built against `giniflow_lab_orders` alone, so every screen it
-- describes — the form, the trending, the flags, the MO card carrying the numbers
-- — was reachable only for a Gini-raised order. There are SIX of those in the
-- table's entire history and none today, while the hospital runs 25-50 HealthRay
-- cases a day. So in practice the lab could never type a value: the one path that
-- existed was the one nobody uses.
--
-- `lab_order_id` is a uuid FK into `giniflow_lab_orders` and cannot hold a
-- HealthRay case, which is keyed on `case_no` text and is rewritten by every sync
-- pass. Same reason `giniflow_lab_case_actions` keys on `case_no`: the row is
-- about the sample, not about our current copy of it.
ALTER TABLE lab_results
  ADD COLUMN IF NOT EXISTS lab_case_no TEXT;

CREATE INDEX IF NOT EXISTS idx_lab_results_lab_case_no
  ON lab_results (lab_case_no)
  WHERE lab_case_no IS NOT NULL;
