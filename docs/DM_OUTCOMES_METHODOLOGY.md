# Gini diabetes outcomes: methodology

This document explains how every figure on the diabetes outcomes scorecard is calculated. Every rule below was fixed before the results were looked at.

- **Engine:** `server/services/analytics/dmOutcomes.js`
- **Build:** `node server/scripts/build-dm-outcomes.mjs [--start=2021-11-14] [--end=2026-10-31] [--out=reports/dm-outcomes/<date>] [--audit=10]`
  - Opens one READ ONLY transaction on the Scribe database, writes no data, and finishes in about 30 seconds.
  - Writes `dm-outcomes.json` (all aggregates) and `scorecard.html`.
  - `--from-json=<file>` re-renders the page without touching the database.
- **Spot check:** `node server/scripts/verify-dm-outcomes-sample.mjs <audit-sample.local.json>`
  - Re-derives each sampled patient's baseline and follow-up from the raw `lab_results` rows, using separate code.
  - The check applies the same cleaning rules in separately written code. 2026-11-11: 20 of 20 matched.

Output is aggregate only. No name, phone or UHID is written to the report. `audit-sample.local.json` holds internal patient ids for verification and must not be shared. `reports/` is git-ignored.

## 1. Reporting period

- Requested period: 14 Nov 2021 to 31 Oct 2026.
- Scribe's clinical records start in practice in January 2022. Only 4 diabetes patients have a visit in Nov–Dec 2021.
- Present the period as "records from 2022 to October 2026".
- "First visit" means the first visit recorded in Scribe. For long-standing patients this is not their first visit to Gini.

## 2. Registry (who is a diabetes patient)

A person is in the registry when both of these hold:

1. **Diabetes:** either condition counts.
   - An active diabetes diagnosis: Type 2, Type 1, LADA, early-onset T2, MODY, type 3c / pancreatogenic, or NADM.
   - Or two HbA1c readings of 6.5% or more on different dates. The two readings must differ in value, or at least one must come from a lab source, so a single result copied into later notes cannot qualify a patient.
   - Gestational diabetes and prediabetes are excluded.
2. **A visit in the period:** at least one consultation, or an attended appointment (status seen, completed or checked-in).

Patients with a single visit are included.

**Duplicates:** patient records with the same name and date of birth are merged into one person, using the lowest record id. Their visits and readings are pooled. HealthRay identity (`health_id`) is already one record per person.

**Diabetes type** comes from the diagnosis slug: Type 2 / Type 1 or LADA / Other specified / Unspecified. Unspecified covers generic "diabetes" and lab-defined patients.

**Diabetes confirmation:**

- Each patient is classified as one of:
  - on a diabetes medicine (biguanide, SU, DPP-4i, SGLT2i, GLP-1/GIP, insulin, TZD or AGI);
  - confirmed by an HbA1c of 6.5% or more;
  - unconfirmed, i.e. a diabetes diagnosis without either.
- 2026-11-11: 94.0% / 1.8% / 4.2%.
- Leaving out the unconfirmed patients changes no headline figure by more than 0.1 (in points or percentage points).

**New to Gini (2025–26):**

- The patient has an attended appointment of type "New Patient", and no recorded Gini visit more than 30 days before it.
- 30 days are allowed because a consultation for the same first visit is often recorded a few days before the appointment.
- Appointment types exist only from January 2025.
- In January–February 2025, many returning patients were labelled "New" when the appointment system started. The 30-day rule removes them.
- 2026-11-11: 4,177 patients.

## 3. Measurements and cleaning

- **Sources:**
  - `lab_results`: HbA1c, LDL, eGFR, UACR, plus BP, weight and BMI where they were entered as labs.
  - `vitals`: BP, weight, BMI.
- **Plausible ranges:** values outside these are discarded.

  | Marker | Range |
  |---|---|
  | HbA1c | 3–20% |
  | LDL | 10–400 |
  | SBP | 70–260 |
  | DBP | 40–160 |
  | Weight | 25–300 kg |
  | BMI | 10–80 |
  | eGFR | 1–200 |
  | UACR | 0–5000 |

- **Year-only dates:** HbA1c values dated 1 January are discarded. They are placeholders for a reading where only the year was known.
- **Repeat copies:** a value transcribed from clinical notes is dropped if the same patient already had the identical value on an earlier date. Clinical notes repeat old results at later visits. Notes-based sources are HealthRay notes, parsed prescriptions, Scribe and OPD entries. Lab sources are never dropped this way.
- **Carried-forward vitals:** weight and BMI vitals that repeat the previous recorded value exactly are dropped.
- **One value per day:** if a lab-confirmed value exists that day, it wins (the highest if there are several). Otherwise the highest value that day is used.
- **Lab-confirmed sources (sensitivity analysis):**
  - `lab_healthray`, `lab`, `report_extract`
  - `import`, `vendor_import`, `vendor_import_2`, `vendor_import_3`
  - `baseline_table`, `vitals_sheet`

## 4. Time windows

- **Index date:** the first visit in the period.
- **Baseline:** the reading closest to the index date, from 180 days before to 14 days after. A tie goes to the earlier reading.
- **Follow-up:** the reading closest to the target day within each window. A tie goes to the later reading.

  | Window | Days after index | Target |
  |---|---|---|
  | 3 months | 60–150 | 90 |
  | 6 months | 151–270 | 180 |
  | 12 months | 271–450 | 365 |
  | 24 months | 630–810 | 730 |
  | 36 months | 990–1,170 | 1,095 |

- **Eligible for a window:** index date + the window's last day falls on or before 31 Oct 2026. Patients who are not yet eligible are "too recent". They are never counted as missing.
- **Measured:** the patient has a baseline and a reading inside the window.
- **Missing:** eligible with a baseline, but no reading in the window. Missing outcomes are never counted as success or failure. They are reported as missing.
- Each window is a separate analysis. Patients with 2 months and 2 years of follow-up are never mixed in one percentage.
- The highest-ever versus lowest-ever reading is not used anywhere.

## 5. HbA1c outcome measures (per window, among measured pairs)

| Measure | Definition |
|---|---|
| Paired change | Follow-up − baseline, in percentage points. Mean and median. Negative = lower HbA1c. |
| Any improvement | Change < 0 |
| Improved ≥0.5 / ≥1.0 | Change ≤ −0.5 / ≤ −1.0 |
| Worsened ≥0.5 | Change ≥ +0.5 |
| Reached <7% | Follow-up < 7. Denominator: baseline ≥ 7. |
| Stayed <7% | Follow-up < 7. Denominator: baseline < 7. |

- **Severity bands (baseline):** <7, 7.0–7.9, 8.0–8.9, 9.0–9.9, ≥10.
- Every percentage carries its numerator and denominator.

## 6. Other markers

- **Markers:** weight, BMI, SBP, DBP, LDL, eGFR, UACR.
- **Method:** the same baseline and window rules, at 6, 12 and 24 months.
- **Reported:** mean and median paired change.
- **UACR:** this distribution is highly skewed, so quote the median.

## 7. Latest combined control

- **Values used:** each person's latest HbA1c, BP and LDL in the 12 months before their last visit. For BP, systolic and diastolic come from the same day.
- **Targets:**
  - HbA1c < 7%.
  - BP < 140/90 is the headline target on the scorecard (common in India); < 130/80 (stricter ADA) is shown beside it. All target cards use the same group: patients with HbA1c, BP and LDL all measured.
  - LDL < 100 mg/dL, with < 70 also shown.
- **Denominator:** patients with all three measured.
- Also shown: each target on its own, and the same analysis for patients seen in the last 6 months.

## 8. Treatment cohorts

- **How drugs are classified:** drug names are normalised by `drugNormalizer.js`. Brands and misspellings map to molecules.
- **Cohorts:**
  - GLP-1 receptor agonists (excluding tirzepatide).
  - Tirzepatide.
  - Any GLP-1/tirzepatide.
  - Weekly insulin (icodec: Awiqli and its spellings).
  - Daily insulin.
- **Index date:** the first prescription date: the start date, else the last-prescribed date, else the record date.
- **Outcomes:** HbA1c and weight, using the same baseline and window rules measured from the drug's index date.
- **Two treatment views:**
  - *Started at Gini* (preferred): the first prescription is at least 30 days after the patient's first recorded visit, so the patient was observed before and after starting.
  - *All prescribed*: includes patients already on the drug when they joined. Their "start" coincides with joining the clinic, which mixes the drug with everything else that changed at that point. For example, any GLP-1 at 6 months: −0.99 for all prescribed against −0.56 for started at Gini.
- **Weekly insulin:** first prescribed in July 2026, so only the cohort size and baseline are reported. No patient has reached 3 months of follow-up.
- These are descriptive changes in patients who received a drug. There is no control group, so they are not drug effects.

## 8a. Kidney, combined control over time, complications

- **Kidney:**
  - UACR stage: A1 <30, A2 30–300, A3 >300 mg/g. Reported as moved to a better or worse stage, and as a fall of 30% or more among patients with baseline UACR of 30 or above.
  - eGFR: median change, and a fall of 30% or more.
  - Both at 12 and 24 months.
- **Combined control over time:** patients with HbA1c, BP (systolic and diastolic on the same day) and LDL at both baseline and follow-up. The share at all three targets is shown at each time point, at 6 and 12 months.
- **Complications:** the share of the registry with a recorded active diagnosis. Microvascular: kidney, nerve, eye. Macrovascular: CAD, stroke, PVD. Diabetic foot is shown separately.

## 9. Engagement and retention

- **Status on 31 Oct 2026:**
  - Active: last visit within 180 days.
  - Overdue: 181–365 days.
  - Long gap: more than 365 days.
- **Deaths and transfers:** Scribe has no field for them. They are reported as "not recorded" and are never inferred from absence.
- **Retention at 3, 6, 12 and 24 months:** any visit inside that window. Grouped by year of first visit, among patients eligible for the window.
- **Long-gap patients:** their last known HbA1c is reported as historical. It is never counted as a current outcome.

## 10. Bias and completeness checks reported

- **Funnel:** eligible, with baseline, and measured for every window.
- **Completeness by enrollment year:** the April 2024 – February 2025 recording gap lowers completeness for patients who enrolled in 2023–2024.
- **Baseline comparison of patients with and without outcome data:** age, sex, baseline HbA1c, visit count and type. The 12- and 6-month windows are compared.
- **Lab-confirmed-only sensitivity analysis:** run alongside the headline analysis.
- **Associations, not causes:** all results are descriptive associations in routine care. Patients who return and get tested differ from those who don't. Falls in HbA1c among high-baseline patients partly reflect regression to the mean.

## 11. Known data limitations

1. The records effectively start in January 2022, not November 2021.
2. Apr 2024 – Feb 2025: about 70% fewer consultations and far fewer HbA1c values were recorded. This is a recording gap.
3. About two-thirds of HbA1c values (about 18,000 of 26,500) were transcribed from clinical notes or prescriptions rather than lab feeds. Repeat copies were removed, and the lab-only sensitivity analysis is shown.
4. The diagnoses table was populated from February 2026 by backfilling from notes. Complications are recorded diagnoses, not screening results.
5. There is no death or transfer data, and no meaningful CGM data (about 12 patients).
6. Medication start dates entered retrospectively may be later than the true start.

## 11a. Confidence intervals

- **Mean paired change:** mean ± 1.96 × SD / √n.
- **Percentages:** Wilson 95% interval.
- They show sampling precision only. They do not account for missing data or selection.

## 11b. Snapshot

- Scribe is live, so each rebuild changes the counts slightly; for example the registry went from 11,968 to 11,969 between runs on 11 Nov 2026.
- Public figures must come from one frozen build: `reports/dm-outcomes/2026-11-11/`.
- Don't rebuild into that folder after sign-off.

## 12. Outputs

| File | Contents | Sharing |
|---|---|---|
| `scorecard.html` | Aggregate press scorecard | For clinical review, then public figures |
| `outcomes.xlsx` | 16 sheets, every figure with numerator, denominator and % | Aggregate |
| `dashboard.html` | 5 tabs with filters: first-visit year, age, sex, baseline HbA1c, treatment, diabetes type, follow-up status | **Internal only** |
| `dm-outcomes.json` | All aggregates | Aggregate |
| `*.local.json` | Row and verification files | Never share |

About the dashboard:

- It embeds de-identified rows so the filters can recompute in the browser. The rows have no names, ids or dates, values are rounded, and the order is shuffled.
- It hides any figure based on fewer than 10 patients.
- Its unfiltered figures were checked against the engine (about 180 values): all match.

Paired changes are rounded to 2 decimals before they are compared with the ±0.5 and 1.0 thresholds. Otherwise floating-point error would leave out a change of exactly 0.5 (for example 8.1 → 7.6).

## 13. Sign-off

Dr Bhansali and the clinical team must review every public figure before release.
