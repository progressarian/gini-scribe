-- ============================================================
-- Gini Flow — a small key/value table for admin-toggleable floor behaviour,
-- starting with whether samples-only ("lab-only") patients show on the
-- station screens and the coordinator board.
-- 2026-09-28
--
-- Hiding them was shipped hardcoded per the floor's request. This makes it a
-- runtime toggle instead of a code change: an admin flips it on
-- /settings/flow, no deploy needed either way. Defaults to TRUE (hidden) so
-- applying this migration changes nothing about today's behaviour.
--
--   node migrations/_runOne.mjs migrations/2026-09-28_giniflow_floor_settings.sql
-- ============================================================

CREATE TABLE IF NOT EXISTS giniflow_floor_settings (
  key        TEXT PRIMARY KEY,
  value      BOOLEAN NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by INT REFERENCES doctors(id)
);

INSERT INTO giniflow_floor_settings (key, value)
VALUES ('hide_lab_only_patients', TRUE)
ON CONFLICT (key) DO NOTHING;
