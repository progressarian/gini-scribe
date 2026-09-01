-- Live updates need a monotonic key to tail from, and every Gini Flow event
-- table is keyed on a uuid. A BIGSERIAL gives the tailer an exact watermark —
-- "everything after 4213" — instead of a timestamp window that has to guess at
-- ties and clock skew. Plan docs/gini-flow/12-REALTIME-PLAN.md section 2.1.
--
-- All three tables are insert-only, so the sequence never has a gap that means
-- something other than "a transaction rolled back".
ALTER TABLE giniflow_visit_events     ADD COLUMN IF NOT EXISTS seq BIGSERIAL;
ALTER TABLE giniflow_lab_order_events ADD COLUMN IF NOT EXISTS seq BIGSERIAL;
ALTER TABLE giniflow_vitals           ADD COLUMN IF NOT EXISTS seq BIGSERIAL;

CREATE INDEX IF NOT EXISTS idx_giniflow_visit_events_seq     ON giniflow_visit_events (seq);
CREATE INDEX IF NOT EXISTS idx_giniflow_lab_order_events_seq ON giniflow_lab_order_events (seq);
CREATE INDEX IF NOT EXISTS idx_giniflow_vitals_seq           ON giniflow_vitals (seq);
