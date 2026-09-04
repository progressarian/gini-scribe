-- A visit that lost a duplicate-patient merge is a tombstone, not a cancellation.
--
-- merge-ghost-giniflow-visits cancels the ghost and detaches its appointment, so
-- reception's "Not coming" column showed four people who were in the building —
-- each with an Undo button that would have put the dead duplicate back on the
-- expected list. Recording the survivor makes the tombstone identifiable, so the
-- station screens can leave it out.

ALTER TABLE giniflow_visits
  ADD COLUMN IF NOT EXISTS merged_into_visit_id UUID REFERENCES giniflow_visits (id);

UPDATE giniflow_visits v
   SET merged_into_visit_id = (e.meta ->> 'merged_into_visit')::uuid
  FROM giniflow_visit_events e
 WHERE e.visit_id = v.id
   AND e.meta ->> 'source' = 'merge-ghost-giniflow-visits'
   AND e.meta ->> 'merged_into_visit' IS NOT NULL
   AND v.merged_into_visit_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_giniflow_visits_merged_into
  ON giniflow_visits (merged_into_visit_id)
  WHERE merged_into_visit_id IS NOT NULL;
