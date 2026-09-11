-- The machine room's case list (39-HYBRID-FLOOR-PLAN.md §16).
--
-- HealthRay is asked one question per visit — "was this patient billed for a
-- machine test?" — and get_transactions is a POST per patient, so the sync has
-- to remember who it has already asked. Without this every loop would re-ask
-- all 106 of today's visits and walk straight back into the WAF 403 that
-- stopped the OPD sync at 06:53 on 11 Sep 2026.
ALTER TABLE giniflow_visits
  ADD COLUMN IF NOT EXISTS machine_scan_at TIMESTAMPTZ;

-- The sync's own worklist: today's visits, oldest-asked first. Partial on the
-- date because no run ever looks at a day that is not today.
CREATE INDEX IF NOT EXISTS idx_giniflow_visits_machine_scan
  ON giniflow_visits (visit_date, machine_scan_at NULLS FIRST);
