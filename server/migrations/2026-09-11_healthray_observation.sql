-- What HealthRay says, recorded beside where the floor actually is
-- (docs/gini-flow/39-HYBRID-FLOOR-PLAN.md §5.3, step 2).
--
-- The chain position stays the FLOOR's. HealthRay's position rides alongside it
-- as an observation, so the two can disagree — and the disagreement is the
-- point: a patient HealthRay has with a doctor while Scribe still has them at
-- vitals is a station that did not record its step, and `behind_station` names
-- the desk to chase.
--
-- Nothing reads these yet. They are written first, deliberately, so the badge
-- and the Behind panel (step 3) are built on a week of real data rather than on
-- a guess about how big the gap is.
ALTER TABLE giniflow_visits
  ADD COLUMN IF NOT EXISTS healthray_status TEXT;

-- When the observation was last refreshed, not when HealthRay changed it —
-- HealthRay has no webhooks, so the only honest claim is when we last looked.
ALTER TABLE giniflow_visits
  ADD COLUMN IF NOT EXISTS healthray_status_at TIMESTAMPTZ;

-- The first station in the journey whose step nobody recorded, and only while
-- HealthRay is strictly ahead of us. NULL means the floor and HealthRay agree,
-- or that HealthRay knows nothing more than we do.
ALTER TABLE giniflow_visits
  ADD COLUMN IF NOT EXISTS behind_station TEXT;

-- The Behind panel's query: every visit on a day that is behind, grouped by the
-- station responsible. Partial, because on a working floor most rows are NULL
-- and an index over those would be most of the table for no reader.
CREATE INDEX IF NOT EXISTS idx_giniflow_visits_behind
  ON giniflow_visits (visit_date, behind_station)
  WHERE behind_station IS NOT NULL;
