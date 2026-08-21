-- Population analytics snapshots.
--
-- The full report is a multi-minute scan across lab_results (540k rows) and
-- medications (178k rows) — far too slow to run inside a request. The worker
-- builds it once a night and stores each section as its own row so the page can
-- fetch one section at a time instead of pulling a 1.4 MB blob and slicing it.
--
-- Sections are stored separately (rather than one JSONB document) because the
-- frontend loads them lazily and because a partial rebuild can replace a single
-- section without rewriting the rest.

CREATE TABLE IF NOT EXISTS analytics_snapshots (
  id             BIGSERIAL PRIMARY KEY,
  as_of          DATE NOT NULL,
  engine_version TEXT NOT NULL,
  generated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  build_ms       INTEGER,
  status         TEXT NOT NULL DEFAULT 'ok',
  error          TEXT
);

CREATE TABLE IF NOT EXISTS analytics_snapshot_sections (
  snapshot_id BIGINT NOT NULL REFERENCES analytics_snapshots(id) ON DELETE CASCADE,
  section_id  TEXT NOT NULL,
  payload     JSONB NOT NULL,
  PRIMARY KEY (snapshot_id, section_id)
);

CREATE INDEX IF NOT EXISTS idx_analytics_snapshots_as_of
  ON analytics_snapshots(as_of DESC, id DESC)
  WHERE status = 'ok';
