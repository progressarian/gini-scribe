CREATE TABLE IF NOT EXISTS crm.days_off (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id   uuid NOT NULL REFERENCES crm.hospitals(id),
  kind          text NOT NULL CHECK (kind IN ('holiday', 'leave')),
  day           date NOT NULL CHECK (extract(isodow FROM day) <> 7),
  user_id       uuid REFERENCES crm.users(id),
  request_id    uuid NOT NULL,
  title         text CHECK (title IS NULL OR length(title) <= 60),
  note          text CHECK (note IS NULL OR length(note) <= 200),
  portion       text NOT NULL DEFAULT 'full' CHECK (portion IN ('full', 'half')),
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
  requested_by  uuid NOT NULL REFERENCES crm.users(id),
  decided_by    uuid REFERENCES crm.users(id),
  decided_at    timestamptz,
  decision_note text CHECK (decision_note IS NULL OR length(decision_note) <= 200),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz,
  CONSTRAINT days_off_kind_user CHECK ((kind = 'holiday') = (user_id IS NULL)),
  CONSTRAINT days_off_holiday_shape CHECK (kind = 'leave' OR (portion = 'full' AND title IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS days_off_one_holiday_uniq
  ON crm.days_off (hospital_id, day)
  WHERE kind = 'holiday' AND status = 'approved' AND deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS days_off_one_leave_uniq
  ON crm.days_off (user_id, day)
  WHERE kind = 'leave' AND status IN ('pending', 'approved') AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS days_off_hospital_day_idx ON crm.days_off (hospital_id, day);
CREATE INDEX IF NOT EXISTS days_off_user_day_idx ON crm.days_off (user_id, day);
CREATE INDEX IF NOT EXISTS days_off_request_idx ON crm.days_off (request_id);
CREATE INDEX IF NOT EXISTS days_off_status_idx ON crm.days_off (status, created_at DESC);

DROP TRIGGER IF EXISTS trg_days_off_updated ON crm.days_off;
CREATE TRIGGER trg_days_off_updated BEFORE UPDATE ON crm.days_off
  FOR EACH ROW EXECUTE FUNCTION crm.set_updated_at();
DROP TRIGGER IF EXISTS trg_days_off_no_delete ON crm.days_off;
CREATE TRIGGER trg_days_off_no_delete BEFORE DELETE ON crm.days_off
  FOR EACH ROW EXECUTE FUNCTION crm.block_hard_delete();
DROP TRIGGER IF EXISTS trg_days_off_audit ON crm.days_off;
CREATE TRIGGER trg_days_off_audit AFTER INSERT OR UPDATE OR DELETE ON crm.days_off
  FOR EACH ROW EXECUTE FUNCTION crm.audit_row();

ALTER TABLE crm.days_off ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm.days_off FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON crm.days_off TO crm_app;

DROP POLICY IF EXISTS days_off_read ON crm.days_off;
CREATE POLICY days_off_read ON crm.days_off FOR SELECT
  USING (crm.in_my_hospital(hospital_id)
         AND (kind = 'holiday'
              OR user_id = (SELECT crm.current_user_id())
              OR (SELECT crm.is_growth_lead())));

DROP POLICY IF EXISTS days_off_insert ON crm.days_off;
CREATE POLICY days_off_insert ON crm.days_off FOR INSERT
  WITH CHECK (crm.in_my_hospital(hospital_id)
              AND requested_by = (SELECT crm.current_user_id())
              AND ((SELECT crm.is_growth_lead())
                   OR (kind = 'leave'
                       AND user_id = (SELECT crm.current_user_id())
                       AND status = 'pending')));

DROP POLICY IF EXISTS days_off_update ON crm.days_off;
CREATE POLICY days_off_update ON crm.days_off FOR UPDATE
  USING (crm.in_my_hospital(hospital_id)
         AND ((SELECT crm.is_growth_lead())
              OR (kind = 'leave' AND user_id = (SELECT crm.current_user_id()) AND status = 'pending')))
  WITH CHECK (crm.in_my_hospital(hospital_id)
              AND ((SELECT crm.is_growth_lead())
                   OR (kind = 'leave' AND user_id = (SELECT crm.current_user_id())
                       AND status = 'cancelled')));
