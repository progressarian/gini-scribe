CREATE TABLE IF NOT EXISTS billing_mis_columns (
  key            TEXT PRIMARY KEY CHECK (key ~ '^[a-z][a-z0-9_]{1,39}$'),
  label          TEXT NOT NULL CHECK (btrim(label) <> '' AND length(label) <= 60),
  kind           TEXT NOT NULL CHECK (kind IN ('consultation', 'test', 'other')),
  sort_order     INT NOT NULL DEFAULT 0,
  item_kinds     TEXT[] NOT NULL DEFAULT '{}',
  group_codes    TEXT[] NOT NULL DEFAULT '{}',
  subgroup_codes TEXT[] NOT NULL DEFAULT '{}',
  item_ids       INT[] NOT NULL DEFAULT '{}',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by     INT REFERENCES doctors(id) ON DELETE SET NULL,
  CONSTRAINT billing_mis_columns_item_kinds_check
    CHECK (item_kinds <@ ARRAY['consultation', 'test', 'procedure', 'medicine', 'other']::text[])
);

ALTER TABLE billing_mis_columns ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_mis_columns FORCE ROW LEVEL SECURITY;
REVOKE ALL ON billing_mis_columns FROM anon, authenticated;

INSERT INTO billing_mis_columns (key, label, kind, sort_order, item_kinds, group_codes, subgroup_codes, item_ids)
VALUES
  ('consultation', 'Consultation charges', 'consultation', 10, ARRAY['consultation'], '{}', '{}', '{}'),
  ('addn_consultation', 'Addn Consultation Fee', 'consultation', 20, '{}', '{}', '{}', '{}'),
  ('blood_tests', 'Blood Tests Charges', 'test', 30, '{}',
     ARRAY(SELECT lower(code) FROM service_groups WHERE name ILIKE '%patholog%' ORDER BY id), '{}', '{}'),
  ('x_ray', 'X-Ray Charges', 'test', 40, '{}',
     ARRAY(SELECT lower(code) FROM service_groups WHERE name ILIKE '%radiolog%' ORDER BY id), '{}', '{}'),
  ('abi', 'ABI Charges', 'test', 50, '{}', '{}', '{}',
     ARRAY(SELECT id FROM service_items WHERE name ~* '\mABI\M' AND name !~ '/' ORDER BY id)),
  ('vpt', 'VPT Charges', 'test', 60, '{}', '{}', '{}',
     ARRAY(SELECT id FROM service_items WHERE name ~* '\mVPT\M' AND name !~ '/' ORDER BY id)),
  ('fundus', 'Fundus Charges', 'test', 70, '{}', '{}', '{}',
     ARRAY(SELECT id FROM service_items WHERE name ~* '\mFUNDUS\M' AND name !~ '/' ORDER BY id)),
  ('ecg', 'ECG Charges', 'test', 80, '{}', '{}', '{}',
     ARRAY(SELECT id FROM service_items WHERE name ~* '\mECG\M' AND name !~ '/' ORDER BY id)),
  ('echo', 'ECHO Charges', 'test', 90, '{}',
     ARRAY(SELECT lower(code) FROM service_groups WHERE name ILIKE '%echo%' OR code ILIKE 'echo' ORDER BY id),
     '{}', '{}')
ON CONFLICT (key) DO NOTHING;
