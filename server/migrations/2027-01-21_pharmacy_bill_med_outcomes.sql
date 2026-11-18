CREATE TABLE IF NOT EXISTS pharmacy_bill_med_outcomes (
  bill_id       UUID NOT NULL REFERENCES pharmacy_bills(id) ON DELETE CASCADE,
  medication_id INT  NOT NULL REFERENCES medications(id) ON DELETE CASCADE,
  outcome       TEXT NOT NULL CHECK (outcome IN ('given', 'substitute', 'not_given', 'requested')),
  medicine_id   INT REFERENCES pharmacy_medicines(id) ON DELETE SET NULL,
  reason        TEXT CHECK (reason IS NULL OR reason ~ '^[a-z_]{2,40}$'),
  decided_by    INT REFERENCES doctors(id) ON DELETE SET NULL,
  decided_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (bill_id, medication_id),
  CONSTRAINT pharmacy_bill_med_outcomes_reason
    CHECK (outcome IN ('given', 'substitute') OR reason IS NOT NULL),
  CONSTRAINT pharmacy_bill_med_outcomes_substitute
    CHECK (outcome <> 'substitute' OR medicine_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS pharmacy_bill_med_outcomes_medication
  ON pharmacy_bill_med_outcomes (medication_id);

ALTER TABLE pharmacy_bill_med_outcomes ENABLE ROW LEVEL SECURITY;
ALTER TABLE pharmacy_bill_med_outcomes FORCE ROW LEVEL SECURITY;
REVOKE ALL ON pharmacy_bill_med_outcomes FROM anon, authenticated;

DO $$
DECLARE
  leftover BOOLEAN;
BEGIN
  IF to_regclass('public.pharmacy_bill_rx_outcomes') IS NOT NULL THEN
    EXECUTE 'SELECT EXISTS (SELECT 1 FROM pharmacy_bill_rx_outcomes)' INTO leftover;
    IF NOT leftover THEN
      DROP TABLE pharmacy_bill_rx_outcomes;
    END IF;
  END IF;
END $$;
