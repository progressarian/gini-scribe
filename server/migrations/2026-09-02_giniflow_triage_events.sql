-- ============================================================
-- Triage board — live updates for the coordinator's own writes.
-- 2026-09-02
--
-- docs/gini-flow/18-TRIAGE-BOARD-PLAN.md, and 12-REALTIME-PLAN.md §2.1 for the
-- tailer this feeds.
--
-- THE PROBLEM. Categorising and assigning are plain UPDATEs on giniflow_visits
-- (services/giniflow/triage.js, "Coordinator writes"). That is deliberate:
-- `category` is a property of the visit, not a journey step, and writing it to
-- giniflow_visit_events would restart the patient's station timer — the rule
-- 10-QUEUE-CONTROL-PLAN.md §7 set. But the event tailer only follows event
-- tables, so it had nothing to emit, and a second coordinator never saw the
-- first one's work until their next poll.
--
-- WHY A SEPARATE TABLE, not a column on giniflow_visits. The tailer needs a
-- monotonic watermark. A BIGSERIAL only advances on INSERT, so it cannot track
-- an UPDATE — tailing giniflow_visits would mean a rev-bumping trigger, or
-- `updated_at`, which is a timestamp window that has to guess at ties and clock
-- skew. An insert-only table beside giniflow_lab_order_events is the shape the
-- module already has, and being a different table from giniflow_visit_events is
-- exactly what keeps the timers out of it.
--
-- It doubles as the audit trail the visit row cannot hold: `category_set_by`
-- keeps only the LAST person to categorise, so a category changed three times
-- before the clinic opens currently leaves no trace of the first two.
--
--   node migrations/_runOne.mjs migrations/2026-09-02_giniflow_triage_events.sql
-- ============================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS giniflow_triage_events (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  visit_id           UUID NOT NULL REFERENCES giniflow_visits(id) ON DELETE CASCADE,
  action             TEXT NOT NULL,              -- categorised | assigned
  category           TEXT,                       -- the value set, for `categorised`
  assigned_sd_id     INT REFERENCES doctors(id),
  assigned_doctor_id INT REFERENCES doctors(id),
  actor_id           INT REFERENCES doctors(id),
  occurred_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  seq                BIGSERIAL
);

-- The tailer's read: "everything after 4213".
CREATE INDEX IF NOT EXISTS idx_giniflow_triage_events_seq
  ON giniflow_triage_events (seq);

-- One visit's triage history, for the audit read.
CREATE INDEX IF NOT EXISTS idx_giniflow_triage_events_visit
  ON giniflow_triage_events (visit_id, occurred_at);

COMMENT ON TABLE giniflow_triage_events IS
  'Coordinator triage writes (categorise, assign). Insert-only, tailed for live updates. NOT read by any station timer — that is giniflow_visit_events.';
