-- ============================================================
-- giniflow_visit_events.occurred_at — clock_timestamp(), not now().
-- 2026-09-02
--
-- 15-CONSULTANT-STATION-REVIEW.md, second pass.
--
-- `now()` is `transaction_timestamp()`: frozen for the whole transaction. Two
-- events written in one transaction — Finalize writes `doctor_done` and
-- `pharmacy_pending` together — therefore landed on the IDENTICAL occurred_at.
--
-- That matters because occurred_at is this module's ordering key. Every timeline
-- read, every duration and every "latest event" lookup orders by it, and the
-- tiebreak is `id`, a random uuid from gen_random_uuid(). With equal timestamps
-- the order is whatever the uuids happen to sort to, so a patient's timeline
-- could show "At pharmacy" above "Consultation done" for the same visit, about
-- half the time. `smoke:giniflow-doctor` caught it as an intermittent failure.
--
-- clock_timestamp() advances DURING a transaction, so consecutive events keep
-- the order they were written in, microseconds apart.
--
-- The engine passes the value explicitly (statusEngine.js), so this default
-- covers the writers that do not: the MO station's take-over and release events,
-- and anything added later that forgets. Durations are unaffected — the two
-- events are zero minutes apart either way.
--
-- Existing rows are left alone: they are history, and rewriting timestamps in an
-- append-only log to fix an ordering rule would be a worse cure than the disease.
-- Where a pair already collides, the order stays arbitrary for that visit.
--
--   node migrations/_runOne.mjs migrations/2026-09-02_giniflow_event_clock.sql
-- ============================================================

ALTER TABLE giniflow_visit_events
  ALTER COLUMN occurred_at SET DEFAULT clock_timestamp();

-- The lab track has the same shape and the same exposure: labStation writes a
-- payment event and a sample event in one transaction (trigger 3).
ALTER TABLE giniflow_lab_order_events
  ALTER COLUMN occurred_at SET DEFAULT clock_timestamp();
