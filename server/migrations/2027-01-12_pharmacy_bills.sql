ALTER TABLE patients ADD COLUMN IF NOT EXISTS registration_source TEXT;

CREATE TABLE IF NOT EXISTS pharmacy_bills (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bill_no             TEXT CHECK (bill_no ~ '\S'),
  series              TEXT CHECK (series IN ('PH', 'PHCN')),
  fy                  TEXT CHECK (fy ~ '^[0-9]{4}-[0-9]{2}$'),
  bill_type           TEXT NOT NULL DEFAULT 'invoice' CHECK (bill_type IN ('invoice', 'credit_note')),
  original_bill_id    UUID REFERENCES pharmacy_bills(id) ON DELETE RESTRICT,
  sale_type           TEXT NOT NULL CHECK (sale_type IN ('opd', 'ipd', 'walkin', 'indent')),
  gst_folded          BOOLEAN NOT NULL DEFAULT FALSE,
  sale_rate_includes_gst BOOLEAN NOT NULL DEFAULT FALSE,
  patient_id          INT NOT NULL REFERENCES patients(id) ON DELETE RESTRICT,
  visit_id            UUID REFERENCES giniflow_visits(id) ON DELETE SET NULL,
  location_id         INT NOT NULL REFERENCES pharmacy_locations(id),
  ipd_number          TEXT CHECK (ipd_number IS NULL OR btrim(ipd_number) <> ''),
  prescriber_name     TEXT CHECK (prescriber_name IS NULL OR btrim(prescriber_name) <> ''),
  prescriber_id       INT REFERENCES doctors(id) ON DELETE SET NULL,
  bill_date           DATE NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Kolkata')::date,
  status              TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'final', 'cancelled')),
  gross_amount        NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (gross_amount >= 0),
  taxable_amount      NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (taxable_amount >= 0),
  cgst_amount         NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (cgst_amount >= 0),
  sgst_amount         NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (sgst_amount >= 0),
  folded_gst_amount   NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (folded_gst_amount >= 0),
  round_off           NUMERIC(6, 2) NOT NULL DEFAULT 0 CHECK (round_off BETWEEN -0.49 AND 0.50),
  net_amount          NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (net_amount >= 0),
  paid_amount         NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (paid_amount >= 0),
  pay_later           BOOLEAN NOT NULL DEFAULT FALSE,
  issued_legal_name   TEXT,
  issued_gstin        TEXT,
  issued_drug_license TEXT,
  notes               TEXT,
  version             INT NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by          INT REFERENCES doctors(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by          INT REFERENCES doctors(id) ON DELETE SET NULL,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finalised_by        INT REFERENCES doctors(id) ON DELETE SET NULL,
  finalised_at        TIMESTAMPTZ,
  cancelled_by        INT REFERENCES doctors(id) ON DELETE SET NULL,
  cancelled_at        TIMESTAMPTZ,
  cancel_reason       TEXT,
  CONSTRAINT pharmacy_bills_draft_unnumbered CHECK (status <> 'draft' OR bill_no IS NULL),
  CONSTRAINT pharmacy_bills_final_numbered
    CHECK (status <> 'final' OR (bill_no IS NOT NULL AND series IS NOT NULL
           AND fy IS NOT NULL AND finalised_at IS NOT NULL)),
  CONSTRAINT pharmacy_bills_cancelled
    CHECK (status <> 'cancelled' OR (cancelled_at IS NOT NULL AND cancel_reason ~ '\S')),
  CONSTRAINT pharmacy_bills_credit_note
    CHECK ((bill_type = 'credit_note') = (original_bill_id IS NOT NULL)),
  CONSTRAINT pharmacy_bills_series_matches
    CHECK (series IS NULL OR series = CASE bill_type WHEN 'invoice' THEN 'PH' ELSE 'PHCN' END),
  CONSTRAINT pharmacy_bills_ipd_number CHECK (sale_type <> 'ipd' OR ipd_number IS NOT NULL),
  CONSTRAINT pharmacy_bills_folded
    CHECK (gst_folded = (sale_type IN ('ipd', 'indent'))),
  CONSTRAINT pharmacy_bills_folded_no_gst
    CHECK (NOT gst_folded OR (cgst_amount = 0 AND sgst_amount = 0)),
  CONSTRAINT pharmacy_bills_gst_halves CHECK (cgst_amount = sgst_amount),
  CONSTRAINT pharmacy_bills_totals
    CHECK (taxable_amount + cgst_amount + sgst_amount + round_off = net_amount),
  CONSTRAINT pharmacy_bills_paid CHECK (paid_amount <= net_amount),
  CONSTRAINT pharmacy_bills_settled
    CHECK (status <> 'final' OR bill_type <> 'invoice' OR pay_later OR paid_amount = net_amount)
);

CREATE UNIQUE INDEX IF NOT EXISTS pharmacy_bills_bill_no_key
  ON pharmacy_bills (bill_no) WHERE bill_no IS NOT NULL;
CREATE INDEX IF NOT EXISTS pharmacy_bills_day_idx ON pharmacy_bills (bill_date, status);
CREATE INDEX IF NOT EXISTS pharmacy_bills_patient_idx ON pharmacy_bills (patient_id, bill_date);
CREATE INDEX IF NOT EXISTS pharmacy_bills_visit_idx
  ON pharmacy_bills (visit_id) WHERE visit_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS pharmacy_bills_original_idx
  ON pharmacy_bills (original_bill_id) WHERE original_bill_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS pharmacy_bills_dues_idx
  ON pharmacy_bills (bill_date) WHERE status = 'final' AND paid_amount < net_amount;

CREATE TABLE IF NOT EXISTS pharmacy_bill_lines (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bill_id            UUID NOT NULL REFERENCES pharmacy_bills(id) ON DELETE CASCADE,
  line_no            INT NOT NULL CHECK (line_no > 0),
  medicine_id        INT NOT NULL REFERENCES pharmacy_medicines(id),
  batch_id           INT NOT NULL REFERENCES pharmacy_batches(id),
  credited_line_id   UUID REFERENCES pharmacy_bill_lines(id) ON DELETE RESTRICT,
  medicine_name      TEXT NOT NULL CHECK (btrim(medicine_name) <> ''),
  batch_no           TEXT NOT NULL,
  expiry_date        DATE NOT NULL,
  hsn_code           TEXT,
  schedule           TEXT,
  rack_no            TEXT,
  pack_size          INT NOT NULL CHECK (pack_size BETWEEN 1 AND 10000),
  unit_label         TEXT NOT NULL,
  qty_units          INT NOT NULL CHECK (qty_units > 0),
  pack_mrp           NUMERIC(12, 2) NOT NULL CHECK (pack_mrp > 0),
  pack_sale_rate     NUMERIC(12, 2) NOT NULL CHECK (pack_sale_rate > 0 AND pack_sale_rate <= pack_mrp),
  gst_rate_pct       NUMERIC(5, 2) NOT NULL CHECK (gst_rate_pct BETWEEN 0 AND 28),
  tax_rate_pct       NUMERIC(5, 2) NOT NULL CHECK (tax_rate_pct BETWEEN 0 AND 28),
  gross_amount       NUMERIC(12, 2) NOT NULL CHECK (gross_amount >= 0),
  mrp_amount         NUMERIC(12, 2) NOT NULL CHECK (mrp_amount > 0),
  mrp_capped         BOOLEAN NOT NULL DEFAULT FALSE,
  taxable            NUMERIC(12, 2) NOT NULL CHECK (taxable >= 0),
  cgst               NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (cgst >= 0),
  sgst               NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (sgst >= 0),
  folded_gst         NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (folded_gst >= 0),
  total              NUMERIC(12, 2) NOT NULL CHECK (total > 0),
  near_expiry_ok_by  INT REFERENCES doctors(id) ON DELETE SET NULL,
  created_by         INT REFERENCES doctors(id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT pharmacy_bill_lines_gst_halves CHECK (cgst = sgst),
  CONSTRAINT pharmacy_bill_lines_total CHECK (taxable + cgst + sgst = total),
  CONSTRAINT pharmacy_bill_lines_within_mrp CHECK (total <= mrp_amount),
  CONSTRAINT pharmacy_bill_lines_tax_rate
    CHECK (tax_rate_pct = 0 OR tax_rate_pct = gst_rate_pct),
  CONSTRAINT pharmacy_bill_lines_folded CHECK (folded_gst = 0 OR tax_rate_pct = 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS pharmacy_bill_lines_line_no_key
  ON pharmacy_bill_lines (bill_id, line_no);
CREATE UNIQUE INDEX IF NOT EXISTS pharmacy_bill_lines_batch_key
  ON pharmacy_bill_lines (bill_id, batch_id) WHERE credited_line_id IS NULL;
CREATE INDEX IF NOT EXISTS pharmacy_bill_lines_medicine_idx ON pharmacy_bill_lines (medicine_id);
CREATE INDEX IF NOT EXISTS pharmacy_bill_lines_batch_idx ON pharmacy_bill_lines (batch_id);
CREATE INDEX IF NOT EXISTS pharmacy_bill_lines_credited_idx
  ON pharmacy_bill_lines (credited_line_id) WHERE credited_line_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS pharmacy_payments (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bill_id      UUID NOT NULL REFERENCES pharmacy_bills(id) ON DELETE RESTRICT,
  direction    TEXT NOT NULL DEFAULT 'in' CHECK (direction IN ('in', 'out')),
  mode         TEXT NOT NULL CHECK (mode IN ('cash', 'card', 'upi', 'neft')),
  amount       NUMERIC(12, 2) NOT NULL CHECK (amount > 0),
  reference    TEXT,
  upi_app      TEXT,
  receipt_no   TEXT CHECK (receipt_no ~ '\S'),
  shift_id     UUID REFERENCES cash_shifts(id) ON DELETE RESTRICT,
  received_by  INT REFERENCES doctors(id) ON DELETE SET NULL,
  received_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT pharmacy_payments_reference
    CHECK (mode = 'cash' OR (reference IS NOT NULL AND reference ~ '\S'))
);

CREATE UNIQUE INDEX IF NOT EXISTS pharmacy_payments_receipt_no_key
  ON pharmacy_payments (receipt_no) WHERE receipt_no IS NOT NULL;
CREATE INDEX IF NOT EXISTS pharmacy_payments_bill_idx ON pharmacy_payments (bill_id);
CREATE INDEX IF NOT EXISTS pharmacy_payments_received_idx ON pharmacy_payments (received_at);
CREATE INDEX IF NOT EXISTS pharmacy_payments_shift_idx
  ON pharmacy_payments (shift_id) WHERE shift_id IS NOT NULL;

DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['pharmacy_bills', 'pharmacy_bill_lines', 'pharmacy_payments'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON %I FROM anon, authenticated', t);
  END LOOP;
END;
$$;
