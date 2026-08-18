-- Reception-typed queue/token number for a flow visit (e.g. "A-14", "27").
--
-- Free text and deliberately NOT unique: the hospital reuses numbers across
-- counters and days, and reception must be able to mirror whatever the physical
-- token slip says rather than whatever we would have generated.
--
-- ⚠️ NOT to be confused with flow_visits.visit_token, which is the opaque URL
-- token for the public tracker (/visit/:token). Leaking that one into a UI label
-- would expose the tracker link, hence the deliberately distant names.
--
--   node migrations/_runOne.mjs migrations/2026-08-18_flow_visit_token_number.sql

ALTER TABLE flow_visits ADD COLUMN IF NOT EXISTS token_number TEXT;

-- Partial index on (date, token) — reception's only lookup is "who is token 27
-- today", and the vast majority of historical rows have no token at all.
CREATE INDEX IF NOT EXISTS idx_flow_visits_token_number
  ON flow_visits (visit_date, token_number)
  WHERE token_number IS NOT NULL;
