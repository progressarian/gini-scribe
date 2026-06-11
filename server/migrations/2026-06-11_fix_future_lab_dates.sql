-- ============================================================================
-- One-off data fix: re-anchor future-dated lab_results rows.
--
-- Cause: Claude-vision lab extraction occasionally misread the report YEAR
-- (e.g. 2026 → 2028), and nothing rejected a future test_date, so impossible
-- future-dated lab rows were stored. The code fix (server/utils/labDate.js +
-- routes/documents.js) now drops future dates on ingest; this corrects the rows
-- already written.
--
-- A lab result can never be dated in the future. We re-anchor each future row to
-- the most authoritative real, non-future date we can derive, in priority order:
--   1. source document's doc_date          (the report's own stated date)
--   2. linked appointment_date             (HealthRay labs tied to a visit)
--   3. source document's upload date        (created_at)
--   4. the lab_results row's own created_at (always in the past — safety net)
-- The final fallback guarantees a non-future, non-null result for every row.
--
-- Idempotent: only touches rows where test_date is still in the future, so
-- re-running is a no-op.
-- ============================================================================
WITH fix AS (
  SELECT lr.id,
    COALESCE(
      CASE WHEN d.doc_date::date        <= CURRENT_DATE THEN d.doc_date::date END,
      CASE WHEN a.appointment_date::date <= CURRENT_DATE THEN a.appointment_date::date END,
      CASE WHEN d.created_at::date       <= CURRENT_DATE THEN d.created_at::date END,
      lr.created_at::date
    ) AS new_date
  FROM lab_results lr
  LEFT JOIN documents    d ON d.id = lr.document_id
  LEFT JOIN appointments a ON a.id = lr.appointment_id
  WHERE lr.test_date::date > CURRENT_DATE
)
UPDATE lab_results lr
   SET test_date = fix.new_date
  FROM fix
 WHERE fix.id = lr.id
   AND fix.new_date IS NOT NULL;
