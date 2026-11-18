ALTER TABLE clinic_holidays ADD COLUMN IF NOT EXISTS created_by_id INTEGER REFERENCES doctors(id);

INSERT INTO clinic_holidays (holiday_date, remarks, created_by)
SELECT DISTINCT ON (o.day) o.day, o.title, COALESCE(u.full_name, 'CRM')
  FROM crm.days_off o
  LEFT JOIN crm.users u ON u.id = o.requested_by
 WHERE o.kind = 'holiday' AND o.status = 'approved' AND o.deleted_at IS NULL
 ORDER BY o.day, o.created_at
ON CONFLICT (holiday_date) DO NOTHING;

CREATE TABLE IF NOT EXISTS clinic_holiday_audit (
  id             BIGSERIAL PRIMARY KEY,
  holiday_date   DATE NOT NULL,
  action         TEXT NOT NULL CHECK (action IN ('added', 'renamed', 'removed')),
  title          TEXT,
  previous_title TEXT,
  actor_id       INTEGER,
  actor_name     TEXT,
  at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS clinic_holiday_audit_day_idx ON clinic_holiday_audit (holiday_date, at DESC);

CREATE OR REPLACE FUNCTION clinic_holiday_audit_append_only()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  RAISE EXCEPTION 'clinic_holiday_audit is append-only: rows cannot be changed or deleted'
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE OR REPLACE TRIGGER clinic_holiday_audit_append_only
  BEFORE UPDATE OR DELETE ON clinic_holiday_audit
  FOR EACH ROW EXECUTE FUNCTION clinic_holiday_audit_append_only();

CREATE OR REPLACE FUNCTION clinic_holiday_audit_row()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  INSERT INTO clinic_holiday_audit (holiday_date, action, title, previous_title, actor_id, actor_name)
  VALUES (
    CASE WHEN TG_OP = 'DELETE' THEN OLD.holiday_date ELSE NEW.holiday_date END,
    CASE TG_OP WHEN 'INSERT' THEN 'added' WHEN 'UPDATE' THEN 'renamed' ELSE 'removed' END,
    CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE NEW.remarks END,
    CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE OLD.remarks END,
    NULLIF(current_setting('app.actor_id', true), '')::integer,
    NULLIF(current_setting('app.actor_name', true), '')
  );
  RETURN NULL;
END;
$$;

CREATE OR REPLACE TRIGGER clinic_holiday_audit_insert_delete
  AFTER INSERT OR DELETE ON clinic_holidays
  FOR EACH ROW EXECUTE FUNCTION clinic_holiday_audit_row();

CREATE OR REPLACE TRIGGER clinic_holiday_audit_rename
  AFTER UPDATE OF remarks ON clinic_holidays
  FOR EACH ROW WHEN (OLD.remarks IS DISTINCT FROM NEW.remarks)
  EXECUTE FUNCTION clinic_holiday_audit_row();

ALTER TABLE clinic_holiday_audit ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION crm.clinic_holiday_days(p_from date, p_to date)
RETURNS TABLE (day date, title text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT h.holiday_date, COALESCE(NULLIF(btrim(h.remarks), ''), 'Clinic holiday')
    FROM public.clinic_holidays h
   WHERE h.holiday_date BETWEEN p_from AND p_to
     AND extract(isodow FROM h.holiday_date) <> 7
   ORDER BY h.holiday_date
$$;

COMMENT ON FUNCTION crm.clinic_holiday_days(date, date) IS
  'The clinic holiday calendar (Settings, Slot settings) for the CRM. Returns only dates and '
  'names, so crm_app needs no privilege on public.clinic_holidays.';

REVOKE ALL ON FUNCTION crm.clinic_holiday_days(date, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crm.clinic_holiday_days(date, date) TO crm_app;
