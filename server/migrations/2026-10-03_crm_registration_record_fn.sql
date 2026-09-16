-- ============================================================
-- Registration writes through a function, not a table grant
-- 2026-10-03
--
--   node migrations/_runOne.mjs migrations/2026-10-03_crm_registration_record_fn.sql
--
-- 2026-10-01 gave crm_registration SELECT and INSERT on
-- crm.patient_referral_sources. Testing the real write path showed that is not
-- enough and too much at the same time:
--
--   not enough — resolving hospital_id needs SELECT on crm.hospitals, so the
--   insert failed with "permission denied for table hospitals";
--   too much   — a table grant lets the caller shape the row, including which
--   hospital it belongs to.
--
-- A SECURITY DEFINER function fixes both. The hospital is resolved inside it,
-- the answer shape is validated inside it, and the role ends up with zero table
-- privileges anywhere in the schema — only the right to ask two questions.
--
-- Idempotent.
-- ============================================================

CREATE OR REPLACE FUNCTION crm.record_referral_source(
  p_patient_id  integer,
  p_answer_type text,
  p_doctor_id   uuid DEFAULT NULL,
  p_free_text   text DEFAULT NULL,
  p_captured_by uuid DEFAULT NULL,
  p_hospital_code text DEFAULT 'GACH'
)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = crm, public, pg_temp AS $$
DECLARE
  v_hospital uuid;
  v_text     text := nullif(btrim(coalesce(p_free_text, '')), '');
BEGIN
  IF p_answer_type NOT IN ('doctor', 'free_text', 'none_self') THEN
    RAISE EXCEPTION 'Unknown referral answer type: %', p_answer_type;
  END IF;
  IF p_answer_type = 'doctor' AND p_doctor_id IS NULL THEN
    RAISE EXCEPTION 'A doctor answer needs a doctor';
  END IF;
  IF p_answer_type = 'free_text' AND v_text IS NULL THEN
    RAISE EXCEPTION 'A free-text answer needs text';
  END IF;

  SELECT id INTO v_hospital FROM crm.hospitals WHERE code = p_hospital_code;
  IF v_hospital IS NULL THEN
    RAISE EXCEPTION 'Unknown hospital code: %', p_hospital_code;
  END IF;

  INSERT INTO crm.patient_referral_sources
    (hospital_id, patient_id, answer_type, doctor_id, free_text, captured_by)
  VALUES (
    v_hospital,
    p_patient_id,
    p_answer_type,
    CASE WHEN p_answer_type = 'doctor' THEN p_doctor_id END,
    CASE WHEN p_answer_type = 'free_text' THEN v_text END,
    p_captured_by
  )
  -- One row per patient. A second answer is not an error worth failing a
  -- registration over; the first one stands.
  ON CONFLICT (patient_id) DO NOTHING;

  RETURN FOUND;
END $$;

COMMENT ON FUNCTION crm.record_referral_source(integer, text, uuid, text, uuid, text) IS
  'Records the patient''s answer to "who referred you?" at registration. The '
  'only write path granted to crm_registration, which holds no table '
  'privileges. One row per patient; a later answer does not overwrite the first.';

REVOKE ALL ON FUNCTION crm.record_referral_source(integer, text, uuid, text, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crm.record_referral_source(integer, text, uuid, text, uuid, text)
  TO crm_registration;
GRANT EXECUTE ON FUNCTION crm.record_referral_source(integer, text, uuid, text, uuid, text)
  TO crm_app;

-- The table grants from 2026-10-01 are now redundant surface. The role can ask
-- its two questions and nothing else.
REVOKE SELECT, INSERT ON crm.patient_referral_sources FROM crm_registration;
DROP POLICY IF EXISTS prs_registration_read ON crm.patient_referral_sources;
DROP POLICY IF EXISTS prs_registration_insert ON crm.patient_referral_sources;

INSERT INTO crm.schema_migrations (version)
VALUES ('2026-10-03_crm_registration_record_fn')
ON CONFLICT DO NOTHING;
