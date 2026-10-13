CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_lab_results_appointment
  ON lab_results (appointment_id) WHERE appointment_id IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_documents_extraction_pending
  ON documents (created_at) WHERE extracted_data->>'extraction_status' = 'pending';
