CREATE TABLE IF NOT EXISTS bills (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bill_no             TEXT CHECK (bill_no ~ '\S'),
  series              TEXT CHECK (series ~ '^\S+$'),
  fy                  TEXT CHECK (fy ~ '^[0-9]{4}-[0-9]{2}$'),
  bill_type           TEXT NOT NULL DEFAULT 'invoice' CHECK (bill_type IN ('invoice', 'credit_note')),
  original_bill_id    UUID REFERENCES bills(id) ON DELETE RESTRICT,
  patient_id          INT NOT NULL REFERENCES patients(id) ON DELETE RESTRICT,
  visit_id            UUID NOT NULL REFERENCES giniflow_visits(id) ON DELETE RESTRICT,
  appointment_id      INT REFERENCES appointments(id) ON DELETE RESTRICT,
  bill_date           DATE NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Kolkata')::date,
  status              TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'final', 'cancelled')),
  scheme_code         TEXT REFERENCES patient_schemes(code) ON DELETE RESTRICT,
  scheme_label        TEXT,
  payer_name          TEXT,
  scheme_ref_enc      TEXT,
  referral_no_enc     TEXT,
  referral_doc_id     INT REFERENCES documents(id) ON DELETE SET NULL,
  patient_age         INT CHECK (patient_age BETWEEN 0 AND 150),
  pay_later           BOOLEAN NOT NULL DEFAULT FALSE,
  actual_amount       NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (actual_amount >= 0),
  discount_amount     NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (discount_amount >= 0),
  tax_amount          NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (tax_amount >= 0),
  patient_payable     NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (patient_payable >= 0),
  claim_amount        NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (claim_amount >= 0),
  adjustment_amount   NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (adjustment_amount >= 0),
  round_off           NUMERIC(6,2) NOT NULL DEFAULT 0 CHECK (round_off BETWEEN -0.49 AND 0.50),
  paid_amount         NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (paid_amount >= 0),
  claim_status        TEXT NOT NULL DEFAULT 'none' CHECK (claim_status IN ('none', 'pending', 'cleared')),
  claim_settlement_id UUID,
  version             INT NOT NULL DEFAULT 0 CHECK (version >= 0),
  finalised_by        INT REFERENCES doctors(id) ON DELETE SET NULL,
  finalised_at        TIMESTAMPTZ,
  cancelled_by        INT REFERENCES doctors(id) ON DELETE SET NULL,
  cancelled_at        TIMESTAMPTZ,
  cancel_reason       TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by          INT REFERENCES doctors(id) ON DELETE SET NULL,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by          INT REFERENCES doctors(id) ON DELETE SET NULL,
  CONSTRAINT bills_draft_has_no_number_check
    CHECK (status <> 'draft' OR bill_no IS NULL),
  CONSTRAINT bills_final_is_numbered_check
    CHECK (status <> 'final' OR (bill_no IS NOT NULL AND series IS NOT NULL
           AND fy IS NOT NULL AND finalised_at IS NOT NULL)),
  CONSTRAINT bills_cancelled_check
    CHECK (status <> 'cancelled' OR (cancelled_at IS NOT NULL
           AND cancel_reason IS NOT NULL AND cancel_reason ~ '\S')),
  CONSTRAINT bills_credit_note_check
    CHECK ((bill_type = 'credit_note') = (original_bill_id IS NOT NULL)),
  CONSTRAINT bills_own_credit_note_check
    CHECK (original_bill_id IS NULL OR original_bill_id <> id),
  CONSTRAINT bills_claim_settlement_check
    CHECK ((claim_status = 'cleared') = (claim_settlement_id IS NOT NULL)),
  CONSTRAINT bills_claim_status_amount_check
    CHECK (claim_status = 'none' OR claim_amount > 0),
  CONSTRAINT bills_totals_check
    CHECK (actual_amount - discount_amount + tax_amount + round_off
           = patient_payable + claim_amount + adjustment_amount),
  CONSTRAINT bills_paid_check CHECK (paid_amount <= patient_payable)
);

CREATE UNIQUE INDEX IF NOT EXISTS bills_id_visit_key ON bills (id, visit_id);

CREATE UNIQUE INDEX IF NOT EXISTS bills_visit_draft_key
  ON bills (visit_id) WHERE status = 'draft' AND bill_type = 'invoice';

CREATE UNIQUE INDEX IF NOT EXISTS bills_bill_no_key
  ON bills (bill_no) WHERE bill_no IS NOT NULL;

CREATE INDEX IF NOT EXISTS bills_visit_idx ON bills (visit_id);

CREATE INDEX IF NOT EXISTS bills_patient_idx ON bills (patient_id, bill_date);

CREATE INDEX IF NOT EXISTS bills_day_idx ON bills (bill_date, status);

CREATE INDEX IF NOT EXISTS bills_claim_idx ON bills (claim_status, bill_date);

CREATE INDEX IF NOT EXISTS bills_appointment_idx
  ON bills (appointment_id) WHERE appointment_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS bills_original_idx
  ON bills (original_bill_id) WHERE original_bill_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS bills_scheme_idx
  ON bills (scheme_code) WHERE scheme_code IS NOT NULL;

CREATE INDEX IF NOT EXISTS bills_dues_idx
  ON bills (bill_date) WHERE status = 'final' AND paid_amount < patient_payable;

ALTER TABLE bills ENABLE ROW LEVEL SECURITY;
ALTER TABLE bills FORCE ROW LEVEL SECURITY;
REVOKE ALL ON bills FROM anon, authenticated;

CREATE TABLE IF NOT EXISTS billing_requests (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind            TEXT NOT NULL CHECK (kind IN ('new_item', 'repeat_item')),
  patient_id      INT REFERENCES patients(id) ON DELETE RESTRICT,
  visit_id        UUID REFERENCES giniflow_visits(id) ON DELETE RESTRICT,
  bill_id         UUID REFERENCES bills(id) ON DELETE RESTRICT,
  service_item_id INT REFERENCES service_items(id) ON DELETE RESTRICT,
  proposed_name   TEXT CHECK (proposed_name ~ '\S'),
  proposed_group  TEXT,
  reason          TEXT NOT NULL CHECK (reason ~ '\S'),
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'approved', 'rejected', 'used')),
  requested_by    INT REFERENCES doctors(id) ON DELETE SET NULL,
  requested_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  decided_by      INT REFERENCES doctors(id) ON DELETE SET NULL,
  decided_at      TIMESTAMPTZ,
  decision_note   TEXT,
  created_item_id INT REFERENCES service_items(id) ON DELETE RESTRICT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by      INT REFERENCES doctors(id) ON DELETE SET NULL,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by      INT REFERENCES doctors(id) ON DELETE SET NULL,
  CONSTRAINT billing_requests_repeat_check
    CHECK (kind <> 'repeat_item' OR (service_item_id IS NOT NULL AND visit_id IS NOT NULL
           AND proposed_name IS NULL)),
  CONSTRAINT billing_requests_new_item_check
    CHECK (kind <> 'new_item' OR (proposed_name IS NOT NULL AND service_item_id IS NULL)),
  CONSTRAINT billing_requests_created_item_check
    CHECK (created_item_id IS NULL OR (kind = 'new_item' AND status IN ('approved', 'used'))),
  CONSTRAINT billing_requests_decided_check
    CHECK (status = 'pending' OR decided_at IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS billing_requests_repeat_key
  ON billing_requests (id, visit_id, service_item_id);

CREATE INDEX IF NOT EXISTS billing_requests_pending_idx
  ON billing_requests (requested_at) WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS billing_requests_bill_idx
  ON billing_requests (bill_id) WHERE bill_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS billing_requests_visit_idx
  ON billing_requests (visit_id) WHERE visit_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS billing_requests_item_idx
  ON billing_requests (service_item_id) WHERE service_item_id IS NOT NULL;

ALTER TABLE billing_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_requests FORCE ROW LEVEL SECURITY;
REVOKE ALL ON billing_requests FROM anon, authenticated;

CREATE TABLE IF NOT EXISTS bill_lines (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bill_id           UUID NOT NULL,
  visit_id          UUID NOT NULL REFERENCES giniflow_visits(id) ON DELETE RESTRICT,
  line_no           INT NOT NULL CHECK (line_no > 0),
  service_item_id   INT NOT NULL REFERENCES service_items(id) ON DELETE RESTRICT,
  source            TEXT NOT NULL DEFAULT 'added'
                    CHECK (source IN ('visit', 'lab_order', 'added')),
  lab_order_id      UUID REFERENCES giniflow_lab_orders(id) ON DELETE RESTRICT,
  doctor_id         INT,
  is_live           BOOLEAN NOT NULL DEFAULT TRUE,
  repeat_request_id UUID,
  group_code        TEXT,
  subgroup_code     TEXT,
  item_code         TEXT,
  bill_code         TEXT,
  bill_name         TEXT NOT NULL CHECK (bill_name ~ '\S'),
  quantity          NUMERIC(8,2) NOT NULL DEFAULT 1 CHECK (quantity > 0),
  base_rate         NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (base_rate >= 0),
  rate              NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (rate >= 0),
  listed_actual     NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (listed_actual >= 0),
  actual_amount     NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (actual_amount >= 0),
  listed_discount   NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (listed_discount >= 0),
  discount          NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (discount >= 0),
  payable_discount  NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (payable_discount >= 0),
  bill_discount     NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (bill_discount >= 0),
  tax_code          TEXT,
  sac_hsn           TEXT,
  tax_rate_pct      NUMERIC(5,2) CHECK (tax_rate_pct BETWEEN 0 AND 100),
  taxable           NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (taxable >= 0),
  cgst              NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (cgst >= 0),
  sgst              NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (sgst >= 0),
  payment_rule_id   INT,
  payment_rule      TEXT,
  patient_payable   NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (patient_payable >= 0),
  claim_amount      NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (claim_amount >= 0),
  adjustment_amount NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (adjustment_amount >= 0),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by        INT REFERENCES doctors(id) ON DELETE SET NULL,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by        INT REFERENCES doctors(id) ON DELETE SET NULL,
  CONSTRAINT bill_lines_balance_check
    CHECK (actual_amount - discount + cgst + sgst
           = patient_payable + claim_amount + adjustment_amount),
  CONSTRAINT bill_lines_total_check
    CHECK (taxable + cgst + sgst - payable_discount - bill_discount
           = patient_payable + claim_amount + adjustment_amount),
  CONSTRAINT bill_lines_gst_halves_check CHECK (cgst = sgst),
  CONSTRAINT bill_lines_quantity_rate_check
    CHECK (listed_actual = ROUND(quantity * rate, 2)),
  CONSTRAINT bill_lines_discount_split_check
    CHECK (discount >= payable_discount + bill_discount AND listed_discount >= payable_discount),
  CONSTRAINT bill_lines_payable_check CHECK (patient_payable <= taxable + cgst + sgst),
  CONSTRAINT bill_lines_remainder_check
    CHECK (claim_amount = 0 OR adjustment_amount = 0),
  CONSTRAINT bill_lines_full_pay_check
    CHECK (payment_rule_id IS NOT NULL
           OR (claim_amount = 0 AND adjustment_amount = 0 AND payable_discount = 0)),
  CONSTRAINT bill_lines_lab_order_check
    CHECK ((source = 'lab_order') = (lab_order_id IS NOT NULL)),
  CONSTRAINT bill_lines_tax_rate_check
    CHECK (cgst + sgst = 0 OR (tax_rate_pct IS NOT NULL AND tax_rate_pct > 0)),
  CONSTRAINT bill_lines_bill_visit_fkey
    FOREIGN KEY (bill_id, visit_id) REFERENCES bills (id, visit_id) ON DELETE RESTRICT,
  CONSTRAINT bill_lines_repeat_request_fkey
    FOREIGN KEY (repeat_request_id, visit_id, service_item_id)
    REFERENCES billing_requests (id, visit_id, service_item_id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX IF NOT EXISTS bill_lines_live_item_key
  ON bill_lines (visit_id, service_item_id)
  WHERE is_live AND repeat_request_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS bill_lines_bill_line_no_key
  ON bill_lines (bill_id, line_no);

CREATE INDEX IF NOT EXISTS bill_lines_visit_idx ON bill_lines (visit_id);

CREATE INDEX IF NOT EXISTS bill_lines_item_idx ON bill_lines (service_item_id);

CREATE INDEX IF NOT EXISTS bill_lines_lab_order_idx
  ON bill_lines (lab_order_id) WHERE lab_order_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS bill_lines_doctor_idx
  ON bill_lines (doctor_id) WHERE doctor_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS bill_lines_repeat_key
  ON bill_lines (repeat_request_id) WHERE repeat_request_id IS NOT NULL;

ALTER TABLE bill_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE bill_lines FORCE ROW LEVEL SECURITY;
REVOKE ALL ON bill_lines FROM anon, authenticated;

CREATE TABLE IF NOT EXISTS bill_line_discounts (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bill_line_id UUID NOT NULL REFERENCES bill_lines(id) ON DELETE RESTRICT,
  rule_id      INT REFERENCES discount_rules(id) ON DELETE RESTRICT,
  code         TEXT CHECK (code ~ '^\S+$'),
  method       TEXT NOT NULL CHECK (method IN ('auto', 'code')),
  taken_from   TEXT NOT NULL DEFAULT 'actual'
               CHECK (taken_from IN ('actual', 'patient_payable', 'bill')),
  amount       NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  applied_by   INT REFERENCES doctors(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by   INT REFERENCES doctors(id) ON DELETE SET NULL,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by   INT REFERENCES doctors(id) ON DELETE SET NULL,
  CONSTRAINT bill_line_discounts_method_code_check CHECK ((method = 'code') = (code IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS bill_line_discounts_line_idx ON bill_line_discounts (bill_line_id);

CREATE INDEX IF NOT EXISTS bill_line_discounts_rule_idx
  ON bill_line_discounts (rule_id) WHERE rule_id IS NOT NULL;

ALTER TABLE bill_line_discounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE bill_line_discounts FORCE ROW LEVEL SECURITY;
REVOKE ALL ON bill_line_discounts FROM anon, authenticated;

CREATE TABLE IF NOT EXISTS cash_shifts (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       INT NOT NULL REFERENCES doctors(id) ON DELETE RESTRICT,
  opened_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  closed_at     TIMESTAMPTZ,
  opening_cash  NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (opening_cash >= 0),
  expected_cash NUMERIC(12,2) CHECK (expected_cash >= 0),
  counted_cash  NUMERIC(12,2) CHECK (counted_cash >= 0),
  difference    NUMERIC(12,2),
  note          TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by    INT REFERENCES doctors(id) ON DELETE SET NULL,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by    INT REFERENCES doctors(id) ON DELETE SET NULL,
  CONSTRAINT cash_shifts_closed_order_check CHECK (closed_at IS NULL OR closed_at >= opened_at),
  CONSTRAINT cash_shifts_counted_check
    CHECK (closed_at IS NOT NULL OR (expected_cash IS NULL AND counted_cash IS NULL
           AND difference IS NULL)),
  CONSTRAINT cash_shifts_difference_check
    CHECK (closed_at IS NULL OR (expected_cash IS NOT NULL AND counted_cash IS NOT NULL
           AND difference = counted_cash - expected_cash))
);

CREATE UNIQUE INDEX IF NOT EXISTS cash_shifts_open_per_user_key
  ON cash_shifts (user_id) WHERE closed_at IS NULL;

CREATE INDEX IF NOT EXISTS cash_shifts_opened_idx ON cash_shifts (opened_at);

ALTER TABLE cash_shifts ENABLE ROW LEVEL SECURITY;
ALTER TABLE cash_shifts FORCE ROW LEVEL SECURITY;
REVOKE ALL ON cash_shifts FROM anon, authenticated;

CREATE TABLE IF NOT EXISTS payments (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bill_id     UUID NOT NULL REFERENCES bills(id) ON DELETE RESTRICT,
  direction   TEXT NOT NULL DEFAULT 'in' CHECK (direction IN ('in')),
  mode        TEXT NOT NULL CHECK (mode IN ('cash', 'card', 'upi')),
  amount      NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  reference   TEXT,
  received_by INT REFERENCES doctors(id) ON DELETE SET NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  shift_id    UUID REFERENCES cash_shifts(id) ON DELETE RESTRICT,
  receipt_no  TEXT CHECK (receipt_no ~ '\S'),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by  INT REFERENCES doctors(id) ON DELETE SET NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by  INT REFERENCES doctors(id) ON DELETE SET NULL,
  CONSTRAINT payments_reference_check
    CHECK (mode = 'cash' OR (reference IS NOT NULL AND reference ~ '\S'))
);

CREATE UNIQUE INDEX IF NOT EXISTS payments_receipt_no_key
  ON payments (receipt_no) WHERE receipt_no IS NOT NULL;

CREATE INDEX IF NOT EXISTS payments_bill_idx ON payments (bill_id);

CREATE INDEX IF NOT EXISTS payments_shift_idx
  ON payments (shift_id) WHERE shift_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS payments_received_idx ON payments (received_at);

ALTER TABLE payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE payments FORCE ROW LEVEL SECURITY;
REVOKE ALL ON payments FROM anon, authenticated;
