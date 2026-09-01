-- ============================================================
-- medications — the two partial unique indexes, into the migration chain.
-- 2026-09-02
--
-- 15-CONSULTANT-STATION-REVIEW.md CS-01.
--
-- These indexes are what make `ON CONFLICT (patient_id, UPPER(COALESCE(
-- pharmacy_match, name))) WHERE is_active = ...` legal: Postgres refuses that
-- clause outright ("there is no unique or exclusion constraint matching the ON
-- CONFLICT specification") unless a matching partial unique index exists.
--
-- Both the consultant station's Finalize and Scribe's own `POST /api/consultations`
-- depend on them, and neither can write a prescription without them. Until now
-- they existed ONLY inside `server/scripts/dedup-medications.js`, an ad-hoc
-- script somebody ran once against production — so on any database built from
-- the migration chain (a restore, a staging copy) every prescription save would
-- have failed, at the last step of a consultation.
--
-- They are also the invariant the module relies on rather than on discipline:
-- one active row per patient per medicine, whichever code path writes it.
--
-- Definitions copied exactly from dedup-medications.js. `IF NOT EXISTS` so this
-- is a no-op on production, where the script already created them.
--
-- ⚠️ On a database that has never been deduped, creating these can fail on
-- existing duplicates. That is the correct failure — run
-- `node scripts/dedup-medications.js` first, which merges duplicates by keeping
-- the most recent row per (patient_id, name) in each active state.
--
--   node migrations/_runOne.mjs migrations/2026-09-02_medications_unique_indexes.sql
-- ============================================================

CREATE UNIQUE INDEX IF NOT EXISTS medications_patient_active_name_uniq
  ON medications (patient_id, UPPER(COALESCE(pharmacy_match, name)))
  WHERE is_active = true;

CREATE UNIQUE INDEX IF NOT EXISTS medications_patient_inactive_name_uniq
  ON medications (patient_id, UPPER(COALESCE(pharmacy_match, name)))
  WHERE is_active = false;
