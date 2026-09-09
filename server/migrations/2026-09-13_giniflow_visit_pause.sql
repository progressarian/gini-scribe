-- ============================================================
-- Pause / resume a visit while the patient steps out.
-- 2026-09-13
--
-- A patient who goes to lunch after checking in keeps accruing waiting time,
-- and the board reads them as overdue for an hour nobody was waiting on them.
-- There was no way to say so: every Gini Flow duration is a gap between
-- giniflow_visit_events.occurred_at rows, or a gap to now(), and nothing held a
-- pause to subtract.
--
-- Pause is deliberately NOT a status. blocked_reports overwrites current_status
-- and stashes the old one in resume_status, which drags the card into the
-- check-in column; a paused patient has to stay exactly where they are, in the
-- same column and the same queue position, just visibly on hold.
--
--   paused_at       set = paused right now, NULL = running. Also the clock the
--                   live timers freeze against while the pause is open.
--   paused_ms_total accumulated across every break of the visit. Not used to
--                   compute the board's clocks — resume shifts the anchor
--                   events forward instead, so all ~25 duration sites stay
--                   correct without knowing pause exists — but it is what
--                   answers "how long was this patient away" afterwards.
--
-- The paused/resumed pair is also written to giniflow_visit_events, which stays
-- the honest record: resume moves an anchor event's occurred_at forward and
-- keeps the true time in that event's meta.original_occurred_at.
--
-- Idempotent.
-- ============================================================

ALTER TABLE giniflow_visits
  ADD COLUMN IF NOT EXISTS paused_at       TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS paused_by       INTEGER REFERENCES doctors(id),
  ADD COLUMN IF NOT EXISTS paused_reason   TEXT,
  ADD COLUMN IF NOT EXISTS paused_ms_total BIGINT NOT NULL DEFAULT 0;

-- The board asks "who is paused" for every card it draws, and the end-of-day
-- sweep asks for the ones still paused.
CREATE INDEX IF NOT EXISTS idx_giniflow_visits_paused
  ON giniflow_visits (visit_date)
  WHERE paused_at IS NOT NULL;
