# 44 — Lab result fields, ranges and formulas the same as HealthRay

Status: **S1–S7 built, not deployed — 15 Sep 2026.** The catalogue holds all 5,503 stored cases:
41 reports, 214 fields (116 sub-fields, 12 headings), 137 ranges, 27 formulas, 0 unresolved formula
references. `shared/labFormula.js` (`npm run smoke:lab-formula`), catalogue-first suggestions and the
server-side recompute (`npm run smoke:lab-catalog`) and the form are in. **S8 — the Flow settings
editor — not started**, so an alias or a range is still changed only by SQL. Follows
`38-MANUAL-FLOOR-PLAN.md`, `39-HYBRID-FLOOR-PLAN.md` §15 and the results form in `LabResultsForm.jsx`.

---

## 1. What was asked

> Now I want to set the formula and reference value of each field same as HealthRay. How can I do it?

Asked on Naresh Kumar (P_103270), case 19912: HBA1C, LIPID PROFILE, C-Peptide, Fasting Blood Sugar,
Homa IR, Homa -B. The "Enter results" form showed HbA1c rows HealthRay never prints ("HbA1c IFCC",
"A1a", "P3", "HbA0"…), no formulas, and one reference range for men and women.

---

## 2. What the form does today

`labResults.suggestionsForTests()` guesses the rows from **past `lab_results`**: any row in the last two
years whose `panel_name` contains the ordered test's name, most-seen first, capped per test.

| Problem                        | Why                                                                             |
| ------------------------------ | ------------------------------------------------------------------------------- |
| Rows HealthRay never prints    | Old uploaded PDFs and other labs wrote extra analytes under the same panel name |
| Order differs from the report  | Sorted by how often a name was seen, not by HealthRay's print order             |
| One range for everyone         | The most recent row's `ref_range` string, whoever that patient was              |
| No formulas                    | VLDL, Non-HDL, ratios, HOMA-IR, HOMA-B must be worked out by hand and typed in  |
| Ranges and units can be edited | Free-text inputs on every row, so a typo becomes the patient's reference range  |

---

## 3. What HealthRay already gave us

Until the lab sync went list-only on 10 Sep 2026, it stored every case's full detail in
`lab_cases.raw_detail_json`: **5,503 cases**. No HealthRay call is needed to build this catalogue.

Each case holds `case_reports[].reports[]` (a report = what the floor calls a test: "LIPID PROFILE",
"HBA1C"), and each report holds `report_tests[]` in print order (`report_tests[].sequence`). Each
`report_tests[].test` carries:

| Field                         | Example                                                                                                            |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `id`                          | `143035`                                                                                                           |
| `name`, `name_to_be_printed`  | `VLDL Cholesterol`                                                                                                 |
| `unit`                        | `mg/dl`                                                                                                            |
| `input_type`                  | `Numeric` / `Single line` / null                                                                                   |
| `formula`                     | `#143039 / 5` — `#<test id>` refers to another test                                                                |
| `test_ref_value`              | `{gender, min_age, max_age (days), min_value, max_value, min_critical_value, max_critical_value, result_in_words}` |
| `has_sub_tests`, `parameters` | CBC-style panels with child tests                                                                                  |
| `result_multiply_by`          | `1`                                                                                                                |
| `test_sample_types`           | `Serum`                                                                                                            |

`test_ref_value` is the **one range HealthRay picked for that patient**. Collecting it across cases
gives every gender / age band the hospital has actually used.

Sample of the last 400 cases: **31 reports, 74 tests, 54 with a range, 12 with a formula.**

| Formula test                  | HealthRay formula                  | Meaning                                 |
| ----------------------------- | ---------------------------------- | --------------------------------------- |
| VLDL Cholesterol              | `#143039 / 5`                      | Triglyceride ÷ 5                        |
| Non HDL Cholestrol            | `#143038 - #143031`                | Total cholesterol − HDL                 |
| LDL / HDL Cholesterol Ratio   | `#143034 / #143031`                | LDL ÷ HDL                               |
| Total / HDL Cholesterol Ratio | `#143038 / #143031`                | Total ÷ HDL                             |
| HOMA - IR                     | `#154821 * #347783 / 405`          | Fasting glucose × fasting insulin ÷ 405 |
| Homa-B                        | `(360 * #347783) / (#154821 - 63)` | 360 × insulin ÷ (glucose − 63)          |
| Mean Blood Glucose            | `#143141 * 35.6 - 77.3`            | from HbA1c                              |
| Bilirubin, Indirect           | `#154826 - #154827`                | Total − direct                          |
| ALT/AST Ratio                 | `#142981 / #143023`                |                                         |
| Blood Urea                    | `#154820 * 2.14`                   | from BUN                                |
| BUN / Creatinine Ratio        | `#154820 / #143403`                |                                         |
| Urea / Creatinine Ratio       | `#142982 / #143403`                |                                         |

Ranges that differ by gender in the sample: HbA1c (F 4.5–6.5, M 4–6), ALT (F 0–34, M 0–45), AST
(F 0–31, M 0–35), Hemoglobin (F 12–15, M 13–17), Insulin Fasting (F 3–30, M 2.6–24.9), Osmolality
Serum, Ferritin.

---

## 4. Design

### D1 — Reports, tests, the link between them, and ranges

```sql
CREATE TABLE lab_report_catalog (
  id             BIGINT PRIMARY KEY,               -- HealthRay report id (54387 = HBA1C)
  name           TEXT NOT NULL,                    -- "HBA1C"
  aliases        TEXT[] NOT NULL DEFAULT '{}',     -- names Scribe orders use: "HbA1c"
  is_active      BOOLEAN NOT NULL DEFAULT TRUE,
  source         TEXT NOT NULL DEFAULT 'healthray', -- 'healthray' | 'manual'
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE lab_test_catalog (
  id             BIGINT PRIMARY KEY,               -- HealthRay test id (143035); manual rows use a sequence
  parent_test_id BIGINT REFERENCES lab_test_catalog(id), -- sub-tests (CBC)
  name           TEXT NOT NULL,                    -- name_to_be_printed
  unit           TEXT,
  input_type     TEXT NOT NULL DEFAULT 'numeric',  -- 'numeric' | 'text'
  formula        TEXT,                             -- kept in HealthRay's "#id" form
  canonical_name TEXT,                             -- joins lab_results for trends
  is_active      BOOLEAN NOT NULL DEFAULT TRUE,
  source         TEXT NOT NULL DEFAULT 'healthray',
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE lab_report_tests (
  report_id      BIGINT NOT NULL REFERENCES lab_report_catalog(id) ON DELETE CASCADE,
  test_id        BIGINT NOT NULL REFERENCES lab_test_catalog(id),
  sequence       INT NOT NULL,                     -- print order inside the report
  PRIMARY KEY (report_id, test_id)
);

CREATE TABLE lab_test_ranges (
  id               BIGSERIAL PRIMARY KEY,
  test_id          BIGINT NOT NULL REFERENCES lab_test_catalog(id) ON DELETE CASCADE,
  gender           TEXT NOT NULL DEFAULT 'Both',   -- 'Both' | 'Male' | 'Female'
  min_age_days     INT NOT NULL DEFAULT 0,
  max_age_days     INT NOT NULL DEFAULT 36500,
  min_value        NUMERIC,
  max_value        NUMERIC,
  min_critical     NUMERIC,
  max_critical     NUMERIC,
  text_range       TEXT,                           -- result_in_words / non-numeric ranges
  is_pregnant      BOOLEAN NOT NULL DEFAULT FALSE,
  healthray_ref_id BIGINT UNIQUE                   -- test_ref_value.id, so re-imports don't duplicate
);
```

HealthRay's own ids are kept, so a formula `#143039` points straight at `lab_test_catalog.id = 143039`
without translation. A test can sit in more than one report (HBA1C and C-Peptide both print HbA1c), so
the report ↔ test link and its print order live in `lab_report_tests`; unit, formula and ranges belong
to the test once.

`giniflow_test_catalog` (what a test costs) is untouched. It is linked to a report through
`lab_report_catalog.aliases`, filled at import by flat-name match and editable in settings.

### D2 — One-time import from stored cases, no HealthRay calls

`server/scripts/import-lab-test-catalog.mjs`:

1. Reads `lab_cases.raw_detail_json` **in batches of 200 cases** — a single query over all 5,503 times
   out (seen while writing this plan).
2. For each report → report_tests → test: upsert the report, the test (latest wins for unit, formula,
   name), the report ↔ test link with its sequence, and every distinct `test_ref_value` into `lab_test_ranges`.
3. Walks `parameters` for sub-tests with `parent_test_id`.
4. Fills `aliases` from `giniflow_test_catalog.test_name` and `lab_cases.test_names` by flat-name match.
5. Dry run by default: prints counts, every report, every formula in test names, and any formula whose
   `#id` does not resolve. `--apply` writes everything in one transaction.
6. Re-runnable: `source = 'manual'` rows and fields edited in settings are never overwritten.

### D3 — The results form uses the catalogue first

`suggestionsForTests(tests, db, patient)`:

- ordered name → `lab_report_catalog` by name or alias (flat match);
- found → its tests in `sequence` order, each with unit, `input_type`, formula, and **the range for this
  patient** — gender match first, then `Both`, age inside the band;
- not found → today's `lab_results` guess, unchanged, so a test never imported still gets a form.

The response gains `testId`, `formula`, `inputType`, `range {min, max, minCritical, maxCritical, text}`
and `calculated: true` for formula rows. `refRange` stays as the printed string ("4.5 - 6.5") so saved
rows and the patient chart look the same as before.

Patient gender and age come from `patients.sex` / `patients.age` (or `dob` when present); the case and
order contexts already join `patients`.

### D4 — Formulas are worked out in the browser, checked on the server

`shared/labFormula.js`, used by both sides:

- a tiny parser for numbers, `#id`, `+ - * /` and brackets only — **no `eval`**;
- `evaluate(formula, valuesById)` → number, or `null` when an input is missing, not a number, or a divisor
  is zero (HOMA-B when glucose = 63);
- rounded to 2 decimals, the way HealthRay prints them.

`LabResultsForm.jsx`: formula rows are read-only and recalculate as source values are typed. On save,
the server recomputes every formula from the submitted values and ignores whatever the browser sent,
so a stale screen cannot store a wrong HOMA-IR.

### D5 — Flag from the range, not from free text

`flag` = `H` / `L` against `min_value` / `max_value`, and `is_critical` against the critical limits,
set by the server on save. Unit and range inputs become read-only for catalogue rows. A test typed in
by hand (not in the catalogue) keeps today's editable unit and range.

### D6 — Flow settings → Lab tests

A new section in `FlowAdminPage.jsx`, next to Machines:

- list of reports, search by name or alias;
- a report opens its tests in order: name, unit, input type, formula (shown as test names, not `#ids`),
  and the ranges table;
- edit unit, ranges, formula, aliases, active; add a test or report by hand (`source = 'manual'`);
- saving a formula checks that every `#id` exists and there is no loop (A uses B uses A).

Capability: `LAB_TEST_CATALOG`, granted to admin and lab admin (§6.4).

---

## 5. Steps

| #   | Step                                                                                  | Test                                                                                              |
| --- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| S1  | Migration `2026-09-24_lab_test_catalog.sql`: the four tables                          | apply; tables empty                                                                               |
| S2  | Import script with `--dry-run`; review counts and unresolved formulas with the floor  | dry-run output; no writes                                                                         |
| S3  | Run the import                                                                        | counts match dry-run; LIPID PROFILE has 8 tests in HealthRay order                                |
| S4  | `shared/labFormula.js`                                                                | `smoke:lab-formula` — all 12 formulas above, missing input → null, divide by zero → null, no eval |
| S5  | `suggestionsForTests` reads the catalogue (fallback kept); range by gender and age    | `smoke:lab-catalog` — male vs female HbA1c range; unknown test falls back                         |
| S6  | Save path: recompute formulas, set `flag` / `is_critical`                             | same smoke — tampered HOMA-IR is replaced; 7.4 HbA1c on a man → H                                 |
| S7  | `LabResultsForm.jsx`: fixed order, read-only unit/range, live formula rows, H/L badge | Naresh Kumar case: Lipid profile auto-fills VLDL, Non-HDL and ratios                              |
| S8  | Flow settings → Lab tests editor                                                      | edit a range, reopen the form, new range shows                                                    |
| S9  | Docs: status here; README env/API table if routes added                               | —                                                                                                 |

Each step ships alone. After S5 the form is already HealthRay-shaped. S7 and S8 are the visible parts.

---

## 6. Decisions (floor, 15 Sep 2026)

1. **Rows outside the catalogue** (e.g. "HbA1c IFCC"): **hidden** from the form. They stay reachable
   only through "+ More" / "Add a test".
2. **Ranges and units on the bench**: **locked** for catalogue tests. Changed only in settings.
3. **No range for the patient's gender**: show **"no range"** and no flag. Never fall back to the other
   gender.
4. **Who edits the catalogue**: **admin and lab admin** — a new capability `LAB_TEST_CATALOG` granted to
   both, on the frontend route and the API.

Import notes found while starting S2:

- `report_tests[]` rows carry their own `sequence` and `is_deleted`; deleted rows are skipped.
- Sub-tests arrive in `test.parameters[]` with their own `sequence` and `main_test_id` (CBC → Differential
  Leucocyte Count → Neutrophil, Lymphocyte…).
- `test_ref_value` also carries `is_pregnant` / `pregnancy_trimester`; pregnancy ranges are imported but
  not applied until the form knows a patient is pregnant.

---

## 7. Limits

- Only tests that appear in cases stored up to 10 Sep 2026 are imported. A test HealthRay added later,
  or one never run here, is added by hand in S8.
- A range exists only for the gender / age bands HealthRay applied to real patients.
- Nothing is written back to HealthRay, and the catalogue does not follow later changes made in
  HealthRay's lab master — those are re-typed in settings (or the import re-run if detail sync ever
  returns).
- Text tests (Blood Group, Urine C/S) get a text box with no flag.
