CREATE UNIQUE INDEX IF NOT EXISTS bills_id_original_key ON bills (id, original_bill_id);

CREATE OR REPLACE FUNCTION bills_credit_note_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  original_type TEXT;
  original_status TEXT;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.bill_type IS DISTINCT FROM OLD.bill_type
       OR NEW.original_bill_id IS DISTINCT FROM OLD.original_bill_id THEN
      RAISE EXCEPTION 'A bill''s type and the bill it credits never change'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'bills_credit_note_fixed_check';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.original_bill_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT bill_type, status INTO original_type, original_status
    FROM bills WHERE id = NEW.original_bill_id FOR SHARE;
  IF FOUND AND (original_type <> 'invoice' OR original_status <> 'final') THEN
    RAISE EXCEPTION 'A credit note can only credit a final invoice'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'bills_credit_note_original_check';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE TRIGGER bills_credit_note_guard
  BEFORE INSERT OR UPDATE OF bill_type, original_bill_id ON bills
  FOR EACH ROW EXECUTE FUNCTION bills_credit_note_guard();

ALTER TABLE payments
  DROP CONSTRAINT IF EXISTS payments_direction_check,
  ADD CONSTRAINT payments_direction_check CHECK (direction IN ('in', 'out'));

ALTER TABLE payments
  DROP CONSTRAINT IF EXISTS payments_cash_out_shift_check,
  ADD CONSTRAINT payments_cash_out_shift_check
    CHECK (direction = 'in' OR mode <> 'cash' OR shift_id IS NOT NULL);

CREATE OR REPLACE FUNCTION payments_direction_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  kind TEXT;
BEGIN
  SELECT bill_type INTO kind FROM bills WHERE id = NEW.bill_id;
  IF FOUND AND (NEW.direction = 'out') <> (kind = 'credit_note') THEN
    RAISE EXCEPTION 'Money comes in on an invoice and goes back out only on a credit note'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'payments_direction_bill_check';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE TRIGGER payments_direction_guard
  BEFORE INSERT OR UPDATE OF bill_id, direction ON payments
  FOR EACH ROW EXECUTE FUNCTION payments_direction_guard();

ALTER TABLE bill_lines
  ADD COLUMN IF NOT EXISTS credited_line_id UUID REFERENCES bill_lines(id) ON DELETE RESTRICT;

ALTER TABLE bill_lines
  DROP CONSTRAINT IF EXISTS bill_lines_credited_line_check,
  ADD CONSTRAINT bill_lines_credited_line_check
    CHECK (credited_line_id IS NULL OR (credited_line_id <> id AND NOT is_live));

CREATE INDEX IF NOT EXISTS bill_lines_credited_idx
  ON bill_lines (credited_line_id) WHERE credited_line_id IS NOT NULL;

CREATE OR REPLACE FUNCTION bill_lines_credit_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  own_type TEXT;
  own_original UUID;
  credited_bill UUID;
  credited_item INT;
  credited_quantity NUMERIC;
  already NUMERIC;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.quantity < OLD.quantity THEN
    SELECT COALESCE(sum(quantity), 0) INTO already
      FROM bill_lines WHERE credited_line_id = NEW.id;
    IF already > NEW.quantity THEN
      RAISE EXCEPTION 'Credit notes already credit % of this line, more than the new quantity %',
        already, NEW.quantity
        USING ERRCODE = 'check_violation', CONSTRAINT = 'bill_lines_credited_quantity_check';
    END IF;
  END IF;
  SELECT bill_type, original_bill_id INTO own_type, own_original
    FROM bills WHERE id = NEW.bill_id;
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;
  IF (own_type = 'credit_note') <> (NEW.credited_line_id IS NOT NULL) THEN
    RAISE EXCEPTION 'Every line of a credit note credits one line of the bill it credits, and only a credit note''s lines do'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'bill_lines_credit_note_line_check';
  END IF;
  IF NEW.credited_line_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT bill_id, service_item_id, quantity INTO credited_bill, credited_item, credited_quantity
    FROM bill_lines WHERE id = NEW.credited_line_id FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;
  IF credited_bill <> own_original OR credited_item <> NEW.service_item_id THEN
    RAISE EXCEPTION 'A credit note''s line credits the same item on the bill it credits'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'bill_lines_credit_note_line_check';
  END IF;
  SELECT COALESCE(sum(quantity), 0) INTO already
    FROM bill_lines WHERE credited_line_id = NEW.credited_line_id AND id <> NEW.id;
  IF already + NEW.quantity > credited_quantity THEN
    RAISE EXCEPTION 'Only % of this line is left to credit', credited_quantity - already
      USING ERRCODE = 'check_violation', CONSTRAINT = 'bill_lines_credited_quantity_check';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE TRIGGER bill_lines_credit_guard
  BEFORE INSERT OR UPDATE OF bill_id, credited_line_id, quantity, service_item_id ON bill_lines
  FOR EACH ROW EXECUTE FUNCTION bill_lines_credit_guard();

ALTER TABLE billing_requests
  ADD COLUMN IF NOT EXISTS refund_lines JSONB,
  ADD COLUMN IF NOT EXISTS requested_mode TEXT,
  ADD COLUMN IF NOT EXISTS approved_mode TEXT,
  ADD COLUMN IF NOT EXISTS mode_reason TEXT,
  ADD COLUMN IF NOT EXISTS credit_note_id UUID;

ALTER TABLE billing_requests
  DROP CONSTRAINT IF EXISTS billing_requests_kind_check,
  ADD CONSTRAINT billing_requests_kind_check
    CHECK (kind IN ('new_item', 'repeat_item', 'refund'));

ALTER TABLE billing_requests
  DROP CONSTRAINT IF EXISTS billing_requests_refund_lines_check,
  ADD CONSTRAINT billing_requests_refund_lines_check
    CHECK (jsonb_typeof(refund_lines) = 'array'
           AND refund_lines <> '[]'::jsonb
           AND NOT jsonb_path_exists(refund_lines, 'strict $[*] ? (@.type() != "object")', '{}', TRUE)
           AND NOT jsonb_path_exists(refund_lines,
             'lax $[*] ? (!exists(@.line_id) || !exists(@.quantity))', '{}', TRUE)
           AND NOT jsonb_path_exists(refund_lines,
             'strict $[*] ? (@.type() == "object").keyvalue() ? (@.key != "line_id" && @.key != "quantity")', '{}', TRUE)
           AND NOT jsonb_path_exists(refund_lines,
             'strict $[*] ? (@.type() == "object") ? (@.line_id.type() != "string"
               || !(@.line_id like_regex "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
               || @.quantity.type() != "number"
               || @.quantity <= 0
               || @.quantity > 999999.99
               || @.quantity * 100 != (@.quantity * 100).floor())', '{}', TRUE));

ALTER TABLE billing_requests
  DROP CONSTRAINT IF EXISTS billing_requests_requested_mode_check,
  ADD CONSTRAINT billing_requests_requested_mode_check
    CHECK (requested_mode IN ('as_paid', 'cash', 'card', 'upi'));

ALTER TABLE billing_requests
  DROP CONSTRAINT IF EXISTS billing_requests_approved_mode_check,
  ADD CONSTRAINT billing_requests_approved_mode_check
    CHECK (approved_mode IN ('as_paid', 'cash', 'card', 'upi'));

ALTER TABLE billing_requests
  DROP CONSTRAINT IF EXISTS billing_requests_mode_reason_check,
  ADD CONSTRAINT billing_requests_mode_reason_check CHECK (mode_reason ~ '\S');

ALTER TABLE billing_requests
  DROP CONSTRAINT IF EXISTS billing_requests_refund_check,
  ADD CONSTRAINT billing_requests_refund_check
    CHECK (kind <> 'refund' OR (bill_id IS NOT NULL AND refund_lines IS NOT NULL
           AND requested_mode IS NOT NULL AND service_item_id IS NULL
           AND proposed_name IS NULL));

ALTER TABLE billing_requests
  DROP CONSTRAINT IF EXISTS billing_requests_refund_only_check,
  ADD CONSTRAINT billing_requests_refund_only_check
    CHECK (kind = 'refund' OR (refund_lines IS NULL AND requested_mode IS NULL
           AND approved_mode IS NULL AND mode_reason IS NULL AND credit_note_id IS NULL));

ALTER TABLE billing_requests
  DROP CONSTRAINT IF EXISTS billing_requests_refund_approved_check,
  ADD CONSTRAINT billing_requests_refund_approved_check
    CHECK (kind <> 'refund'
           OR ((status IN ('approved', 'used')) = (approved_mode IS NOT NULL)
               AND (status IN ('approved', 'used')) = (credit_note_id IS NOT NULL)));

ALTER TABLE billing_requests
  DROP CONSTRAINT IF EXISTS billing_requests_mode_change_check,
  ADD CONSTRAINT billing_requests_mode_change_check
    CHECK ((mode_reason IS NULL OR approved_mode IS NOT NULL)
           AND (approved_mode IS NULL OR approved_mode = requested_mode
                OR mode_reason IS NOT NULL));

ALTER TABLE billing_requests
  DROP CONSTRAINT IF EXISTS billing_requests_credit_note_fkey,
  ADD CONSTRAINT billing_requests_credit_note_fkey
    FOREIGN KEY (credit_note_id, bill_id) REFERENCES bills (id, original_bill_id)
    ON DELETE RESTRICT;

CREATE UNIQUE INDEX IF NOT EXISTS billing_requests_credit_note_key
  ON billing_requests (credit_note_id) WHERE credit_note_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS billing_requests_pending_refund_key
  ON billing_requests (bill_id) WHERE kind = 'refund' AND status = 'pending';

ALTER TABLE bills ENABLE ROW LEVEL SECURITY;
ALTER TABLE bills FORCE ROW LEVEL SECURITY;
REVOKE ALL ON bills FROM anon, authenticated;

ALTER TABLE bill_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE bill_lines FORCE ROW LEVEL SECURITY;
REVOKE ALL ON bill_lines FROM anon, authenticated;

ALTER TABLE payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE payments FORCE ROW LEVEL SECURITY;
REVOKE ALL ON payments FROM anon, authenticated;

ALTER TABLE billing_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_requests FORCE ROW LEVEL SECURITY;
REVOKE ALL ON billing_requests FROM anon, authenticated;
