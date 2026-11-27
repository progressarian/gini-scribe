SET LOCAL lock_timeout = '5s';

INSERT INTO service_groups (code, name, sort_order)
SELECT 'MEMBERSHIP', 'Membership', 900
 WHERE NOT EXISTS (SELECT 1 FROM service_groups WHERE lower(code) = 'membership');

INSERT INTO service_subgroups (group_id, code, name, sort_order)
SELECT g.id, 'MEMBERSHIP-CONS', 'Consultant', 1
  FROM service_groups g
 WHERE lower(g.code) = 'membership'
   AND NOT EXISTS (SELECT 1 FROM service_subgroups WHERE lower(code) = 'membership-cons');

CREATE TABLE IF NOT EXISTS membership_plans (
  id                       SERIAL PRIMARY KEY,
  code                     TEXT NOT NULL CHECK (code ~ '^[A-Z0-9_-]{2,30}$'),
  name                     TEXT NOT NULL CHECK (name ~ '\S' AND length(name) <= 120),
  price                    NUMERIC(12,2) NOT NULL CHECK (price >= 0),
  consult_count            INT NOT NULL CHECK (consult_count >= 0 AND consult_count <= 1000),
  dietitian_count          INT NOT NULL DEFAULT 0 CHECK (dietitian_count >= 0 AND dietitian_count <= 1000),
  lab_discount_pct         NUMERIC(5,2) NOT NULL DEFAULT 0
                             CHECK (lab_discount_pct >= 0 AND lab_discount_pct <= 100),
  lab_excludes_outsourced  BOOLEAN NOT NULL DEFAULT FALSE,
  service_item_id          INT NOT NULL UNIQUE REFERENCES service_items(id) ON DELETE RESTRICT,
  is_active                BOOLEAN NOT NULL DEFAULT TRUE,
  created_by               INT REFERENCES doctors(id) ON DELETE SET NULL,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by               INT REFERENCES doctors(id) ON DELETE SET NULL,
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT membership_plans_benefit_check CHECK (consult_count + dietitian_count > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS membership_plans_code_key ON membership_plans (lower(code));

CREATE SEQUENCE IF NOT EXISTS membership_card_seq;

CREATE TABLE IF NOT EXISTS membership_cards (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  card_no            TEXT NOT NULL UNIQUE,
  plan_id            INT NOT NULL REFERENCES membership_plans(id) ON DELETE RESTRICT,
  holder_patient_id  INT NOT NULL REFERENCES patients(id) ON DELETE RESTRICT,
  sold_bill_id       UUID NOT NULL REFERENCES bills(id) ON DELETE RESTRICT,
  sold_line_id       UUID NOT NULL,
  price              NUMERIC(12,2) NOT NULL CHECK (price >= 0),
  consult_total      INT NOT NULL CHECK (consult_total >= 0),
  dietitian_total    INT NOT NULL CHECK (dietitian_total >= 0),
  consult_left       INT NOT NULL CHECK (consult_left >= 0),
  dietitian_left     INT NOT NULL CHECK (dietitian_left >= 0),
  status             TEXT NOT NULL DEFAULT 'active'
                       CHECK (status IN ('active', 'exhausted', 'cancelled')),
  cancelled_at       TIMESTAMPTZ,
  cancelled_by       INT REFERENCES doctors(id) ON DELETE SET NULL,
  cancel_reason      TEXT,
  created_by         INT REFERENCES doctors(id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by         INT REFERENCES doctors(id) ON DELETE SET NULL,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT membership_cards_left_check
    CHECK (consult_left <= consult_total AND dietitian_left <= dietitian_total),
  CONSTRAINT membership_cards_cancel_check
    CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS membership_cards_sold_line_key
  ON membership_cards (sold_line_id) WHERE status <> 'cancelled';
CREATE INDEX IF NOT EXISTS membership_cards_holder_idx ON membership_cards (holder_patient_id);

CREATE TABLE IF NOT EXISTS membership_card_uses (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  card_id         UUID NOT NULL REFERENCES membership_cards(id) ON DELETE RESTRICT,
  kind            TEXT NOT NULL CHECK (kind IN ('consultation', 'dietitian')),
  patient_id      INT NOT NULL REFERENCES patients(id) ON DELETE RESTRICT,
  bill_id         UUID REFERENCES bills(id) ON DELETE RESTRICT,
  bill_line_id    UUID,
  visit_id        UUID,
  used_on         DATE NOT NULL,
  source          TEXT NOT NULL CHECK (source IN ('bill', 'manual')),
  note            TEXT,
  created_by      INT REFERENCES doctors(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reversed_at     TIMESTAMPTZ,
  reversed_by     INT REFERENCES doctors(id) ON DELETE SET NULL,
  reverse_reason  TEXT,
  CONSTRAINT membership_card_uses_bill_check
    CHECK ((source = 'bill') = (bill_id IS NOT NULL AND bill_line_id IS NOT NULL)),
  CONSTRAINT membership_card_uses_reversed_check
    CHECK ((reversed_at IS NULL) = (reverse_reason IS NULL))
);

CREATE INDEX IF NOT EXISTS membership_card_uses_card_idx
  ON membership_card_uses (card_id, used_on DESC);
CREATE UNIQUE INDEX IF NOT EXISTS membership_card_uses_line_key
  ON membership_card_uses (bill_line_id) WHERE reversed_at IS NULL AND bill_line_id IS NOT NULL;

ALTER TABLE bills
  ADD COLUMN IF NOT EXISTS membership_card_id UUID REFERENCES membership_cards(id) ON DELETE RESTRICT;

ALTER TABLE bill_lines
  ADD COLUMN IF NOT EXISTS membership_benefit TEXT
    CHECK (membership_benefit IN ('consultation', 'dietitian'));

ALTER TABLE discount_rules
  ADD COLUMN IF NOT EXISTS membership_plan_id INT REFERENCES membership_plans(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS tests_only BOOLEAN NOT NULL DEFAULT FALSE;

CREATE UNIQUE INDEX IF NOT EXISTS discount_rules_membership_plan_key
  ON discount_rules (membership_plan_id) WHERE membership_plan_id IS NOT NULL;

ALTER TABLE billing_settings
  ADD COLUMN IF NOT EXISTS membership_dietitian_item_id INT
    REFERENCES service_items(id) ON DELETE SET NULL;

ALTER TABLE membership_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE membership_plans FORCE ROW LEVEL SECURITY;
REVOKE ALL ON membership_plans FROM anon, authenticated;

ALTER TABLE membership_cards ENABLE ROW LEVEL SECURITY;
ALTER TABLE membership_cards FORCE ROW LEVEL SECURITY;
REVOKE ALL ON membership_cards FROM anon, authenticated;

ALTER TABLE membership_card_uses ENABLE ROW LEVEL SECURITY;
ALTER TABLE membership_card_uses FORCE ROW LEVEL SECURITY;
REVOKE ALL ON membership_card_uses FROM anon, authenticated;

REVOKE ALL ON SEQUENCE membership_card_seq FROM anon, authenticated;
