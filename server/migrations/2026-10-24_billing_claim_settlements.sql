CREATE TABLE IF NOT EXISTS claim_settlements (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payer_name  TEXT NOT NULL CHECK (payer_name ~ '\S'),
  received_on DATE NOT NULL,
  reference   TEXT NOT NULL CHECK (reference ~ '\S'),
  amount      NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  note        TEXT,
  cleared_by  INT REFERENCES doctors(id) ON DELETE SET NULL,
  cleared_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  voided_at   TIMESTAMPTZ,
  voided_by   INT REFERENCES doctors(id) ON DELETE SET NULL,
  void_reason TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by  INT REFERENCES doctors(id) ON DELETE SET NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by  INT REFERENCES doctors(id) ON DELETE SET NULL,
  CONSTRAINT claim_settlements_void_check
    CHECK ((voided_at IS NULL AND voided_by IS NULL AND void_reason IS NULL)
        OR (voided_at IS NOT NULL AND void_reason IS NOT NULL AND void_reason ~ '\S'))
);

CREATE INDEX IF NOT EXISTS claim_settlements_reference_idx
  ON claim_settlements (lower(reference));

CREATE INDEX IF NOT EXISTS claim_settlements_received_idx
  ON claim_settlements (received_on) WHERE voided_at IS NULL;

ALTER TABLE claim_settlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE claim_settlements FORCE ROW LEVEL SECURITY;
REVOKE ALL ON claim_settlements FROM anon, authenticated;

CREATE TABLE IF NOT EXISTS claim_settlement_bills (
  settlement_id UUID NOT NULL REFERENCES claim_settlements(id) ON DELETE RESTRICT,
  bill_id       UUID NOT NULL REFERENCES bills(id) ON DELETE RESTRICT,
  amount        NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  voided_at     TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by    INT REFERENCES doctors(id) ON DELETE SET NULL,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by    INT REFERENCES doctors(id) ON DELETE SET NULL,
  PRIMARY KEY (settlement_id, bill_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS claim_settlement_bills_live_key
  ON claim_settlement_bills (bill_id) WHERE voided_at IS NULL;

CREATE INDEX IF NOT EXISTS claim_settlement_bills_bill_idx ON claim_settlement_bills (bill_id);

ALTER TABLE claim_settlement_bills ENABLE ROW LEVEL SECURITY;
ALTER TABLE claim_settlement_bills FORCE ROW LEVEL SECURITY;
REVOKE ALL ON claim_settlement_bills FROM anon, authenticated;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'bills_claim_settlement_id_fkey' AND conrelid = 'bills'::regclass
  ) THEN
    ALTER TABLE bills
      ADD CONSTRAINT bills_claim_settlement_id_fkey
      FOREIGN KEY (claim_settlement_id) REFERENCES claim_settlements(id) ON DELETE RESTRICT;
  END IF;
END;
$$;

CREATE INDEX IF NOT EXISTS bills_claim_settlement_idx
  ON bills (claim_settlement_id) WHERE claim_settlement_id IS NOT NULL;
