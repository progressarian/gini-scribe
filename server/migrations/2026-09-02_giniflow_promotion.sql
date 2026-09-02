-- ============================================================
-- Gini Flow — promotion into the shared clinical record.
-- 2026-09-02
--
-- 06-PHASE-2-PLAN.md question 12, answered. The two module-owned tables that
-- deliberately stopped short of the patient's record — `giniflow_vitals` and
-- `giniflow_lab_orders` — now copy forward into `vitals` and `documents`.
--
-- WHY NOW. Gini Flow's prescriptions already reach the shared tables (Finalize
-- writes `documents` + `medications`), so the patient app and the doctor's Labs
-- tab see them. A vitals reading and a lab report taken at a Gini Flow station
-- did not, which meant the floor could measure a patient and upload their report
-- and neither would appear on the chart the consultant reads. The May 2026
-- dual-DB decision makes the shared table the delivery mechanism: there is no
-- push to the patient app, only these rows.
--
-- THE IDEMPOTENCY KEY is the point of this migration. Both original migrations
-- refused to write the shared tables for the same reason — "adding a third
-- writer while two floor modules run in parallel invites the same patient being
-- recorded twice with different numbers". That risk is real and does not go away
-- by deciding to promote; it goes away by making promotion impossible to do
-- twice. So the shared row carries the id of the Gini Flow row it came from,
-- under a UNIQUE index, and promotion is an upsert on that key. A re-upload
-- updates the same document; a re-saved reading updates the same vitals row;
-- a replayed sync changes nothing.
--
-- Partial indexes, so the 63,816 existing vitals and 55,000 existing documents
-- that have no Gini Flow origin are untouched and unconstrained.
--
--   node migrations/_runOne.mjs migrations/2026-09-02_giniflow_promotion.sql
-- ============================================================

ALTER TABLE vitals
  ADD COLUMN IF NOT EXISTS giniflow_vitals_id UUID;

CREATE UNIQUE INDEX IF NOT EXISTS uq_vitals_giniflow_vitals_id
  ON vitals (giniflow_vitals_id)
  WHERE giniflow_vitals_id IS NOT NULL;

COMMENT ON COLUMN vitals.giniflow_vitals_id IS
  'The giniflow_vitals row this was promoted from. UNIQUE: one station reading, one clinical row.';

ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS giniflow_lab_order_id UUID;

CREATE UNIQUE INDEX IF NOT EXISTS uq_documents_giniflow_lab_order_id
  ON documents (giniflow_lab_order_id)
  WHERE giniflow_lab_order_id IS NOT NULL;

COMMENT ON COLUMN documents.giniflow_lab_order_id IS
  'The giniflow_lab_orders row this report was promoted from. UNIQUE: re-uploading replaces, never duplicates.';

-- Mirrors giniflow_vitals.promoted_at, which shipped in the original migration
-- against exactly this day.
ALTER TABLE giniflow_lab_orders
  ADD COLUMN IF NOT EXISTS promoted_at TIMESTAMPTZ;

COMMENT ON COLUMN giniflow_lab_orders.promoted_at IS
  'When the uploaded report was copied into `documents`. Null means it has not been.';
