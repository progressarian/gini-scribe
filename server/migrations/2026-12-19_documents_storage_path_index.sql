CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_documents_storage_path
  ON documents (storage_path) WHERE storage_path IS NOT NULL;
