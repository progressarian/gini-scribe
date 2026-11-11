# Proposed revision: who counts as a diabetes patient

**Status: proposed, awaiting clinical review.** The press report (snapshot of 11 November 2026) keeps the
current, verified figure of **11,969** until this revision is approved.

## Why

The current rule misses diabetic patients whose diabetes is written in a different way. Checked read-only on
11 November 2026, among patients seen between 14 November 2021 and 31 October 2026:

| Change | Extra patients | Total |
|---|---|---|
| Current rule (verified) | — | 11,969 |
| A. Other diabetes diagnosis names (`type_3c_diabetes`, `secondary_diabetes`, `early_onset_diabetes`, `pancreatogenic_diabetes`, `flatbush_diabetes`, `type_2_dm_mody`, `diabetes_(type_2)`, `gdm_to_type_2_dm`, …) | +63 | 12,032 |
| B. A diabetic complication is recorded (neuropathy, nephropathy, retinopathy, foot ulcer, ketoacidosis, …) | +34 | 12,066 |
| D. HealthRay's or the OPD diagnosis list on an appointment says diabetes | +54 | 12,153 overall with C |
| **Proposed: A + B + D** | **+162** | **12,131** |

Not included, because they are less certain:
- C: a diabetes diagnosis marked inactive only (+33).
- E: diabetes-only medicine without any written diagnosis (+194). Insulin can also be for pregnancy or steroid-induced high sugar.
- A note that only mentions diabetes in free text (may say "no diabetes" or "family history").
- One high HbA1c.

Still excluded: prediabetes, gestational diabetes only, diabetes insipidus, euglycaemia, "non-diabetic", hypoglycaemia, and rule-out or family-history entries.

Notes reading failures: none. Every note was read, so this is not a cause.

## Proposed query (gives 12,131; read-only, about 6 seconds)

```sql
WITH diabetes_diagnosis AS (
  SELECT DISTINCT patient_id
  FROM diagnoses
  WHERE is_active
    AND (
      diagnosis_id ~ '^(type_?[12]_?(diabetes(_mellitus)?|dm)|dm[12]|t[12]dm|diabetes(_mellitus)?|lada|early_onset_(type_2_dm|t2dm|type_2_diabetes_mellitus)|young_type_2_dm|type_1b_dm|mody|type_3c_dm|pancreatogenous_diabetes(_type_3c)?|nadm)$'
      OR (
        diagnosis_id ~* '(diabet|(^|_)dm(_|$)|t[12]dm|dm[12]|lada|mody|flatbush)'
        AND diagnosis_id !~* '(pre_?diab|pre_dm|prediabet|insipidus|eu?glyc|non_?diabet|no_?diabet|hypoglyc|under_evaluation|r/o|rule_?out|family|fh_|risk)'
        AND diagnosis_id !~* '^(gdm|early_gdm|gestational_diabetes(_mellitus)?)$'
      )
    )
),
healthray_diagnosis_list AS (
  SELECT DISTINCT a.patient_id
  FROM appointments a,
       LATERAL (VALUES (a.healthray_diagnoses), (a.opd_diagnoses)) v(list),
       LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(v.list) = 'array' THEN v.list ELSE '[]'::jsonb END) d(item)
  WHERE d.item->>'name' ~* '(diabet|\mt2dm\M|\mt1dm\M|\mdm\M|\mlada\M|\mmody\M)'
    AND d.item->>'name' !~* '(pre[ -]?diab|insipidus|gestational|\mgdm\M|non[ -]?diab|euglyc)'
),
two_high_hba1c AS (
  SELECT patient_id
  FROM lab_results
  WHERE canonical_name = 'HbA1c'
    AND result BETWEEN 6.5 AND 20
    AND test_date <= '2026-10-31'
    AND to_char(test_date, 'MM-DD') <> '01-01'
  GROUP BY patient_id
  HAVING COUNT(DISTINCT test_date) >= 2
     AND (COUNT(DISTINCT result) >= 2
          OR bool_or(source IN ('lab_healthray','lab','report_extract','import','vendor_import',
                                'vendor_import_2','vendor_import_3','baseline_table','vitals_sheet')))
),
has_diabetes AS (
  SELECT patient_id FROM diabetes_diagnosis
  UNION SELECT patient_id FROM healthray_diagnosis_list
  UNION SELECT patient_id FROM two_high_hba1c
),
visited AS (
  SELECT patient_id FROM consultations
  WHERE visit_date BETWEEN '2021-11-14' AND '2026-10-31'
  UNION
  SELECT patient_id FROM appointments
  WHERE status IN ('seen','completed','checkedin')
    AND appointment_date BETWEEN '2021-11-14' AND '2026-10-31'
)
SELECT COUNT(DISTINCT
         CASE WHEN p.dob IS NOT NULL
              THEN lower(trim(p.name)) || '|' || p.dob
              ELSE 'id:' || p.id END) AS diabetes_patients
FROM patients p
JOIN has_diabetes d ON d.patient_id = p.id
JOIN visited v      ON v.patient_id = p.id;
```

## If approved

1. Put the same rule into `server/services/analytics/dmOutcomes.js` (registry) and `server/scripts/count-all-patients.mjs`.
2. Rebuild the report into a new folder (the 11 November press snapshot stays frozen), re-run the independent recount, and get clinical sign-off.
3. Combine with the HealthRay backfill (`docs/HEALTHRAY_BACKFILL_PLAN.md`). The missing 2024 visits and older patients are the bigger reason the count is lower than expected.
