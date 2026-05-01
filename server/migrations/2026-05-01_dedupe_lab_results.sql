-- One lab reading per (patient, canonical test, date).
--
-- Existing rows for the same (patient_id, canonical_name, test_date) — created
-- before per-date dedup landed in documents.js / syncLabResults — are collapsed
-- to the lowest id, choosing by source priority then earliest created_at.
-- Then we install the unique index that enforces the rule going forward.

WITH ranked AS (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY patient_id, canonical_name, test_date
           ORDER BY CASE source
             WHEN 'opd' THEN 1
             WHEN 'report_extract' THEN 2
             WHEN 'lab_healthray' THEN 3
             WHEN 'vitals_sheet' THEN 4
             WHEN 'prescription_parsed' THEN 5
             WHEN 'healthray' THEN 6
             WHEN 'manual' THEN 7
             WHEN 'scribe' THEN 8
             WHEN 'import' THEN 9
             ELSE 99
           END,
           created_at NULLS LAST,
           id
         ) AS rn
  FROM lab_results
  WHERE canonical_name IS NOT NULL
    AND test_date IS NOT NULL
    AND source IN ('report_extract','manual','opd','healthray','prescription_parsed','lab_healthray','vitals_sheet','scribe','import')
)
DELETE FROM lab_results lr USING ranked r
WHERE lr.id = r.id AND r.rn > 1;

CREATE UNIQUE INDEX IF NOT EXISTS uq_lab_results_per_date
  ON lab_results (patient_id, canonical_name, test_date)
  WHERE canonical_name IS NOT NULL
    AND source IN ('report_extract','manual','opd','healthray','prescription_parsed','lab_healthray','vitals_sheet','scribe','import');
