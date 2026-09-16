-- ============================================================
-- Referral capture: let the growth team move a referral's journey
-- 2026-10-05
--
--   node migrations/_runOne.mjs migrations/2026-10-05_crm_referral_capture.sql
--
-- 2026-09-16_crm_phase1_rls.sql let only ceo_admin, head_of_growth, operations
-- and clinical_team write journey events. That was too tight for Phase 1: the
-- brief (§7) says statuses are "updatable manually by ops/growth" until Scribe
-- automation lands, and the person who knows the patient never turned up is the
-- rep who logged the referral.
--
-- Widened to the growth roles, but scoped rather than blanket: a rep may only
-- move a referral that RLS already lets them see. The EXISTS re-runs the
-- doctor_referrals_read policy, so ownership is decided in exactly one place
-- instead of being restated here and drifting.
--
-- Idempotent.
-- ============================================================

DROP POLICY IF EXISTS journey_insert ON crm.referral_journey_events;
CREATE POLICY journey_insert ON crm.referral_journey_events
  FOR INSERT
  WITH CHECK (
    crm.in_my_hospital(hospital_id)
    AND crm.current_user_role() IN (
      'ceo_admin', 'head_of_growth', 'growth_manager', 'growth_executive',
      'operations', 'clinical_team'
    )
    -- Visible to them under the referral's own policy, or it is not theirs to move.
    AND EXISTS (SELECT 1 FROM crm.doctor_referrals r WHERE r.id = referral_id)
  );

-- The rep's open-leads list. A referral is "open" until it reaches a terminal
-- state; those are the ones that must never become invisible.
CREATE OR REPLACE VIEW crm.v_open_referrals
  WITH (security_invoker = true) AS
SELECT r.id,
       r.referral_code,
       r.hospital_id,
       r.referring_doctor_id,
       d.full_name AS doctor_name,
       d.area,
       r.patient_name_raw,
       r.patient_phone_raw,
       r.status,
       r.urgency,
       r.referred_at,
       r.status_changed_at,
       r.attribution_status,
       r.expected_action,
       r.responsible_executive_id,
       sl.name AS service_line_name,
       -- How long it has been sitting where it is. A referral that has not moved
       -- in a week is the thing the leakage dashboard will eventually shout
       -- about; surfacing it now costs nothing.
       (now() - r.status_changed_at) AS time_in_status
FROM crm.doctor_referrals r
LEFT JOIN crm.doctors d ON d.id = r.referring_doctor_id
LEFT JOIN crm.service_lines sl ON sl.id = r.service_line_id
WHERE r.deleted_at IS NULL
  AND r.status NOT IN ('closed', 'lost')
ORDER BY
  CASE r.urgency WHEN 'emergency' THEN 0 WHEN 'urgent' THEN 1 WHEN 'soon' THEN 2 ELSE 3 END,
  r.status_changed_at;

COMMENT ON VIEW crm.v_open_referrals IS
  'Referrals that have not reached closed or lost. Inherits the caller''s RLS, '
  'so an executive sees only referrals for doctors they own or that they are '
  'responsible for.';

-- ---- Attribution at registration (brief §6, rules 1 and 4) --------------
--
-- A patient naming a doctor at the desk is the primary attribution source: it
-- is the patient's own word, not a rep's. It does one of two things —
--
--   * a rep already claimed this patient for that doctor -> the claim is
--     CONFIRMED and becomes verified;
--   * nobody claimed it -> a verified referral is created, because a real
--     referral nobody logged is still a real referral.
--
-- SECURITY DEFINER because the front desk has no CRM identity by design.
-- crm_registration holds no table privileges, so this cannot live in the
-- application: the linkage has to happen inside a function that already runs
-- as the owner, or not at all.
--
-- Matching is canonical patient id first, normalised phone second — rule 2's
-- ordering.
CREATE OR REPLACE FUNCTION crm.link_registration_attribution(
  p_patient_id integer,
  p_doctor_id  uuid,
  p_phone      text DEFAULT NULL
)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = crm, public, pg_temp AS $$
DECLARE
  v_hospital uuid;
  v_ref      uuid;
BEGIN
  IF p_patient_id IS NULL OR p_doctor_id IS NULL THEN RETURN 'none'; END IF;
  SELECT id INTO v_hospital FROM crm.hospitals WHERE code = 'GACH';

  SELECT id INTO v_ref
    FROM crm.doctor_referrals
   WHERE deleted_at IS NULL
     AND referring_doctor_id = p_doctor_id
     AND attribution_status <> 'verified'
     AND (patient_id = p_patient_id
          OR (p_phone IS NOT NULL
              AND patient_phone_e164 = crm.normalize_phone(p_phone)))
   ORDER BY referred_at DESC
   LIMIT 1;

  IF v_ref IS NOT NULL THEN
    UPDATE crm.doctor_referrals
       SET attribution_status = 'verified',
           verified_at = now(),
           patient_id = COALESCE(patient_id, p_patient_id)
     WHERE id = v_ref;
    INSERT INTO crm.referral_journey_events
      (hospital_id, referral_id, status, occurred_at, notes, source)
    VALUES (v_hospital, v_ref, 'consulted', now(),
            'Confirmed at registration — the patient named this doctor', 'manual');
    RETURN 'verified_existing';
  END IF;

  INSERT INTO crm.doctor_referrals
    (hospital_id, referring_doctor_id, source, patient_id, patient_phone_raw,
     status, attribution_status, verified_at)
  VALUES (v_hospital, p_doctor_id, 'gini_scribe', p_patient_id, p_phone,
          'consulted', 'verified', now())
  RETURNING id INTO v_ref;

  INSERT INTO crm.referral_journey_events
    (hospital_id, referral_id, status, occurred_at, notes, source)
  VALUES (v_hospital, v_ref, 'consulted', now(),
          'Patient named this doctor at registration', 'manual');
  RETURN 'created_verified';
END $$;

REVOKE ALL ON FUNCTION crm.link_registration_attribution(integer, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crm.link_registration_attribution(integer, uuid, text) TO crm_registration;
GRANT EXECUTE ON FUNCTION crm.link_registration_attribution(integer, uuid, text) TO crm_app;

-- record_referral_source now closes the loop itself, so the answer and the
-- attribution it implies are written in one call and cannot drift apart.
--
-- The old six-argument signature is dropped first. CREATE OR REPLACE only
-- replaces an identical signature — adding the phone parameter would otherwise
-- leave both versions in place as overloads, and every existing two-argument
-- call would then fail as ambiguous.
DROP FUNCTION IF EXISTS crm.record_referral_source(integer, text, uuid, text, uuid, text);

CREATE OR REPLACE FUNCTION crm.record_referral_source(
  p_patient_id  integer,
  p_answer_type text,
  p_doctor_id   uuid DEFAULT NULL,
  p_free_text   text DEFAULT NULL,
  p_captured_by uuid DEFAULT NULL,
  p_hospital_code text DEFAULT 'GACH',
  p_patient_phone text DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = crm, public, pg_temp AS $$
DECLARE
  v_hospital uuid;
  v_text     text := nullif(btrim(coalesce(p_free_text, '')), '');
  v_written  boolean;
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
    v_hospital, p_patient_id, p_answer_type,
    CASE WHEN p_answer_type = 'doctor' THEN p_doctor_id END,
    CASE WHEN p_answer_type = 'free_text' THEN v_text END,
    p_captured_by
  )
  ON CONFLICT (patient_id) DO NOTHING;
  v_written := FOUND;

  IF v_written AND p_answer_type = 'doctor' THEN
    PERFORM crm.link_registration_attribution(p_patient_id, p_doctor_id, p_patient_phone);
  END IF;

  RETURN v_written;
END $$;

REVOKE ALL ON FUNCTION crm.record_referral_source(integer, text, uuid, text, uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crm.record_referral_source(integer, text, uuid, text, uuid, text, text)
  TO crm_registration;
GRANT EXECUTE ON FUNCTION crm.record_referral_source(integer, text, uuid, text, uuid, text, text)
  TO crm_app;

INSERT INTO crm.schema_migrations (version)
VALUES ('2026-10-05_crm_referral_capture')
ON CONFLICT DO NOTHING;
