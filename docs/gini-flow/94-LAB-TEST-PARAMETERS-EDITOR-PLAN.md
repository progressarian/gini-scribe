# 94 — Manage each test's parameters, ranges and formulas in Settings

Status: **S1–S9 built and tested on the e2e copy (`e2e/lab-catalog/LC01–LC09`), not yet committed or
deployed — 12 Nov 2026.** On production only two things have run: the S1 migration
(`2026-12-31_lab_test_parameters_editor.sql`) and the S2 link backfill (37 tests linked; Blood Glucose
and Malaria Parasite deliberately skipped — rerun the script only with
`--skip "Blood Glucose" --skip "Malaria Parasite"`). Builds the missing S8 of
`44-LAB-TEST-CATALOG-PLAN.md` and answers the external spec "Test Parameters & Formulas — Scribe
Implementation Spec". What changed from this plan while building is in §7.

---

## 1. What was asked

> Check in Scribe and make a plan for how we can implement this and manage it dynamically for a test.

"Dynamically" = an admin opens a test in Settings and changes what it reports (fields, units, ranges,
formulas) without SQL or a deploy, and the lab's Enter-results form follows on the next open.

---

## 2. What Scribe already has

Two catalogues that do not know about each other:

| Catalogue                                 | Holds                                                                                     | Edited in                                     |
| ----------------------------------------- | ----------------------------------------------------------------------------------------- | --------------------------------------------- |
| `giniflow_test_catalog` (291 tests)       | what the floor can **order** and bill: name, station, category, billing item              | Settings → Test catalogue (`TestCatalogPage`) |
| `lab_report_catalog` + `lab_report_tests` | what a test **reports**: 41 reports, each an ordered list of fields                       | nowhere — SQL only                            |
| `lab_test_catalog`                        | 214 fields: name, unit, input type (numeric/text/group), formula, sub-fields              | nowhere                                       |
| `lab_test_ranges`                         | 137 ranges: sex, age band (days), low/high, critical low/high, text range, pregnancy flag | nowhere                                       |

They are joined only by **name matching**: an ordered test name is flattened and compared with the
report's name and `aliases` (`labCatalog.js CATALOG_SQL`, `testMatch.js tm_reports`). A rename on either
side silently breaks the link and the form falls back to guessing rows from past `lab_results`.

Already working, and kept as is:

- Formulas are stored by id (`#143039 / 5`), computed by `shared/labFormula.js` (no `eval`), shown
  live in `LabResultsForm.jsx`, and recomputed on the server at save (`labResults.applyCatalog`).
- Flags H/L and critical are set by the server from the range; unit and range are read-only on the bench.
- Range choice: the patient's sex first, then `Both`, narrowest age band; no range → no flag.
- `lab_results` stores the unit, range text and flag as they were at save, so editing the catalogue
  never changes a result already saved.

So the spec's phases 1, 2 and 4 exist as data and engine. What is missing is the **editor**, a **firm
link** from an orderable test to its report, **guardrails**, and **patient values in formulas**.

---

## 3. Design

### D1 — A firm link from an orderable test to its report

```sql
ALTER TABLE giniflow_test_catalog
  ADD COLUMN IF NOT EXISTS lab_report_id BIGINT REFERENCES lab_report_catalog(id) ON DELETE SET NULL;
```

- `catalogRowsFor` resolves an ordered test through `lab_report_id` first, then today's name/alias
  match as the fallback (so nothing breaks while the link is being filled). Both entry points use it:
  floor orders (`suggestedRows`) and HealthRay cases (`suggestedCaseRows`), whose test names reach the
  orderable test through `TEST_MATCHES_SQL`.
- Backfill script `server/scripts/link-test-catalog-reports.mjs`: uses the existing name/alias match,
  dry run first, batches of 100, skips rows already linked, prints every test it could not link or
  that matched more than one report.
- Unlinked active tests are the "not set up" backlog shown in the UI (D2), except tests marked
  **"Result is a file"** (`results_as_file BOOLEAN NOT NULL DEFAULT FALSE` on `giniflow_test_catalog`):
  ECG, X-ray, Echo, Fundus and other machine reports have no fields and must not count as missing.

Found while building S2 (12 Nov 2026):

- The backfill reuses billing's matcher (`TEST_MATCHES_SQL`: billing aliases, brackets, word order)
  as well as plain name/alias equality. Production dry run: **39 of 291** tests link to exactly one
  report, none ambiguous; **249 active tests have no report** (242 lab, 7 machine) — the catalogue only
  holds reports HealthRay sent detail for. That is the real "Not set up" backlog.
- `testMatch.js` (billing) does **not** read `lab_report_id` yet: adding a link-based hit can turn a
  single match into two and leave a bill line unmatched. It moves to a later step with its own billing
  tests.

### D2 — Where it lives: the existing Test catalogue

No new settings tab. In `TestCatalogPage`:

- the test name becomes a link to `/settings/tests/:id`;
- a **Results** column: `8 fields`, or a `Not set up` chip when no report is linked;
- a second warning line in the existing `tcat__warn` style:
  "N active lab tests have no result fields — the lab can only upload a file for them";
- a "Not set up" filter beside the All / Lab / Machine toggle;
- a **Needs attention** count per test: active numeric fields with no unit and no "no unit" tick,
  ranges that overlap, formulas pointing at an inactive field. Imported HealthRay data already breaks
  some of these (blank units are known); they are listed, never bulk-blocked.

New page `/settings/tests/:id` (full page, lazy-loaded through `lazyWithRetry`), test name as the
title, breadcrumb back to the catalogue, three tabs:

| Tab           | Holds                                                                                                   |
| ------------- | ------------------------------------------------------------------------------------------------------- |
| Details       | name, station, category, billing item (read-only link to Services) — what the page already edits inline |
| Result fields | the linked report's fields in print order; link/unlink a report; add, edit, reorder, deactivate fields  |
| History       | who changed what and when (D7)                                                                          |

After "+ Add test" saves a Lab or Machine test, it lands on Result fields with "Link an existing
report" and "Create a new report" offered.

### D3 — Result fields tab

One table, one row per field, inline save (no modal per field):

| Column   | Behaviour                                                                                                   |
| -------- | ----------------------------------------------------------------------------------------------------------- |
| ⠿ order  | drag or ↑/↓ buttons (keyboard); writes `lab_report_tests.sequence`                                          |
| Name     | the printed name                                                                                            |
| Unit     | combobox over units already used; "no unit" must be ticked explicitly for unitless numbers                  |
| Type     | Number · Text · Pick list · Calculated · Heading (group)                                                    |
| Decimals | 0–4, default 2; used by formula rounding (`labFormula.js` hard-codes 2 today) and the bench's numeric input |
| Ranges   | a chip `3 ranges` / `No range` → opens the ranges panel (D4)                                                |
| Formula  | Calculated only → the formula editor (D5), shown as names: `Triglycerides ÷ 5`                              |
| Required | `lab_report_tests.is_required` — the bench must fill it                                                     |
| Active   | off hides it from new forms; saved results keep it                                                          |

Sub-fields (CBC → Differential count → Neutrophils) show indented under their heading.

New rules (unit or "no unit", valid formula) apply when **that field** is next saved. A field that
already breaks one can still be opened and fixed; the save refuses until it is fixed, and says how.

Two admins editing the same field: every save sends the row's `updated_at`; a stale save is refused
with "Changed by <name> at <time> — reload to see it", never silently overwritten.

A field can sit in several reports (HbA1c prints in HBA1C and C-Peptide). Its unit, ranges and formula
belong to the field, so the row shows **"Also in: C-Peptide"** and the save confirmation says the change
applies to both.

Schema additions (all nullable / defaulted, additive only):

```sql
ALTER TABLE lab_test_catalog
  ADD COLUMN IF NOT EXISTS options  TEXT[],          -- Pick list choices
  ADD COLUMN IF NOT EXISTS decimals SMALLINT,        -- NULL = 2, today's rounding
  ADD COLUMN IF NOT EXISTS no_unit  BOOLEAN NOT NULL DEFAULT FALSE;
-- input_type check widened to ('numeric','text','group','select')
```

"Calculated" is not a stored type: a field is calculated exactly when it has a formula, so the spec's
"calculated with an empty formula" cannot exist.

### D4 — Ranges panel

A small table per field: Sex (Both/Male/Female) · Age from · Age to (entered in years, months or days,
stored as days) · Low · High · Critical low · Critical high · Prints as (text range).

Save checks: low ≤ high; critical low ≤ low and critical high ≥ high; no two rows with the same sex and
overlapping ages; at least one of low/high/text. Pregnancy ranges stay imported but not editable until
the form knows a patient is pregnant (plan 44 §6).

Selection rule is printed under the table so admins know what the bench will do: "Patient's sex
first, then Both; the narrowest age band wins; no match → no range, no flag."

**Fix needed in S6:** today, when the patient's sex is unknown or `Other`, `CATALOG_SQL` and
`catalogTestsByIds` accept **any** range, so a Male range can be applied. That breaks plan 44 §6.3
("never fall back to the other gender"). Unknown/Other sex → `Both` ranges only. Same for unknown age:
only ranges covering every age (0 – 36,500 days), never a guessed band.

### D5 — Formula editor

- Stored as today: `#<field id>` tokens. Rename-safe already — no migration.
- Typing `#` opens a picker of **this report's fields only** (sub-fields included). Inputs from other
  reports would stay blank on the bench (decision §5.4), so the picker does not offer them. Each pick
  shows as a chip with the name; the text underneath keeps the id. Imported formulas that already point
  outside the report are shown with a "may stay blank" note.
- Live preview: sample values per input → result, with each input's unit beside it (so the `× 100` in
  ACR is visibly a unit conversion).
- Save is refused when: the formula does not parse; an id does not exist or is inactive; it refers to
  itself or forms a loop across the whole catalogue (A → B → A).
- A field used by an active formula cannot be deactivated; the refusal names the formulas.

Known limit kept from today: inputs must be typed in the **same save**. A formula whose input belongs
to a different order (e.g. BUN/Creatinine when creatinine was in another order) stays blank. Listed in
§6.

### D6 — Patient values in formulas (eGFR)

Extend `shared/labFormula.js`:

- tokens `@age` (years), `@female` (1/0), `@weight` (kg, today's vitals only);
- operators `^`, functions `min(a,b)`, `max(a,b)` — enough for CKD-EPI 2021 and Cockcroft-Gault;
- server passes the patient values into `applyCatalog`; the browser shows them read-only above the form.

Weight is taken only from **today's** vitals for that visit, never carried forward (vitals rows repeat
the previous weight when none was taken). No weight today → the formula stays blank and says why.

eGFR fields are then created as ordinary Calculated fields by an admin — no eGFR-specific code.

### D7 — History of every change

`lab_catalog_audit` — append-only (same trigger pattern as `billing_audit`): who, when, entity
(report/field/range/link), entity id, before JSON, after JSON. The History tab reads it. Import script
re-runs keep their rule: rows edited in settings (`edited_at` set) are never overwritten.

### D8 — Access

New capability `LAB_TEST_CATALOG` (decided in plan 44 §6.4) granted to **admin** and **lab_admin**,
on the `/settings/tests/:id` route and every new endpoint. `/settings/tests` and
`/api/giniflow/test-catalog` reads also accept `LAB_TEST_CATALOG` so lab admin can reach the list
(§5.1); the list's price and billing edits stay `ADMIN`.

### D9 — API

All under `/api/lab-catalog`, routes → `server/services/labCatalog/*`, Zod schemas in `schemas/index.js`:

| Method | Path                        | Does                                                 |
| ------ | --------------------------- | ---------------------------------------------------- |
| GET    | `/tests/:catalogId`         | the test, its linked report, fields, ranges          |
| PUT    | `/tests/:catalogId/report`  | link / unlink / create-and-link a report             |
| POST   | `/reports/:id/fields`       | add a field (new, or an existing one by id)          |
| PATCH  | `/fields/:id`               | name, unit, type, decimals, options, formula, active |
| PUT    | `/reports/:id/order`        | field order                                          |
| PUT    | `/fields/:id/ranges`        | replace the field's ranges (validated as a set)      |
| POST   | `/formulas/check`           | parse, resolve, loop check, preview — no write       |
| GET    | `/reports/:id/fields?q=`    | the `#` picker (this report's fields)                |
| GET    | `/tests/:catalogId/history` | audit rows                                           |

Every write runs in one short transaction with its audit row.

---

## 4. Steps

Each step ships alone and is tested on the e2e copy (3100), never by editing real tests in production.
The test database has the catalogue **tables** but no catalogue **rows**, so S1 adds a fixture seed
(`e2e/fixtures/labCatalog.mjs`): LIPID PROFILE (8 fields, VLDL / Non-HDL / ratio formulas), HBA1C with
male and female ranges, and RFT with the BUN → Urea → Urea/Creatinine chain.

| #   | Step                                                                                                                    | Test                                                                                                                 |
| --- | ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| S1  | Migration: `lab_report_id`, `results_as_file`, field columns, `lab_catalog_audit`, capability; e2e catalogue fixture    | apply on test DB; existing form unchanged                                                                            |
| S2  | Link-first lookup for orders and cases; backfill script (dry run → apply, asked first, prod)                            | `smoke:lab-catalog`; renamed test still opens its fields; HealthRay case form unchanged                              |
| S3  | Catalogue list: Results column, warning line, Not set up filter, name → link                                            | e2e: unlinked test shows the chip and is counted                                                                     |
| S4  | Detail page read-only: fields, ranges, formulas shown as names                                                          | e2e: LIPID PROFILE shows 8 fields, VLDL as `Triglycerides ÷ 5`                                                       |
| S5  | Edit fields: add, rename, unit, type, decimals (wired into rounding), order, required, active, stale-save guard + audit | e2e: add a field → Enter results shows it in that order; ratio with 1 decimal prints 43.4                            |
| S6  | Ranges panel with validation; unknown sex/age → Both / all-ages ranges only                                             | e2e: male/female HbA1c ranges; overlapping band refused; 7.4 on a man → H; patient with sex Other gets no Male range |
| S7  | Formula editor: picker, preview, loop and missing-id checks, deactivate guard                                           | smoke: loop refused; e2e: new ratio field computes live and on save                                                  |
| S8  | Pick-list fields on the bench form                                                                                      | e2e: Urine sugar Nil/Trace/+ saves as text                                                                           |
| S9  | Patient values in formulas (`@age`, `@female`, `@weight`, `^`, min/max)                                                 | `smoke:lab-formula`: CKD-EPI 2021 known cases; no weight today → blank with reason                                   |
| S10 | Docs: this plan's status, plan 44 S8 → done, README API table                                                           | —                                                                                                                    |

S1–S4 change nothing for the lab bench. S5 is the first visible change on the floor.

---

## 5. Decisions (12 Nov 2026)

1. **Who edits:** admin and lab_admin, through `LAB_TEST_CATALOG`. Lab admin can open the Test
   catalogue list and each test's Result fields page.
2. **Verify before release:** not in this plan. Results stay released on save; a separate plan follows
   once the editor ships.
3. **Shared fields:** one field, one unit and set of ranges everywhere. The row shows "Also in: …" and
   the save confirms the change applies to every report listed.
4. **Cross-order formula inputs:** stay blank for now; only values entered in the same save are used.

---

## 6. Limits

- Only the e2e copy is used to try edits; production catalogue edits start once S5 is deployed and are
  done by admins through the page.
- HealthRay's lab master is not synced back; a change made there must be repeated here.
- Panels as orderable bundles of separate orderable tests (spec "Panels") are not built: an RFT is one
  report with 11 fields today, and bundle pricing already exists as billing packages
  (`service_item_package_parts`).
- Spec items not adopted: per-result rich text (never), a `formula_version` column (results already
  store their unit/range/flag at save; the audit table gives the history).

---

## 7. As built (12 Nov 2026)

Where the build differs from §3, or found something the plan did not know:

- **Formula editor (D5):** buttons, not a typed `#` picker — picking a field adds it at once (this report's active number
  fields), operators, numbers, brackets, Remove last, Clear. Nothing free-typed, so nothing to mistype.
  Formulas are still stored as `#id` text.
- **Formula grammar (D6):** `shared/labFormula.js` now has one parser for evaluating and for checking
  syntax: `+ − × ÷ ^`, brackets, `min(a, b)`, `max(a, b)`, `@age`, `@female` (1/0), `@weight`. No `eval`.
  CKD-EPI 2021 and Cockcroft-Gault are ordinary formulas; no eGFR field has been created on production.
- **Weight (D6):** taken only from `giniflow_vitals` recorded on the visit date (IST); the carried-forward
  `vitals` table is not used.
- **Pick lists:** the bench form shows a dropdown and the save refuses any value outside the list,
  storing the listed spelling as `result_text`.
- **Ranges (D4):** ages are stored exactly as entered; bands may meet at a boundary (HealthRay's imported
  bands do), only a real overlap is refused. Ranges are updated in place so HealthRay ids survive.
- **Bugs fixed on the bench:** an unknown or `Other` sex took any Male/Female range, and an unknown age was
  treated as 0 (newborn bands). Both now get only `Both` / all-ages ranges.
- **Import script:** `import-lab-test-catalog.mjs` no longer re-adds ranges to a field edited in Settings.
- **Decimals:** drive formula rounding on the bench and the server (default 2, as before).
- **Not built:** adding an existing field to a second report (only new fields); billing's `testMatch.js`
  still ignores `lab_report_id` (needs its own billing tests); verify-before-release (§5.2, separate plan).

Added 13 Nov 2026 after first use:

- **Formula builder only offers what can come next:** after a value only signs, `)` and `,` (inside
  `min(`/`max(` before its second value); after a sign or bracket only values. A broken sequence can no
  longer be built; the server check is unchanged.
- **Formula from words:** `POST /api/lab-catalog/reports/:reportId/formula-from-text` sends the
  description and this report's active number fields (ids, names, units — no patient data) to Claude
  (`claude-opus-5-5`, structured output). The answer goes through the same `checkFormula` as a hand-built
  one and is only placed in the builder; nothing is saved until the person clicks Save. No key → 503.
- **File-only tests on the bench:** a test marked "Results come as a file" gets no typing rows; an
  all-file order shows only the upload note.
