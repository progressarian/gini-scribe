CREATE SEQUENCE IF NOT EXISTS pharmacy_transfer_no_seq;

CREATE TABLE IF NOT EXISTS pharmacy_transfers (
  id               SERIAL PRIMARY KEY,
  transfer_no      TEXT NOT NULL DEFAULT ('TRF' || lpad(nextval('pharmacy_transfer_no_seq')::text, 6, '0')),
  from_location_id INT NOT NULL REFERENCES pharmacy_locations(id),
  to_location_id   INT NOT NULL REFERENCES pharmacy_locations(id),
  notes            TEXT,
  issued_by        INT REFERENCES doctors(id) ON DELETE SET NULL,
  issued_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT pharmacy_transfers_two_places CHECK (from_location_id <> to_location_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS pharmacy_transfers_no_key ON pharmacy_transfers (transfer_no);
CREATE INDEX IF NOT EXISTS pharmacy_transfers_from_idx ON pharmacy_transfers (from_location_id, issued_at);
CREATE INDEX IF NOT EXISTS pharmacy_transfers_to_idx ON pharmacy_transfers (to_location_id, issued_at);

CREATE TABLE IF NOT EXISTS pharmacy_transfer_lines (
  id           SERIAL PRIMARY KEY,
  transfer_id  INT NOT NULL REFERENCES pharmacy_transfers(id) ON DELETE RESTRICT,
  line_no      INT NOT NULL CHECK (line_no > 0),
  medicine_id  INT NOT NULL REFERENCES pharmacy_medicines(id),
  batch_id     INT NOT NULL REFERENCES pharmacy_batches(id),
  qty_units    INT NOT NULL CHECK (qty_units > 0),
  CONSTRAINT pharmacy_transfer_lines_batch_once UNIQUE (transfer_id, batch_id)
);

CREATE INDEX IF NOT EXISTS pharmacy_transfer_lines_batch_idx ON pharmacy_transfer_lines (batch_id);

CREATE SEQUENCE IF NOT EXISTS pharmacy_indent_no_seq;

CREATE TABLE IF NOT EXISTS pharmacy_indents (
  id           SERIAL PRIMARY KEY,
  indent_no    TEXT NOT NULL DEFAULT ('IND' || lpad(nextval('pharmacy_indent_no_seq')::text, 6, '0')),
  location_id  INT NOT NULL REFERENCES pharmacy_locations(id),
  patient_id   INT NOT NULL REFERENCES patients(id) ON DELETE RESTRICT,
  ipd_number   TEXT CHECK (ipd_number IS NULL OR btrim(ipd_number) <> ''),
  bill_id      UUID NOT NULL REFERENCES pharmacy_bills(id) ON DELETE RESTRICT,
  notes        TEXT,
  raised_by    INT REFERENCES doctors(id) ON DELETE SET NULL,
  raised_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS pharmacy_indents_no_key ON pharmacy_indents (indent_no);
CREATE UNIQUE INDEX IF NOT EXISTS pharmacy_indents_bill_key ON pharmacy_indents (bill_id);
CREATE INDEX IF NOT EXISTS pharmacy_indents_location_idx ON pharmacy_indents (location_id, raised_at);
CREATE INDEX IF NOT EXISTS pharmacy_indents_patient_idx ON pharmacy_indents (patient_id);

DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['pharmacy_transfers', 'pharmacy_transfer_lines', 'pharmacy_indents'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON %I FROM anon, authenticated', t);
  END LOOP;
END;
$$;
