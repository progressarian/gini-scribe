ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS giniflow_extra_report_of UUID;

CREATE INDEX IF NOT EXISTS idx_documents_giniflow_extra_report_of
  ON documents (giniflow_extra_report_of)
  WHERE giniflow_extra_report_of IS NOT NULL;

COMMENT ON COLUMN documents.giniflow_extra_report_of IS
  'The giniflow_lab_orders row this is an additional report of (e.g. a second X-ray film). The first report stays on giniflow_lab_order_id.';
