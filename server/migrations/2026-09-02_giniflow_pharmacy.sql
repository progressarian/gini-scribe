-- ============================================================
-- Pharmacy station — the dispensing record already exists.
-- 2026-09-02
--
-- docs/gini-flow/16-PHARMACY-STATION-PLAN.md §3
--
-- NO new dispensing table. `medicine_collections` is the per-medicine record,
-- it is in daily use at the counter, it already carries a bulk write path and
-- the not-collected report is built on it. A second one would split "did the
-- patient get their medicines" across two tables.
--
-- The only thing this station needs and the schema lacks is a memory of the
-- medicine card having been sent, so the automatic send that follows `exited`
-- cannot fire twice for one visit (§7, `sendCardToPatient` — idempotent).
-- ============================================================

ALTER TABLE giniflow_visits
  ADD COLUMN IF NOT EXISTS card_sent_at TIMESTAMPTZ;

COMMENT ON COLUMN giniflow_visits.card_sent_at IS
  'When the medicine card was last sent to the patient on WhatsApp (Gini Flow pharmacy station).';

-- The counter reads today's marks for one patient on every card open. Without
-- this the lookup is a scan of the whole collection history.
CREATE INDEX IF NOT EXISTS idx_medicine_collections_patient_date
  ON medicine_collections (patient_id, collected_date);
