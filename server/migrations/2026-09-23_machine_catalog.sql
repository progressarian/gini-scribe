-- ============================================================
-- Machines live in the step catalogue, not in code.
-- 2026-09-23 · docs/gini-flow/41-MACHINE-CATALOG-PLAN.md
--
-- Until now the six machines were a literal in shared/machineStages.js, so
-- adding 2D Echo took a code change and a deploy before a patient's Echo could
-- appear anywhere. Each machine already has a flow_step_catalog row whose id is
-- the machine id; these columns hold what the literal held.
--
-- The backfill copies the literal exactly, so the Machine Room behaves the same
-- the moment the code reading it ships.
--
--   node migrations/_runOne.mjs migrations/2026-09-23_machine_catalog.sql
-- ============================================================

ALTER TABLE flow_step_catalog
  ADD COLUMN IF NOT EXISTS machine            BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS machine_order      INT,
  ADD COLUMN IF NOT EXISTS machine_short_name TEXT,
  ADD COLUMN IF NOT EXISTS machine_full_name  TEXT,
  ADD COLUMN IF NOT EXISTS machine_icon       TEXT,
  ADD COLUMN IF NOT EXISTS order_test_name    TEXT,
  ADD COLUMN IF NOT EXISTS bill_names         TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS value_fields       TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS report_doc_types   TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS hands_over         BOOLEAN NOT NULL DEFAULT FALSE;

UPDATE flow_step_catalog c
   SET machine            = TRUE,
       machine_order      = m.machine_order,
       machine_short_name = m.short_name,
       machine_full_name  = m.full_name,
       machine_icon       = m.icon,
       order_test_name    = m.order_test_name,
       bill_names         = m.bill_names,
       value_fields       = m.value_fields,
       report_doc_types   = m.report_doc_types,
       hands_over         = m.hands_over
  FROM (VALUES
    ('abi',    1, 'ABI',     'Ankle–Brachial Index',           '🦵', 'ABI',
       ARRAY['ABI'],                                 ARRAY['ABI Right', 'ABI Left'],
       ARRAY['abi'],  FALSE),
    ('vpt',    2, 'VPT',     'Vibration Perception Threshold', '🦶', 'VPT',
       ARRAY['VPT'],                                 ARRAY['VPT Right', 'VPT Left'],
       ARRAY['vpt'],  FALSE),
    ('fundus', 3, 'Fundus',  'Fundus photography',             '👁️', 'Fundus',
       ARRAY['Fundus'],                              ARRAY['Fundus Right Eye', 'Fundus Left Eye'],
       ARRAY['eye'],  FALSE),
    ('tmt',    4, 'TMT',     'Treadmill test',                 '🏃', 'TMT',
       ARRAY['TMT'],                                 ARRAY['TMT Result', 'METs Achieved', 'Max Heart Rate', 'Exercise Duration'],
       ARRAY['tmt'],  FALSE),
    ('ecg',    5, 'ECG',     'Electrocardiogram',              '💓', 'ECG',
       ARRAY['ECG'],                                 ARRAY['ECG Finding'],
       ARRAY['ecg'],  TRUE),
    ('echo',   6, '2D Echo', '2D Echocardiogram',              '🫀', '2D Echo',
       ARRAY['2D Echo', 'Echo', 'Echocardiography'], ARRAY['Ejection Fraction', 'Echo Finding'],
       ARRAY['echo'], FALSE)
  ) AS m(id, machine_order, short_name, full_name, icon, order_test_name,
         bill_names, value_fields, report_doc_types, hands_over)
 WHERE c.id = m.id;
