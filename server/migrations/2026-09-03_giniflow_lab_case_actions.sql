-- What the technician did about a case that Gini Flow does not own.
--
-- The hospital's own lab cases arrive through `labSync` and live in `lab_cases`.
-- Gini Flow cannot write back to HealthRay — `labHealthrayApi.js` has one POST,
-- `/user/sign_in`, and everything else is a GET — so this station can never
-- claim to have changed a sample's state over there.
--
-- What it CAN do is what 06-PHASE-2-PLAN §0.4 asked for: "the lab screen should
-- confirm and attribute an upload, not be the only path by which results
-- appear". This table is that attribution and nothing more — a record of who
-- chased a sample and when, so an uncollected tube has a name against it instead
-- of sitting on a read-only list nobody is accountable for.
--
-- Keyed on `case_no` rather than a foreign key into `lab_cases`: the case row is
-- rewritten by every sync pass, and an action is about the sample, not about our
-- current copy of it.
CREATE TABLE IF NOT EXISTS giniflow_lab_case_actions (
  id         BIGSERIAL PRIMARY KEY,
  case_no    TEXT NOT NULL,
  action     TEXT NOT NULL CHECK (action IN ('chased', 'sample_taken')),
  actor_role TEXT NOT NULL DEFAULT 'lab',
  actor_id   INT REFERENCES doctors(id),
  note       TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (case_no, action)
);

CREATE INDEX IF NOT EXISTS idx_giniflow_lab_case_actions_case
  ON giniflow_lab_case_actions (case_no);
