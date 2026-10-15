CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_lab_results_patient_test_date_result
  ON lab_results (patient_id, test_name, test_date DESC) INCLUDE (result);
