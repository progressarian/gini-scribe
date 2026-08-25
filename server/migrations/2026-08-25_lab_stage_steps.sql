-- Lab turnaround as timed stages: collection stays the patient-facing step;
-- delivery, processing and reporting become background steps that run in
-- parallel while the patient waits for their consultation.
--
-- Background steps are deliberately NOT ordinary flow steps. They must be
-- excluded from stationBusy (or the lab tech is "busy" for the whole processing
-- window), from the one-patient-one-place guard (or processing locks the patient
-- out of their consultation), from recalcEstimate (or the visit budget inflates
-- past its target), from deriveStage / total_steps, and from the public patient
-- tracker. Those exclusions land in the next change — the rows below are created
-- INACTIVE and with no template wiring, so this migration cannot alter a live
-- journey on its own.

BEGIN;

ALTER TABLE flow_step_catalog
  ADD COLUMN IF NOT EXISTS is_background BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS parent_step_catalog_id TEXT REFERENCES flow_step_catalog(id);

-- Copied onto the visit's own step at creation, so a later catalog edit never
-- retro-changes how an old visit behaved.
ALTER TABLE flow_visit_steps
  ADD COLUMN IF NOT EXISTS is_background BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_fvs_background
  ON flow_visit_steps (visit_id) WHERE is_background;

-- Three stages per test type. Durations are per test: bloods take longest to
-- process, ABI and X-Ray are read on site.
INSERT INTO flow_step_catalog
  (id, name, default_duration_min, station, assigned_role, display_order, is_active,
   is_background, parent_step_catalog_id)
VALUES
  ('blood_deliver', 'Blood — delivered to lab',   10, 'Lab', 'lab_transport', 30, FALSE, TRUE, 'blood_sample'),
  ('blood_process', 'Blood — lab processing',     45, 'Lab', 'lab_tech',      31, FALSE, TRUE, 'blood_sample'),
  ('blood_report',  'Blood — reports available',  15, 'Lab', 'lab_tech',      32, FALSE, TRUE, 'blood_sample'),
  ('abi_deliver',   'ABI — sent for reading',      5, 'Lab', 'lab_transport', 33, FALSE, TRUE, 'abi'),
  ('abi_process',   'ABI — processing',           15, 'Lab', 'lab_tech',      34, FALSE, TRUE, 'abi'),
  ('abi_report',    'ABI — report available',     10, 'Lab', 'lab_tech',      35, FALSE, TRUE, 'abi'),
  ('xray_deliver',  'X-Ray — sent for reading',    5, 'Lab', 'lab_transport', 36, FALSE, TRUE, 'x_ray'),
  ('xray_process',  'X-Ray — processing',         20, 'Lab', 'lab_tech',      37, FALSE, TRUE, 'x_ray'),
  ('xray_report',   'X-Ray — report available',   15, 'Lab', 'lab_tech',      38, FALSE, TRUE, 'x_ray')
ON CONFLICT (id) DO NOTHING;

COMMIT;
