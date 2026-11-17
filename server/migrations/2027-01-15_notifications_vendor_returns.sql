CREATE TABLE IF NOT EXISTS notifications (
  id            BIGSERIAL PRIMARY KEY,
  kind          TEXT NOT NULL CHECK (kind ~ '^[a-z_]{2,40}$'),
  severity      TEXT NOT NULL DEFAULT 'info' CHECK (severity IN ('info', 'warning', 'critical')),
  capability    TEXT CHECK (capability IS NULL OR capability ~ '^[A-Z_]{2,60}$'),
  doctor_id     INT REFERENCES doctors(id) ON DELETE CASCADE,
  title         TEXT NOT NULL CHECK (btrim(title) <> ''),
  body          TEXT,
  link          TEXT CHECK (link IS NULL OR link ~ '^/[^/]'),
  entity_type   TEXT,
  entity_id     TEXT,
  dedupe_key    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at   TIMESTAMPTZ,
  CONSTRAINT notifications_audience CHECK ((capability IS NULL) <> (doctor_id IS NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS notifications_open_key
  ON notifications (dedupe_key) WHERE resolved_at IS NULL AND dedupe_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS notifications_capability_idx
  ON notifications (capability, created_at DESC) WHERE resolved_at IS NULL AND capability IS NOT NULL;
CREATE INDEX IF NOT EXISTS notifications_doctor_idx
  ON notifications (doctor_id, created_at DESC) WHERE resolved_at IS NULL AND doctor_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS notification_reads (
  notification_id BIGINT NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  doctor_id       INT NOT NULL REFERENCES doctors(id) ON DELETE CASCADE,
  read_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (notification_id, doctor_id)
);

CREATE SEQUENCE IF NOT EXISTS pharmacy_vendor_return_no_seq;

CREATE TABLE IF NOT EXISTS pharmacy_vendor_returns (
  id            SERIAL PRIMARY KEY,
  return_no     TEXT NOT NULL DEFAULT ('VRT' || lpad(nextval('pharmacy_vendor_return_no_seq')::text, 6, '0')),
  vendor_id     INT NOT NULL REFERENCES pharmacy_vendors(id),
  location_id   INT NOT NULL REFERENCES pharmacy_locations(id),
  reason        TEXT NOT NULL CHECK (reason IN ('expired', 'near_expiry', 'damaged', 'other')),
  vendor_ref    TEXT,
  notes         TEXT,
  total_value   NUMERIC(14, 2) NOT NULL DEFAULT 0 CHECK (total_value >= 0),
  created_by    INT REFERENCES doctors(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS pharmacy_vendor_returns_no_key ON pharmacy_vendor_returns (return_no);
CREATE INDEX IF NOT EXISTS pharmacy_vendor_returns_vendor_idx
  ON pharmacy_vendor_returns (vendor_id, created_at);

CREATE TABLE IF NOT EXISTS pharmacy_vendor_return_lines (
  id          SERIAL PRIMARY KEY,
  return_id   INT NOT NULL REFERENCES pharmacy_vendor_returns(id) ON DELETE RESTRICT,
  line_no     INT NOT NULL CHECK (line_no > 0),
  medicine_id INT NOT NULL REFERENCES pharmacy_medicines(id),
  batch_id    INT NOT NULL REFERENCES pharmacy_batches(id),
  qty_units   INT NOT NULL CHECK (qty_units > 0),
  unit_cost   NUMERIC(12, 4) NOT NULL CHECK (unit_cost >= 0),
  value       NUMERIC(14, 2) NOT NULL CHECK (value >= 0),
  CONSTRAINT pharmacy_vendor_return_lines_batch_once UNIQUE (return_id, batch_id)
);

DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['notifications', 'notification_reads', 'pharmacy_vendor_returns',
                           'pharmacy_vendor_return_lines'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON %I FROM anon, authenticated', t);
  END LOOP;
END;
$$;
