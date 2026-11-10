# OPD Year-on-Year Data — Plan

Status: draft for review · 2026-11-10 · explored from code only, no production queries run yet

## 1. The request

Eleven OPD figures, year on year, in two sets:

- **Set A**: every patient seen in the year
- **Set B**: only patients seen **at least 3 times in that year**

| #   | Figure                                                                                                              |
| --- | ------------------------------------------------------------------------------------------------------------------- |
| 1   | Total visits                                                                                                        |
| 2   | Unique patients                                                                                                     |
| 3   | Average age of patients seen                                                                                        |
| 4   | Average age of onset (AOO) of diabetes                                                                              |
| 5   | Patients on a GLP-1 (Mounjaro, Wegovy, Semanext, Semalix, Semasize, Wyntide, Blupen, Yurpeak, Semafull, Sembolic …) |
| 6   | Patients on Awiqli                                                                                                  |
| 7   | Patients on both 5 and 6                                                                                            |
| 8   | Patients with dual adiposity                                                                                        |
| 9   | Patients with HbA1c in control (< 7)                                                                                |
| 10  | Patients with all three in control: HbA1c < 7, BP < 140, LDL < 100                                                  |
| 11  | Patients with DKD or CAD in the diagnosis                                                                           |

## 2. Where each figure lives

| #     | Source                                                                                                                                                                                                   | Existing code                                                                                                                   | Gap found while exploring                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1, 2  | `appointments` only (HealthRay is the authority for visits)                                                                                                                                              | `reports/opdSummary.js` `BASE` (drops leads, blocked patients, `TESTSLOT-` files, rebooked cancels); `analytics/patientBase.js` | `BASE` drops `TESTSLOT-` files but not the `Dr. Test Consultant` doctor, so the report drops that doctor as well. A Scribe consultation does not create an appointment row, so Scribe-only visit days are counted separately in step 1 and are not mixed into the totals. `BASE` falls back to `file_no` when `patient_id` is missing, and UHIDs are reassigned, so unique patients use `patient_id` only and rows without one are counted separately.                                  |
| 3     | `appointments.age` (the age on that visit), else `patients.dob`, else `patients.age`                                                                                                                     | `patientBase.js` (age from DOB at a date, else stored age)                                                                      | `patients.age` is **overwritten with HealthRay's latest age** on every sync, so for past years it reads too old. Use the age written on the patient's first visit of the year; if there is none, use DOB at that visit date; use the stored age only as a last resort, and count how often each source is used.                                                                                                                                                                         |
| 4     | Diagnosis details text: HealthRay writes `"…Since 2023, AOO 35 yrs"` into `diagnoses.notes` and `appointments.healthray_diagnoses[].details`. `diagnoses.since_year` is filled only by the Genie import. | None — AOO is only passed to AI summaries as text                                                                               | New parsing: AOO = explicit `AOO nn` if present; else `since year − birth year`; else unknown. Report how many patients each route covered.                                                                                                                                                                                                                                                                                                                                             |
| 5     | `medications` (+ `last_prescribed_date`) and the per-visit snapshot `appointments.healthray_medications`                                                                                                 | `analytics/drugNormalizer.js` (GLP-1 molecules, fixed for the press report on 2026-11-02)                                       | Not in the normaliser: **Semalix, Semasize, Wyntide, Blupen, Semafull, Sembolic** (none are in `medicine_db.json` either, so they only exist as typed text). Needs the brand scan in step 1.                                                                                                                                                                                                                                                                                            |
| 6, 7  | same                                                                                                                                                                                                     | none                                                                                                                            | **No Awiqli / insulin icodec pattern at all.** Add a separate `icodec` group (it is also an insulin, so it must count as insulin elsewhere).                                                                                                                                                                                                                                                                                                                                            |
| 8     | `diagnoses.diagnosis_id = 'dual_adiposity'`; `vitals.bmi` + `vitals.waist`                                                                                                                               | `healthray/db.js` `normalizeDiagnosisId`                                                                                        | The mapper sends any bare "adiposity" to `dual_adiposity` (only "central/visceral adiposity" are kept apart), so the diagnosis count may overcount. Waist is sparse (GLP-1 report: ~8.5% of patients with reliable pairs).                                                                                                                                                                                                                                                              |
| 9, 10 | `lab_results` (`HbA1c`, `LDL`), `vitals.bp_sys` / `bp_dia`                                                                                                                                               | `analytics/markerSeries.js` (range filters, `dropCopies` for HealthRay-copied values); `BIO_TARGET`                             | HbA1c / LDL copied forward by HealthRay (26% of `healthray`-source HbA1c repeat an earlier value) — use `dropCopies`. The existing targets are HbA1c 7, SBP 130 good / 140 warn, LDL 100; the request's BP 140 matches the warn line.                                                                                                                                                                                                                                                   |
| 11    | `diagnoses` + per-visit `appointments.healthray_diagnoses`                                                                                                                                               | `analytics/constants.js` `CONDITION_GROUPS` `ckd`, `cad`                                                                        | `ckd` pattern misses `ckd_stage_3`-style slugs and any "diabetic kidney disease"/"DKD" slug. The `diagnoses` table holds **one row per patient per diagnosis, updated in place**, so it cannot tell which year a diagnosis was written — use the per-visit snapshot for that. The sync drops absent findings ("CAD-") before writing to `diagnoses`, but **the snapshot keeps the raw parsed list, so `status: "Absent"` entries must be filtered out**, or every "CAD-" counts as CAD. |

## 3. Proposed definitions

| Term                 | Proposed definition                                                                                                                                                                                                                                                                                                                                                                              |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Year                 | Calendar year: 2023, 2024, 2025, 2026 to date (as at the run date).                                                                                                                                                                                                                                                                                                                              |
| Visit                | One attended appointment day per patient (`completed` / `seen` / `checkedin`), in-person new + follow-up only. Tele, lab-only, leads, blocked, test data and rebooked cancels left out.                                                                                                                                                                                                          |
| Unique patient       | Distinct `patient_id` with ≥ 1 visit in the year                                                                                                                                                                                                                                                                                                                                                 |
| Set B (≥ 3 visits)   | ≥ 3 distinct visit days within that same year. 2026 is labelled part-year because patients still have time to reach 3.                                                                                                                                                                                                                                                                           |
| Age                  | Age on the patient's first visit of the year (source order in §2 #3); mean and median, with n                                                                                                                                                                                                                                                                                                    |
| AOO                  | Among diabetic patients seen in the year; explicit AOO first, then since-year − birth year; values outside 1–90 dropped. All diabetes, with Type 2 shown separately (Type 1 onset is much younger)                                                                                                                                                                                               |
| On a GLP-1 / Awiqli  | Prescribed in that year: named in a visit's medication snapshot in the year, or a `medications` row started, last prescribed or tied to a consultation in the year. A row that is merely still "active" does **not** count, since patients who stopped coming keep their last prescription active forever. Rows saying deferred / not started / refused are skipped (already in the normaliser). |
| Dual adiposity       | Both shown: written diagnosis in the year; and measured — latest BMI ≥ 25 and latest waist ≥ 90 cm (men) / ≥ 80 cm (women) in the year, among patients with both recorded                                                                                                                                                                                                                        |
| HbA1c in control     | Latest HbA1c in the year < 7. Denominator = everyone with an HbA1c that year                                                                                                                                                                                                                                                                                                                     |
| All three in control | Latest HbA1c < 7 **and** latest BP < 140 **and** latest LDL < 100, all in the same year. Denominator = everyone with all three measured that year                                                                                                                                                                                                                                                |
| DKD or CAD           | DKD = diabetic nephropathy / DKD / CKD any stage; CAD = coronary artery disease / IHD / MI / angina. Present (not "Absent") in a diagnosis written that year. DKD, CAD and either reported separately                                                                                                                                                                                            |

Every percentage is shown with its numerator and denominator, and "not measured" is a separate count, never folded into "not in control".

## 4. Work plan

Everything only reads data. Nothing is written to production.

**Step 1 — Coverage and brand scan (read-only, ask before each query).**

- Visits per year, and per year how many have a HealthRay snapshot, a Scribe consultation, both or neither — this decides how far back YoY is trustworthy (`HISTORY_START_DATE` is 2023-01-01).
- DOB coverage, and how many diabetics carry an `AOO` or `since` in their diagnosis text.
- Distinct medicine names matching `sema|tirz|glut|tide|pen|awiq|icodec` plus the ten brands named, with the group each falls into — feeds the normaliser fix.
- Distinct diagnosis slugs matching `kidney|ckd|dkd|nephro|coronary|cad|ihd|adipos`.

**Step 2 — Code fixes (small, testable).**

- `drugNormalizer.js`: add the missing GLP-1 brands once step 1 shows how they are written; add an `insulin_icodec` group (Awiqli) that also counts as insulin. Extend `probe-drug-normalizer.mjs --fixtures-only` cases.
- `constants.js` `CONDITION_GROUPS.ckd`: match `ckd_stage_N`, `diabetic_kidney_disease`, `dkd`.
- These change the existing Outcomes/Analytics report too — expected and correct, noted in the run log.

**Step 3 — New script `server/scripts/report-opd-yoy.mjs`.** Reuses `opdSummary.js` exclusions, `patientBase.js` age helpers, `drugNormalizer.js`, `conditions.js`, `markerSeries.js` (`dropCopies` on). Adds only: per-year visit grouping, the AOO parser, the per-visit diagnosis/medication read, and the control rules in §3. Reads through `cronPool` inside `BEGIN READ ONLY`, never `SET SESSION`.

**Step 4 — Run on the e2e database** (`localhost:5435`) for output shape, then once on production with permission asked at that point.

**Step 5 — Output** (`server/reports/`, not committed):

- `opd-yoy-<date>.xlsx`
  - _Summary_: the 11 figures × years, Set A and Set B side by side, each with n and %
  - _Method_: definitions from §3, exclusions and counts dropped at each step, data coverage per year
  - _Patients — INTERNAL_: Health ID, year, visits, age, AOO and its source, GLP-1 / Awiqli, dual adiposity, latest HbA1c / SBP / LDL with dates, DKD / CAD. No names or phones.
- One-page HTML summary for sharing

**Step 6 — Spot check** 5 patients (at least one Awiqli + GLP-1, one DKD, one with AOO from since-year) against HealthRay.

## 5. Known data risks

- **Older years are thinner.** HealthRay snapshots and Scribe consultations started at different times; a lower 2023 figure may be missing data, not fewer patients. Step 1 decides which years are shown.
- **Diagnoses lose their history.** The `diagnoses` row is overwritten on each sync; per-year counts depend on the per-visit snapshot, which only HealthRay visits have.
- **Carried-forward values.** Weight, HbA1c and BP are often copied between visits (see GLP-1 plan §8); the `dropCopies` filter guards HbA1c/LDL; BP from unsourced `vitals` rows needs the same check.
- **"In control" depends on who was tested.** Patients without a reading that year are reported separately; the rate is among those measured.
- **New generic brands.** Six of the ten named brands are not in the medicine database; a miss in the brand scan undercounts GLP-1 users.
- **Cumulative notes.** Doctors append follow-up blocks to one HealthRay note, so a visit's snapshot can repeat diagnoses written at the first visit. That is fine for "mentioned in diagnosis", but labs come from `lab_results` by test date, never from the note snapshot.
- **Duplicate charts.** The same person can exist as a GNI shell and a P\_ chart; unique patients may be slightly overcounted. Step 1 counts how many visit-year patients share a phone and name.
- **Observational data.** Wording like "among patients seen in 2025…".

## 6. Open decisions

Asked separately; answers recorded here.

- **Year**: calendar year — 2023, 2024, 2025, 2026 to date.
- **Visits**: in-person OPD only (new + follow-up). Tele and lab-only visits left out.
- **Dual adiposity**: show both — the written-diagnosis count, and a measured count (BMI ≥ 25 and waist ≥ 90 cm men / ≥ 80 cm women) among patients with both recorded.
- **Control denominators (#9, #10)**: everyone measured that year, diabetic or not. Patients without the reading(s) are reported separately.

- **BP in control**: systolic < 140 only (diastolic shown, not used).
- **DKD**: kidney disease (nephropathy / DKD / CKD any stage) in a diabetic patient only.
- **Doctors**: all consultants; lab-only (`Dr. Hospital Admin`) and `Dr. Test Consultant` excluded.
- **GLP-1 scope**: every GLP-1 / GIP molecule — tirzepatide, semaglutide injectable and oral (Rybelsus), liraglutide, dulaglutide, exenatide and Soliqua (lixisenatide + glargine). Each is also shown separately.

Still open (answered by data, not by you, in step 1):

1. How each of Semalix, Semasize, Wyntide, Blupen, Semafull, Sembolic is written, and which molecule it maps to. Any that is ambiguous goes back to the doctor before it is counted.
2. Which years have complete enough data to show.

## 7. Step 1 results — visit coverage (2026-11-10)

Five read-only queries (each `BEGIN READ ONLY … ROLLBACK`, 1–20 s).

- **Appointments exist only from 2025-01-01.** Attended in-person OPD: 2025 17,467 visit days / 6,645 patients; 2026 to 10 Nov 17,443 / 7,470. Age is on 100% of visits; HealthRay diagnosis snapshot on 66% (2025) and 89% (2026) of visits.
- **Consultations go back to 2021**, but all those without an appointment were bulk-loaded on two days (HealthRay past OPD visits, per the user): 46,531 rows dated 2021–2024 loaded 15 Feb – 27 Mar 2026 (32,666 on 24 Mar), and 18,837 dated Jan 2025 – Feb 2026 loaded 15 Feb – 16 Mar 2026 (18,436 on 25 Feb).
- **Their dates are not visit dates.** 17–18% fall on a Sunday, against 0.5–0.7% of real appointments (OPD is closed on Sundays). In Jan 2025 – Feb 2026, 83% sit within ±7 days of a real appointment but not on it (only 3% exactly ±1 day), so they are mostly the same visits under another date — probably a date taken from the note text. From March 2026 consultations and appointments line up (0–130 a month without an appointment).
- **Conclusion:** visit counts (#1, #2, #3 and Set B) can only come from `appointments`, i.e. 2025 vs 2026. The imported consultations are not counted as visits.
- **New exclusion:** demo patients (`ZZDEMO_` file numbers) are not dropped by the shared OPD base; the report drops them, along with `TESTSLOT-` files and `Dr. Test Consultant`.

- **Years (decided 2026-11-10)**: 2025 full year vs 2026 to date, plus 2025 for the same 1 Jan – as-of window (like-for-like).

## 8. Step 1 results — medicines (2026-11-10)

Read-only scan of `medications` plus 2025+ visit medicine snapshots (300 most-used matching names; the cut-off tail is one patient each).

- **Missing GLP-1 brands, now added to `drugNormalizer.js` as injectable semaglutide**: Semasize (~210 patients), Semalix / Semalix XL (~90), Sembolic (~75), Sematrinity (~60), Semaglu (~57, whole-word only so "Erly (semaglutide)" stays liraglutide), Wyntide (~33), Blupen ("blue pen", 8), Semafull, Semawin, Semamac, with their misspellings. All are written on the semaglutide schedule (0.25 → 0.5 → 1 → 1.7 → 2.4 mg); Wyntide's 0.25/0.5/1 mg doses are semaglutide, not tirzepatide. Sematrinity, Semaglu, Semawin and Semamac were not on the request's list.
- **Awiqli** (~317 patients; "awiquli", "awiqly"; 100–160 units weekly) is now an insulin, and `isInsulinIcodec()` identifies it for #6 / #7. Deferred / not-started rows are excluded.
- Left unmatched: "exena" (2 patients), "Voglirapid" (voglibose).
- `probe-drug-normalizer.mjs --fixtures-only`: 76/76 pass.
- **Side effect:** the GLP-1 press report and the Outcomes report will now count these patients as semaglutide (injectable semaglutide names in the scan: 3,130 → 4,187 patient-name rows).

## 9. Step 1 results — diagnoses (2026-11-10)

Read-only scans of the active `diagnoses` table and the 2025+ visit diagnosis snapshots, plus the stored HealthRay note text.

- **Snapshot status has three values: present, absent and blank.** Blank comes from an older parse and is concentrated in 2025 (CAD: 2,647 blank of ~3,000 entries in 2025; 714 of ~10,500 in 2026). Counting blank as present would inflate 2025.
- **The doctor's sign in the note (`CAD+` / `CAD-`) is reliable**: recorded present matched `CAD+` 938 vs 15; recorded absent matched `CAD-` 6,817 vs 29. For blank 2025 entries the note gives `CAD-` 1,125 / `CAD+` 1,009. Rule: read the **last** sign in the note (follow-up blocks are appended at the bottom), the same way in both years.
- **CAD by recorded status alone**: 3,819 patients absent, 637 present, ~1,900 blank.
- **Nephropathy is mostly a screening stage, not disease.** Most entries carry a KDIGO stage: G1A1 / G2A1 (normal) are the largest groups (present 1,148 / 521, blank 1,611 / 715). Disease stages (A2–A3 or G3–G5) are ~1,270 present / ~1,300 blank. Nephropathy is usually written without a sign ("NEPHROPATHY (G1A1)"), so the stage decides. The `diagnoses` table's 3,402 `diabetic_nephropathy` patients therefore overcount DKD.
- **Not DKD**: renal stones / calculi, cysts, AKI, nephrotic syndrome, IgA nephropathy, renal artery stenosis, "non-diabetic kidney disease".
- **Dual adiposity**: "dual adiposity" ~5,000 patients in 2025–26 snapshots; near variants "dual obesity" (156), "dual adiposities" (12), "overweight with dual adiposity" (4), "triple obesity" (3). The mapper's bare-"adiposity" catch-all affects only ~6 patients.
- **AOO coverage** among 7,279 diabetic patients seen 2025+: explicit AOO 4,691 (64%); year only 2,038 (28%, AOO = age on the visit − years since diagnosis); neither 550 (8%).

### Decisions (2026-11-10)

- **DKD**: in a diabetic patient, KDIGO stage G3a or worse, or albumin A2 or worse, unless the doctor wrote "NEPHROPATHY-"; explicit "diabetic nephropathy / DKD / CKD stage N" with a disease stage also counts. G1A1 / G2A1 are not DKD.
- **Unstaged nephropathy** (G1A?, G2A?, no stage) with no sign: not DKD; reported as "kidney status unclear".
- **Dual adiposity** wordings: dual adiposity, dual adiposities, dual obesity, overweight with dual adiposity. Triple obesity is not counted.
- **Per year**: a condition counts if present at the patient's **latest visit of the year**.
- **CAD**: the last `CAD+` / `CAD-` sign in that visit's stored note; when the note has no sign, the recorded status (present counts; blank and absent do not); "CAD p/PTCA", "post CABG", "CAD with stent" count as present.

Step 1 is complete. Next: step 3, the report script.

## 10. Step 3 — report script (2026-11-10)

- Logic: `server/services/analytics/opdYoy.js` (periods, visit load, age, AOO, GLP-1 / Awiqli, dual adiposity, DKD, CAD, control rules). Runner and output: `server/scripts/report-opd-yoy.mjs --target=e2e|production [--as-of=YYYY-MM-DD]`, one `BEGIN READ ONLY` transaction, 120 s statement limit, rolled back.
- Rule checks without a database: `npm run smoke:opd-yoy` (40/40 pass).
- e2e run: completes; the fixtures have no 2025–26 visits, so it only proves the queries and output.
- Output in `server/reports/` (gitignored): `opd-yoy-<date>.xlsx` (Summary, Numbers, GLP-1 by drug, Data coverage, Method), `opd-yoy-patients-INTERNAL-<date>.xlsx` (Health IDs, internal only), `opd-yoy-summary-<date>.html`.

## 11. Production run (2026-11-10)

`node scripts/report-opd-yoy.mjs --target=production` — 74 s, read-only, 34,910 visit days.

| Figure                            | 2025          | 2025 to 10 Nov | 2026 to 10 Nov |
| --------------------------------- | ------------- | -------------- | -------------- |
| Visits                            | 17,467        | 14,913         | 17,443         |
| Unique patients                   | 6,645         | 6,027          | 7,471          |
| Patients with ≥ 3 visits          | 2,686         | 2,268          | 2,632          |
| Mean age                          | 53.5          | 53.5           | 52.7           |
| Mean AOO (all diabetes)           | 44.9          | 45.0           | 44.2           |
| On a GLP-1                        | 1,049 (15.8%) | 915 (15.2%)    | 1,502 (20.1%)  |
| On Awiqli                         | 0             | 0              | 314 (4.2%)     |
| On both                           | 0             | 0              | 148 (2.0%)     |
| Dual adiposity, diagnosis         | 45.6%         | 46.3%          | 52.0%          |
| Dual adiposity, measured          | 74.6%         | 74.3%          | 74.0%          |
| HbA1c < 7                         | 47.8%         | 48.3%          | 49.6%          |
| HbA1c < 7 + SBP < 140 + LDL < 100 | 25.2%         | 26.3%          | 26.9%          |
| DKD (diabetics)                   | 21.2%         | 21.0%          | 23.3%          |
| CAD                               | 8.3%          | 8.5%           | 10.2%          |

Caveats for the write-up:

- 2025 has HealthRay prescription / diagnosis copies on 66–67% of visits against 87–89% in 2026, so 2025 GLP-1 / Awiqli counts may be low (medicine rows fill part of the gap). Diagnosis figures use patients with a diagnosis list as the denominator, so they are less affected.
- Measured dual adiposity: waist was recorded for far fewer patients in 2025 (2,043 measured vs 4,485).
- 2025 AOO is mostly worked out from the diagnosis year (2,577 of 4,212); 2026 is mostly written AOO (4,071 of 4,827). Means agree (44.9 vs 44.2).
- GLP-1 mix shifts in 2026: injectable semaglutide 199 → 1,260 patients (like-for-like window), liraglutide 345 → 112.
- Spot check pending (step 6). The internal sheet now also carries the UHID (needs a rerun to appear).

### Spot check (2026-11-10)

All 5 patients matched HealthRay (Awiqli + GLP-1, DKD from stage, CAD+ from note, AOO from since-year, all three in control). Awiqli confirmed as first prescribed in 2026, so 0 in 2025 is correct. Report cleared to share.

### Summary page redesign (2026-11-10)

- `server/services/analytics/opdYoyHtml.js` renders the HTML: KPI tiles (#1–4) with change vs the same dates last year, paired 2025/2026 bars for #5–11 and GLP-1 by drug, an "All patients / Seen 3+ times" switch, a full table of every period, and a "How to read these numbers" section. Light and dark mode, phone layout, print styles. Change arrows are neutral (a rise in DKD/CAD is not "good").
- The report run now also writes `opd-yoy-<date>.json` (aggregate figures only). `node scripts/report-opd-yoy.mjs --render-only=reports/opd-yoy-<date>.json` rebuilds the page without touching the database.

### Self-review fixes (2026-11-10)

Found while re-checking the rules; the 11:36 / 11:42 production outputs predate them and need a rerun.

- **CAD with a past procedure was read as absent.** "CAD- POST PTCA (2019)" is parsed as name "cad", details "post ptca", and the note's "CAD-" was taken as the absent sign. Now a "-" followed by post / s/p / p/ / h/o / old is a separator, not a sign (same for nephropathy), and PTCA / CABG / stent is looked for in the details too. "CAD-CVA" is still read as absent (≈7 patients, ambiguous).
- **AOO written as a year** ("AOO 2015") was read as age 20; now treated as the diagnosis year.
- **"Since 12 yrs"** (a duration) gave no onset; now onset = age at the visit − 12.
- Page: label says "systolic BP"; the Awiqli "none in 2025" note comes from the data; the full table opens when printing.
- Checks: `npm run smoke:opd-yoy` 45/45; page numbers vs Excel Summary 96/96 cells match.

### 2023–2024 behind a button (2026-11-10)

- The report now also computes 2023 and 2024 "as stored in Scribe": visits = imported consultation days (status not `historical`, demo/test/blocked excluded); diagnoses read from `mo_data.raw_diagnosis` line by line (`parseRawDiagnosis`: name, `+`/`−` sign, details; a dash before POST / S/P / H/O is a separator); labs and vitals by their own dates; medicines from medicine rows dated in the year; age from DOB, else today's stored age minus the years back.
- 2025+ periods never read imported notes (an earlier run let 2023–24 AOO fill gaps in 2025: +56 patients, −0.1 yrs; fixed and covered by a check).
- Page: "Show 2023–2024 (Scribe imports)" button, off by default; when on, a warning box explains the limits, the years get fixed lighter shades, and every bar resting on fewer than 100 patients is faded and tagged "few patients".
- Production run (read-only, 84 s): 2023 — 17,466 visit days, 5,621 patients; 2024 — 11,284, 4,269. 2025–2026 unchanged from the verified run. Page vs Excel: 160/160 cells match with the button on; `smoke:opd-yoy` 53/53.

### Excel: one sheet per year (2026-11-10)

`opd-yoy-<date>.xlsx` now has one sheet per year, newest first (`2026 to 10 Nov`, `2025`, `2024 (Scribe import)`, `2023 (Scribe import)`), then `Method`. Each year sheet: title and a note (year to date / full year / import warning), the 11 figures with columns All patients | Seen 3+ times, GLP-1 by drug, and data coverage. The same-dates comparison columns are page-only. The combined Summary / Numbers / GLP-1 / Data coverage sheets were removed. The internal patient file stays one sheet with a Period column. Verified 128/128 cells against the saved figures.

Formatting pass (same day): year sheets rebuilt with exceljs as formatted tables with numeric cells (counts, ages = Mean / Median / Patients with a value / Out of, shares = Patients / Out of / %), shaded section and column headers, borders, wrapped labels, frozen title rows, landscape one page per sheet. Percentages on fewer than 100 patients are grey italic with a legend line. Checked by rendering every sheet to PDF and by comparing all 376 values with the saved figures.

### Import visit counts corrected (2026-11-10)

Measured on Mar 2025 – Feb 2026, where both the import and real appointments exist (6,370 patients in both): the import holds 1.95 dates per real visit — 15,933 exactly on a visit, 15,383 a few days off it, 2,294 far from any; 95% of real visits have an imported date within 7 days; patient counts agree (~94%). Merging a patient's imported dates ≤ 3 days apart gave 16,129 against 17,667 real (≈ 9% low by design).

Applied to the import years (`mergeNearbyImported`, chained, across New Year, later note's diagnosis kept): 2023 17,466 → 15,625 visits (patients 5,621 unchanged); 2024 11,284 → 7,191 visits, 4,269 → 4,261 patients (8 patients whose only 2024 date was a 1–3 Jan duplicate of a late-December visit). 2025 onwards unchanged. Wording on the page, year sheets and Method updated: visit counts for 2023–24 are estimates, patient counts reliable. Checks: smoke 55/55, Excel 352 values and page 160 cells match the saved figures.

### 20-patient spot check and two more fixes (2026-11-10, report as at 2026-11-09)

- Report frozen at `--as-of=2026-11-09`; share the `…-2026-11-09` files.
- 20 patients (GLP-1 yes/no 2025 and 2026, Awiqli, DKD yes/no/unclear, CAD yes/no) checked against their stored HealthRay notes and prescriptions: 20/20 correct.
- Fix 1: notes like "retinopathycad+" (no space) hid the CAD sign; the pattern now also accepts "cad" right after "…pathy" (per-visit SQL and imported-note parser).
- Fix 2 (older flaw, exposed by fix 1): a visit with an empty diagnosis list but a CAD sign in its note was taken as the patient's latest diagnosis list, so dual adiposity / DKD read as absent and denominators were wrong. Now dual adiposity, DKD and all "with a diagnosis list" denominators use the latest visit with a real list; CAD may still use a later note's sign. Biggest effect on 2025 (to 9 Nov): dual adiposity 46.3% → 49.4%, DKD 20.9% → 23.2%, CAD 9.3% → 9.0%; 2026: dual adiposity 52.0% → 53.3%, DKD 23.3% → 24.2%, CAD 10.5% → 10.3%.
- After both fixes the 20 spot-check patients are unchanged; Excel matches the saved figures; `smoke:opd-yoy` 57/57.

### Reconciled with Monthly summary (2026-11-10)

Ran the Monthly summary counting base (`opdSummary.js` `BASE`, type `opd`) read-only over 2025, 2025 to 9 Nov and 2026 to 9 Nov. Recounted one visit per patient per day, attended statuses only, report exclusions: identical to the report in all three periods (0 visits, 0 patients difference). The Monthly summary shows more because it counts every appointment row (same patient twice the same day: +1,505 rows in 2025, +291 in 2026) and counts 130 still "in visit" 2026 appointments as came.
