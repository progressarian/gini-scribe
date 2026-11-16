CREATE TABLE IF NOT EXISTS ghm_live_events (
  seq            BIGSERIAL PRIMARY KEY,
  appointment_id INTEGER,
  patient_id     INTEGER,
  kind           TEXT NOT NULL,
  actor_id       INTEGER,
  at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ghm_live_events_at ON ghm_live_events (at);

COMMENT ON TABLE ghm_live_events IS
  'Signals that a GHM call-list row changed. Each API process tails seq and pushes it to open GHM screens; rows older than two days are pruned.';

ALTER TABLE ghm_live_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE ghm_live_events FORCE ROW LEVEL SECURITY;
REVOKE ALL ON ghm_live_events FROM anon, authenticated;
