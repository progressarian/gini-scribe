-- ============================================================
-- Referrals — the return leg.
-- 2026-09-02
--
-- docs/gini-flow/19-REFERRALS-STATION-PLAN.md §12.3, deferred there and built
-- here. Brief §4.7: "specialist report return can add an external_medicine".
--
-- WHY. A referral was write-only. The letter went out and the row's story ended
-- at `appointment_booked` — what the specialist actually said came back on paper
-- and stayed on paper. The consequence is not administrative: the specialist
-- starts medicines, and Gini's own prescriber cannot see them at the moment they
-- prescribe. That is the interaction check failing silently.
--
-- The medicines themselves are NOT stored here. They go to `medications` with
-- `external_doctor` set, through the same addExternal() the consult screen uses,
-- because a medicine a patient is taking belongs on the medicine card whatever
-- route it arrived by. `2026-09-02_consultant_prescription.sql` explains why
-- there is no second medicines table and never will be.
--
--   node migrations/_runOne.mjs migrations/2026-09-02_giniflow_referral_response.sql
-- ============================================================

ALTER TABLE giniflow_referrals
  ADD COLUMN IF NOT EXISTS response_note TEXT,
  ADD COLUMN IF NOT EXISTS response_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS response_by   TEXT;

COMMENT ON COLUMN giniflow_referrals.response_note IS
  'What the specialist said, in the words the desk was given. Free text on purpose.';
COMMENT ON COLUMN giniflow_referrals.response_at IS
  'When the reply was recorded here — not when the specialist saw the patient.';
COMMENT ON COLUMN giniflow_referrals.response_by IS
  'Who at Gini wrote it down. The specialist is already named by to_doctor.';
