ALTER TABLE crm.tasks
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'manual' CHECK (kind IN ('manual', 'follow_up_visit', 'promise')), -- manual | follow_up_visit | promise
  ADD COLUMN IF NOT EXISTS cancel_reason text,
  ADD COLUMN IF NOT EXISTS closed_by_visit_id uuid REFERENCES crm.visits(id);

CREATE UNIQUE INDEX IF NOT EXISTS tasks_one_open_follow_up_uniq
  ON crm.tasks (owner_id, doctor_id)
  WHERE kind = 'follow_up_visit' AND status IN ('open', 'in_progress') AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS tasks_owner_kind_idx
  ON crm.tasks (owner_id, kind, status, due_date) WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS tasks_visit_idx
  ON crm.tasks (visit_id) WHERE visit_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS tasks_closed_by_visit_idx
  ON crm.tasks (closed_by_visit_id) WHERE closed_by_visit_id IS NOT NULL;

CREATE OR REPLACE FUNCTION crm.staff_name(p_user_id uuid)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = crm, public, pg_temp AS $$
  SELECT u.full_name
    FROM crm.users u
   WHERE u.id = p_user_id
     AND EXISTS (SELECT 1 FROM crm.user_hospitals m
                  WHERE m.user_id = u.id AND m.hospital_id = ANY (crm.current_hospital_ids()));
$$;

GRANT EXECUTE ON FUNCTION crm.staff_name(uuid) TO crm_app;
