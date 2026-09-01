-- The one-line gloss under each test chip, from gini-doctor-final.html s-tests
-- ("UACR / Albumin ratio", "Vit B12 / Metformin depletes"). Plan 08 section 2.6.
-- It is why an MO picks a test, so it belongs beside the name, not in a tooltip.
ALTER TABLE giniflow_test_catalog ADD COLUMN IF NOT EXISTS gloss TEXT;

UPDATE giniflow_test_catalog c SET gloss = g.gloss
  FROM (VALUES
    ('HbA1c',             'Glycated Hb'),
    ('FBS',               'Fasting glucose'),
    ('Post-meal',         'Post-prandial glucose'),
    ('HOMA-IR',           'Insulin resistance'),
    ('Fasting Insulin',   'With FBS for HOMA-IR'),
    ('Lipid panel',       'LDL · HDL · TG'),
    ('Total cholesterol', 'Lipids'),
    ('LDL',               'Target <100'),
    ('HDL',               'Protective'),
    ('TG',                'Triglycerides'),
    ('Creatinine',        'Kidney'),
    ('eGFR',              'Kidney function'),
    ('KFT',               'Full kidney panel'),
    ('UACR',              'Albumin ratio'),
    ('Urine R/M',         'Routine · microscopy'),
    ('TSH',               'Thyroid — fatigue'),
    ('FT3',               'Thyroid'),
    ('FT4',               'Thyroid'),
    ('LFT',               'Liver function'),
    ('CBC',               'Blood count'),
    ('Vit D',             'Deficiency common'),
    ('Vit B12',           'Metformin depletes'),
    ('ECG',               'Cardiac rhythm'),
    ('NT-proBNP',         'Heart failure'),
    ('hs-CRP',            'Inflammation')
  ) AS g(test_name, gloss)
 WHERE c.test_name = g.test_name;

-- "Vitamin D" and "Vit D" are the same test under two names. No panel and no
-- order uses "Vitamin D", and two names for one test is two charges waiting to
-- happen — the duplicate guard keys on the name.
UPDATE giniflow_test_catalog SET is_active = FALSE
 WHERE test_name = 'Vitamin D'
   AND EXISTS (SELECT 1 FROM giniflow_test_catalog WHERE test_name = 'Vit D' AND is_active);
