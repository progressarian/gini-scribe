# Five-year diabetes outcomes: plan

The goal is a credible, reproducible picture of Gini's real-world diabetes outcomes. It does not aim for the best-looking number.

Deliverables:

- An aggregate scorecard (press numbers).
- A 5-tab dashboard (static HTML, de-identified, with filters).
- A methodology document.
- An Excel workbook holding every numerator and denominator.

## 1. What the production data actually contains (read-only check, 2026-11-11)

| Item | Finding | Consequence |
|---|---|---|
| Clinical start | Consultations: 4 in 2021, then 8,655 in 2022. Vitals and HbA1c also start in 2022. | The real data start is **January 2022**, not 14 Nov 2021. Say "2022–Oct 2026, ~4 years 10 months". |
| 2024 gap | Consultations fall from ~2,200/month (Jan–Mar 2024) to ~650/month (Apr 2024–Feb 2025), then return to 4,219 in Mar 2025. HbA1c falls to 50–100/month in the same period. | This is a **recording/import gap**, not fewer patients. 12- and 24-month windows that fall in this gap will look like "missing" outcomes. Disclose it, and show completeness by enrollment year. |
| Diabetes patients | 12,128 patients have an active diabetes diagnosis (T2DM 11,407, T1DM ~530, LADA 93, MODY, 3c, early-onset). Another 436 have HbA1c ≥6.5 but no diagnosis. | The registry is defined from diagnoses, with lab-defined patients as an option (decision D2). GDM and prediabetes are excluded. |
| Diagnosis capture | The `diagnoses` table was populated from 2026-02-15 (backfilled from notes). It is a snapshot with no diagnosis date. | Diabetes type is usable. Complication prevalence is "recorded", not screened. |
| HbA1c sources | 26,500 readings. 9,227 are parsed from prescription text; only 48% of those carry the visit date, the rest a date written in the note. Other sources: HealthRay notes 8,932 (repeat copies of old values), lab feeds and imports ~9,000. 236 readings sit on a "1 January" date (year-only placeholder). | Values that are copies are dropped (an existing rule). Readings on 1 January are excluded. A lab-confirmed-only result is run as a sensitivity check (D3). |
| With any HbA1c | 9,370 of 12,128 (2021-11-14 → 2026-10-31). 5,338 have ≥2 dated HbA1c. | Press numbers 1–2 are available. |
| 3+ visits over ≥6 months | 4,792 | Press number 3 is available. |
| Enrollment by first-visit year | 2022: 2,293 · 2023: 2,894 · 2024: 1,402 · 2025: 3,124 · 2026: 2,400 | Shown in the retention section. |
| Deaths / transfers | **No field exists anywhere** in the schema. | Report "not recorded", and never infer a death or transfer from absence. Every non-attender is "lost to follow-up / status unknown". |
| CGM | About 12 patients have any TIR/CGM value. | Report "insufficient data (n≈12)". No CGM outcomes. |
| Medications | `drug_class`/`med_group` are almost empty (2 patients). | Classify drugs with the existing name normaliser `drugNormalizer.js` (GLP-1, tirzepatide, insulin icodec, etc.). |
| Duplicate people | 280 name+DOB groups (561 rows). Identity keys on `health_id`. | Duplicates are merged for counting (de-identified person id = smallest patient id in the group), with the count disclosed. |

## 2. Definitions (prespecified, fixed before looking at results)

- **Registry**: an active diabetes diagnosis (D2), plus at least one consultation or attended appointment between 2022-01-01 and 2026-10-31. Single-visit patients are included.
- **Enrollment (index) date**: the first visit in the period.
- **Baseline HbA1c**: the reading closest to the index date, from 180 days before to 14 days after. Ties: the earliest-dated wins. If no reading falls in that range, the patient has "no baseline".
- **Follow-up windows** (days after the index date; the reading nearest the target counts, and on a tie the later reading wins):

  | Window | Range | Target |
  |---|---|---|
  | 3 months | 60–150 | 90 |
  | 6 months | 150–270 | 180 |
  | 12 months | 270–450 | 365 |
  | 24 months | 630–810 | 730 |
  | 36 months | 990–1,170 | 1,095 |

- **Eligible for window W**: index date + W's upper bound ≤ 2026-10-31. Patients who are not yet eligible are reported separately as "too recent", never as missing.
- **Measured at W**: has a baseline and a reading inside W. Missing is never counted as a success or a failure.
- **Outcome measures**:
  - Paired change (follow-up − baseline): mean and median.
  - Any improvement (<0).
  - Improved by ≥0.5 and by ≥1.0 points.
  - Worsened by ≥0.5 points.
  - Reached <7% (among those with baseline ≥7%).
  - Kept <7% (among those with baseline <7%).
- **Severity bands (baseline HbA1c)**: <7, 7–7.9, 8–8.9, 9–9.9, ≥10.
- **Engagement status on 2026-10-31**:
  - Active: last visit ≤ 6 months ago.
  - Overdue: 6–12 months.
  - Long gap: more than 12 months.
  - Deceased / transferred: "not recorded".
- **Retention at 3/6/12/24 months**: a visit inside the window around index + N months, among patients enrolled long enough ago. Grouped by enrollment year.
- **Latest comprehensive control**:
  - Uses each patient's latest HbA1c, BP and LDL, each within the 12 months before the last visit.
  - Targets: HbA1c <7, BP <130/80 (or <140/90 as a secondary measure), LDL <100 (or <70 as a secondary measure).
  - Denominator: patients with all three measured.
- **Other markers** use the same windows: weight, BMI, SBP/DBP, LDL, eGFR, UACR. Weight change uses only real measurements: vitals that repeat the previous weight are carried forward 43% of the time and get dropped.
- **Treatment cohorts**:
  - GLP-1 (semaglutide, liraglutide, dulaglutide) and tirzepatide.
  - Weekly insulin (icodec) and daily insulin.
  - Index date = first prescription. Outcomes use the same windows and are labelled descriptive, not causal.
- **Bias checks**:
  - Missingness per window.
  - Baseline age, sex, HbA1c and visit count compared between patients with and without outcome data.
  - A lab-confirmed-only sensitivity check.
  - Results by enrollment year.

## 3. Build (reuses `server/services/analytics/`)

- `server/services/analytics/dmOutcomes.js`: registry, cohorts, windows, outcome stats. It reuses `markerSeries.js` (dedupe, copy-drop), `drugNormalizer.js` and `stats.js`. One read-only transaction keeps the load on prod small: a handful of set-based queries, no loops.
- `server/scripts/build-dm-outcomes.mjs` writes to `reports/dm-outcomes/<date>/`:
  - `scorecard.html`: the press one-pager, each number with n/N.
  - `dashboard.html`: 5 tabs. The filters (enrollment year, age band, sex, baseline HbA1c band, treatment, diabetes type, follow-up status) run client-side over an aggregate cube, with cells of <10 patients suppressed.
  - `outcomes.xlsx`: every table with numerators and denominators.
  - `methodology.md`.
- No patient names, phones or UHIDs leave the database. The output is aggregates only.
- Tests: unit checks on window and eligibility edge cases, plus a hand-recount of 20 random patients against their chart before release.

## 4. Sign-off

Every public number goes to Dr Bhansali and the clinical team before the press conference. The scorecard carries the caveats about the 2024 gap and the missing death/transfer data.

## 5. Decisions (2026-11-11)

- **Period:** 14 Nov 2021 – 31 Oct 2026 as requested. The scorecard states that records effectively start in January 2022.
- **Registry:** a diabetes diagnosis, or two HbA1c readings of 6.5% or more on different dates.
- **HbA1c:** the headline uses all cleaned sources. The lab-confirmed-only result is published beside it.
- **Delivery:** scorecard and methodology first (done: `docs/DM_OUTCOMES_METHODOLOGY.md`), then the 5-tab dashboard and the Excel file.
