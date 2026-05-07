-- Medication refill requests (gini-only — patient_id is the scribe int FK).
-- Header + items split so we can keep a permanent order history with
-- per-medicine quantities. Patient app inserts via the gini_create_refill_request
-- RPC over Supabase PostgREST; the doctor side reads via raw SQL through the
-- existing pg pool (server/routes/refills.js).
--
-- Re-runnable: drops the previous attempt before recreating.

DROP FUNCTION IF EXISTS gini_create_refill_request(INTEGER, JSONB, TEXT);
DROP FUNCTION IF EXISTS gini_create_refill_request(TEXT, JSONB, TEXT);
DROP FUNCTION IF EXISTS gini_get_refill_requests(INTEGER, TEXT, INT);
DROP FUNCTION IF EXISTS gini_get_refill_requests(TEXT, TEXT, INT);
DROP FUNCTION IF EXISTS gini_get_patient_refill_requests(INTEGER, INT);
DROP FUNCTION IF EXISTS gini_update_refill_request_status(UUID, TEXT, TEXT);
DROP TABLE IF EXISTS medication_refill_request_items;
DROP TABLE IF EXISTS medication_refill_requests;

CREATE TABLE medication_refill_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id INTEGER NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending',
  notes TEXT,
  reject_reason TEXT,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  status_updated_at TIMESTAMPTZ,
  status_updated_by TEXT
);

CREATE INDEX idx_refill_requests_patient
  ON medication_refill_requests (patient_id, status, requested_at DESC);
CREATE INDEX idx_refill_requests_status
  ON medication_refill_requests (status, requested_at DESC);

CREATE TABLE medication_refill_request_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id UUID NOT NULL REFERENCES medication_refill_requests(id) ON DELETE CASCADE,
  medication_name TEXT NOT NULL,
  dose TEXT,
  timing TEXT,
  quantity INT NOT NULL CHECK (quantity > 0),
  source_medication_id TEXT
);

CREATE INDEX idx_refill_items_request
  ON medication_refill_request_items (request_id);


-- Patient app calls this. Items shape:
--   [{ medication_name, dose, timing, quantity, source_medication_id }, ...]
CREATE OR REPLACE FUNCTION gini_create_refill_request(
  p_patient_id INTEGER,
  p_items JSONB,
  p_notes TEXT DEFAULT NULL
) RETURNS UUID AS $$
DECLARE
  v_request_id UUID;
  v_item JSONB;
  v_exists BOOLEAN;
BEGIN
  IF p_patient_id IS NULL THEN
    RAISE EXCEPTION 'p_patient_id is required';
  END IF;
  SELECT EXISTS(SELECT 1 FROM patients WHERE id = p_patient_id) INTO v_exists;
  IF NOT v_exists THEN
    RAISE EXCEPTION 'patient % not found', p_patient_id;
  END IF;
  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'p_items must be a non-empty JSON array';
  END IF;

  INSERT INTO medication_refill_requests (patient_id, notes)
  VALUES (p_patient_id, p_notes)
  RETURNING id INTO v_request_id;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    INSERT INTO medication_refill_request_items
      (request_id, medication_name, dose, timing, quantity, source_medication_id)
    VALUES (
      v_request_id,
      COALESCE(v_item->>'medication_name', ''),
      v_item->>'dose',
      v_item->>'timing',
      GREATEST(1, COALESCE((v_item->>'quantity')::INT, 1)),
      v_item->>'source_medication_id'
    );
  END LOOP;

  RETURN v_request_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;


-- Patient app reads its own refill history via this. Returns header rows
-- with items inlined (same shape as the doctor-side list endpoint).
CREATE OR REPLACE FUNCTION gini_get_patient_refill_requests(
  p_patient_id INTEGER,
  p_limit INT DEFAULT 100
) RETURNS TABLE (
  id UUID,
  patient_id INTEGER,
  status TEXT,
  notes TEXT,
  reject_reason TEXT,
  requested_at TIMESTAMPTZ,
  status_updated_at TIMESTAMPTZ,
  status_updated_by TEXT,
  items JSONB
) AS $$
BEGIN
  IF p_patient_id IS NULL THEN
    RAISE EXCEPTION 'p_patient_id is required';
  END IF;
  RETURN QUERY
  SELECT
    r.id, r.patient_id, r.status, r.notes, r.reject_reason,
    r.requested_at, r.status_updated_at, r.status_updated_by,
    COALESCE(
      (SELECT jsonb_agg(
        jsonb_build_object(
          'id', i.id,
          'medication_name', i.medication_name,
          'dose', i.dose,
          'timing', i.timing,
          'quantity', i.quantity,
          'source_medication_id', i.source_medication_id
        ) ORDER BY i.medication_name
       ) FROM medication_refill_request_items i WHERE i.request_id = r.id),
      '[]'::jsonb
    ) AS items
  FROM medication_refill_requests r
  WHERE r.patient_id = p_patient_id
  ORDER BY r.requested_at DESC
  LIMIT p_limit;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
