-- MO / SD → "Chief Endocrinologist", display names only.
--
-- The role keys, status keys and capability names are untouched: `mo`, `sd`,
-- `sd_pending`, `with_sd`, `actor_role = 'mo_sd'` and GINIFLOW_STATION_MO are
-- identifiers in the event log, the permission matrix and the URL
-- /giniflow/station/mo. Renaming them would need every historic event rewritten
-- and would break auth, to change something nobody sees.
--
-- The consultant is deliberately NOT renamed. In `flow_step_catalog` only the
-- three steps assigned to `mo` move; `sd_consult` and `chief_consult` are the
-- consultant tiers above and keep their names.

UPDATE giniflow_sla_config
   SET label = 'Wait for Chief Endocrinologist',
       description = 'After vitals, before the Chief Endocrinologist sees the patient'
 WHERE station = 'wait_sd';

UPDATE giniflow_sla_config
   SET label = 'Chief Endocrinologist station'
 WHERE station = 'sd';

UPDATE giniflow_sla_config
   SET description = 'After the Chief Endocrinologist is ready, before the consultant sees'
 WHERE station = 'wait_doctor';

UPDATE flow_step_catalog SET name = 'Chief Endocrinologist Assessment'      WHERE id = 'mo_assessment';
UPDATE flow_step_catalog SET name = 'Prescription — Chief Endocrinologist to prepare' WHERE id = 'rx_ready';
UPDATE flow_step_catalog SET name = 'Chief Endocrinologist Reviews Reports' WHERE id = 'mo_review';

-- Journeys copy the catalogue name when they are planned, so the ones already
-- laid out for today would otherwise keep the old wording.
UPDATE giniflow_visit_steps s
   SET step_name = f.name
  FROM flow_step_catalog f
 WHERE f.id = s.step_catalog_id
   AND s.step_catalog_id IN ('mo_assessment', 'rx_ready', 'mo_review')
   AND s.step_name <> f.name;
