-- Goals were re-inserted on every consultation save, producing duplicates
-- (e.g. P_5900 had each marker repeated many times). Switch to an upsert
-- keyed on (consultation_id, marker): one goal row per marker per
-- consultation, updated in place when the AI re-extracts.
--
-- Manual goals from the UI (visit.js POST /goal) are stored with
-- consultation_id = NULL. Postgres treats NULLs as distinct in a unique
-- index, so manual goals are not constrained by this index.

-- 1. Collapse existing duplicates: keep the oldest row per
--    (consultation_id, marker), drop the rest. Only touches AI-written
--    goals (consultation_id IS NOT NULL).
DELETE FROM goals g
USING goals g2
WHERE g.consultation_id IS NOT NULL
  AND g.consultation_id = g2.consultation_id
  AND g.marker = g2.marker
  AND g.id > g2.id;

-- 2. Enforce one goal per (consultation, marker) going forward.
CREATE UNIQUE INDEX IF NOT EXISTS idx_goals_consultation_marker
  ON goals(consultation_id, marker)
  WHERE consultation_id IS NOT NULL;
