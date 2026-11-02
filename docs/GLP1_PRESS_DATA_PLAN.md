# GLP-1 Patient Data — Press Conference Plan

Status: draft for review · 2026-11-02 · no production queries run yet

## 1. The request

Translated from the doctor's voice note (Punjabi/Hindi):

> Data on every GLP-1 drug we use: how many patients are on each, how many visits they've had, how long they've been on it, and their numbers (HbA1c, weight, fasting sugar). Also whether their insulin is still running or has been stopped. Weight and waist size alongside. I need all of it for the next press conference.

Two outputs:

1. **Headline numbers per drug** (for slides and the press conference)
2. **Per-patient list** (for the doctor to check and pick case examples), keyed by Health ID

## 2. Where each piece lives

| Data point            | Table / source                                                                                                                            | How it gets there                                                                                                                          | Existing code that reads it                                                                                                                          |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| GLP-1 prescriptions   | `medications` (`name`, `composition`, `pharmacy_match`, `drug_class`, `dose`, `started_date`, `stopped_date`, `stop_reason`, `is_active`) | Scribe consultations (`routes/consultations.js`), HealthRay Rx sync (`services/healthray/db.js`), Gini Flow Rx (`giniflow/consultEdit.js`) | `analytics/treatment.js` `getMedicationRows` → `analytics/drugNormalizer.js`                                                                         |
| Which drug (molecule) | Brand names grouped in `drugNormalizer.js` `MOLECULES`                                                                                    | —                                                                                                                                          | tirzepatide, semaglutide oral/injectable, liraglutide, dulaglutide, exenatide, plus a "GLP-1, molecule not identified" group                         |
| Patient count         | built from the rows above                                                                                                                 | —                                                                                                                                          | `drugOutcomes.js` `buildDrugCohorts` (one row per patient per drug, start date = earliest of `started_date` / `last_prescribed_date` / `created_on`) |
| Visits                | `consultations.visit_date` + `appointments.appointment_date` (status `seen`/`completed`/`checkedin`), one per distinct day                | —                                                                                                                                          | `analytics/patientBase.js` `getPatientBase` → `visit_days` (all-time only, **not counted from the GLP-1 start**)                                     |
| Time on drug          | `medications.started_date` → `stopped_date` or today                                                                                      | —                                                                                                                                          | `drugOutcomes.js` `buildPersistenceByCohort`, `treatment.js` (per drug class, not per patient)                                                       |
| HbA1c                 | `lab_results` `canonical_name = 'HbA1c'`                                                                                                  | HealthRay lab sync, lab API, report extraction, manual entry                                                                               | `analytics/markerSeries.js` (range 3–20)                                                                                                             |
| Fasting sugar         | `lab_results` `canonical_name = 'FBS'`                                                                                                    | same                                                                                                                                       | `markerSeries.js` marker `fg` (40–600 mg/dL)                                                                                                         |
| Weight / BMI          | `vitals.weight`, `vitals.bmi`                                                                                                             | HealthRay OPD vitals (`healthray/db.js` ~L1904), Gini Flow vitals station                                                                  | `markerSeries.js` (vitals table only)                                                                                                                |
| Waist                 | `vitals.waist`                                                                                                                            | HealthRay OPD vitals "Waist / Waist Circumference", Gini Flow vitals (column added 2026-10-19)                                             | `markerSeries.js` marker `waist`                                                                                                                     |
| Insulin               | `medications` rows the normaliser puts in the `insulin` class                                                                             | same as GLP-1                                                                                                                              | only used as a separate comparison group — **no "stopped after GLP-1" logic**                                                                        |
| Patient-app readings  | `patient_vitals_log` (weight, waist, fasting RBS)                                                                                         | MyHealth Genie app                                                                                                                         | `opdBiomarkers.js` only; **the analytics module leaves them out**                                                                                    |

Starting and later values: `drugOutcomes.js` `computeOutcomes` takes the starting value from up to 180 days before the drug started to 14 days after. It then compares that with values at 3 months (60–150 days), 6 months (150–270 days) and 12 months (270–450 days). For weight it adds the share who lost ≥5% or ≥10%; for HbA1c, the share who reached below 7 or dropped by ≥1 point.

## 3. Definitions to agree before running

| Term                       | Proposed definition                                                                                                                                                                                                                   |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GLP-1 patient              | Has ≥1 `medications` row that resolves to a GLP-1 / GIP molecule (or a GLP-1 named without a drug) and ≥1 counted visit                                                                                                               |
| Start date                 | Earliest start date for that drug, as `buildDrugCohorts` already does. Rows whose start was filled in much later are labelled (`observed_start` / `backfilled_short` / `backfilled_long`).                                            |
| Visits on GLP-1            | Distinct counted visit days from the start date up to the as-of date                                                                                                                                                                  |
| Time on GLP-1              | From the start date to `stopped_date`, or to the as-of date if the drug is still active. Shown in days and months.                                                                                                                    |
| On insulin at GLP-1 start  | Has an insulin row with a start date on or before the GLP-1 start, and that row was not stopped before the GLP-1 start                                                                                                                |
| Insulin stopped            | Was on insulin at GLP-1 start, has no active insulin row now, and had a counted visit after the stop date. A drop with `stop_reason = 'Not in latest prescription'` counts as stopped, because a later prescription left insulin out. |
| Insulin continuing         | Still has an active insulin row                                                                                                                                                                                                       |
| Insulin reduced (optional) | Units in `dose` at the latest prescription are below the units at GLP-1 start. `dose` is free text, so this needs parsing and a manual spot check.                                                                                    |
| Change in a number         | Change from the starting value to the 3/6/12-month value, counting only patients who have both values                                                                                                                                 |

## 4. Work plan

All steps only read data. Nothing is written to production.

**Step 1 — Check the brand list.** Using `server/scripts/probe-drug-normalizer.mjs` as the base, list distinct medicine names whose name or composition contains `glutide` / `tirzep` / `glp`, or whose `drug_class` is `glp1`, together with the group each one falls into. Any name the normaliser misses (e.g. new Indian semaglutide generics from 2026) gets added to the `aliases` in `drugNormalizer.js`. One read-only query; ask before running.

**Step 2 — New script `server/scripts/report-glp1-press.mjs`.** It reuses `getPatientBase`, `getMedicationRows`, `buildDrugCohorts`, `computeOutcomes`, `summariseOutcomes` and `buildPersistenceByCohort`. New code adds only:

- visits on GLP-1 for each patient (`consultations` + `appointments` after the start date)
- the insulin status as defined in §3 (from the same `medRows`; no extra query)
- one row per patient: first and latest HbA1c / FBS / weight / waist with dates (from `markerSeries`)

It reads through `cronPool` inside `BEGIN READ ONLY` and never uses `SET SESSION` (the production database's connection pooler would carry that setting over to the live API).

**Step 3 — Run against the e2e database first** (`localhost:5435`) to check the output shape, then run once against production, with permission asked at that point.

**Step 4 — Output** (`server/reports/`, not committed):

- `glp1-summary-<date>.xlsx`
  - Sheet _By drug_: patients, active now, median months on drug, median visits, HbA1c / FBS / weight / waist starting value → 3 / 6 / 12 months (how many patients, median, mean change), % losing ≥5% / ≥10% weight, % reaching HbA1c < 7, insulin continued / reduced / stopped
  - Sheet _Patients_: Health ID, drug, start date (with how reliable it is), months on drug, visits, GLP-1 active?, HbA1c first → latest, FBS first → latest, weight first → latest, waist first → latest, insulin status. **No names or phone numbers** (DPDP).
  - Sheet _Method_: the definitions from §3 and how many patients were left out at each step
- A one-page HTML summary of the headline numbers for slides

**Step 5 — Spot check.** Pick 5 patients at random (at least one "insulin stopped" and one tirzepatide) and compare against their HealthRay prescriptions and labs before any number goes public.

## 5. Known data risks

- **Start dates entered late.** Many medication rows were typed in long after the drug actually began. For the press, quote the `observed_start` group, or show it next to the full group.
- **Waist is sparse.** It only exists where HealthRay OPD or the Gini Flow vitals station recorded it. Expect a small number of patients with both a starting and a later value. Report it as "n patients with waist recorded".
- **Weight comes from clinic measurements only.** Weights patients enter in the app (`patient_vitals_log`) are left out on purpose, because they aren't measured in clinic.
- **Insulin can look "stopped" when it wasn't.** The HealthRay sync marks a medicine as stopped whenever the latest prescription doesn't list it. A short or partial prescription could therefore make insulin look stopped. Requiring a later visit, plus the step 5 spot check, guards against this.
- **Patients who stopped coming.** A patient who left still shows their last prescription as active. Report "insulin stopped" only among patients seen ≥3 months after the GLP-1 start.
- **Observational data.** The patients weren't randomised and there was no comparison group, so figures are associations seen in routine care, not proof the drug caused them (the existing report says the same in `analytics/index.js`). Use wording like "among our patients on X…".
- **Very large numbers count as wrong data.** The existing range filters (HbA1c 3–20, FBS 40–600, waist 40–200) already drop values like that.

## 6. Decisions

- Patients: everyone on a GLP-1, with diabetics also reported as a separate subgroup (the insulin numbers come from that subgroup)
- Range: all history from 2023 onwards, up to the as-of date
- Format: Excel + one-page HTML summary

## 7. Step 1 result (2026-11-02)

Read-only scan of `medications`: 449 distinct GLP-1-like names, ~4,260 rows. Fixes made in `drugNormalizer.js` (test cases in `probe-drug-normalizer.mjs --fixtures-only`):

- Added Yurpeak → tirzepatide; Erl / Erli / Erlt / Eryl / Erely / Vigovy → semaglutide injection (whole-word match only)
- New group: lixisenatide + insulin glargine (Soliqua / Saliqua), counted as both GLP-1 and insulin
- A stored "GLP-1 RA" class alone no longer makes a medicine a GLP-1; the name must show it. Insulins, supplements, antibiotics, FSH etc. that carried that label drop out
- Added insulin brands Huminsulin, Insugen, Mixtard, Actrapid, Basalog, Wosulin
- Rows saying the drug was deferred, not started, refused or declined are skipped

Waiting for the doctor: Gliptoza (counted as semaglutide), Tide / Tide Plus / Tide E, Exenta, Lyrato, Jarla, Gliptino (excluded), and "Eplerenone / Eribulin / Insulin Glargine (Erly)" (counted as semaglutide).

## 8. Step 3 result (2026-11-02)

`node scripts/report-glp1-press.mjs --target=production` ran in 43 s. 2,169 patients have a GLP-1 row; 2,059 started their first GLP-1 on or after 2023-01-01 ("Any GLP-1"; 2,082 counting patients whose first GLP-1 was earlier but who switched drug after 2023).

Not ready to quote yet:

- Weight and waist changes have a median of 0 in every group, while the 43 patients whose start was recorded at the time show −5.5 kg. Likely causes: weight/waist carried forward unchanged between visits, and start dates entered late so the "start" value is already on the drug. Needs a check of how often a follow-up reading equals the start reading.
- Only 567 of 2,059 patients (28%) have a start date recorded at the time.
- Insulin stopped (112 of 457) still needs the step 5 spot check.

### Weight check result

One read-only query pulled 43,422 weight / waist / HbA1c / FBS readings for the 2,059 patients.

- `vitals` rows with no `source` (14,905 weight readings, written by the Scribe consultation save, visit and sync routes and document extraction) repeat the previous weight 43% of the time. Gini Flow vitals repeat 5%, HealthRay OPD vitals 16%.
- 45% of the 6-month weight pairs are exactly unchanged (66% when both readings have no source), which is why the median is 0.
- On 463 days a patient has two different weights; the analytics module keeps the higher one, which is often the copied first-visit value.
- HbA1c and fasting sugar are barely affected (2–3% unchanged pairs).
- Weight from reliable subsets: starts recorded at the time, median −5.5 kg (n=43, 58% lost ≥5%); measured sources only, median −3.9 kg (n=27).

### Report changed and rerun (2026-11-02)

Decision: weight from reliable readings only; waist dropped from the summary (kept per patient, marked unverified). Weight now = start (−180/+14 days) vs latest reading ≥60 days after start, using readings measured at the visit, or all readings when the start was recorded at the time. Per-window outcome sheets now cover HbA1c and FBS only.

Result, any GLP-1: 226 patients with a reliable pair (174 start-recorded, 52 measured), 90.6 → 86.6 kg median, −3.6 kg median change (−4.5%), 45% lost ≥5%, 13% lost ≥10%, median 4.2 months between readings, 4.9% exactly unchanged. Tirzepatide −3.4 kg (n=53, 43% lost ≥5%); semaglutide injection −3.3 kg (n=187, 40%).

### Insulin rule tightened (2026-11-02)

Spot check: P_126780 was marked insulin stopped but was not (insulin missing only from the last prescription). Rule now: stopped only when insulin is absent at 2+ visits from the stop date; missing from one prescription only is shown separately and left out of the rate. Result, any GLP-1: 57 of 400 stopped (14.2%), down from 112 of 457 (24.5%); 57 patients dropped from one prescription only. Tirzepatide 26/134 (19%), semaglutide injection 41/256 (16%), liraglutide 10/117 (9%).

### Copied HbA1c / FBS dropped (2026-11-02)

Spot check: P_179477's HbA1c 10.5 on 08-Aug-2026 (`source = healthray`) repeated the first visit's 10.5; the real latest is 9.2 (06-Aug). In this cohort 26% of `healthray`-source HbA1c readings repeat an earlier value, against 4–8% for other sources. `markerSeries.js` now has a `dropCopies` option (off by default, so the main outcomes report is unchanged): a `healthray`-source reading whose value already appeared earlier for that patient and marker is dropped. The GLP-1 report turns it on. Any GLP-1, 6 months: HbA1c 8.0 → 6.9 (n=408, 52% reached <7, 45% fell ≥1); diabetic 8.2 → 7.1 (n=371); FBS 136 → 115 (n=534).

### Hand check complete (2026-11-02)

P_126780 (insulin falsely stopped) and P_179477 (copied HbA1c) were wrong and are fixed above. P_175717 (insulin stopped, HbA1c 11.4 → 7.1), P_111810 (tirzepatide weight 115.3 → 107.6 kg) and P_174815 (insulin continuing, HbA1c 5.0) match HealthRay.

### Report expanded after external review (2026-11-02)

Summary page now has six sections: key figures, patient overview, diabetes outcomes, weight and waist, insulin, treatment journey. Excel adds Overview, Insulin, GLP-1 dose, Stop reasons and Timeline (17,793 rows) sheets plus end date, treatment status, stop reason, doses and insulin units per patient.

- Unique patients are now 2,059 everywhere (patients whose first GLP-1 was before 2023 are left out entirely); 2,666 patient–drug records; 494 patients used more than one GLP-1.
- Treatment status: 709 on drug and seen in the last 6 months, 913 still prescribed but not seen for 6+ months, 437 discontinued.
- Waist uses the same reliable-reading rule as weight: 176 patients (8.5%), median −1 cm.
- Insulin, 849 on insulin at start = 401 counted + 392 not seen 3+ months + 56 dropped from one prescription only. Stopped 57/401. Continuing, dose estimate: 64 reduced ≥20%, 139 similar, 66 increased, 75 not readable. 141 started insulin after the GLP-1.
- Stop reasons are essentially unrecorded: 85% "left off a later prescription", 14% no reason.
- GLP-1 dose: start vs latest mostly identical, because medicine rows rarely keep a per-visit history. Tirzepatide is the exception (2.5 → 5 mg median, 66 increased).

### Second review fixes (2026-11-02)

- Status now uses the last GLP-1 prescription date: 700 active (prescribed in last 6 months), 922 status unknown (last prescribed 6+ months ago), 437 discontinued.
- "Previous visit" stop reason is the Scribe visit save superseding old medicines (`routes/visit.js`), now grouped with "left off a later prescription": 377 (86%); 60 no reason.
- GLP-1 doses: only standard doses per drug are counted; dose history is shown as the latest dose distribution instead of start vs latest (rows are usually updated in place). Semaglutide injection has 210 non-standard doses written (e.g. 0.6/1.8 mg), left out.
- Added: per-patient improved/stable/worse (HbA1c 529 of 824 improved ≥0.3; FBS 555/1,023; weight 156/227; waist 94/176; insulin stopped 57/401), insulin-started-later still on insulin (112 of 141), an Insulin dose review sheet (130 patients to check by hand), Example candidates sheet (50 patients, consent needed), window definitions, and a Data quality and limitations section.

### Final validation (2026-11-02)

- Erly (199 prescriptions) and Gliptoza (19) are written at 0.6 → 1.2 → 1.8 → 3 mg, the liraglutide schedule, so `drugNormalizer.js` now maps them to liraglutide (brand names now win over a generic name in the same text, e.g. "Semaglutide (Erly)"). Oxemia (50/100 mg, once labelled gabapentinoid) is no longer a GLP-1. Pending the clinical team's confirmation. Effect: semaglutide injection 1,174 → 1,060, liraglutide 429 → 556, unique patients 2,059 → 2,055, non-standard semaglutide doses 210 → 102.
- Counts reconcile: 2,055 unique patients, 1,549 on one GLP-1 and 506 on two or more (502 excluding "drug not named"); per-patient drug counts sum to 2,679 = sum of drug rows.
- Independent recompute of HbA1c at 6 months from the Timeline sheet: n=408, 8.0 → 6.9, median −0.7, 51.5% <7 (report 51.7%; the gap is the Timeline's 1-decimal rounding at the 7.0 cut-off).
- Oral semaglutide waist (n=26): start median 114.5, latest 111, median of per-patient changes −0.2, mean −1.5. Not an error — median of differences is not the difference of medians — but the group is small and readings are a median 33 months apart.
- Added "Change by time on GLP-1" (latest on-treatment reading, bands <3, 3–6, 6–12, 12+ months), public tables now need n ≥ 20, insulin-start timing (median 3.6 months after GLP-1 start; 112 of 141 still on it), and the Example candidates sheet is renamed INTERNAL.

### Active window and 12-month headline (2026-11-02)

Decision: "active" = GLP-1 prescribed in the last 12 months (was 6). Result: 1,009 active, 613 status unknown, 437 discontinued of 2,059. Key figures now show HbA1c and fasting sugar at both 6 months (n=408 / 534) and 12 months after start (HbA1c 7.9 → 7.2, 45% <7, n=300; FBS 135 → 121, n=385).

### Period filter (2026-11-02)

Tried and removed at the user's request: the page is all-time only (2,059 patients). The Patients sheet keeps a "Last GLP-1 prescription" column.

## 9. Still open

1. Which doctors count: all consultants, or only the press-conference doctor's patients?
2. Deadline (the press conference date)?
3. The doctor's answers on the drug names above
