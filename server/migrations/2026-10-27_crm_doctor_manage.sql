ALTER TABLE crm.doctors
  ADD COLUMN IF NOT EXISTS removed_reason text,
  ADD COLUMN IF NOT EXISTS removed_note   text,
  ADD COLUMN IF NOT EXISTS removed_by     uuid REFERENCES crm.users(id);

ALTER TABLE crm.visits
  ADD COLUMN IF NOT EXISTS change_reason text;

CREATE TABLE IF NOT EXISTS crm.doctor_removal_requests (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id   uuid NOT NULL REFERENCES crm.hospitals(id),
  doctor_id     uuid NOT NULL REFERENCES crm.doctors(id),
  requested_by  uuid NOT NULL REFERENCES crm.users(id),
  reason        text NOT NULL CHECK (reason IN ('duplicate', 'left', 'not_a_doctor', 'not_interested', 'other')), -- duplicate | left | not_a_doctor | not_interested | other
  note          text,
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')), -- pending | approved | rejected | cancelled
  decided_by    uuid REFERENCES crm.users(id),
  decided_at    timestamptz,
  decision_note text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS removal_one_pending_uniq
  ON crm.doctor_removal_requests (doctor_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS removal_status_idx
  ON crm.doctor_removal_requests (hospital_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS removal_requester_idx
  ON crm.doctor_removal_requests (requested_by, created_at DESC);

DROP TRIGGER IF EXISTS trg_doctor_removal_requests_updated ON crm.doctor_removal_requests;
CREATE TRIGGER trg_doctor_removal_requests_updated BEFORE UPDATE ON crm.doctor_removal_requests
  FOR EACH ROW EXECUTE FUNCTION crm.set_updated_at();
DROP TRIGGER IF EXISTS trg_doctor_removal_requests_no_delete ON crm.doctor_removal_requests;
CREATE TRIGGER trg_doctor_removal_requests_no_delete BEFORE DELETE ON crm.doctor_removal_requests
  FOR EACH ROW EXECUTE FUNCTION crm.block_hard_delete();
DROP TRIGGER IF EXISTS trg_doctor_removal_requests_audit ON crm.doctor_removal_requests;
CREATE TRIGGER trg_doctor_removal_requests_audit AFTER INSERT OR UPDATE OR DELETE ON crm.doctor_removal_requests
  FOR EACH ROW EXECUTE FUNCTION crm.audit_row();

ALTER TABLE crm.doctor_removal_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm.doctor_removal_requests FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON crm.doctor_removal_requests TO crm_app;

DROP POLICY IF EXISTS removal_read ON crm.doctor_removal_requests;
CREATE POLICY removal_read ON crm.doctor_removal_requests FOR SELECT
  USING (crm.in_my_hospital(hospital_id)
         AND (crm.is_growth_lead()
              OR requested_by = crm.current_user_id()
              OR crm.can_access_doctor(doctor_id)));

DROP POLICY IF EXISTS removal_insert ON crm.doctor_removal_requests;
CREATE POLICY removal_insert ON crm.doctor_removal_requests FOR INSERT
  WITH CHECK (crm.in_my_hospital(hospital_id)
              AND crm.can_access_doctor(doctor_id)
              AND requested_by = crm.current_user_id());

DROP POLICY IF EXISTS removal_update ON crm.doctor_removal_requests;
CREATE POLICY removal_update ON crm.doctor_removal_requests FOR UPDATE
  USING (crm.in_my_hospital(hospital_id)
         AND (crm.is_growth_lead() OR requested_by = crm.current_user_id()))
  WITH CHECK (crm.in_my_hospital(hospital_id)
              AND (crm.is_growth_lead()
                   OR (requested_by = crm.current_user_id() AND status IN ('pending', 'cancelled'))));

CREATE OR REPLACE FUNCTION crm.assign_new_doctor(p_doctor_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = crm, public, pg_temp AS $$
DECLARE
  v_me uuid := crm.current_user_id();
  v_doctor crm.doctors%ROWTYPE;
BEGIN
  SELECT * INTO v_doctor FROM crm.doctors WHERE id = p_doctor_id;
  IF v_doctor.id IS NULL OR v_doctor.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'doctor not found';
  END IF;
  IF v_doctor.created_by IS DISTINCT FROM v_me OR v_doctor.created_at < now() - interval '10 minutes' THEN
    RAISE EXCEPTION 'only the person who just added a doctor can take it';
  END IF;
  IF NOT crm.in_my_hospital(v_doctor.hospital_id) THEN
    RAISE EXCEPTION 'doctor not in your hospital';
  END IF;
  IF EXISTS (SELECT 1 FROM crm.doctor_assignments
              WHERE doctor_id = p_doctor_id AND effective_to IS NULL) THEN
    RETURN;
  END IF;
  INSERT INTO crm.doctor_assignments
    (hospital_id, doctor_id, executive_id, manager_id, territory_id, assigned_by, reason)
  SELECT v_doctor.hospital_id, v_doctor.id, u.id, u.manager_id, v_doctor.territory_id, u.id,
         'Added by the rep'
    FROM crm.users u WHERE u.id = v_me;
END $$;

CREATE OR REPLACE FUNCTION crm.mobile_owner(p_mobile text, p_except uuid DEFAULT NULL)
RETURNS TABLE (doctor_id uuid, full_name text, visible boolean, owner_name text)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = crm, public, pg_temp AS $$
  SELECT CASE WHEN crm.can_access_doctor(d.id) THEN d.id END,
         CASE WHEN crm.can_access_doctor(d.id) THEN d.full_name END,
         crm.can_access_doctor(d.id),
         u.full_name
    FROM crm.doctors d
    LEFT JOIN crm.doctor_assignments a ON a.doctor_id = d.id AND a.effective_to IS NULL
    LEFT JOIN crm.users u ON u.id = a.executive_id
   WHERE d.deleted_at IS NULL
     AND d.mobile_e164 = crm.normalize_phone(p_mobile)
     AND crm.in_my_hospital(d.hospital_id)
     AND (p_except IS NULL OR d.id <> p_except)
   LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION crm.doctor_history(p_doctor_id uuid, p_limit int DEFAULT 20)
RETURNS TABLE (changed_at timestamptz, operation text, actor_name text,
               changed_fields text[], old_data jsonb, new_data jsonb)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = crm, public, pg_temp AS $$
  SELECT l.changed_at, l.operation, u.full_name, l.changed_fields, l.old_data, l.new_data
    FROM crm.audit_log l
    LEFT JOIN crm.users u ON u.id = l.actor_id
   WHERE l.table_name = 'doctors'
     AND l.record_id = p_doctor_id::text
     AND crm.in_my_hospital(l.hospital_id)
     AND crm.can_access_doctor(p_doctor_id)
   ORDER BY l.changed_at DESC, l.id DESC
   LIMIT least(greatest(p_limit, 1), 100);
$$;

GRANT EXECUTE ON FUNCTION crm.assign_new_doctor(uuid) TO crm_app;
GRANT EXECUTE ON FUNCTION crm.mobile_owner(text, uuid) TO crm_app;
GRANT EXECUTE ON FUNCTION crm.doctor_history(uuid, int) TO crm_app;
