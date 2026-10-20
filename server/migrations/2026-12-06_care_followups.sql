-- Care coordinator follow-ups (docs/gini-flow/81-CARE-COORDINATOR-FOLLOWUPS-PLAN.md §5.1).
--
-- Additive only. Nothing existing reads these tables: only the Follow-ups page,
-- its API and the worker's collect job do. The go-live date is written once
-- (app_kv 'care_followups_since'), and the collector only picks up referrals and
-- next-visit orders made on or after it.
--
--   node migrations/_runOne.mjs migrations/2026-12-06_care_followups.sql

CREATE TABLE IF NOT EXISTS referrals (
  id SERIAL PRIMARY KEY,
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  doctor_name TEXT,
  speciality TEXT,
  reason TEXT,
  status TEXT DEFAULT 'pending',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  appointment_id INTEGER
);

CREATE TABLE IF NOT EXISTS care_followups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  source TEXT NOT NULL
    CHECK (source IN ('gf_referral', 'rx_referral', 'next_visit_order', 'hr_follow_up')),
  source_key TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL
    CHECK (kind IN ('consultant', 'specialty', 'mo', 'chief', 'lab_test', 'machine_test', 'other')),
  target TEXT NOT NULL,
  detail TEXT,
  matched_doctor_id INTEGER REFERENCES doctors(id),
  matched_specialty TEXT,
  matched_tests TEXT[],
  availability TEXT NOT NULL DEFAULT 'unknown'
    CHECK (availability IN ('in_house', 'outsourced', 'not_available', 'unknown')),
  ordered_by_id INTEGER REFERENCES doctors(id),
  ordered_by_name TEXT,
  ordered_on DATE NOT NULL,
  due_on DATE,
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'booked', 'done', 'not_available', 'declined', 'closed')),
  outcome_reason TEXT,
  booked_appointment_id INTEGER REFERENCES appointments(id) ON DELETE SET NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_call_status TEXT,
  last_call_at TIMESTAMPTZ,
  assigned_to INTEGER REFERENCES doctors(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_care_followups_open ON care_followups (status, due_on);
CREATE INDEX IF NOT EXISTS idx_care_followups_patient ON care_followups (patient_id);

CREATE TABLE IF NOT EXISTS care_followup_events (
  id BIGSERIAL PRIMARY KEY,
  followup_id UUID NOT NULL REFERENCES care_followups(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('call', 'status', 'note', 'booked', 'auto')),
  call_status TEXT,
  from_status TEXT,
  to_status TEXT,
  note TEXT,
  actor_id INTEGER REFERENCES doctors(id),
  at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_care_followup_events_item ON care_followup_events (followup_id, at);

-- History can't be rewritten. A delete is allowed only when it cascades from its
-- follow-up being removed (trigger depth > 1), never directly.
CREATE OR REPLACE FUNCTION care_followup_events_append_only()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'care_followup_events is append-only: rows cannot be changed or deleted'
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE OR REPLACE TRIGGER care_followup_events_append_only
  BEFORE UPDATE OR DELETE ON care_followup_events
  FOR EACH ROW EXECUTE FUNCTION care_followup_events_append_only();

ALTER TABLE care_followups ENABLE ROW LEVEL SECURITY;
ALTER TABLE care_followups FORCE ROW LEVEL SECURITY;
REVOKE ALL ON care_followups FROM anon, authenticated;

ALTER TABLE care_followup_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE care_followup_events FORCE ROW LEVEL SECURITY;
REVOKE ALL ON care_followup_events FROM anon, authenticated;

INSERT INTO app_kv (key, value, updated_at)
VALUES ('care_followups_since',
        to_jsonb(((NOW() AT TIME ZONE 'Asia/Kolkata')::date)::text),
        NOW())
ON CONFLICT (key) DO NOTHING;
