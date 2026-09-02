-- ============================================================
-- External medicines — the prescriber context the brief asked for.
-- 2026-09-02
--
-- Brief §3 `external_medicines`, resolved onto the table this repo actually has.
--
-- NOT A SECOND TABLE. `2026-09-02_consultant_prescription.sql` settled that:
-- "the refill queue, the dose-review queue, the medicine card, MHG and the Genie
-- sync all read the existing table, and a second history is the failure this
-- module is structured to avoid". A medicine a patient is taking belongs on the
-- medicine card whatever route it arrived by, so it lives in `medications` with
-- `external_doctor` set. That decision stands.
--
-- WHAT WAS ACTUALLY MISSING. Of the brief's twelve external-medicine fields,
-- nine already map onto `medications`. Three did not, and addExternal() was
-- squashing them into general-purpose columns:
--
--   prescriber_specialty ─┬─→ `notes`, joined with " · ". Two facts in one
--   prescriber_hospital  ─┘   string cannot be rendered separately or queried.
--   interaction_flag     ───→ `clinical_note`, which ALSO holds the reason a
--                             Gini dose was changed. One column, two meanings,
--                             and the safety-critical one loses.
--   condition            ───→ nowhere at all.
--
-- INTERACTION_FLAG IS THE ONE THAT MATTERS. The brief's own example is "dual
-- RAAS block with Telma AM" — a flag a human wrote after checking a pair. It has
-- to be renderable as a warning next to the medicine, and it cannot be if it is
-- indistinguishable from a dose-change note. It is never generated: an unchecked
-- pair must look unchecked.
--
--   node migrations/_runOne.mjs migrations/2026-09-02_external_medicine_context.sql
-- ============================================================

ALTER TABLE medications
  ADD COLUMN IF NOT EXISTS external_specialty TEXT,
  ADD COLUMN IF NOT EXISTS external_hospital  TEXT,
  ADD COLUMN IF NOT EXISTS external_condition TEXT,
  ADD COLUMN IF NOT EXISTS interaction_flag   TEXT;

COMMENT ON COLUMN medications.external_specialty IS
  'The outside prescriber''s specialty. Meaningful only alongside external_doctor.';
COMMENT ON COLUMN medications.external_hospital IS
  'Where the outside prescriber practises.';
COMMENT ON COLUMN medications.external_condition IS
  'What the outside prescriber is treating with it — the patient''s answer, not a diagnosis code.';
COMMENT ON COLUMN medications.interaction_flag IS
  'A checked interaction, written by a human. Never generated: an unchecked pair must look unchecked.';
