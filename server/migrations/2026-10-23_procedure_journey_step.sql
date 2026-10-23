BEGIN;

INSERT INTO flow_step_catalog (id, name, default_duration_min, station, assigned_role)
VALUES ('procedure', 'Procedure', 10, 'Reception', 'reception')
ON CONFLICT (id) DO NOTHING;

COMMIT;
