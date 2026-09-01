-- ============================================================
-- Gini Flow — patient priority and manual queue order.
-- 2026-09-01
--
-- Two ways the floor manager overrides the board's default ordering
-- (longest-waiting first):
--
--   priority       a standing property of the visit — an urgent patient stays
--                  urgent at every station they pass through, so it survives
--                  status changes.
--   queue_position a manual "call this one next" set by dragging a card inside
--                  its column. Deliberately scoped to the station the patient
--                  is standing in: the moment they move on, the order their old
--                  column had for them is meaningless.
--
-- `queue_column` is what makes that scoping safe. advanceStatus clears the
-- position on every move, but nothing can guarantee every future path through
-- this table does — a backfill, the demo seeder, a manual UPDATE. Storing the
-- column the position was set for lets the board ignore a position that belongs
-- to a queue the patient has already left, instead of pinning them to the top of
-- a column they are no longer in (BQ-06).
--
-- `priority_reason` mirrors what GF-18 established for blocking: a red mark on a
-- card that does not say why gives the floor a colour and no action. It is
-- optional here rather than required — an urgent patient is often self-evident
-- at the desk, and forcing a sentence would only produce empty ones.
--
-- Attribution lives on the visit row, NOT in giniflow_visit_events. Every timer,
-- average and timeline step in the system is the gap between consecutive event
-- rows, so an event that is not a journey step would restart the patient's
-- station clock and split their timeline. Priority is a property of the visit,
-- like category and blocked_reason, and is recorded the same way.
--
-- No index: the board fetches the whole day in one query and sorts in Node, so
-- an index on these columns would be maintained for a query that does not exist
-- (BQ-12).
--
--   node migrations/_runOne.mjs migrations/2026-09-01_giniflow_priority_queue.sql
-- ============================================================

ALTER TABLE giniflow_visits
  ADD COLUMN IF NOT EXISTS priority        TEXT NOT NULL DEFAULT 'normal',
  ADD COLUMN IF NOT EXISTS queue_position  INT,
  ADD COLUMN IF NOT EXISTS queue_column    TEXT,
  ADD COLUMN IF NOT EXISTS priority_reason TEXT,
  ADD COLUMN IF NOT EXISTS priority_set_by INT REFERENCES doctors(id),
  ADD COLUMN IF NOT EXISTS priority_set_at TIMESTAMPTZ;
