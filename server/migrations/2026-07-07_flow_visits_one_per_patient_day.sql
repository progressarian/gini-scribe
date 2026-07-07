-- Enforce one active flow visit per patient per day.
--
-- flow_visits previously had no per-patient/day uniqueness (only visit_token was
-- UNIQUE), so a patient could accumulate several rows in a day — a re-check-in
-- after completion, or a manual check-in plus an appointment-linked row — and
-- the Coordinator board counted rows, over-reporting "Completed" (e.g. 54 rows
-- for 42 real patients). The read side now dedups and both insert paths guard
-- against it; this index is the durable backstop against races.
--
-- Patients are keyed by patient_db_id when present, else by patient_id (file
-- number, e.g. P_155780) — matching the app-level dedup key. Cancelled rows are
-- excluded so a mistaken/cancelled check-in still allows a fresh one, and
-- Postgres allows any number of cancelled rows.
--
-- ORDER OF OPERATIONS: run the one-time cleanup (dedupe-flow-visits.mjs --apply)
-- FIRST. If duplicate non-cancelled rows still exist, this CREATE fails and
-- leaves an INVALID index behind. CONCURRENTLY avoids locking the table for
-- writes; it must run outside a transaction (the _runOne.mjs runner does).
--
--   node migrations/_runOne.mjs migrations/2026-07-07_flow_visits_one_per_patient_day.sql

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_flow_visits_one_per_patient_day
  ON flow_visits (COALESCE(patient_db_id::text, patient_id), visit_date)
  WHERE status <> 'cancelled';
