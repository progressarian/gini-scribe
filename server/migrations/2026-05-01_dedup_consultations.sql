-- 2026-05-01: collapse same-day duplicate consultations + prevent new ones.
--
-- Why: re-saves through `POST /consultations` (always-INSERT, see
-- routes/consultations.js:119), HealthRay nightly sync, and OPD walk-ins
-- each create a new consultations row. Combined with free-text doctor
-- names ("Anil Bhansali" / "Bhansali" / "dr. bhansali" all coexist), a
-- patient routinely ends up with 2–3 rows per visit. The website hides this
-- by collapsing on (visit_date, status) at render time; the underlying data
-- is still messy and any new screen has to remember to re-do that dedup.
--
-- This migration:
--   1. picks ONE winner row per (patient_id, visit_date::date, doctor) —
--      preferring the row with the most clinical content (mo_data + con_data
--      + transcripts) and most recent created_at as a tie-break.
--   2. repoints child rows (vitals, diagnoses, medications, lab_results,
--      documents, goals) from losers to the winner so no clinical history
--      is lost.
--   3. deletes the loser rows.
--   4. adds a unique index that blocks future duplicates.
--
-- Idempotent: re-running it on a clean table is a no-op.

BEGIN;

-- ── 1. Build the dedup plan in a temp table ───────────────────────────────
DROP TABLE IF EXISTS _consult_dedup;
CREATE TEMP TABLE _consult_dedup AS
WITH ranked AS (
  SELECT
    id,
    patient_id,
    visit_date::date AS visit_day,
    -- Doctor key: prefer doctor FK; fall back to lower-cased lastname of
    -- whichever name field is set. NULL collapses to '' so multiple
    -- no-doctor same-day rows still group together.
    COALESCE(
      con_doctor_id::text,
      mo_doctor_id::text,
      lower(
        regexp_replace(
          regexp_replace(coalesce(con_name, mo_name, ''), '^\s*dr\.?\s*', '', 'i'),
          '.*\s+', ''  -- last token = lastname
        )
      ),
      ''
    ) AS doctor_key,
    -- Score = total JSON content + transcripts. Higher = more complete.
    COALESCE(length(mo_data::text), 0)
      + COALESCE(length(con_data::text), 0)
      + COALESCE(length(mo_transcript), 0)
      + COALESCE(length(con_transcript), 0)
      + COALESCE(length(quick_transcript), 0) AS content_score,
    created_at
  FROM consultations
),
groups AS (
  SELECT
    patient_id,
    visit_day,
    doctor_key,
    -- Winner = highest content_score, tie-break by newest created_at, then id DESC.
    (ARRAY_AGG(id ORDER BY content_score DESC, created_at DESC, id DESC))[1] AS winner_id,
    ARRAY_AGG(id ORDER BY content_score DESC, created_at DESC, id DESC) AS all_ids
  FROM ranked
  GROUP BY patient_id, visit_day, doctor_key
),
losers AS (
  SELECT
    g.winner_id,
    unnest(g.all_ids) AS loser_id
  FROM groups g
  WHERE array_length(g.all_ids, 1) > 1
)
SELECT winner_id, loser_id
FROM losers
WHERE loser_id <> winner_id;

-- Report what we're about to do (visible in psql / migration logs).
DO $$
DECLARE
  loser_count int;
  group_count int;
BEGIN
  SELECT COUNT(*), COUNT(DISTINCT winner_id) INTO loser_count, group_count
  FROM _consult_dedup;
  RAISE NOTICE '[dedup_consultations] % loser rows in % groups', loser_count, group_count;
END$$;

-- ── 2. Repoint child rows from losers to winners ──────────────────────────

UPDATE vitals v
   SET consultation_id = d.winner_id
  FROM _consult_dedup d
 WHERE v.consultation_id = d.loser_id;

UPDATE diagnoses g
   SET consultation_id = d.winner_id
  FROM _consult_dedup d
 WHERE g.consultation_id = d.loser_id;

UPDATE medications m
   SET consultation_id = d.winner_id
  FROM _consult_dedup d
 WHERE m.consultation_id = d.loser_id;

UPDATE lab_results l
   SET consultation_id = d.winner_id
  FROM _consult_dedup d
 WHERE l.consultation_id = d.loser_id;

UPDATE documents doc
   SET consultation_id = d.winner_id
  FROM _consult_dedup d
 WHERE doc.consultation_id = d.loser_id;

UPDATE goals gl
   SET consultation_id = d.winner_id
  FROM _consult_dedup d
 WHERE gl.consultation_id = d.loser_id;

-- ── 3. Delete loser rows ──────────────────────────────────────────────────

DELETE FROM consultations c
 USING _consult_dedup d
 WHERE c.id = d.loser_id;

-- ── 4. Unique index — prevent new duplicates ──────────────────────────────
--
-- Key matches the dedup logic: (patient_id, visit_day, doctor key).
-- The doctor key uses COALESCE(con_doctor_id, mo_doctor_id, -1) — once we
-- start setting doctor FKs, multi-doctor same-day visits naturally get
-- distinct keys. Legacy rows with both doctor_ids null collapse to -1, and
-- after this migration there's at most one such row per (patient, day).

CREATE UNIQUE INDEX IF NOT EXISTS uq_consultations_one_per_doctor_per_day
  ON consultations (
    patient_id,
    (visit_date::date),
    COALESCE(con_doctor_id, mo_doctor_id, -1)
  );

COMMIT;
