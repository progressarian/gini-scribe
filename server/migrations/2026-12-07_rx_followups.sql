CREATE TABLE IF NOT EXISTS giniflow_rx_followups (
  id         BIGSERIAL PRIMARY KEY,
  visit_id   UUID NOT NULL REFERENCES giniflow_visits(id) ON DELETE CASCADE,
  action     TEXT NOT NULL CHECK (action IN
               ('not_taken', 'note', 'sent_whatsapp', 'collected', 'not_needed')),
  remark     TEXT NOT NULL CHECK (btrim(remark) <> ''),
  actor_id   INTEGER REFERENCES doctors(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS giniflow_rx_followups_visit_idx
  ON giniflow_rx_followups (visit_id, created_at DESC, id DESC);

INSERT INTO app_kv (key, value, updated_at)
VALUES ('rx_followups_since', to_jsonb(((NOW() AT TIME ZONE 'Asia/Kolkata')::date)::text), NOW())
ON CONFLICT (key) DO NOTHING;
