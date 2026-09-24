# 52 — Billing: task list

Task list for `52-BILLING-PLAN.md`, phase by phase. Every task says **what**
to build, **where** it goes, the **steps**, **done when** — the check that
must pass — and its **E2E test**, which is written, run and passing before the
task is marked done. Finish and check one task before
starting the next.

## How to mark progress

| Checkbox | Status word   | Meaning           |
| -------- | ------------- | ----------------- |
| `[ ]`    | `Pending`     | Not started       |
| `[~]`    | `In progress` | Being worked on   |
| `[x]`    | `Done`        | Built and checked |

Change the checkbox and the status word together.

## Rules for every task

- `DATABASE_URL` in `.env` is **production**. A migration is applied only after
  its SQL has been reviewed, from `server/`:
  `node migrations/_runOne.mjs migrations/<file>.sql`. Every migration is
  idempotent (`IF NOT EXISTS`, `ON CONFLICT DO NOTHING`).
- Every new table has RLS enabled, `FORCE ROW LEVEL SECURITY`, and
  `REVOKE ALL … FROM anon, authenticated`, the same as
  `giniflow_patient_bills`.
- **Nothing billing-related is seeded or hardcoded** (plan D8): no group, item,
  price, category, rule, code, percentage or amount in code or migrations.
- No comments in code. Run `npm run format` before marking a task done.
- Routes are HTTP only; domain logic lives in `server/services/billing/`.
  Request bodies validate against Zod schemas in `server/schemas/index.js`.
- Permissions live in `shared/permissions.js` and are enforced on both sides:
  `src/config/routes.js` (pages) and `server/middleware/auth.js` (endpoints).
- **Every billing endpoint lives under `/api/billing`**, which is staff-only
  and gated in `server/middleware/auth.js` (P1-03):

  | Path                               | Needs              |
  | ---------------------------------- | ------------------ |
  | `/api/billing/master`              | `BILLING_MASTER`   |
  | `/api/billing/import`              | `BILLING_MASTER`   |
  | `/api/billing/settings`            | `BILLING_SETTINGS` |
  | `/api/billing/claims`              | `BILLING_CLAIMS`   |
  | `/api/billing/reports`             | `BILLING_REPORTS`  |
  | anything else under `/api/billing` | `BILLING_DESK`     |

  A route that needs a stricter permission than its path (e.g. the request
  inbox, undo clear) also checks it with `requireCapability` on the route. An
  endpoint outside `/api/billing` is never used for billing: the server lets
  any logged-in account, including a patient-app login, reach an address
  that isn't listed in its permission map.

- **Every task that adds a billing route** adds a case for it to
  `server/scripts/verify-rbac.mjs` and asserts in its e2e test that a role
  without the permission gets 403.
- New pages load through `lazyWithRetry` in `src/router.jsx`. Settings pages
  are added to `SETTINGS_TABS` in `src/pages/SettingsLayout.jsx`.
- Money is calculated in integer paise with the helpers in
  `shared/labPayment.js` (`paise`, `rupeesFromPaise`). No float arithmetic on
  rupees.
- Every create / update / delete / cancel writes a `billing_audit` row with
  `writeAudit` (P1-13) inside the same transaction; routes pass
  `auditContext(req)` down to the service. The P1-13 test fails if a billing
  service writes without it. Never pass decrypted card or Aadhaar numbers on
  purpose; `writeAudit` masks them anyway.
- **Codes** on new billing tables are unique ignoring case (unique index on
  `lower(code)`), non-blank and without spaces (plan §5, decided in the P1-04
  review). Lookups compare `lower(code)`; upserts use
  `ON CONFLICT ((lower(code)))`. Store the code as typed.
- **Inputs are strict.** Services use `cleanActive` (only `true`/`false`)
  and `readNumber` (numbers or number-like text; blank means "not set") from
  `common.js`, never `Number(x)` or truthiness on raw input (P1-16 review).
  Every whole number is checked against `INT_MAX` (use `wholeNumber`) and
  every money value against `MONEY_MAX`, so nothing too big for its column
  reaches the database (P1-25 review).
- **Services join an outer transaction.** Every billing service uses
  `inTransaction` from `server/services/billing/transaction.js`: given the
  pool it opens its own transaction; given a connection already inside a
  transaction it joins it with a savepoint. The Excel import calls the same
  service functions instead of repeating their rules (P1-15 review).
- **Every update sets `updated_at = NOW()` and `updated_by`** — there is no
  database trigger for it.
- **Anything that points at a group, subgroup, item, tax code or category is
  a "use"** and must be added to `USAGE_KINDS` in `server/services/billing/usage.js`
  — whether it is a database link, a text copy of a code, or an array of ids.
  The P1-14 tests fail automatically for a new database link or a new column
  named `scheme_code` / `patient_category` / `parent_code`; arrays of ids
  (e.g. discount rules' `group_ids`) are not caught and must be added by hand
  (P1-14 review).
- **Dates are India dates.** A `DATE` default is
  `(NOW() AT TIME ZONE 'Asia/Kolkata')::date`, never `CURRENT_DATE` (the
  database clock is UTC, so between midnight and 5:30 am IST `CURRENT_DATE`
  is yesterday). Services use the same India date for "today" (P1-09 review).
- Smoke scripts go in `server/scripts/`, run inside a transaction that is
  rolled back, and are added to `server/package.json`.

## Definition of done — every task

A task is marked `Done` only after all of these, in order:

1. **Build** the task as described.
2. **Write its e2e test** in the file named in the task's **E2E test** line.
   The test checks what the task's **Done when** says, through the real API
   and, for screens, through the real browser page.
3. **Run the test** against the local test database (Phase T):
   `npm run test:e2e -- <spec file>`.
4. **If it fails, fix the code (or the test, if the test is wrong) and run it
   again.** Repeat until it passes. Never mark a task done with a failing,
   skipped or commented-out test.
5. **Run the whole billing suite** (`npm run test:e2e:billing`) to make sure
   nothing that passed before is now broken; fix anything that is.
6. Run the task's smoke script if it has one, then `npm run format` and
   `npm run build`.
7. Mark the task `Done`, and write in the task any problem found and how it was
   fixed.

Tasks with no code (data preparation, decisions) say "No code" in their E2E
line and are checked by review instead.

**E2E tests never touch production.** They run only against the local test
database from Phase T; the setup refuses to start if `DATABASE_URL` points
anywhere else.

## Category structure used throughout

CGHS is one category with three sub-categories. Pensioner and CGHS Referral are
**not** separate categories.

- **CGHS**
  - **CGHS Paid:** the patient pays an amount the admin sets; the rest is
    claimed from CGHS.
  - **CGHS Referral:** the patient pays ₹0 every visit; the full amount is
    claimed from CGHS.
  - **Pensioner:** the patient pays ₹0; the full amount is claimed from CGHS.
- Other categories (ECHS, Senior Citizen, insurers…) and General (no
  category).

The admin creates these rows and their rules on screen or by Excel; they are
not seeded.

**Consultant fees differ per doctor per category.** Example from the hospital
(2026-09-17): a Pensioner or CGHS Referral bill is ₹350 for Dr Rahul and Dr
Beant and ₹700 for Dr Banshali; the patient pays ₹0, gets only the printout,
and the bill shows **Pending** in the CGHS pending register until CGHS pays
into the bank, when it is **Cleared** (one bill or many at once, always the
full amount).

---

## Phase 0 — Data preparation

**Phases can overlap (decided 2026-09-17).** P0-05 to P0-09 are data work by
the admin team. Phase 1 onward builds empty machinery tested with test data
and does not wait for them; only the tasks marked **Depends on** (P2-13,
P3-23, P4-38) and go-live wait for the admin team's data.

Goal: the hospital's real price list, categories and rules exist in one Excel
file before anything is built on top of them.

- [x] **P0-01 · Blank Excel template** — `Done`
  - **What:** the workbook the admin team fills in, matching plan §9 exactly.
  - **Where:** `docs/gini-flow/billing-template.xlsx`.
  - **Steps:**
    1. Create sheets `Groups`, `Subgroups`, `Items`, `Categories`,
       `Category rules`, `Category rates`, `Payment rules`, `Consultant fees`, `Discounts`,
       `Read me`.
    2. Put the column names from plan §9 in row 1 of each sheet, in the same
       order, with a frozen header row.
    3. Add drop-down validation where the value list is fixed: `kind`,
       `patient_pays`, `remainder`, `method`, `mode`, `active`.
  - **Done when:** the file opens in Excel/Sheets, every sheet has the exact
    headers, and the drop-downs offer only the allowed values.
  - **E2E test:** `e2e/billing/phase0/P0-01-blank-excel-template.spec.js` — asserts: the generated template and the committed `docs/gini-flow/billing-template.xlsx` both have the ten sheets in order, the exact headers from plan §9, a frozen header row, no data rows, a stop-style drop-down on every fixed-value column (and only those) covering rows 2–2001, and the Read me header row.
  - **Result:** Done 2026-09-17.
    - `server/services/billing/importColumns.js` holds every sheet's columns
      (key, type, required, allowed values), the single source P2-02 asks for.
    - `server/services/billing/importTemplate.js` builds the workbook with
      `exceljs` (added to `server/package.json`; the installed `xlsx` can't
      write drop-downs). P2-03 reuses it for the download.
    - `server/scripts/build-billing-template.mjs` writes
      `docs/gini-flow/billing-template.xlsx`; re-run it after any column
      change.
    - Drop-downs: `kind`, `patient_pays`, `remainder`, `method`, `mode`, and
      every yes/no column (`active` plus the other booleans, which the
      importer reads as yes/no), on rows 2–2001; required headers are shaded.
    - The Read me sheet has its header row only; P0-02 fills it.
    - Checked with `openpyxl` against plan §9 (0 mismatches) and opened with
      LibreOffice; the drop-downs survive a LibreOffice round trip.
    - **Review fixes (2026-09-17):** `Consultant fees.visit_type` is optional
      (blank = every visit type, matching the plan's "any" example);
      drop-downs added for `visit_type` (New / Follow Up / Investigation) and
      `gender` (Male / Female / Other); the test loads `exceljs` through the
      server package and compares the committed file's headers directly to
      `importColumns.js` (a deliberately broken copy fails the test).
      Noted, not changed: `doctor` names may be ambiguous (the P2 importer
      must refuse a name matching two doctors); drop-downs cover rows
      2–2001; `exceljs` 4.4.0 pulls a `uuid` with a moderate advisory that
      doesn't apply to how it is used; the file's created date is fixed on
      purpose so rebuilds are byte-identical.

- [x] **P0-02 · "Read me" sheet** — `Done`
  - **What:** plain-language instructions so the admin team fills the file
    correctly without help.
  - **Steps:**
    1. One row per column of every sheet: what it means, whether it is
       required, an example.
    2. Explain the allowed values: `full / amount / percent / nothing`,
       `claim / adjustment`, `auto / code`, `suggest / auto`.
    3. State the rules:
       - every test is its own item;
       - there are no packages;
       - dates are `YYYY-MM-DD`;
       - codes are unique;
       - a discount code may never equal a bill code;
       - an `amount` may not be higher than the price of an item the rule
         covers.
    4. Explain that a blank `visit_type` on `Consultant fees` means every
       visit type for that doctor, and that multi-value columns are
       comma-separated.
    5. Show the CGHS example: a `CGHS` row, then `CGHS Paid`,
       `CGHS Referral` and `Pensioner` rows with `parent_code = cghs`.
  - **Done when:** someone who hasn't seen the plan can fill one row of every
    sheet correctly from the Read me alone.
  - **E2E test:** `e2e/billing/phase0/P0-02-read-me-sheet.spec.js` — asserts: no doctor name, rupee amount or bill code from the hospital appears in the template code; in the generated and the committed template the Read me has the title, every rule the task lists, the value list, exactly one row per column (required, allowed values, meaning, what a blank cell means, a valid example) matching `importColumns.js`, the defaults the importer will apply, a purpose row per sheet, the "example only" notice, and placeholder-only examples of a category with sub-categories and of doctors' fees.
  - **Result:** Done 2026-09-17.
    - Each column in `server/services/billing/importColumns.js` now carries
      its meaning and an example (an empty example is written "(blank)"), and
      each sheet a one-line purpose, so the Read me can never drift from the
      columns.
    - `server/services/billing/importReadme.js` holds the title, 14 rules,
      the allowed-values list and two layout examples (a category with its
      sub-categories, and doctors' fees), written with placeholders only (see
      "No hospital data in code" below).
    - `importTemplate.js` writes it in four sections (How to fill this file,
      Allowed values, Columns sheet by sheet, Examples) with row heights set
      from the text length, because wrapped rows don't grow on their own and
      overlapped in the first render.
    - Checked by rendering the sheet through LibreOffice.
    - **Review fixes (2026-09-17):**
      - every optional column now has a `blank` value and description in
        `importColumns.js`; the Read me shows it in a new "if left blank"
        column, and the importer will apply the same values (P2-04);
      - a blank `valid_from` on Payment rules, Consultant fees and Discounts
        means "upload day, only when first created" (P2-08, P3-17a), so
        re-uploading a file never creates duplicate rate rows;
      - the hospital's default consultation fee (blank `doctor` on an item) is
        explained;
      - `general` is a reserved category code (P1-19, P2-06);
      - the header rule now says column order doesn't matter;
      - P2-04 reads the upload with `exceljs`.
    - **No hospital data in code (2026-09-17):** the examples no longer name
      real doctors, fees or bill codes. They use placeholders (`[Doctor A]`,
      `[fee]`, `[sub code 1]`) under an "Example only — nothing here is saved"
      notice; every real category, doctor, fee and code is entered by the
      admin. A test fails if a fixture doctor's name, a rupee amount or a
      `CC`-style bill code appears in the template code.

- [x] **P0-03 · Export the test list** — `Done`
  - **What:** every test the hospital runs, so none is left unpriced.
  - **Where:** a one-off script `server/scripts/export-billing-test-list.mjs`
    (read-only).
  - **Steps:**
    1. Read every active row of `giniflow_test_catalog` (name, category: lab /
       machine / echo / xray / offsite).
    2. Read every report name from the lab result catalogue (plan 44).
    3. Write one `.xlsx` with columns `test_name`, `category`, `current_price`,
       `suggested_group`.
    4. Ask before running it: it reads the production database.
  - **Done when:** the file lists every lab report and every machine, ECHO and
    X-ray test by name, with no duplicates.
  - **E2E test:** `e2e/billing/phase0/P0-03-export-the-test-list.spec.js` — asserts: the script, run against the test database, writes every fixture test exactly once with its category and price, merges a lab report into the catalogue test of the same name or alias, lists a report with no catalogue test as "No price yet", leaves out inactive reports, groups ABI/VPT as Machine and 2D Echo as ECHO in group order, flags placeholder prices, sets the filter over every column, leaves table counts unchanged, and runs as `BEGIN TRANSACTION READ ONLY` → SELECTs only → COMMIT; X-ray and Offsite get their own groups; likely-same names are flagged (not names that add more than their bracket); spelling duplicates are kept once with a note; a report for a retired catalogue test is marked retired, also through the real database.
  - **Result:** Done 2026-09-17.
    - `server/services/billing/testListExport.js` reads the active test
      catalogue, the active lab reports and the machine catalogue inside a
      read-only transaction, merges them by name and alias, and writes the
      sheet "Tests to price" with `test_name`, `category`, `current_price`,
      `suggested_group`, plus `found_in`, `possibly_same_as` and `note`.
    - `server/scripts/export-billing-test-list.mjs` runs it and prints the
      database host (never credentials) and counts.
    - **Run on production (approved, read-only):**
      `docs/gini-flow/billing-test-list.xlsx` — 70 tests: 63 Lab, 5 Machine,
      1 ECHO, 1 X-ray. None has a real price yet (catalogue prices are
      placeholders; lab reports have none).
    - **Found:** the test catalogue and HealthRay's lab reports often name the
      same test differently. The sheet flags likely pairs in
      `possibly_same_as` (e.g. CBC / Complete Blood Count(CBC), LFT / LIVER
      FUNCTION TEST (LFT), Fasting Insulin / Insulin Fasting, Vit B12 /
      Vitamin - B12). Pairs a rule can't safely spot are for the admin team to
      check by eye: Lipid panel / LIPID PROFILE, FBS / Fasting Blood Sugar,
      KFT / RFT, Urine R/M / URINE ROUTINE Micro, UACR / Microalbumin /
      Creatinine Ratio, Vit D / VITAMIN - D3, Creatinine and eGFR / SERUM
      CREATININE AND EGFR. Each real test should end up as one item.
    - **Review fixes (2026-09-17):**
      - two catalogue tests whose names differ only in spelling are kept once,
        with a note "Also listed as … (₹…) — keep one of the two" (before, the
        second was dropped silently);
      - a lab report whose test was retired in the test catalogue is marked
        "retired in test catalogue — check before pricing" instead of
        looking new;
      - a name that adds more than its bracket (e.g. "Liver Function Test
        (LFT) with GGT") is no longer flagged as the same as "LFT";
      - the sheet's filter range follows the column list;
      - importing the export module no longer opens a database connection
        (the machine catalogue is loaded only when an export runs);
      - the exported file is kept out of git (`.gitignore`:
        `docs/gini-flow/billing-test-list*.xlsx`, and the same for the P0-04
        consultant list); re-run the script for a fresh list.
      - Re-run on production (read-only): still 70 tests (39 lab reports with
        no price, 29 catalogue-only, 2 in both); no spelling duplicates and no
        retired matches; 8 rows flagged as possibly the same test.

- [x] **P0-04 · Export the consultant list** — `Done`
  - **What:** every active consultant, so each gets a New and a Follow Up
    consultation item.
  - **Where:** `server/scripts/export-billing-consultant-list.mjs`
    (read-only).
  - **Steps:**
    1. Read active doctors (id, name, role).
    2. Write an `.xlsx` with two rows per doctor: visit type `New` and
       `Follow Up`.
    3. Ask before running it: it reads the production database.
  - **Done when:** every active consultant appears twice, once per visit type.
  - **E2E test:** `e2e/billing/phase0/P0-04-export-the-consultant-list.spec.js` — asserts: the script, run against the test database, lists each fixture consultant twice (New, then Follow Up) with an empty General fee; leaves out inactive consultants, the lab-only provider and non-consultant roles; counts the last 90 days (cancelled included, 200 days ago excluded) and the next 30 days (90 days ahead excluded) separately; matches appointment names exactly, without "Dr", by short name, or by a single contains-match; reports unmatched names; flags a shared name, a possible duplicate doctor and a consultant with no appointments, but not staff logins like Lab / Lab Admin or "Dr Raj" / "Dr Rajesh Kumar"; lists other active staff on their own sheet; leaves table counts unchanged; and runs as `BEGIN TRANSACTION READ ONLY` → SELECTs only → COMMIT.
  - **Result:** Done 2026-09-17.
    - `server/services/billing/consultantListExport.js` +
      `server/scripts/export-billing-consultant-list.mjs`, read-only like
      P0-03. A consultant is an active doctor with role `consultant`, except
      the lab-only provider ("Dr. Hospital Admin", `shared/labOnly.js`).
    - Sheet "Consultants to price": `doctor`, `visit_type`, `doctor_id`,
      `short_name`, `specialty`, `chief`, `appointments_last_90_days`,
      `general_fee` (blank, for the admin team), `note`.
    - Sheet "Other active staff": every other active doctor-table user with
      role and recent appointments, so a non-consultant who sees patients is
      not missed.
    - **Run on production (approved, read-only):**
      `docs/gini-flow/billing-consultant-list.xlsx` (not in git) — 39
      consultants (78 rows, 1 chief), no shared names, 31 other active staff.
    - **Found:**
      - 20 of the 39 consultants have no appointments in the last 90 days —
        the admin team should confirm whether they still consult before
        pricing them;
      - the lab-only provider has 750 recent appointments and is correctly
        left out of the price list;
      - the "Admin" login (role admin) has 13 recent appointments — probably
        bookings made under the wrong user; the admin team should check.
    - **Review fixes (2026-09-17):**
      - a read-only check showed 10,888 appointments in the last 90 days:
        9,015 match a doctor's name exactly, 154 carry a doctor id, 1,210 have
        no doctor name, and ~509 had a HealthRay-style name that didn't match
        exactly (mostly cancelled). The export now matches names the way the
        HealthRay sync does (exact, then without "Dr"/"Dr.", then short name,
        then a contains-match used only when exactly one doctor fits); only
        10 appointments across 4 names stay unmatched;
      - the count is split into `appointments_last_90_days` and
        `appointments_next_30_days` (before, future bookings were counted
        under "last 90 days"); cancelled appointments are still counted
        (decided 2026-09-17);
      - new flag "Possibly the same person as …" for doctor names that differ
        by a typo or a whole extra word, or where one's short name is the
        other's name (doctor names only, so staff logins like "Lab" / "Lab
        Admin" are not flagged);
      - the script's summary uses a `lab_only` field instead of the note's
        wording, and prints how many appointments matched nobody.
      - **Re-run on production (read-only):** still 39 consultants, and still
        20 with no appointments in the last 90 or next 30 days, so that flag
        is real. **Duplicate records found — the admin team must decide which
        to keep before pricing:**
        - "Dr. Rahul Katya" (id 3) and "Dr. Rahul Katyal" (id 44), both
          active consultants — very likely one person;
        - "Dr. Beant Sidhu" (id 5, consultant, short name "Dr. Beant Kaur")
          and "Dr. Beant Kaur" (id 51, **MO**) — the MO record carries 266
          recent appointments, so the fee the hospital means for "Dr Beant"
          may belong to the MO record, which is not on the consultant list.
      - Dr. Anil Bhansali (id 1) is the chief consultant and is on the list.
      - Decided 2026-09-17: **Investigation visits have no consultation fee**, so consultants get New and Follow Up rows only; the template's consultation `visit_type` drop-downs now offer only New and Follow Up.

- [~] **P0-05 · Hand over to the admin team** — `In progress`
  - **What:** give the admin team the template, the Read me and both lists.
  - **Done when:** the admin team has confirmed they have all three files.
  - **E2E test:** No code — checked by review.
  - **Progress (2026-09-17):** handover pack prepared, not yet sent.
    - `docs/gini-flow/billing-handover-2026-09-17.zip` (and the same files in
      `docs/gini-flow/billing-handover/`), kept out of git because the lists
      hold production names and prices:
      - `Billing-handover-note.pdf` — what is in the pack, what to fill and in
        which order, the decisions needed first (Dr Rahul's two records, Dr
        Beant's consultant/MO records, 20 consultants with no recent
        appointments, the "Admin" login's appointments, tests listed under two
        names, no real prices yet), the rules, and what else we need (GSTIN,
        bill footer, bill and receipt number prefixes);
      - `billing-template.xlsx`, `billing-test-list.xlsx`,
        `billing-consultant-list.xlsx`.
    - **Remaining:** send the pack to the admin team and get their
      confirmation that they have all three files; then mark this task Done.

- [ ] **P0-06 · Admin team fills the service master** — `Pending`
  - **What:** `Groups`, `Subgroups`, `Items` sheets.
  - **Checklist:**
    - groups (e.g. OPD, Lab, Machine, ECHO, X-ray);
    - subgroups (e.g. Biochemistry, Haematology, Neuropathy, Cardiac);
    - every consultation item with its price;
    - every lab report with its price;
    - every machine, ECHO and X-ray test with its price.
  - **Done when:** every row from P0-03 and P0-04 has an item row with a price.
  - **E2E test:** No code — checked by review.

- [ ] **P0-07 · Admin team fills categories and rules** — `Pending`
  - **What:** `Categories`, `Category rules`, `Payment rules`,
    `Category rates` sheets.
  - **Checklist:**
    - **Categories:** CGHS with its three sub-categories (CGHS Paid, CGHS
      Referral, Pensioner) and its payer name, plus every other category.
    - **Category rules:** who belongs to each.
    - **Payment rules:** what each sub-category's patient pays, per item,
      subgroup or group and visit type:
      - CGHS Paid: an amount for the consultation items;
      - CGHS Referral and Pensioner: nothing;
      - the rest claimed.
    - **Category rates:** special prices and bill codes such as `CC02`.
  - **Done when:** every category and sub-category the hospital uses has its
    payment rules filled.
  - **Also:** the `Consultant fees` sheet — for every doctor, visit type and
    category/sub-category: the fee and what the patient pays (e.g. Pensioner
    and CGHS Referral: ₹350 Dr Rahul, ₹350 Dr Beant, ₹700 Dr Banshali, patient
    pays nothing, rest claimed).
  - **E2E test:** No code — checked by review.

- [ ] **P0-08 · Admin team fills discounts** — `Pending`
  - **What:** `Discounts` sheet.
  - **Checklist:**
    - every discount code (e.g. `CC50`): its %, flat amount or fixed price;
    - which groups, items, consultants and categories each code covers;
    - automatic rules (e.g. by age);
    - dates and usage limits.
  - **Done when:** every code reception uses today is in the sheet.
  - **Also:** doctor coupons — which doctors each coupon covers, and its limits
    per day and per doctor per day.
  - **E2E test:** No code — checked by review.

- [ ] **P0-09 · Bill settings information** — `Pending`
  - **What:** what can't come from the Excel file.
  - **Checklist:**
    - hospital GSTIN;
    - the footer text for bills;
    - the bill number prefix and receipt number prefix for the current
      financial year (e.g. `GAC/26-27/` and `RCPT/26-27/`).

    The logo and letterhead are already stored in the prescription settings
    and are reused.

  - **Done when:** all values are written down and agreed.
  - **E2E test:** No code — checked by review.

---

## Phase T — Test setup (before Phase 1)

Goal: a safe, repeatable end-to-end test setup that every later task uses.

**Status 2026-09-17: all nine tasks done. `npm run test:e2e` → 34 passed, three runs in a row.**
The only database in `.env` is production, so tests get their own local
database.

- [x] **PT-01 · Local test database** — `Done`
  - **What:** a Postgres database used only by tests.
  - **Where:** `docker-compose.yml` (the existing `postgres` service, port
    5435), a database named `gini_scribe_test`.
  - **Steps:**
    1. Start the container with `docker compose up -d postgres`.
    2. Create `gini_scribe_test`.
    3. Create the `anon` and `authenticated` roles, so the RLS lines in the
       migrations run the same as on Supabase.
  - **Done when:** `psql` connects to
    `postgres://user:pass@localhost:5435/gini_scribe_test`.
  - **E2E test:** No code — checked by connecting.
  - **Result:** Done 2026-09-17. `docker-compose.yml` now uses `postgres:17-alpine` to match production (17.6). `e2e/setup/init.sql` creates `anon`, `authenticated`, `service_role`, the `auth.jwt()/uid()/role()` helpers, and `pgcrypto` + `pg_trgm` in `public` (production's trigram indexes use `public.gin_trgm_ops`).

- [x] **PT-02 · Build the schema in the test database** — `Done`
  - **What:** the test database gets the same schema as production.
  - **Where:** `e2e/setup/buildSchema.mjs`.
  - **Steps:**
    1. Apply `server/schema.sql`, then every file in `server/migrations/`
       in name order (skipping `_runOne.mjs` and non-SQL files).
    2. Stop at the first failing file and print its name.
    3. Fix any migration that can't run on a fresh database (e.g. it expects
       Supabase-only objects) in a way that doesn't change production
       behaviour, and write down each fix.
  - **Done when:** a fresh test database builds end to end with no errors.
  - **E2E test:** `e2e/setup/buildSchema.spec.js` — a fresh build succeeds
    and the billing tables that exist so far are present.
  - **Result:** Done 2026-09-17. **Problem found:** `schema.sql` + migrations can't build a database; about ten core tables (`appointments`, `giniflow_visits`, `giniflow_lab_orders`, `lab_cases`, …) were created directly in Supabase. **Fix (approved):** one read-only, structure-only dump of production's `public` schema saved as `e2e/setup/schema-baseline.sql` (no rows, no secrets). `buildSchema.mjs` applies `init.sql` → baseline → every repo migration except the 7 old non-replayable ones in `baseline-migrations.txt` (so migrations not yet deployed, e.g. `lab_billing`, are applied), then `snapshot.sql` saves the reference rows migrations insert. Runs through `psql` in the container so `CREATE INDEX CONCURRENTLY` works. 183 files apply cleanly.

- [x] **PT-03 · Production guard** — `Done`
  - **What:** tests refuse to run against anything but the local test
    database.
  - **Where:** `e2e/setup/guard.mjs`, called first by the global setup and by
    every helper that opens a database connection.
  - **Steps:**
    1. Allow only host `localhost`/`127.0.0.1`, port `5435`, database
       `gini_scribe_test`.
    2. Otherwise stop with "E2E refused: DATABASE_URL is not the local test
       database".
  - **Done when:** pointing `DATABASE_URL` at any other database stops the run
    before anything connects.
  - **E2E test:** `e2e/setup/guard.spec.js` — the guard throws for a
    production-looking URL and passes for the test URL.
  - **Result:** Done 2026-09-17. `e2e/setup/guard.mjs`; also rejects a `?host=` override. Used by `db.mjs`, `testEnv.mjs`, `buildSchema.mjs`, `globalSetup.mjs`.

- [x] **PT-04 · Test environment file** — `Done`
  - **What:** the environment the API runs with during tests.
  - **Where:** `e2e/.env.e2e` (committed, no secrets).
  - **Steps:**
    1. `DATABASE_URL` = the test database.
    2. A test-only JWT secret and a test encryption key for
       `aadhaarCrypt.js`.
    3. Switch off every outside call: HealthRay, the lab API, Genie, Google
       Sheets, MSG91, Anthropic/Deepgram (empty credentials and any existing
       "off" flags). Cron stays off (`RUN_CRON_IN_API` unset).
    4. Confirm the Gini Flow sync that runs inside the API makes no HealthRay
       call with these settings.
  - **Done when:** the API starts with this file and logs no outside call
    during a test run.
  - **E2E test:** `e2e/setup/noExternalCalls.spec.js` — starts the API, runs a
    check-in, and asserts no request left the machine (outbound calls are
    blocked and counted).
  - **Result:** Done 2026-09-17. **Problem found:** `dotenv` fills any unset variable from the production `.env`, so a plain override would still hand production credentials to the test API. **Fix:** `testEnv.mjs` blanks every key found in `.env`, then applies `e2e/.env.e2e`; the API log shows `injecting env (0)`. `blockNetwork.mjs` is preloaded into the test API. **Second problem found by the test:** `net.connect()` passes its options wrapped in an array, which the first version of the blocker let through; fixed. `VITE_API_URL` is also forced to the test API for Vite.

- [x] **PT-05 · Install Playwright** — `Done`
  - **What:** the e2e test tool.
  - **Where:** root `package.json` (dev dependency `@playwright/test`),
    `e2e/playwright.config.js`.
  - **Steps:**
    1. Install `@playwright/test` and the Chromium browser.
    2. The config starts the API (port 3001, with `e2e/.env.e2e`) and Vite
       (port 3000) as `webServer`s.
    3. It runs specs from `e2e/`, one worker, with screenshots and traces kept
       on failure.
  - **Done when:** an empty spec runs green.
  - **E2E test:** `e2e/setup/smoke.spec.js` — the login page loads.
  - **Result:** Done 2026-09-17. `@playwright/test` 1.63 added. The Chromium download timed out, so the config uses the installed Google Chrome (`channel: "chrome"`; override with `E2E_BROWSER_CHANNEL` / `E2E_CHROME_PATH`). Test API on port 3101 and Vite on 3100, so `npm run dev` (3000/3001) keeps running. Schema build happens in `startApi.mjs` (`prepare.mjs`) because Playwright starts web servers before global setup.

- [x] **PT-06 · Reset and fixtures** — `Done`
  - **What:** every run starts from the same known data.
  - **Where:** `e2e/setup/globalSetup.mjs`, `e2e/fixtures/`.
  - **Steps:**
    1. Run the guard (PT-03).
    2. Empty all billing tables and the test patients/visits.
    3. Insert **test-only** fixtures:
       - one user per role (admin, reception_admin, reception, coordinator,
         lab);
       - a few test patients (a General adult, a 72-year-old, a CGHS Paid, a
         CGHS Referral and a Pensioner patient);
       - two test consultants;
       - a handful of catalogue tests.

    These fixtures exist only in the test database; production is never
    seeded (plan D8).

  - **Done when:** two runs in a row start from identical data.
  - **E2E test:** `e2e/setup/fixtures.spec.js` — the fixture rows exist after
    setup, and billing tables are empty.
  - **Result:** Done 2026-09-17. `reset.mjs` truncates all tables, restores the reference snapshot, inserts fixtures, and moves every sequence past 20000. **Problem found:** the first run deadlocked with the API's startup queries; the reset now uses a lock timeout and retries. Category/sub-category fixtures for the CGHS patients are added in Phase 1, when those columns exist.

- [x] **PT-07 · Test helpers** — `Done`
  - **Where:** `e2e/helpers/`.
  - **What:**
    - `loginAs(page, role)` and `apiAs(role)` (an authenticated request
      client);
    - `db` (guarded query helper);
    - `money` (rupee/paise asserts);
    - `builders` for groups, items, categories, rules, codes and bills, so each
      spec creates only the data it needs.
  - **Done when:** a spec can log in as each role and create an item in one
    line.
  - **E2E test:** `e2e/setup/helpers.spec.js` — each helper works for each
    role.
  - **Result:** Done 2026-09-17. `auth.mjs` (`apiAs`, `anonymousApi`, `loginAs`, token cache), `db.mjs`, `money.mjs`, `builders.mjs` (`insertRow`, `buildPatient`, `buildCatalogTest`, `buildScheme`, `countRows`). Billing builders are added task by task as their tables arrive. **Test fix:** `/api/auth/me` is public by design and answers `{ authenticated: false }`; the anonymous check now uses a protected reception route.

- [x] **PT-08 · Scripts** — `Done`
  - **Where:** root `package.json`.
  - **What:**
    - `test:e2e` runs all specs, or the given spec file.
    - `test:e2e:billing` runs `e2e/billing/**`.
    - `test:e2e:setup` rebuilds the test database (PT-02) and resets it
      (PT-06).
  - **Done when:** all three scripts work from a clean checkout plus Docker.
  - **E2E test:** No code beyond the scripts — checked by running them.
  - **Result:** Done 2026-09-17. `test:e2e`, `test:e2e:billing`, `test:e2e:setup` (runs `e2e/setup/rebuild.mjs`). `format` / `format:check` now include `e2e/**`. `.gitignore` keeps `e2e/.env.e2e` (no secrets) and ignores `e2e/.artifacts/`.

- [x] **PT-09 · How-to note** — `Done`
  - **Where:** `e2e/README.md`.
  - **What:** how to start the test database, build it, run one spec, run the
    billing suite, read a failure trace, and the production guard.
  - **Done when:** a new developer can run the billing suite from the note
    alone.
  - **E2E test:** No code.
  - **Result:** Done 2026-09-17. `e2e/README.md`: safety, setup, running, fixtures, helpers, failures, and how to refresh the production baseline (ask first).

---

## Phase 1 — Master data, settings, role, admin screens

Goal: admins can create, edit and delete every price-list item, category,
sub-category, category rule and category rate on screen; the new role exists;
today's lab prices keep working.

### 1A. Role and permissions

- [x] **P1-01 · New role `reception_admin`** — `Done`
  - **What:** a role for the person who manages billing data.
  - **Where:** `shared/permissions.js` (`ROLES`, role labels); user management
    screens; `src/pages/LoginPage.jsx`.
  - **Steps:**
    1. Add `RECEPTION_ADMIN: "reception_admin"` to `ROLES`, following
       `LAB_ADMIN`.
    2. Add its display label wherever role labels are listed.
    3. Make it selectable when an admin creates or edits a user.
    4. Make it appear on the login screen like the other roles.
  - **Done when:** an admin can create a user with this role and that user can
    log in.
  - **E2E test:** `e2e/billing/phase1/P1-01-new-role-reception-admin.spec.js` — asserts: an admin can create a user with this role and that user can log in.
  - **Note:** there is no role picker in the user-management screen yet; users with this role are created through `POST /api/doctors` or `server/scripts/create-staff.mjs`. `POST /api/doctors` now refuses unknown roles.

- [x] **P1-02 · Billing capabilities** — `Done`
  - **What:** five capabilities and who has them (plan §10).
  - **Where:** `shared/permissions.js`.
  - **Steps:**
    1. Add `BILLING_DESK`, `BILLING_MASTER`, `BILLING_SETTINGS`,
       `BILLING_CLAIMS`, `BILLING_REPORTS`.
    2. Grant them:
       - admin: all five;
       - reception_admin: desk, master, claims, reports;
       - reception: desk only.
    3. Grant them to **no other role** (coordinator included).
  - **Done when:** the role → capability matrix matches plan §10 exactly.
  - **E2E test:** `e2e/billing/phase1/P1-02-billing-capabilities.spec.js` — asserts: the role → capability matrix matches plan §10 exactly.
  - **Note:** admin already holds every capability (`ALL`), so only the two reception roles needed grants. The test reads the table in plan §10 directly, so the code and the plan can't drift apart.

- [x] **P1-03 · Billing API gate** — `Done`
  - **What:** close every billing endpoint by default, before any exists.
  - **Where:** `server/middleware/auth.js`, `server/scripts/verify-rbac.mjs`.
  - **Steps:**
    1. Add `/api/billing` to `DOCTOR_ONLY_PREFIXES`, so a patient-app login
       is refused.
    2. Map `/api/billing` and its five areas in `ROUTE_CAPABILITIES` (see
       "Rules for every task").
    3. Add role and patient-session cases to `verify-rbac.mjs`.
  - **Done when:** each role reaches exactly its billing areas; patient-app
    and anonymous requests are refused.
  - **E2E test:** `e2e/billing/phase1/P1-03-billing-api-gate.spec.js` — asserts: for admin, reception_admin, reception, coordinator, lab and a consultant, GET and POST on each of the six areas are refused exactly where plan §10 says; a real patient-app session is refused with "Doctor account required"; no login is refused; `/api/billing/masterful` is gated as the desk, not as master.
  - **Result:** Done 2026-09-18. The old P1-03 (checking billing screens and APIs as each role) needs screens and routes that don't exist yet; it moved to **P1-38** in 1G.

### 1B. Database: service master

- [x] **P1-04 · Migration file: service groups and subgroups** — `Done`
  - **Where:** `server/migrations/<date>_billing_service_master.sql`.
  - **Steps:**
    1. `service_groups`: `id`, `code` unique, `name`, `sort_order`,
       `is_active`, `created_at/by`, `updated_at/by`.
    2. `service_subgroups`: same columns plus `group_id` →
       `service_groups`.
    3. RLS lines for both.
    4. No rows inserted.
  - **Done when:** the SQL reads correctly and runs twice without error inside
    `BEGIN … ROLLBACK`.
  - **E2E test:** `e2e/billing/phase1/P1-04-migration-file-service-groups-and-subgroups.spec.js` — asserts: the migration runs twice on a fresh test database without error; the new tables, columns and indexes exist; RLS is on; no business rows are inserted.
  - **Result:** Done 2026-09-18. File: `server/migrations/2026-10-08_billing_service_master.sql` (dated after the newest existing migration so it replays last). Codes are unique ignoring case and can't be blank or contain spaces; names can't be blank; a group with subgroups can't be deleted; `created_by`/`updated_by` point at `doctors`. **Not yet applied to production** — waits for SQL review and approval. The e2e test database now rebuilds itself whenever a migration file changes. Review (2026-09-18): the case-insensitive code rule and the `updated_at`/`updated_by` rule are now in "Rules for every task", plan §5, P1-05, P1-06, P1-15 and P2-08. When applying to production, run outside OPD hours with `SET lock_timeout`, after checking no same-named table exists.

- [x] **P1-05 · Migration file: tax codes** — `Done`
  - **Where:** same migration file.
  - **Steps:** `tax_codes`: `id`, `code` (same rules as P1-04: unique
    ignoring case, non-blank, no spaces), `sac_hsn`, `rate_pct` (default 0),
    `is_active`, audit columns, RLS. No rows.
  - **Done when:** as P1-04.
  - **E2E test:** `e2e/billing/phase1/P1-05-migration-file-tax-codes.spec.js` — asserts: the migration runs twice on a fresh test database without error; the new tables, columns and indexes exist; RLS is on; no business rows are inserted.
  - **Result:** Done 2026-09-18. Added to `2026-10-08_billing_service_master.sql`. `rate_pct` is `NUMERIC(5,2)`, 0–100, default 0; `sac_hsn` is optional, exactly 4, 6 or 8 digits. Review (2026-09-18): the plan now says a line with GST off or no tax code is saved with no tax code and 0% (nothing seeded); migration tests check the exact database error for each refusal; P1-16 refuses deactivating a tax code used by active items. Not yet applied to production (applied together after P1-06). The migration e2e checks now share `e2e/helpers/migration.mjs`, which drops and rebuilds every table the file creates.

- [x] **P1-06 · Migration file: service items and price history** — `Done`
  - **Where:** same migration file.
  - **Steps:**
    1. `service_items` with every column in plan §5.1:
       - `code` (same rules as P1-04), `name`, `subgroup_id`,
         `base_price >= 0`, `unit`;
       - `allow_quantity`, `max_quantity`;
       - `tax_code_id`, `price_includes_tax`;
       - `kind` (consultation / test / procedure / medicine / other);
       - `doctor_id`, `visit_type`, `test_catalog_id`, `is_active`.
    2. Partial unique index on `(doctor_id, visit_type)` for active
       consultation items.
    3. Partial unique index on `test_catalog_id` where not null.
    4. `service_item_price_history`: `service_item_id`, `old_price`,
       `new_price`, `reason`, `changed_by`, `changed_at`.
    5. RLS for both.
  - **Done when:** as P1-04.
  - **E2E test:** `e2e/billing/phase1/P1-06-migration-file-service-items-and-price-history.spec.js` — asserts: the migration runs twice on a fresh test database without error; the new tables, columns and indexes exist; RLS is on; no business rows are inserted.
  - **Result:** Done 2026-09-18. Added to `2026-10-08_billing_service_master.sql`, which is now complete (5 tables). The database itself also enforces the kind rules the P1-17 service checks: a consultation item has a `New`/`Follow Up` visit type (never Investigation) and a doctor, or no doctor for the hospital default — at most one active default per visit type (`NULLS NOT DISTINCT`); any other kind has neither; a `test` item, and only a test item, links to one `giniflow_test_catalog` row; `max_quantity` (≥ 1) only when `allow_quantity`. The one-item-per-test rule counts inactive items too (plan §5.1). Price history rows need a reason and are removed with their item. **Consequence:** a test that exists only in the lab report catalogue (not in `giniflow_test_catalog`) needs a catalogue row before it can be priced; P2-05 refuses such rows with a message telling the admin to add the test first. P4-07 converts appointment visit types (Tele/OPD → Follow Up). Second review: a test checks the database's allowed kinds and visit types equal `ITEM_KINDS` / `CONSULTATION_VISIT_TYPES` in `importColumns.js`. Not yet applied to production (P1-07).

- [x] **P1-07 · Apply the service master migration** — `Done`
  - **Steps:**
    1. Review the full file.
    2. Run it with `_runOne.mjs`.
    3. List the new tables and confirm they are empty.
  - **Done when:** the tables exist in production, empty, with RLS on.
  - **E2E test:** No new spec — after applying to production, re-run `npm run test:e2e:setup` so the test database has the same migration, then the whole billing suite.
  - **Result:** Done 2026-09-18. Applied ~12:30 IST, then verified read-only from a fresh connection: all 15 indexes, 40 constraints and 54 columns are identical to the tested migration; 0 rows; RLS on and forced; no anon/authenticated grants; the app login (`postgres`) bypasses RLS and has select/insert/update/delete on all 5 tables (it also sees the 137 existing `giniflow_patient_bills` rows, which use the same lock-down). Name-clash check first (none of the 5 names existed), then applied in one transaction with `lock_timeout = 3s` by a one-off apply-and-verify script run from `server/` by the team (the agent session is not allowed to reach production). Verified in the same transaction before commit: `service_groups`, `service_subgroups`, `tax_codes`, `service_items`, `service_item_price_history` exist, 0 rows each, RLS on and forced, no anon/authenticated grants. Test database rebuilt and the whole suite re-run green.

### 1C. Database: categories, rates, settings, audit

- [x] **P1-08 · Migration file: extend `patient_schemes`** — `Done`
  - **Where:** `server/migrations/<date>_billing_categories.sql`.
  - **Steps:**
    1. Add columns:
       - `parent_code` → `patient_schemes(code)`;
       - `payer_name`;
       - `requires_referral`, `requires_referral_doc` (both default false);
       - `print_category_on_bill` (default false);
       - `allow_pay_later` (nullable).
    2. Add a trigger that refuses a row whose parent already has a parent
       (two levels only: e.g. CGHS › Pensioner is allowed, nothing below
       Pensioner).
  - **Done when:** existing rows are untouched and the trigger refuses a
    third level.
  - **E2E test:** `e2e/billing/phase1/P1-08-migration-file-extend-patient-schemes.spec.js` — asserts: existing rows are untouched and the trigger refuses a third level.
  - **Result:** Done 2026-09-18. File: `server/migrations/2026-10-09_billing_categories.sql`. Adds the six columns (booleans `NOT NULL DEFAULT FALSE`, the rest nullable), a `parent_code` link to `patient_schemes(code)` (a parent with sub-categories can't be deleted), a "not its own parent" rule, a non-blank `payer_name` rule and a partial index on `parent_code`. The trigger refuses a third level both ways: a row can't go under a sub-category, and a category that has sub-categories can't become a sub-category. Review (2026-09-18): the trigger locks the parent row while it checks, so two simultaneous edits can't create a third level (tested with two connections); `CATEGORY_DB_COLUMNS` in `importColumns.js` maps each Categories-sheet column to its database column (`print_on_bill` → `print_category_on_bill`), checked by a test; daily-cap and drop-down behaviour for sub-categories added to P1-19. Re-runnable; no rows inserted; existing rows and the existing scheme service are unchanged. **Not yet applied to production** (P1-12).

- [x] **P1-09 · Migration file: category rules and category rates** — `Done`
  - **Where:** same file.
  - **Steps:**
    1. `category_rules`:
       - `scheme_code`, `name`, `min_age`, `max_age`, `gender`;
       - `requires_card`, `mode` (`suggest` / `auto`), `priority`,
         `is_active`;
       - `UNIQUE (scheme_code, name)`.
    2. `category_item_rates`:
       - `scheme_code`, `service_item_id`, `rate` (nullable), `bill_name`,
         `bill_code`, `valid_from`, `valid_to`;
       - primary key `(scheme_code, service_item_id, valid_from)`.
    3. RLS for both. No rows.
  - **Done when:** as P1-04.
  - **E2E test:** `e2e/billing/phase1/P1-09-migration-file-category-rules-and-category-rates.spec.js` — asserts: the migration runs twice on a fresh test database without error; the new tables, columns and indexes exist; RLS is on; no business rows are inserted.
  - **Result:** Done 2026-09-18. Added to `2026-10-09_billing_categories.sql`. Differences from plan §5.2/§5.3, all stricter: links to `patient_schemes` and `service_items` are `ON DELETE RESTRICT` (not CASCADE), so the database backs up P1-19's "refuse delete when used"; a category rule must have at least one criterion (a rule with none would match every patient); ages 0–150 and min ≤ max; a rate row must change something (rate, bill name or bill code); `valid_to` not before `valid_from`; bill codes have no spaces. Gender and mode lists are checked against `GENDERS` / `CATEGORY_RULE_MODES`, and `CATEGORY_RULE_DB_COLUMNS` / `CATEGORY_RATE_DB_COLUMNS` map the sheet columns to the database. Overlapping rate periods for the same item are refused by the P1-22 service, not the database. Review (2026-09-18): `valid_from` defaults to the India date (not `CURRENT_DATE`, which is UTC), rule names are unique per category ignoring case; P1-19/P1-20/P1-21/P1-22 updated (rules only on leaf categories, tie-break, `mapGender`, auto-ending the previous rate). Not yet applied to production (P1-12).

- [x] **P1-11 · Migration file: billing settings, bill series, audit** — `Done`
  - **Where:** its own file, `server/migrations/2026-10-10_billing_settings_audit.sql` (it inserts the one settings row, and the categories file is tested to insert none).
  - **Steps:**
    1. `billing_settings`, a single row enforced by a fixed primary key:
       - `discount_stacking` (default `best_only`);
       - `allow_pay_later` (default false);
       - `max_codes_per_bill`;
       - `gst_enabled` (default false), `gstin`, `state_code`, `legal_name`;
       - `bill_footer`.

       Insert only the one row of defaults.

    2. `bill_series`: `series`, `fy`, `prefix`, `next_no`, primary key
       `(series, fy)`. No rows.
    3. `billing_audit`: `id`, `entity`, `entity_id`, `action`, `before` JSONB,
       `after` JSONB, `actor_id`, `at`, `ip`.
    4. RLS for all three.

  - **Done when:** as P1-04, and `billing_settings` has exactly one row.
  - **E2E test:** `e2e/billing/phase1/P1-11-migration-file-billing-settings-bill-series.spec.js` — asserts: the migration runs twice on a fresh test database without error; the new tables, columns and indexes exist; RLS is on; no business rows are inserted; `billing_settings` has exactly one row with the safe defaults.
  - **Result:** Done 2026-09-18. One settings row, guaranteed by a `TRUE`-only primary key, with the safe defaults (best-only stacking, pay-later off, GST off). Extra checks: a GSTIN must be a valid 15-character GSTIN whose first two digits equal `state_code`; GST can only be switched on once GSTIN, state code and legal name are filled; `max_codes_per_bill` ≥ 1 when set. `bill_series`: `fy` like `2026-27` (consecutive years), `next_no` ≥ 1, plus a `number_width` column (default 6, e.g. `000001`) so the padding is admin-set rather than hardcoded. `billing_audit` is append-only (a trigger refuses update and delete), indexed by entity, time and actor. Review (2026-09-18): the settings row can't be deleted (trigger); `billing_audit.actor_id` refuses deleting a user who appears in the log (was `SET NULL`, which the append-only trigger itself blocked); the financial-year check only does its arithmetic when the format matches. Emptying the whole log (TRUNCATE) is not blocked, because the e2e reset needs it; audit rows are kept as financial records. Not yet applied to production (P1-12).

- [x] **P1-12 · Apply the categories migration** — `Done`
  - **Steps:** review, run, confirm the new columns, tables and the single
    settings row. Two files, in order: `2026-10-09_billing_categories.sql`,
    then `2026-10-10_billing_settings_audit.sql`. Neither drops anything (the
    scheme price tables are dropped later, in P1-10, after P1-24 is live).
  - **Done when:** everything exists in production; `patient_schemes` data is
    unchanged.
  - **E2E test:** No new spec — after applying, rebuild the test database and run the whole billing suite.
  - **Result:** Done 2026-09-18. Pre-check: none of the new tables, columns or functions existed; `patient_schemes` structure matched the tested version. Applied both files in one transaction (`lock_timeout = 3s`) by a check-and-apply script run by the team. Checked before commit: the 6 existing categories were byte-for-byte unchanged (same fingerprint before and after); 6 new columns; 5 new tables with RLS on and forced and no anon/authenticated grants; `billing_settings` has its one row (best-only, pay-later off, GST off). Verified read-only afterwards from a fresh connection: 14 indexes, 49 constraints, 69 columns, 3 triggers and 3 functions identical to the tested migrations; the app login (`postgres`) bypasses RLS and has full access. Test database rebuilt and the whole suite re-run green.

### 1D. Server services

- [x] **P1-13 · Audit helper** — `Done`
  - **Where:** `server/services/billing/audit.js`.
  - **What:** `writeAudit(client, { entity, entityId, action, before, after, actorId, ip })`,
    always inside the caller's transaction.
  - **Done when:** every later service uses it, and a rolled-back transaction
    leaves no audit row.
  - **E2E test:** `e2e/billing/phase1/P1-13-audit-helper.spec.js` — asserts: every later service uses it, and a rolled-back transaction leaves no audit row.
  - **Result:** Done 2026-09-18. `server/services/billing/audit.js`: `writeAudit(client, {...})` refuses the pool (it must be the transaction's own client), requires `entity`, `entityId` and `action`, stores the id as text and empty snapshots as `NULL`. `auditContext(req)` returns `{ actorId: req.doctor.doctor_id, ip: req.ip }` for routes to pass down. The e2e test scans `server/services/billing/` and fails if any file writes SQL without calling `writeAudit`, so later services are held to it automatically. Review (2026-09-18): it opens a savepoint first, so a connection without an open transaction is refused with a clear message (the first version accepted it and saved the row on its own); sensitive keys (`scheme_ref`, `aadhaar*`, `card_no`, `card_number`, `pin`, `password`, `token`, `access_token`, `refresh_token`, any case, any depth) are stored as `[redacted]`, because the log can never be edited or deleted; actions must be one of `AUDIT_ACTIONS` (extend the list when a task needs a new one); the scan also catches `UPDATE ${table} SET` and `UPDATE public.x SET`. The scan checks files, not each individual write.

- [x] **P1-14 · "Where is it used" helper** — `Done`
  - **Where:** `server/services/billing/usage.js`.
  - **What:** given a group, subgroup, item, tax code or category, return every
    place that still uses it, so deletes can be blocked with a clear message.
  - **Steps:**
    1. Check child rows: subgroups, items, sub-categories, rules, rates.
    2. Check patients and appointments for categories.
    3. Check bill lines once they exist (Phase 4 adds that check).
  - **Done when:** it returns an empty list for an unused row and a readable
    list, e.g. "3 sub-categories under CGHS", for a used one.
  - **E2E test:** `e2e/billing/phase1/P1-14-where-is-it-used-helper.spec.js` — asserts: it returns an empty list for an unused row and a readable list, e.g. "3 sub-categories under CGHS", for a used one.
  - **Result:** Done 2026-09-18. `server/services/billing/usage.js`: `whereUsed(kind, key, db)` for `group`, `subgroup`, `item`, `taxCode`, `category` returns `{ name, uses: [{ table, column, count, text }] }` with texts like "3 sub-categories under CGHS", "4 appointments are booked as CGHS"; an unknown row is a 404. `assertUnused(kind, key, db)` throws 409 with the list and "Deactivate it instead." Category uses: sub-categories, rules, rates, patients, appointments (appointments have no database link, so they are listed by hand). Price history and the old `scheme_*` tables are not "uses": they are deleted along with the row. The e2e test reads every blocking database link into these tables and fails if the usage list misses one, so a later table that links to them (e.g. Phase 4 bill lines) must be added here before its tests pass. Review (2026-09-18): a second test finds every column named `scheme_code` / `patient_category` / `parent_code` in any table; it immediately found two uses the first version missed — `giniflow_lab_orders.scheme_code` ("3 test orders are priced as CGHS") and `scheme_cap_overrides.scheme_code` ("1 daily-limit override is recorded for CGHS") — both now counted. Unknown kinds, including `constructor` / `toString`, are refused. P1-15, P3-02 and P4-01 carry the follow-up steps. A category ever used on an appointment can only be deactivated, never deleted (D9).

- [x] **P1-15 · Service groups and subgroups service** — `Done`
  - **Where:** `server/services/billing/serviceGroups.js`.
  - **What:** list (with item counts), create, update (name, code, order),
    deactivate, delete.
  - **Steps:**
    1. Codes are unique ignoring case; a duplicate (including `lab` when
       `LAB` exists) returns 409 with a message. Find by code with
       `lower(code) = lower($1)`.
    2. Delete calls `usage.js` and returns 409 with the list when the row is
       used. If something starts using the row between that check and the
       delete, the database refuses with a foreign-key error (`23503`): catch
       it, call `whereUsed` again, and return the same 409 with the list — never
       a raw database error (P1-14 review). The same applies to every later
       delete.
    3. Every write is audited, and every update sets `updated_at = NOW()` and
       `updated_by`.
  - **Done when:** all operations work and a used group can't be deleted.
  - **E2E test:** `e2e/billing/phase1/P1-15-service-groups-and-subgroups-service.spec.js` — asserts: all operations work and a used group can't be deleted.
  - **Result:** Done 2026-09-18. `server/services/billing/serviceGroups.js` (`listGroups`, `create/update/setActive/delete` for groups and subgroups) plus a shared `server/services/billing/transaction.js` (`inTransaction`, `httpError`). Every function takes `ctx` from `auditContext(req)` and an optional `db`. Codes are trimmed, unique ignoring case (409), no spaces (400); names can't be blank; sort order is a whole number; update changes only the fields sent. A subgroup can only be created under, moved to or reactivated under an **active** group. **Deactivating a group or subgroup is refused while it still has active subgroups / items** (409 naming them) — no silent cascade. Delete locks the row, calls `assertUnused`, and turns a late foreign-key error into the same 409 with the list; an item added while a delete runs is caught (tested with two connections). Every write stamps `created_by`/`updated_by` and writes an audit row in the same transaction; a failed write leaves neither. Review (2026-09-18): handed a connection that is already inside a transaction, every billing service now **joins** it (a savepoint) instead of opening its own, so the Excel import (P2-08) can call the same functions all-or-nothing; a connection with no open transaction is refused. Only `actorId` and `ip` are taken from `ctx`. Names are unique ignoring case among groups, and among subgroups of the same group (409 "A subgroup called "Biochemistry" already exists in Lab"); a subgroup can't be moved into a group that already has one with that name. Deactivating a parent that still has active children stays **refused** (decided 2026-09-18).

- [x] **P1-16 · Tax codes service** — `Done`
  - **Where:** `server/services/billing/taxCodes.js`.
  - **What:** list, create, update, deactivate, delete (blocked when used).
    `rate_pct` must be 0–100.
  - **Steps:** deactivating a tax code that active items still use is refused
    with 409 and the list of those items (P1-05 review).
  - **Done when:** as P1-15.
  - **E2E test:** `e2e/billing/phase1/P1-16-tax-codes-service.spec.js` — asserts: create, update, deactivate and delete tax codes through the API; `rate_pct` outside 0–100 is refused; deleting a used tax code returns 409 with the "used in" list; deactivating a tax code used by an active item returns 409 with those items.
  - **Result:** Done 2026-09-18. `server/services/billing/taxCodes.js` (`listTaxCodes` with item counts, lowest rate first; `createTaxCode`, `updateTaxCode`, `setTaxCodeActive`, `deleteTaxCode`). Rate 0–100 with at most 2 decimals (checked without floating-point error, so 0.29 is accepted); SAC/HSN blank or exactly 4, 6 or 8 digits; codes unique ignoring case. Deactivating is refused while active items use it, naming them; delete is refused while any item uses it. Tested at the service level; the HTTP routes (and their 403 checks) come in P1-27. Shared helpers moved from P1-15 into `server/services/billing/common.js` (`cleanCode`, `cleanName`, `cleanOrder`, `assertCodeFree`, `lockRow`, `deleteUnused`, `auditFields`) for every later service. Review (2026-09-18): on/off must be a real `true`/`false` — the text `"false"` used to skip the "still used by active items" check and still switch the code off (also true of P1-15's groups and subgroups); numbers must be numbers or number-like text (`true` used to become 1%). Both are now shared checks in `common.js` (`cleanActive`, `readNumber`) with tests in P1-15 and P1-16.

- [x] **P1-17 · Service items service** — `Done`
  - **Where:** `server/services/billing/serviceItems.js`.
  - **What:** list with search (name/code) and filters (group, subgroup, kind,
    active, consultant), create, update, deactivate, delete.
  - **Steps:**
    1. Validate kind-specific fields:
       - a consultation item needs a visit type;
       - a test item needs a `test_catalog_id`.
    2. Refuse a second active consultation item for the same doctor + visit
       type, and a second item for the same catalogue test.
    3. A base price change requires a reason and writes
       `service_item_price_history` in the same transaction.
    4. Delete is blocked when used.
    5. Creating, moving or reactivating an item locks its subgroup
       (`FOR SHARE`) and requires it to be active, so an item can't slip into
       a subgroup that is being deactivated at the same moment (P1-15 review).
    6. Item names are unique within their subgroup, ignoring case, like
       group and subgroup names.
    7. An item can only be given an **active** tax code, locked `FOR SHARE`
       while checking, so it can't be switched off at the same moment
       (P1-16).
    8. Use the shared helpers in `common.js` rather than repeating them.
  - **Done when:** all operations work and each rule is refused with a clear
    message.
  - **E2E test:** `e2e/billing/phase1/P1-17-service-items-service.spec.js` — asserts: all operations work and each rule is refused with a clear message.
  - **Result:** Done 2026-09-18. `server/services/billing/serviceItems.js`: `listItems` (search by name/code with `%`/`_` taken literally; filters group, subgroup, kind, doctor, active; paging with a total; group/subgroup/tax code/doctor/test names joined in), `createItem`, `updateItem`, `setItemActive`, `priceHistory`, `deleteItem`. Kinds and visit types come from `ITEM_KINDS` / `CONSULTATION_VISIT_TYPES` in `importColumns.js`. Rules: a consultation needs `New`/`Follow Up` (a doctor, or none for the hospital default), other kinds have no doctor or visit type; a test item links to one active catalogue test and each test has one item; one active consultation per doctor + visit type and one default per visit type — the friendly check first, and the database's unique index mapped to the same kind of 409 when two creates race (tested deterministically); subgroup and tax code must be active and are locked `FOR SHARE`; the doctor must be active and not the lab-only provider; names unique within the subgroup; money ≥ 0 with at most 2 decimals; strict true/false and numbers. Reactivating re-checks everything. A price change needs a reason and writes `service_item_price_history`; **creating an item also writes a first history row (reason "Created")**, so the history is complete from day one. Delete is refused while category rates use the item; an unused item's history goes with it. Shared `cleanMoney` / `cleanFlag` added to `common.js`. Review (2026-09-18): "price includes tax" is refused unless the item has a tax code (also when the tax code is removed on edit); the first "Created" price-history row is kept (confirmed).

- [x] **P1-18 · "Not priced" list** — `Done`
  - **Where:** `serviceItems.js`.
  - **What:** every active catalogue test (lab, machine, ECHO, X-ray) that has
    no service item yet, and every active consultant missing a New or Follow Up
    item.
  - **Done when:** creating the missing item removes it from the list.
  - **E2E test:** `e2e/billing/phase1/P1-18-not-priced-list.spec.js` — asserts: creating the missing item removes it from the list.
  - **Result:** Done 2026-09-18. `notPricedList(db)` in `serviceItems.js` returns three lists: **tests** — active catalogue tests with no item (`no_item`) or only a deactivated one (`item_deactivated`, with its id and code), grouped by category, with the catalogue's current price; **reportsNotInCatalogue** — active lab report catalogue entries (name or alias) with no active test-catalogue match (`not_in_catalogue` / `retired_in_catalogue`), which can't be priced until an admin adds them to the test catalogue (P1-06 finding); **consultants** — one row per active consultant per missing visit type (`New` / `Follow Up`), `no_item` or `item_deactivated`, with `default_covers` saying whether the hospital default fee bills them meanwhile. Medical officers, inactive consultants and the lab-only provider are never listed. `normalizeTestName` moved to `server/services/billing/testNames.js` so this doesn't load the Excel library. Review (2026-09-18): each report row also lists `possibly_same_as` — active catalogue tests that look like the same test (the P0-03 matching: "Complete Blood Count (CBC)" → "CBC", "Vitamin B12" → "Vit B12"), so the screen can suggest adding an alias instead of a duplicate catalogue test that could be billed twice. `looksLikeSameTest` moved to `testNames.js` alongside `normalizeTestName`. The admin screen (P1-3x) should show that suggestion first.

- [x] **P1-19 · Categories and sub-categories service (extend `patientSchemes.js`)** — `Done`
  - **Where:** `server/services/patientSchemes.js`.
  - **Steps:**
    1. Accept and return the new columns.
    2. Allow `parent_code` so CGHS can hold CGHS Paid, CGHS Referral and
       Pensioner; refuse a third level with a clear message.
    3. Return categories as a tree (category with its sub-categories).
    4. Add delete (plan D9): refuse when the category is used by patients,
       appointments, sub-categories, rules, rates or bills, and offer
       deactivate instead.
    5. Audit every write.
    6. Keep `listSchemes` and `isKnownScheme` behaving as today for the GHM
       sheet. Sub-categories are valid values there too.
    7. Adding the first sub-category to a category that already has category
       rules returns those rules, so the admin can move them to a
       sub-category (a category with sub-categories can't be billed on its
       own; P1-09 review).
    8. **Daily cap with sub-categories** (decided 2026-09-18, P1-08 review):
       a parent's `daily_cap` counts appointments of the parent **and all its
       sub-categories** together (e.g. the CGHS cap counts CGHS Paid, CGHS
       Referral and Pensioner patients). A sub-category may also have its own
       cap, which counts only itself. A booking must pass both. Change
       `schemeDayCount` and `nextDatesWithRoom` in `server/services/schemeCap.js`
       accordingly, keeping the booking-lock behaviour they have today.
    9. **Labels in drop-downs:** a sub-category is shown as "CGHS › Pensioner"
       (parent label › own label) wherever categories are listed: the GHM
       sheet, the scheme settings page and the billing screens. Return
       `parent_code` and the display label from `listSchemes`.
  - **Done when:** CGHS › CGHS Paid / CGHS Referral / Pensioner can be
    created, and the GHM smoke scripts still pass (see P1-36).
  - **Also:** refuse the reserved code `general`.
  - **E2E test:** `e2e/billing/phase1/P1-19-categories-and-sub-categories-service-extend.spec.js` — asserts: CGHS › CGHS Paid / CGHS Referral / Pensioner can be created, and the GHM smoke scripts still pass (see P1-36); with a CGHS cap of 2, one Pensioner and one CGHS Paid booking fill it and a third CGHS-family booking is refused; a sub-category's own cap is enforced as well; the list shows "CGHS › Pensioner".
  - **Result:** Done 2026-09-18. `server/services/patientSchemes.js`: `listSchemes` now returns the new columns plus `parent_label` and `display_label` ("CGHS › Pensioner"), ordered parent then its sub-categories, and hides sub-categories of a retired parent from the active list; `listSchemeTree` nests them; `createScheme` / `updateScheme` accept the new fields with strict checks (booleans, payer text, `allow_pay_later` true/false/blank), refuse the reserved code `general`, a third level (clear 409 whether added or moved, including the database trigger's refusal), a duplicate label under the same parent, a retired or missing parent, retiring a parent that still has active sub-categories, and bringing a sub-category back under a retired parent; adding the first sub-category to a category that has rules returns `rules_to_move`; `deleteScheme` refuses while anything uses the category (the P1-14 list) and is audited. Every write is audited and joins an outer transaction. Existing callers keep working: the two `/api/patient-schemes` write routes now pass `auditContext(req)`. `server/services/schemeCap.js`: a booking is checked against its own category's cap and, for a sub-category, the parent's cap counting the parent and all sub-categories; the tightest is reported (`scope_label`, "…, counting its sub-categories" in the refusal message), and `nextDatesWithRoom` respects both. `shared/patientCategories.js` uses `display_label`, so drop-downs and pills show "CGHS › Pensioner". `smoke:ghm-categories` passes against the test database (5 seeded appointments; it writes to appointments, so never run it against production). `deleteUnused` in `common.js` now takes a `key` column. Note: the server-side GHM count pills still use the seed list in `shared/patientCategories.js` (as for any scheme added after the seed) — unchanged here. Review (2026-09-18): `daily_cap` now only takes a whole number ≥ 0 or blank — before, `true` became 1 and `[]` became **0 (no bookings that day)**; `isKnownScheme` also requires the parent to be active; P1-21 never auto-applies a rule left on a category that has sub-categories.

- [x] **P1-20 · Category rules service** — `Done`
  - **Where:** `server/services/billing/categoryRules.js`.
  - **What:** list by category or sub-category, create, update, deactivate,
    delete. `min_age <= max_age`; names are unique per category, ignoring
    case.
  - **Steps:** refuse a rule on a category that has sub-categories (e.g. bare
    CGHS): such a category can't be billed on its own, so the rule must name
    the sub-category (P1-09 review).
  - **Done when:** all operations work.
  - **E2E test:** `e2e/billing/phase1/P1-20-category-rules-service.spec.js` — asserts: all operations work; a rule on a category that has sub-categories is refused.
  - **Result:** Done 2026-09-18. `server/services/billing/categoryRules.js`: `listRules` (by category, active only, ordered by priority; shows "CGHS › Pensioner"), `createRule`, `updateRule` (re-checks the whole rule), `setRuleActive` (reactivating re-checks the category), `deleteRule`. Gender and mode come from `GENDERS` / `CATEGORY_RULE_MODES`. Refused: a rule on a category that has sub-categories (409, "put the rule on one of its sub-categories"), a retired or missing category, a rule with no condition, min > max, ages outside 0–150 or not whole, unknown gender/mode, non-boolean card flag, negative priority, a name already used in that category ignoring case. Every write audited; joins an outer transaction. **Race found and fixed while testing:** if a sub-category was being created at the same moment, a new rule waited for the category's lock but then checked for sub-categories with a snapshot taken before it waited, so it slipped through; the sub-category check now runs as its own query after the lock (test 9 failed before the fix, passes after). Review (2026-09-18): an **automatic** rule for a category that needs a card number (on it or its parent) must itself require a card, otherwise it can only be a suggestion (409) — so an age rule can't silently bill non-cardholders as CGHS; the list returns `category_active` so rules of a retired category show as such; deleting a rule that something refers to gives a friendly 409 (future-proof for bills that record the rule).

- [x] **P1-21 · Category resolver** — `Done`
  - **Where:** `server/services/billing/categoryResolver.js`.
  - **What:** `resolveCategory({ patient, appointment, date })` returns
    `{ category, parent, source, suggestions }`.
  - **Steps:**
    1. A category set on the appointment, else on the patient, always wins
       (Q15). If it is a sub-category (e.g. Pensioner), its parent (CGHS) is
       returned too.
    2. Otherwise, active `auto` rules in priority order; the first that matches
       (age from the patient's date of birth on that date, gender, has card) is
       used. Ties: the lowest `priority` wins, then the oldest rule (lowest
       `id`). Compare gender after normalising the patient's sex with
       `mapGender` (`server/services/healthray/mappers.js`), never raw text
       (P1-09 review).
       A rule whose category has sub-categories (left behind when the
       category gained them) is never applied automatically: it is returned
       as a suggestion flagged "move this rule to a sub-category" (P1-19
       review).
       Rules whose category (or its parent) is retired are ignored. An
       automatic rule never puts a patient into a category that needs a card
       number (`requires_ref` on it or its parent) unless the patient has a
       card saved — even if the rule was saved before the category started
       needing a card (P1-20 review).
    3. Matching `suggest` rules are returned as suggestions.
    4. Otherwise General (no category).
  - **Done when:** each of the four cases returns the expected result.
  - **E2E test:** `e2e/billing/phase1/P1-21-category-resolver.spec.js` — asserts: each of the four cases returns the expected result.
  - **Result:** Done 2026-09-18. `server/services/billing/categoryResolver.js`: `resolveCategory({ patient, appointment, date }, data)` is a pure function over `loadResolverData(db)` (all categories with display name, active flag, "needs a card" and "has active sub-categories", plus active rules by priority then id); `resolveCategoryFor(input, db)` does both. Returns `{ category, parent, source: appointment | patient | rule | general, rule, suggestions: [{ category, rule, reason }], needs_sub_category, age, age_source, warnings }`. Order: the appointment's category, else the patient's — only if active; a retired or unknown recorded category is skipped with a warning; a recorded bare parent (e.g. CGHS) is returned with `needs_sub_category` and its active sub-categories as `choose_sub_category` suggestions. Then automatic rules (first match; ties by id); a rule on a category with sub-categories only suggests (`move_rule_to_sub_category`); a card category is never applied without a saved card (`needs_card`); retired categories' rules are ignored; other matching rules become suggestions (`suggest_rule` / `lower_priority_auto_rule`), in priority order, one per category. Age is from the date of birth on the billing date (India date by default), falling back to the recorded age; no age means age rules don't match. **Deviation:** gender is normalised with the resolver's own `normalizeGender` (`M`/`male` → Male, `F`/`female` → Female, blank → unknown, anything else → Other) instead of `mapGender`, which turns `"M"` and blank into "Other". Categories load in `sort_order`, then name, so the sub-categories offered for a bare parent always come in the same order (the full suite caught them arriving in a random order).

- [x] **P1-22 · Category rates service** — `Done`
  - **Where:** `server/services/billing/categoryRates.js`.
  - **What:** a grid for one category or sub-category (every active item with
    base price and that category's rate, bill name, bill code, dates), upsert a
    row, delete a row.
  - **Steps:**
    1. `rate >= 0` or empty.
    2. `valid_to` is not before `valid_from`.
    3. Two rows for the same item may not overlap in dates. Saving a new row
       whose `valid_from` is after the start of the current open-ended row
       ends that row on the day before (`valid_to = new valid_from − 1`),
       in the same transaction; any other overlap is refused (decided
       2026-09-18). The Excel import (P2-08) uses the same save.
    4. The grid shows whether a value comes from the sub-category itself or is
       inherited from CGHS.
  - **Done when:** the grid saves and reloads correctly.
  - **E2E test:** `e2e/billing/phase1/P1-22-category-rates-service.spec.js` — asserts: the grid saves and reloads correctly.
  - **Result:** Done 2026-09-19. `server/services/billing/categoryRates.js`: `rateGrid(category, { date, groupId, subgroupId })` lists every active item with its General price, the category's own rate row on that date, the parent's (for a sub-category), and the **effective** rate, bill name and bill code with where each came from (`own` / `parent` / `base`), plus `next_valid_from` when a future rate card is loaded; `saveRate`, `deleteRate`, `rateHistory`. Saving the same start date updates that row. A new **open-ended** rate whose start is after the current open-ended row's start ends that row the day before, in the same transaction and audited; every other overlap is refused, naming the dates. **Choice made:** a _time-limited_ rate inside an open-ended one is refused rather than auto-ending the open one — auto-ending it would leave a gap after the time-limited rate ends, silently falling back to the General price. Saves for the same category + item are serialised with a transaction-scoped advisory lock, so two simultaneous saves can't overlap (tested with a held transaction; removing the lock makes it fail). Refused: a retired or unknown category, a deactivated or unknown item, a negative rate or more than 2 decimals, impossible dates, an end before the start, a row that changes nothing, a bill code with spaces. Review (2026-09-19): deleting a rate reports the rate that ends the day before it (`previous`); with `reopen_previous: true` it extends that rate over the deleted one's dates in the same transaction (audited), so undoing a mistaken rate card doesn't leave the item on the General price — not automatic, because an earlier end date may have been deliberate; the screen asks. `saveRate` returns `starts_in_past` so the screen can confirm a back-dated rate. Keeping "a time-limited rate inside an open-ended one is refused" (confirmed).

- [x] **P1-23 · Billing settings and bill series services** — `Done`
  - **Where:** `server/services/billing/billingSettings.js`,
    `server/services/billing/billSeries.js`.
  - **What:**
    - Settings: read and update the single row (stacking mode, pay-later,
      max codes, GST fields, footer). The GSTIN format is checked (15
      characters), including its last (check) character, computed with the
      standard GSTIN checksum, so a mistyped GSTIN is refused before it is
      printed on bills (P1-11 review). Settings are only ever updated, never
      deleted (the database refuses a delete).
    - Series: list, and create/update the prefix for a series (`MAIN`,
      `RCPT`) and financial year.
  - **Done when:** both save and reload; a bad GSTIN is refused.
  - **E2E test:** `e2e/billing/phase1/P1-23-billing-settings-and-bill-series-services.spec.js` — asserts: both save and reload; a bad GSTIN is refused, including one with the right shape but a wrong check character.
  - **Result:** Done 2026-09-19. `billingSettings.js`: `getSettings`, `updateSettings` (only the fields sent; strict checks; stacking from `STACKING_MODES`; footer ≤ 1000 characters; blank "codes per bill" means no limit). The GSTIN is upper-cased, checked for shape and for its check character with the standard GSTIN checksum (verified against two published valid GSTINs; a one-character typo is refused); a blank state code is filled from the GSTIN's first two digits; a GSTIN from another state is refused; GST can't be switched on until GSTIN, state code and legal name are filled, and while it is on they can't be cleared. `billSeries.js`: `listSeries` (with the formatted next number, e.g. `GAC/26-27/000001`), `saveSeries` (create or update by series + financial year; series stored in capitals; prefix without spaces, ≤ 30; width 1–12), `financialYear(date)` (April–March) and `formatNumber` for Phase 4. **The next number can only go up** — lowering it could reuse bill numbers — and must fit the width; raising it lets the hospital continue from an earlier numbering. Every change audited. Review (2026-09-19): no code changes; P4-05 now refuses prefix/width changes once a number is issued in that year and warns from 1 March when next year's series is missing; P4-23/P4-24 escape all entered text before printing. Only the regular-taxpayer GSTIN pattern is accepted (right for a hospital).

- [x] **P1-24 · Move test prices to the service master** — `Done`
  - **Where:** `server/services/pricing.js`, `server/services/giniflow/testCatalog.js`.
  - **Steps:**
    1. `testPricesFor` reads `service_items.base_price` through
       `test_catalog_id`, falling back to `giniflow_test_catalog.price` only
       for tests that have no item yet.
    2. Category prices read `category_item_rates` instead of the `scheme_*`
       tables (dropped afterwards in P1-10).
    3. The Reception station arrivals query (`receptionStation.js`,
       `scheme_opd_fee`) reads the category's consultation rate from
       `category_item_rates` instead of `scheme_opd_fees`.
    4. Remove `opdFeeFor` and `medicinePricesFor` from `pricing.js`: nothing
       calls them, and they read tables that P1-10 drops.
    5. `testCatalog.js` stops writing `price`; a price edit returns a message
       pointing to the service master.
  - **Done when:** MO test ordering and reception's lab payment queue show the
    same prices as before for every test (checked in P1-35).
  - **E2E test:** `e2e/billing/phase1/P1-24-move-test-prices-to-the-service-master.spec.js` — asserts: MO test ordering and reception's lab payment queue show the same prices as before for every test (checked in P1-35).
  - **Result:** Done 2026-09-19 — **code only; takes effect when deployed.** `server/services/pricing.js`: a test's base price is its active service item's price, else the catalogue price (`catalogBasePriceSql`, shared by every reader); a category price is the category's own rate in `category_item_rates`, else its parent's, for the India date (`testPricesFor(names, category, db, date)`); `consultationRateJoinSql` gives the Reception arrivals row the category's rate for the assigned doctor's consultation item (else the hospital default item) for the visit's type — Investigation has none, no category shows nothing, as before. Every direct catalogue-price read was switched: MO test panels (`moStation.js`), the desk's test list and arrivals fee (`receptionStation.js`), machine orders (`machineSync.js`, `machineStation.js`), machine options (`machineCatalog.js`), the admin test catalogue (`testCatalog.js`, which also shows `pricedBy` / the item code). `opdFeeFor` and `medicinePricesFor` are removed; no code reads the `scheme_*` tables any more (P1-10 can drop them once this is deployed). **Deviation:** the test catalogue still saves a price for a test that has **no** billing item — the item screens and the hospital's items don't exist yet, so blocking all price edits would leave no way to change a test price; for a test that has an active item, a price edit is refused with the item's name and code. New `shared/billingVisitType.js` (`billingVisitType`, `billingVisitTypeSql`): Investigation → none; `isNewVisitType` → New; everything else (Follow-Up, Tele, OPD) → Follow Up — a test checks the JavaScript and SQL versions agree. With no items or rates loaded, every screen shows exactly today's prices (tested); `smoke-floor-journey` and `smoke-bill-test-steps` pass against the test database. Review (2026-09-19): machine tests (the machine station's `addMachineTestOn` and the machine sync's fallback when HealthRay gives no amount) are now priced with the visit's category rate through `testPriceForVisit`, the same as lab tests — before, they always took the General price, which would have mattered as soon as category rates were loaded; rates of a retired category, or of a sub-category whose parent is retired, are no longer used (matching the resolver). The desk's test picker still lists base prices (it has no patient); the Billing Counter shows the real line.

- [ ] **P1-10 · Migration file: drop the unused scheme price tables** — `Pending`
  - **Moved here (2026-09-18):** it was ordered before P1-24, but
    `pricing.js` (`testPricesFor`, used by MO test ordering and check-in) and
    `receptionStation.js` (the arrivals list) still read these tables, so
    dropping them first would break those screens. It now runs only after
    P1-24's code is **deployed to production**.
  - **Where:** its own migration file (not the categories file, so P1-12 never
    drops anything).
  - **Steps:**
    1. Confirm no code references `scheme_test_prices`, `scheme_opd_fees` or
       `scheme_medicine_prices` (a grep over `server/`, `src/`, `shared/`;
       scripts included — `seed-scheme-demo.mjs` is removed or updated).
    2. The migration first counts rows in all three tables.
    3. It raises an error and stops if any has rows.
    4. Otherwise it drops them.
  - **Done when:** the drop only happens when all three are empty, and only
    after P1-24 is live.
  - **E2E test:** `e2e/billing/phase1/P1-10-migration-file-drop-the-unused-scheme-price.spec.js` — asserts: the drop only happens when all three are empty; a code search finds no remaining reference to the three tables.

- [ ] **P1-39 · Drop the old catalogue price column** — `Pending`
  - **Added (2026-09-21, P1-37 review):** `giniflow_test_catalog.price` is not
    a copy — it is still the live price of every test that has no billing item
    (P1-24, P1-34). Dropping it early would bill those tests at ₹0.
  - **Where:** its own migration file, plus `catalogBasePriceSql` /
    `testPricesFor` in `server/services/pricing.js` and the places that read
    the column.
  - **Steps:**
    1. Runs only after P1-24's code is deployed to production.
    2. The migration first counts active catalogue tests with no active
       billing item, and stops with an error naming them if there are any —
       so it can only run when the "Not priced" list has no tests left.
    3. The price reads switch to the item's price only; then the column is
       dropped.
  - **Done when:** the drop refuses to run while any active test has no item,
    and every floor screen shows the same prices after it.
  - **E2E test:** `e2e/billing/phase1/P1-39-drop-the-old-catalogue-price-column.spec.js`
    — asserts: the migration stops while a test has no item; once every test
    has one, it drops the column and the MO screen, reception's queue and the
    machine room show unchanged prices.

### 1E. Routes

- [x] **P1-25 · Validation schemas** — `Done`
  - **Where:** `server/schemas/index.js`.
  - **What:** Zod schemas for create/update of groups, subgroups, tax codes,
    items, categories, category rules, category rates, settings, series.
  - **Steps:** unknown fields are rejected; money fields are non-negative
    numbers with at most 2 decimals.
  - **Done when:** each endpoint in P1-26/27 uses its schema.
  - **E2E test:** `e2e/billing/phase1/P1-25-validation-schemas.spec.js` — asserts: each endpoint in P1-26/27 uses its schema.
  - **Result:** Done 2026-09-19. `server/schemas/billing.js`, re-exported from `server/schemas/index.js`: 20 schemas in `BILLING_SCHEMAS` — create/update for groups, subgroups, tax codes, items (update also takes `reason`), categories, category rules; category rate save/delete; `billingActiveSchema` (`{ is_active: true/false }`); settings update; series save; and three query schemas (item list, rules/category list, rate grid). All are strict (unknown fields refused — so a desk request can never slip in a price field); update schemas need at least one field; money is a number ≥ 0 with at most 2 decimals, or text like `1200.50` (no commas, `₹` or exponents); lists (kinds, visit types, genders, modes, stacking) come from the shared constants. The query schemas turn `active=true`/`false` text into a real boolean and refuse anything else (the P1-17 note for routes). The schemas check shape and type; business rules stay in the services. A test sends a full valid body through each schema and into the real service, so the two can't drift apart. P1-26/P1-27 must mount every route with its schema (their tests check it). Review (2026-09-19): numbers too big for the database no longer reach it — a sort order, id, cap, quantity or priority above 2,147,483,647 (the integer limit) or a money value above 9,999,999,999.99 (the `NUMERIC(12,2)` limit) gets a clear 400 in both the schemas **and** the services (shared `INT_MAX`, `MONEY_MAX`, `wholeNumber` in `common.js`); before, they reached the database and came back as a raw 500 "out of range". Bill numbers (`next_no`, `BIGINT`) may go above the integer limit.

- [x] **P1-26 · Master data routes** — `Done`
  - **Where:** `server/routes/billingMaster.js`, mounted in
    `server/index.js`, under `/api/billing/master`.
  - **What:** list/create/update/delete for groups, subgroups, items, tax
    codes, category rules and category rates, plus the "not priced" list and
    price history, all behind `BILLING_MASTER`. Category create, update
    and delete (with sub-categories and the new fields) live here too, at
    `/api/billing/master/categories`, calling the P1-19 service. The existing
    `/api/patient-schemes` routes are left as they are: their writes need
    `SCHEME_ADMIN`, which only admin holds, so extending them would lock
    reception_admin out of categories (plan §10).
  - **Steps:** a delete that is blocked returns 409 with the "used in" list.
    Query-string filters arrive as text: convert `active=true/false` to a real
    boolean (and reject anything else with 400) before calling the service,
    whose checks are strict (P1-17 review). Numbers may be passed as text.
  - **Done when:** each endpoint works and returns 403 without the capability.
  - **E2E test:** `e2e/billing/phase1/P1-26-master-data-routes.spec.js` — asserts: each endpoint works and returns 403 without the capability.
  - **Result:** Done 2026-09-19. `server/routes/billingMaster.js`, mounted in `server/index.js`, all under `/api/billing/master`: groups (list, create, update, `PUT …/active`, delete), subgroups (create, update, active, delete), `GET tax-codes` (list only — **tax-code changes are in P1-27's settings routes, admin only, as plan §10 says**), items (list with filters, `not-priced`, `:id/price-history`, create, update, active, delete), categories (tree, create, update, delete), category rules (list, create, update, active, delete), category rates (`GET :code` grid, `GET :code/items/:itemId` history, `PUT` save, `DELETE` with a body), and `GET usage/:kind/:key` for the screens to show "where it's used" before a delete. Every body and query goes through its P1-25 schema; ids in the path must be whole numbers within range and category codes must look like codes (400 otherwise). Each route also checks `BILLING_MASTER` itself, on top of the `/api/billing/master` gate (tested: removing the route check still leaves reception, coordinator and lab refused). A 4xx carries the service's details (`uses`, `active`, `conflicts`) so the screen can list them. Changes are audited with the signed-in user and IP. The existing `/api/patient-schemes` routes are unchanged. Review (2026-09-19): unexpected (5xx) errors from billing routes are logged in full with a short reference and shown to the user only as "Something went wrong — it has been logged (ref …)", so database internals (constraint and table names, error codes) are never sent; clear 4xx messages and their details are unchanged. The wrapper is `server/routes/billingHttp.js` (`billingRoute`), for every billing router. Deleting a category rate is now `DELETE /api/billing/master/category-rates/:code/items/:itemId/:validFrom?reopen_previous=true` (no request body, which some proxies drop); the body schema was replaced by `billingCategoryRateDeleteQuerySchema`.

- [x] **P1-27 · Settings routes** — `Done`
  - **Where:** `server/routes/billingSettings.js`, mounted in
    `server/index.js`, under `/api/billing/settings`.
  - **What:** read/update settings, list/update series, behind
    `BILLING_SETTINGS`. Tax code CRUD also sits here.
  - **Done when:** only admin can change these.
  - **E2E test:** `e2e/billing/phase1/P1-27-settings-routes.spec.js` — asserts: only admin can change these.
  - **Result:** Done 2026-09-19. `server/routes/billingSettings.js`, mounted in `server/index.js`, under `/api/billing/settings`, admin only (`BILLING_SETTINGS`, checked on each route as well as by the prefix gate): `GET` / `PATCH` the settings; `GET` / `PUT series` (create or update by series + year); tax codes `GET` (list), `POST`, `PATCH :id`, `PUT :id/active`, `DELETE :id`. Every body and query uses its P1-25 schema; errors go through the shared `billingRoute` (clear 4xx with details, plain 5xx). Tested over HTTP: admin can do all of it; **reception_admin, reception and coordinator get 403 on every settings endpoint** and change nothing; the GSTIN typo, "GST on without details", "next number can only go up", and "tax code in use" refusals all come back as clear 4xx with their details. Review (2026-09-19): a series must be one of `BILL_SERIES` (`MAIN` for bills, `RCPT` for receipts, in `billSeries.js`) — any other code is refused (400), so a typo like `MIAN` can't create a useless series and leave the year without a real one; saving settings or a series without changing anything returns the current values and writes no audit row.

### 1F. Admin screens

- [x] **P1-28 · Billing section in settings** — `Done`
  - **Where:** `src/pages/SettingsLayout.jsx`, `src/router.jsx`,
    `src/config/routes.js`, `src/queries/hooks/useBillingMaster.js`.
  - **Steps:**
    1. Add tabs:
       - Services;
       - Categories (the existing schemes page);
       - Category rates;
       - Discounts (Phase 3);
       - Bulk import (Phase 2);
       - Desk requests (Phase 4);
       - Billing settings.
    2. Show only the tabs the user's capabilities allow.
    3. Add TanStack Query hooks for every Phase 1 endpoint.
  - **Done when:** the tabs appear for admin and reception_admin only.
  - **E2E test:** `e2e/billing/phase1/P1-28-billing-section-in-settings.spec.js` — asserts: the tabs appear for admin and reception_admin only.
  - **Result:** Done 2026-09-19. Settings now shows a tab only when the user may open its page (the tab list reads the same `PAGE_CAPABILITIES` the route guard uses, so a tab and its gate can't disagree). New tabs: **Services** (`/settings/services`, `BILLING_MASTER`), **Category rates** (`/settings/category-rates`, `BILLING_MASTER`) and **Billing settings** (`/settings/billing`, `BILLING_SETTINGS`, admin only); "Patient schemes" is renamed **Categories**. `/settings` itself opens for admin and reception_admin and goes to the first tab they may use (admin → Patient Flow, reception_admin → Services); everyone else is sent home. reception_admin sees Services and Category rates only; Patient Flow, Prescription, Test catalogue, Categories and Billing settings stay admin-only (a deep link sends them home). `src/queries/hooks/useBillingMaster.js` has a query or mutation hook for every `/api/billing/master` and `/api/billing/settings` endpoint (the test compares it with the route files, so a new endpoint without a hook fails). The three new pages are simple read-only starters (groups list, a category's rate grid, current settings and series) that P1-29, P1-32 and P1-33 turn into the real screens. Not done on purpose: **Discounts, Bulk import and Desk requests tabs are added with their pages in Phases 3, 2 and 4** — a tab with no page behind it would be a broken screen. **Categories stays admin-only until P1-31**, because the current page still saves through the admin-only `/api/patient-schemes`; P1-31 moves it to `/api/billing/master/categories` and opens it to reception_admin. Review (2026-09-19): switching category on the Category rates tab no longer shows the previous category's rates while the new ones load (it shows "Loading…"; old rows are kept only when a filter changes within the same category); the Category rates and Billing settings tabs show "Could not load …" on a failed request instead of loading forever; saving, switching off or deleting an item or a category rate also refreshes the floor's price lists (`giniflow` queries), so the Reception desk in the same browser doesn't show an old price for up to 10 minutes; the Categories page title now says "Categories" to match its tab; the "turned away" tests also check the user did not land on `/login` and the app loaded, so a broken login can't make them pass. Bug fix (2026-09-21, reported in manual testing): with seven tabs the Settings tab row no longer fitted small screens — on a phone (390 px) it ran to 665 px, pushing the whole page 275 px wider than the screen and hiding Services, Category rates and Billing settings off the edge. The row now scrolls sideways inside itself like the app's main navigation (no wrapping, no scrollbar) and the selected tab scrolls into view. The Patient Flow tab's card grid (min 400 px per column) also overflowed on phones; its columns now shrink to the screen (`minmax(min(400px, 100%), 1fr)`). Desktop layout unchanged. Test 13 checks every settings page fits a 390 px screen with its tab in view. Still pre-existing: the Prescription tab is 11 px too wide at 360 px.

- [x] **P1-29 · Services page** — `Done`
  - **Where:** `src/pages/billing/ServicesSettingsPage.jsx`.
  - **Steps:**
    1. Left: groups and their subgroups (add, rename, reorder, deactivate,
       delete).
    2. Right: items of the selected subgroup: search, filters, add/edit form
       (name, code, price, unit, quantity rules, tax code, kind, consultant
       and visit type, or catalogue test).
    3. A price change asks for a reason; a history drawer shows past prices.
    4. A blocked delete shows the "used in" list.
  - **Done when:** a group, subgroup and item can be created, edited and
    deleted from the screen.
  - **E2E test:** `e2e/billing/phase1/P1-29-services-page.spec.js` — asserts: a group, subgroup and item can be created, edited and deleted from the screen.
  - **Result:** Done 2026-09-19. `/settings/services` (`src/pages/billing/ServicesSettingsPage.jsx`, parts in `src/components/billing/`). **Left:** groups with their subgroups — add, rename, move up/down, deactivate/activate, delete (delete asks "Confirm delete" first); "All items" or a group or subgroup picks what the right side lists. **Right:** the items, with search (name or code), a kind filter and active/off filter; "+ Add item" is enabled once a subgroup is picked; each row has Edit, History, Deactivate/Activate and Delete. **Item form:** name, code, subgroup, kind, price, unit, "quantity can be more than 1" with an optional max, tax code (and "price includes tax" once one is chosen), consultant (or hospital default) and visit type for a consultation, catalogue test for a test (tests that already have an item are not offered). A server refusal is shown inside the form. **Price change:** changing the price shows a required "Reason for the price change" field; saving without a price change needs no reason and writes no history. **History drawer:** every price with old → new, reason, who and when. **Blocked delete:** a "can't be deleted" dialog lists where it is used and offers "Deactivate instead"; if that is refused too (e.g. a subgroup that still has active items) the reason is shown in the dialog. New endpoint `GET /api/billing/master/items/choices` (`BILLING_MASTER`) gives the form its lists — kinds and visit types from the server's own vocabulary, active catalogue tests with the item already linked to each, and active consultants without the lab-only provider — plus the `useBillingItemChoices` hook. Tested in Chrome as reception_admin: create/rename a group, add and reorder subgroups, create other/test/consultation items, a duplicate-code refusal in the form, a price change with reason and its history, filters, deactivate/activate, both blocked-delete cases, and deleting item, subgroups and group. Test helper `e2e/helpers/browser.mjs` (`gotoReady`) reloads a page only when Chrome reported `net::ERR_NETWORK_CHANGED` (documented in `e2e/README.md`). Review (2026-09-19): the item form no longer loses work to a stray click — clicking outside it or pressing Escape closes it straight away only when nothing was changed, otherwise it asks "Discard your changes?" (Keep editing / Discard); every billing dialog keeps keyboard focus inside while open and hands it back to the button that opened it; editing an item whose consultant, tax code or catalogue test has since been switched off shows that choice marked "(inactive)" / "(retired)" instead of wrongly reading "Hospital default" / "No tax" / "Choose a test"; switching group or subgroup shows "Loading…" instead of the previous subgroup's items (old rows are kept only while typing a search); the heading follows a rename, and "+ Add item" is disabled with a hint while the chosen subgroup is off; the ↑/↓ buttons are locked while a move is saving, so a double click can't scramble the order; prices with paise always show two decimals (₹175.50). Fixing the discard prompt also caught a real bug: without separate keys React reused the "Keep editing" button as the Save button mid-click, so "Keep editing" submitted the form.

- [x] **P1-30 · "Not priced" tab** — `Done`
  - **Where:** Services page.
  - **What:** the P1-18 list, each row with "Create item" that opens the item
    form pre-filled (name, test link or consultant + visit type).
  - **Done when:** creating an item removes the row.
  - **E2E test:** `e2e/billing/phase1/P1-30-not-priced-tab.spec.js` — asserts: creating an item removes the row.
  - **Result:** Done 2026-09-19. The Services page has an **Items / Not priced · N** switch (N = tests + consultant fees missing). The Not priced view (`src/components/billing/NotPricedPanel.jsx`) shows the P1-18 list in three tables. **Tests without an item** (name, category, catalogue price, status): "Create item" opens the item form pre-filled with the test name, kind test, the catalogue test and its catalogue price — the admin picks a subgroup and a code. **Consultants without a fee** (one row per missing visit type, with what they are billed meanwhile: the hospital default fee or nothing): "Create item" pre-fills kind consultation, the consultant, the visit type and a name. Where the missing item exists but is switched off, the row offers "Activate CODE" instead of Create (a test can only ever have one item). **Lab reports not in the catalogue** are listed with their "possibly the same as" suggestion and no button — they need a catalogue test (admin, Test catalogue tab) before they can be priced. Saving or activating refreshes the list, so the row disappears. Closing a pre-filled form without changes creates nothing.

- [x] **P1-31 · Categories page (extend `SchemesSettingsPage.jsx`)** — `Done`
  - **Steps:**
    1. Show categories as a tree, e.g. **CGHS › CGHS Paid, CGHS Referral,
       Pensioner**. "Add sub-category" sits on each top-level category;
       sub-categories have no "add" button (two levels only).
    2. Add fields: payer name (sub-categories inherit it from CGHS unless set),
       needs referral, needs referral scan, print category on bill, pay-later
       (follow global / allow / don't allow).
    3. Add a "Who belongs" panel for category rules (age range, gender, has
       card, suggest/auto, priority).
    4. Add delete with the "used in" message.
    5. Wherever a category is chosen (GHM sheet, patient record, Billing
       Counter), sub-categories appear indented under their parent, e.g.
       "CGHS › Pensioner".
  - **Done when:** CGHS with its three sub-categories can be created, and
    existing GHM category pills still render.
  - **E2E test:** `e2e/billing/phase1/P1-31-categories-page-extend-schemessettingspage-jsx.spec.js` — asserts: CGHS with its three sub-categories can be created, and existing GHM category pills still render.
  - **Result:** Done 2026-09-19. `/settings/schemes` ("Categories" tab) is rebuilt on the `/api/billing/master/categories` endpoints and is now open to `BILLING_MASTER` (admin and reception_admin; it was admin-only via `SCHEME_ADMIN`, which still guards the old `/api/patient-schemes` writes). **Left:** the category tree — each top-level category with its sub-categories under it and an "Add sub-category" form; sub-categories have none (two levels only); "Add category" at the bottom. **Right, details:** label, colour, patients per day, payer name (a sub-category shows its parent's payer as the placeholder, "Same as CGHS: …"), pay later (follow the billing setting / allow / don't allow), card number required, needs a referral, needs the referral scanned, print the category on the bill; Save sends only what changed; Retire / Bring back; Delete asks first and, when the category is in use, shows the "used in" list with "Deactivate instead" (its refusal, e.g. active sub-categories, is shown in the dialog). **Right, Who belongs:** the category's rules (age range, gender, has card, suggest/automatic, priority) with add, edit, activate/deactivate and delete; server refusals (e.g. a rule with no condition, an automatic rule without a card for a card category) show in the form. A category with sub-categories takes no rules of its own; when its first sub-category is added, the rules it already had are listed with a "Move to…" picker. Pickers: the shared vocabulary marks sub-categories (`sub`) and the patient record's scheme dropdown indents them under their parent ("CGHS › Pensioner"); the GHM sheet already reads `display_label`. The rule vocabularies (`GENDERS`, `CATEGORY_RULE_MODES`, …) moved to `shared/billingVocab.js` so the screen uses the server's own lists (`importColumns.js` re-exports them). The small code+name add form is now `src/components/billing/AddForm.jsx`, shared with the Services page. Billing Counter pickers arrive with the counter (Phase 2). Review (2026-09-19): **only an admin can change a category's patients-per-day limit** — the server refuses a `daily_cap` change (or a non-empty cap on create) from anyone without `ADMIN` with a 403, and for reception_admin the field is read-only with a note; everything else on the page stays open to reception_admin. Clicking another category with unsaved edits asks "Discard your changes to …?" (Keep editing / Discard) instead of silently dropping them. "Move to…" lists only active sub-categories. The "can't be deleted" dialog says "Retire instead" on this page, matching its Retire / Bring back wording. Each top-level category shows a small "+ Sub-category" button that opens the add form, instead of an open form under every category. Also fixed a pre-existing flaky check in the P1-13 audit test: it searched the whole audit row (including its random id) for "5678", so an id containing those digits failed it; it now checks only the before/after snapshots. Not changed here: the GHM sheet builds its category pills from the starting list when its page loads, so new categories get no pill of their own (labels and dropdowns are right); that is a separate GHM change.

- [x] **P1-32 · Category rates page** — `Done`
  - **Where:** `src/pages/billing/CategoryRatesPage.jsx`.
  - **What:** pick a category or sub-category → grid of items (group,
    subgroup, item, base price, category rate, bill name, bill code, valid
    from/to, inherited from parent or own), inline edit, filter by group, clear
    a row.
  - **Done when:** a CGHS rate with bill code `CC02` can be saved for a
    consultation item and shows as inherited under CGHS Paid, CGHS Referral
    and Pensioner.
  - **E2E test:** `e2e/billing/phase1/P1-32-category-rates-page.spec.js` — asserts: a CGHS rate with bill code `CC02` can be saved for a consultation item and shows as inherited under CGHS Paid, CGHS Referral and Pensioner.
  - **Result:** Done 2026-09-19. `/settings/category-rates` (`src/pages/billing/CategoryRatesPage.jsx`): pick a category or sub-category (sub-categories indented under their parent), optionally a group and an "as of" date; the grid lists every active item with group › subgroup, item and code, base price, the rate in effect (marked **Own**, **From CGHS** or **Base price**), bill name and bill code (marked "From CGHS" when inherited), the own rate's dates and "Changes on …" when a later rate is waiting. **Edit** opens the row inline: rate, bill name, bill code, from and to. The rate box is filled only from the category's own rate — the inherited or base price shows as a hint — so setting just a bill code doesn't freeze today's price into the category. "From" defaults to today, so a price change starts a new rate and the server closes the old one the day before (earlier bills keep their price); a rate starting in the past warns. **Clear** removes the category's own rate; when an earlier rate ended the day before, it also offers "Clear and go back to ₹X" (the P1-22 `reopen_previous`). A refused save shows the reason in the row. Tested: CGHS ₹800 + `CC02` on a consultation item shows as inherited under CGHS Paid, CGHS Referral and Pensioner; Pensioner's own ₹600 overrides only Pensioner; a bill-code-only row keeps the inherited rate; group filter; a change from tomorrow; clearing back to the earlier rate; clearing a sub-category back to the parent; a refused bill code. Review (2026-09-21): the grid now also returns **today's date**, so looking at rates "as of" an older date no longer backdates an edit — the "From" box starts at today (or at the viewed date when that is in the future), and only a deliberate change starts a rate in the past. **Clear** stays disabled ("Checking…") until the screen knows whether an earlier rate ends the day before, so a quick click can't delete a rate and leave a gap where "Clear and go back to ₹X" should have been offered. Each row has **History**, a drawer listing every rate for that item in this category with its dates, rate and bill code, and a Clear on any of them — the only way before to remove a future rate was to switch the "as of" date to it first. A **Search** box filters the grid by item name or code, like the Services page.

- [x] **P1-33 · Billing settings page** — `Done`
  - **Where:** `src/pages/billing/BillingSettingsPage.jsx`.
  - **Steps:**
    1. Settings: discount stacking, pay-later toggle, max codes per bill, bill
       footer.
    2. GST: switch, GSTIN, state, legal name, tax code list.
    3. Number series: prefix per financial year for bills and receipts.
    4. A note that the logo and letterhead come from Prescription settings.
    5. The page is visible to admin only.
  - **Done when:** every value saves and reloads.
  - **E2E test:** `e2e/billing/phase1/P1-33-billing-settings-page.spec.js` — asserts: every value saves and reloads.
  - **Result:** Done 2026-09-21. `/settings/billing` (`src/pages/billing/BillingSettingsPage.jsx`), admin only, in four cards. **Bills:** when several discounts apply (only the best / each rule's in turn), most codes on one bill (empty = no limit), allow pay later (a category can override it), bill footer, and a note that the logo and letterhead come from **Prescription settings** (linked). **GST:** charge GST, GSTIN, state code (filled from the GSTIN when empty), legal name; the server's refusals show in the card — GST can't be switched on until GSTIN, state and legal name are filled, a GSTIN whose last character doesn't match is refused, and those details can't be cleared while GST is on. After a save the card reloads from what the server stored, so an upper-cased GSTIN and an auto-filled state code don't look like unsaved changes. **Tax codes:** list (code, SAC/HSN, rate, items using it, active) with add, inline edit, switch off/on and delete; a code still used by an item shows the "used in" list. **Number series:** for the current financial year, or next year's ahead of April, one row each for Bills and Receipts with prefix, digits and next number and a preview of the next number ("GH/26-27/00041"); "Set up" creates a missing row; lowering the next number is refused with the reason in the row. Each card saves only what changed. The stacking modes, the bill series codes and the financial-year rule moved to `shared/billingVocab.js` so the page and server share them. P1-28's settings-tab test was updated for the new page. Review (2026-09-21): each card now remembers the values it was loaded with and sends only the fields you changed — before, a card compared against the latest settings, so after any refresh an untouched field that another admin had changed meanwhile was sent back with your save and quietly undid their change; an untouched card now refreshes itself instead. The tax-code add form has its own Code, SAC/HSN and Rate % boxes and shows a refusal (e.g. a rate over 100) under the form instead of in a passing toast. Delete on a tax code has a Keep button to back out. The bill footer (1000), GSTIN (15), legal name (200), series prefix (30), tax code (40) and SAC/HSN (8) boxes stop at the server's own limits.

- [x] **P1-34 · Test catalogue page stops editing price** — `Done`
  - **Where:** `/settings/tests` page.
  - **What:** the price becomes read-only, showing the service item's price,
    with a link to that item (or "Create item" when missing).
  - **Done when:** no price can be typed on the test catalogue page.
  - **E2E test:** `e2e/billing/phase1/P1-34-test-catalogue-page-stops-editing-price.spec.js` — asserts: no price can be typed on the test catalogue page.
  - **Result:** Done 2026-09-21. `/settings/tests` no longer has a price box anywhere — not on each row, and not on "Add a test". Each row's price is read-only and says where it comes from: a test with an active billing item shows the item's price and code, linked to **Services** searched to that item (`/settings/services?q=CODE`); a test with no item shows its old catalogue price, greyed, with **Create item**, which opens the Services item form pre-filled with the test's name, kind test, the catalogue link and that price (`/settings/services?createTest=<id>`; a test that already has an item says so instead); a test whose item is switched off shows "CODE is off", linked to it. The catalogue list now also returns `offItemCode` for a switched-off item. The page's warning counts active tests with no billing item ("reception charges the old catalogue price until one is created") and links to Services. A test added here starts at ₹0 and is priced by creating its item. Review (2026-09-21): **the catalogue endpoint now refuses every price change** (409) — with a billing item: "change its price in Settings → Services"; without one: "Test prices are set on the test's billing item; create one in Settings → Services" — so no catalogue price can change behind the screen either (this widens P1-24's guard; its test 5 was updated, and its message now names Settings → Services). A retired test with no item shows "Retired" instead of Create item (Services only takes active tests), and Services now says "That test can't get a new item — it already has one, or it's retired" when a link can't be used. The links' spoken names start with their visible text ("P-FER — change the price of Ferritin in Services", "Create item for Ferritin"). The warning counts tests with "no active billing item", which is right for tests whose item is switched off.

### 1G. Checks

- [x] **P1-35 · Smoke script: master data** — `Done`
  - **Where:** `server/scripts/smoke-billing-master.mjs`,
    `server/package.json` (`smoke:billing-master`).
  - **Checks:**
    1. Create, update and delete one of each master row.
    2. Deleting a used row is refused.
    3. CGHS › Pensioner is accepted; a child under Pensioner is refused.
    4. A duplicate consultation item is refused.
    5. A price change writes history.
    6. The resolver's four cases (P1-21), including a patient recorded as
       Pensioner resolving to CGHS › Pensioner.
    7. Test prices returned by `testPricesFor` equal today's prices for every
       catalogue test.
    8. Everything runs inside a rolled-back transaction.
  - **Done when:** the script passes.
  - **E2E test:** `e2e/billing/phase1/P1-35-smoke-script-master-data.spec.js` — the same scenarios as the smoke script, end to end through the API as `reception_admin`: master CRUD, used-row delete refused, third level refused, duplicate consultation refused, price history written, the resolver's four cases, and unchanged test prices.
  - **Result:** Done 2026-09-21. `server/scripts/smoke-billing-master.mjs`, run with `npm run smoke:billing-master` from `server/`. It prints which database it is on, runs every check on one connection inside `BEGIN … ROLLBACK`, and then confirms from a second connection that no smoke row was left (check 8), so it is safe to run anywhere — but it uses `DATABASE_URL` from `.env`, which is production; point it elsewhere with `DATABASE_URL=… npm run smoke:billing-master`. Checks: (1) a group, subgroup, item, tax code, category, rule and rate are each created, updated and deleted; (2) deleting a used subgroup or group is refused with the list of uses; (3) CGHS › Pensioner is accepted and a child under Pensioner is refused; (4) a second New consultation item for the same doctor is refused; (5) a price change needs a reason and writes history; (6) the resolver's four cases on the real resolver with only the smoke rule loaded (so production rules can't sway it): appointment category (Pensioner → "CGHS › Pensioner"), patient's category, automatic 60+ card rule, General; (7) `testPricesFor` returns today's price for every active catalogue test, and follows a new active item. Prints ✓/✗ per check and exits 1 on any failure. Tested: the e2e spec runs the script against the test database (ALL OK 8/8, row and audit counts unchanged) and repeats checks 1–5 and 7 over HTTP as reception_admin (the resolver has no API until the Billing Counter in Phase 2). Breaking the pricing, the resolver, the price history or deletes makes the script fail on the matching check. **Not run against production** — say if you want it run there. Review (2026-09-21): **check 7 now compares the floor screens, not the price rule with itself** — Reception's test list, the doctor/MO price lookup (`testPricesFor`) and the machine room's list must give every active test the same price, and a test with a new active item must be priced from it on the floor; it also prints (without failing) which tests now bill at their item's price instead of their old catalogue price — at go-live that list should be empty, later it shows exactly what Services changed. **Check 8 now looks for every row the run made**, including tax codes, rules, rates, price history and the append-only `billing_audit` rows (matched by entity and id), since a leaked audit row could never be removed. **Check 1 reads back every update** (group and subgroup names, SAC code, payer name, rule priority, rate, unit) instead of only checking that nothing threw. Tested by breaking a floor screen's price, an update that doesn't save, and a row written outside the transaction — each fails the matching check.

- [x] **P1-36 · Regression checks** — `Done`
  - **Steps:**
    1. `npm run build` is clean.
    2. `npm run smoke:ghm-categories` and `npm run smoke:ghm-pill-filters`
       pass.
    3. The MO test ordering screen and reception's payment queue show
       unchanged prices.
  - **Done when:** all pass.
  - **E2E test:** `e2e/billing/phase1/P1-36-regression-checks.spec.js` — asserts: all pass.
  - **Result:** Done 2026-09-21. `e2e/billing/phase1/P1-36-regression-checks.spec.js`: (1) `npm run build` exits cleanly with no error; (2) `npm run smoke:ghm-categories` passes against the test database on a day seeded with enough appointments — the script silently "passes" with "Need N appointments" when a day is too empty, so the test seeds one and refuses that message — and every appointment it touches is put back; (3) `npm run smoke:ghm-pill-filters` passes on the same day (this npm script was missing from `server/package.json` and is now added); (4) a test ordered through the MO API is quoted and charged its catalogue price on the MO screen and on reception's payment queue, and still the same after it gets a billing item at that price, with the earlier order keeping its amount. Both GHM scripts read `DATABASE_URL` from `.env` (production) and `smoke:ghm-categories` edits real appointments before restoring them, so they were run **only against the test database**. Breaking a price on the MO screen, the price stamped on an order, or GHM's unknown-category check each fails the matching test. Review (2026-09-21): the price check now also covers a **CGHS patient with no CGHS rates** — the MO screen looks up the visit's category and must still quote the base price (not marked "scheme priced"), and the order reception sees and the stored order (with `scheme_code` cghs) carry the same amount — so a bug in the category-rate path alone (which only runs when a visit has a category) now fails P1-36; before, only a patient with no category was checked. The build check relies on the exit code and "built in", and fails only on Vite's own "error during build" / "Build failed" lines, not on any word "error" in the output (a file like `ErrorBoundary.jsx` could have tripped it).

- [x] **P1-38 · Permission check on every billing screen and API** — `Done`
  - **What:** prove the matrix is enforced on both sides once the Phase 1
    screens and routes exist (moved here from P1-03).
  - **Steps:**
    1. Log in as reception: billing admin pages are hidden and their APIs
       return 403.
    2. Log in as coordinator: every billing page and API is refused.
    3. Log in as reception_admin: settings are refused, everything else is
       allowed.
  - **Done when:** all three checks pass.
  - **E2E test:** `e2e/billing/phase1/P1-38-permission-check.spec.js` — asserts: as `reception`, billing admin pages are hidden and their APIs return 403; as `coordinator`, every billing page and API is refused; as `reception_admin`, billing settings are refused and everything else is allowed. Repeat the same check at the end of Phases 3, 4 and 5 for the pages and routes each adds.
  - **Result:** Done 2026-09-21. `e2e/billing/phase1/P1-38-permission-check.spec.js` reads every route straight from `billingMaster.js` and `billingSettings.js` (so a route added later is checked automatically) and calls each one as each role with a dummy id and an empty body — the permission check runs before validation, so a refusal changes nothing and an allowed call stops at 400/404. **reception**: all master and settings APIs return 403; no Settings tab; every billing page (Categories, Services, Category rates, Billing settings) sends them away. **coordinator**: every billing API is refused, the desk (`/api/billing/…`) included; no Settings tab; every billing page sends them away. **reception_admin**: every settings API returns 403 and every master API is allowed (none 403, none 5xx); the Settings section shows Categories, Services and Category rates, each opens, and Billing settings sends them away. **admin**: every API and page is allowed. The gates for routes not built yet already hold: claims, reports and import are refused to reception and allowed to reception_admin and admin, the desk is allowed to reception. The old `/api/patient-schemes` writes stay admin-only. Breaking the matrix (coordinator given billing master; settings API or page opened to billing master; the claims gate removed) fails the matching test. Repeat at the end of Phases 3, 4 and 5. Review (2026-09-21): the route list now comes from **every** `server/routes/billing*.js` file, each with its own `BASE`, and the test fails if a billing route file has a route it can't read — so the Phase 2 import and Phase 4 desk routes are checked as soon as they exist. Each route's area follows its path: master, import, claims, reports and settings refuse reception; anything else under `/api/billing` is the desk, which reception may use. A new check covers **every role** in `shared/permissions.js`: only admin and reception_admin hold billing master, claims and reports; only admin holds settings; only admin, reception and reception_admin hold the desk; lab and a consultant are refused every billing API over HTTP. Quietly giving coordinator billing reports, or adding a route file whose routes the test can't read, now fails it.

- [x] **P1-37 · Update the plan status** — `Done`
  - **What:** mark Phase 1 as built in `52-BILLING-PLAN.md`, with any
    differences from the plan written down.
  - **E2E test:** No new spec — run `npm run test:e2e:billing`; the whole suite must be green before the phase is marked built.
  - **Result:** Done 2026-09-21. `52-BILLING-PLAN.md`: the status line now says Phase T and Phase 1 are built (Phase 0 waits on the admin team's data, Phases 2–7 are a plan); a new **§0a "Phase 1 as built"** lists what Phase 1 did differently — Settings tabs for later phases not shown yet, the Categories page open to reception_admin with the daily limit admin-only, no catalogue prices at all, New/Follow Up-only consultation items, one floor price rule, rate changes that start a new rate, the shared vocabulary file, the extra endpoints, the permission check that picks up new route files, and what is and isn't in production (migrations applied; code up to P1-32 pushed; P1-33 onwards not committed; nothing from P1-24 on known to be deployed; P1-10 still waiting). The phase table marks T and 1 as built. `npm run test:e2e:billing`: 351 passed, none failed or flaky. Review (2026-09-21): the plan's §4 no longer calls `giniflow_test_catalog.price` a "read-only copy dropped after one release" — it is the fallback price for any test without a billing item, so dropping it on a schedule would bill those tests at ₹0; a new task **P1-39** drops it only once no active test is left without an item (the migration refuses otherwise). §9 and P2-06 now carry the P1-31 rule into the Excel import: a `daily_cap` change in an upload is refused unless the uploader is an admin, so reception_admin can't raise a limit by uploading a file. §0a's production note is dated and keeps only what the plan needs (P1-10 and P1-39 wait for the P1-24 deploy); the commit and deploy state stays in this task list.

---

## Phase 2 — Bulk Excel import

Goal: the admin uploads the Phase 0 workbook, sees exactly what will change,
and saves it all at once or not at all.

- [x] **P2-01 · Migration: import history** — `Done`
  - **Where:** `server/migrations/<date>_billing_imports.sql`.
  - **What:** `billing_imports` (`id`, `file_name`, `imported_by`,
    `imported_at`, `counts` JSONB per sheet, `status`), RLS on. Review, then
    apply.
  - **Done when:** the table exists in production.
  - **E2E test:** No new spec — the table is exercised by P2-08's test. Rebuild the test database after applying.
  - **Progress (2026-09-21):** `server/migrations/2026-10-12_billing_imports.sql` — `billing_imports` (`id` BIGSERIAL, `file_name` not blank, `imported_by` → `doctors` ON DELETE RESTRICT, `imported_at` default now, `counts` JSONB object default `{}`, `status` `saved` / `failed`), indexed by `imported_at DESC`, RLS on and forced, no access for `anon` / `authenticated` — the same lockdown as the other billing tables. `status` allows `failed` so P2-08 can decide whether to record a failed attempt (the save itself is all-or-nothing). Added a short migration spec anyway (`e2e/billing/phase2/P2-01-migration-import-history.spec.js`: runs twice, planned columns, refusals, lockdown); the test database rebuilt with it. **Applied to production 2026-09-21** (aws-1-ap-south-1 pooler): the check found no table, `--apply` created it, and the read-only verify passed all 11 checks (columns, defaults, status values, blank-name and counts checks, the link to `doctors`, the index, RLS on and forced, no `anon` / `authenticated` access, empty). Review (2026-09-21): a second file, `server/migrations/2026-10-13_billing_imports_link.sql`, makes `billing_imports.imported_by` required (the history must say who imported each file) and adds a nullable **`billing_audit.import_id`** → `billing_imports` (ON DELETE RESTRICT, indexed `(import_id, at)` for import rows only), so every change-log row an import writes can point at that import and the import history can list exactly what one import changed; screen edits leave it empty and the change log stays append-only. P2-08 sets it. Tests added to the P2-01 spec; the whole billing suite passed on the rebuilt test database (358). **Applied to production 2026-09-21**: the check found no `import_id`, `--apply` added it, and the read-only verify passed all 6 checks (`imported_by` required; `import_id` bigint, optional, → `billing_imports` with delete refused; the partial index; the change log still append-only; no existing change-log row touched).

- [x] **P2-02 · Column definitions in one place** — `Done`
  - **Where:** `server/services/billing/importColumns.js`.
  - **What:** for each sheet: column name, required or not, type, allowed
    values, the key columns. Both the template builder and the parser read
    this, so they can never disagree.
  - **Done when:** every column in plan §9 is defined.
  - **Note:** `importColumns.js` already exists from P0-01; this task adds
    whatever the parser still needs (e.g. per-column parsing) to the same file.
  - **E2E test:** `e2e/billing/phase2/P2-02-column-definitions-in-one-place.spec.js` — asserts: every column in plan §9 is defined.
  - **Result:** Done 2026-09-21. Every column in plan §9 was already defined in `importColumns.js` (from P0-01); the spec now reads the §9 table itself and checks both ways — every planned sheet, key and column is defined, and nothing unplanned. Added what the parser needs, in the same definitions the template is built from: each number column is **money** (≤ 2 decimals: `base_price`, `rate`, `fee`, `patient_value`, `value`, `max_discount`) or **whole** (the rest; `sort_order` may be negative); comma-separated columns (`visit_types`, `allowed_roles`, `groups`, `subgroups`, `items`, `doctors`, `categories`) are marked `multi`, with `choices` where the values are fixed — kept out of `values`, so the template doesn't give them a single-choice drop-down. New `parseCell(column, raw)` returns `{ value }` or `{ error }` in plain words: blank → the column's blank value (or "is required"), numbers must be plain (no ₹ or commas) and within limits, dates as `YYYY-MM-DD`, a real date cell or an Excel date number (30 February refused), yes/no, choices matched ignoring case and returned in their proper spelling, comma lists trimmed and de-duplicated, and Excel's rich-text and formula cells read as their text or result. `parseRow(sheet, cells)` parses a whole row and names each error by its column. `INT_MAX` / `MONEY_MAX` moved to `shared/billingVocab.js` (re-exported by `common.js`) so the columns file doesn't load the database. The template and Phase 0 specs are unchanged and pass. Review (2026-09-21), tested with awkward real-Excel inputs: a cell showing an **Excel error** (`#N/A`, `#REF!`, also as a formula's result) and a **formula with no saved value** were read as the text `[object Object]` — they are now refused in plain words ("shows an Excel error …", "a formula with no saved value; open the file in Excel, save it and upload again"), and any other unreadable cell is refused too; a money formula with rounding noise (`=0.1+0.2`) is accepted as ₹0.30 instead of "at most 2 decimals"; a comma list of only commas is blank (e.g. "all") instead of an empty list that could mean "nothing"; text columns carry the same limits as saving — codes (`code`, `*_code`) at most 40 characters and no spaces, `unit` 30, other text 200 — so an over-long name or a code with a space is an error row at once instead of failing at save; a date typed with a time (`2026-10-01 00:00:00`, an ISO timestamp) keeps its date. Five tests added; breaking each fix fails its test.

- [x] **P2-03 · Template download** — `Done`
  - **Where:** `server/services/billing/importTemplate.js`.
  - **What:** build the `.xlsx` from P2-02, including the Read me sheet and
    drop-downs.
  - **Steps:** the `Payment rules` and `Discounts` sheets are marked "available
    after Phase 3" until P3-22 switches them on.
  - **Done when:** the downloaded file matches P0-01.
  - **Note:** `importTemplate.js` already exists from P0-01; this task adds
    the Read me content, the "available after Phase 3" marking and the
    download route.
  - **E2E test:** `e2e/billing/phase2/P2-03-template-download.spec.js` — asserts: the downloaded file matches P0-01.
  - **Result:** Done 2026-09-21. `GET /api/billing/import/template` in the new `server/routes/billingImport.js` (the file P2-10 adds the other import routes to) sends the workbook as `gini-billing-template.xlsx` (xlsx type, attachment, `no-store`). Admin and reception_admin get it; every other role gets 403, and so does a request with no login ("Doctor account required" — all of `/api/billing` is doctor-only). The download is byte-for-byte `docs/gini-flow/billing-template.xlsx`: `writeTemplateFile` now saves the same buffer the route sends (exceljs's `writeFile` zipped it differently), and the committed file was rebuilt (it was already stale). **Available after Phase 3:** `LATER_SHEETS` in `importColumns.js` lists `Payment rules`, `Consultant fees` and `Discounts` — Consultant fees too, because each fee row also saves a payment rule (P3-22's "Also"). Those sheets get a grey tab and a note on their first header cell; the Read me gets rule 15 naming them and an "(available after Phase 3)" row under each; P3-22 switches them on by emptying the list. The Read me content itself was built in P0-02. `sendFailure` is split out of `billingRoute` so a file download reports errors the same way. Checked against a second copy of the test API on port 3111 (the user's test app was running): both billing roles download the same bytes as the committed file; four other roles and no login are refused. P0-01, P0-02, P2-01 and P2-02 specs pass (24); the P2-03 spec runs with the next full suite. Review (2026-09-21): **the file is not byte-stable** — exceljs stamps every zip entry with the current time, so two builds a few seconds apart differ in bytes while their content is identical (P0-01's "rebuilds are byte-identical" held only within the same two-second tick); the spec now compares the unzipped content of the download, the committed file and a fresh build instead of bytes, and a stale committed file still fails it. The Phase 3 rule read "The and Discounts sheets" when only one sheet is left (P3-22 may switch them on one at a time) — it now reads right for one sheet or several (test 5). Building the file per request takes ~70 ms, so it is not cached. Noted for P2-04: rows on a Phase 3 sheet must show in the preview as "not imported yet", never be dropped silently. The Read me's "Settings › Billing › Bulk import" is the P2-11 page, not there yet; until then the file downloads from the API (the `?token=` form works in a browser).

- [x] **P2-04 · Parse the upload** — `Done`
  - **Where:** `server/services/billing/importParse.js`.
  - **Phase 3 sheets (from the P2-03 review):** rows on a sheet in
    `LATER_SHEETS` are not imported; the preview lists them as "not imported
    yet — available after Phase 3" so nothing is dropped silently.
  - **Steps:**
    1. Read the file with `exceljs` (the library the template is built with);
       accept numbers typed as text as well as real numbers.
    2. Refuse unknown sheets, missing required columns and files over a size
       limit.
    3. Trim text, turn `yes/no` into booleans, and read dates as
       `YYYY-MM-DD`.
  - **Done when:** a template file parses into rows per sheet.
  - **Blank cells (from the P0-02 review):** an empty optional cell takes the
    `blank.value` defined for that column in `importColumns.js` (e.g.
    `sort_order` 0, `unit` each, `active` yes, `priority` 100,
    `allowed_roles` all three roles). The Read me's "if left blank" column is
    written from the same definitions, so the two never disagree. A test
    checks every column's default is applied.
  - **E2E test:** `e2e/billing/phase2/P2-04-parse-the-upload.spec.js` — asserts: a template file parses into rows per sheet.
  - **Result:** Done 2026-09-21. `parseUpload(buffer)` in `server/services/billing/importParse.js` reads the file with `exceljs` and returns `{ problems, sheets }`. **Whole-file problems** refuse the upload and are all listed at once: an empty file, over 5 MB (`MAX_UPLOAD_BYTES`), not an `.xlsx`, a sheet that isn't the template's (an empty extra sheet like `Sheet1` and the Read me are ignored), a header that isn't one of the sheet's columns, a column given twice, a required column missing, more than 5,000 rows on a sheet (`MAX_SHEET_ROWS`), or no rows at all (the untouched template). Sheet names and headers match ignoring case and spaces, and columns may come in any order. **Rows:** each sheet in template order, each row with its Excel row number, what was typed (`input`, dates shown as `YYYY-MM-DD` — for the P2-09 error file), the parsed `values` and its `errors` named by column; blank rows (also rows of only spaces) are skipped. Every cell goes through P2-02's `parseRow`, so numbers typed as text, trimming, yes/no, dates (typed, date cells and Excel serials), formulas, rich text and Excel error cells behave as defined there, and an empty optional cell takes its `blank.value` (the same definitions the Read me's "if left blank" column is written from). **Phase 3 sheets** (`LATER_SHEETS`) are counted as `notImported` and never parsed, so a half-filled Discounts sheet can't block an upload. 9 tests, all pass without servers; breaking the blank-row skip, the Phase 3 skip, the unknown-column check or the date display each fails its test (the blank-row test first used an empty row that exceljs already skips, so it now uses a row of spaces). Review (2026-09-21), probed with what an admin actually does in Excel: **a deleted header let its values vanish** — clearing the `active` header while `no` stayed in the cells imported the row as active (and on an update any missing optional column would have overwritten stored values with defaults); every template column must now be in row 1 ("the column active is missing; put the header back (leave its cells empty to use the default)"), which is what the Read me already says, and values in a column with no header are refused ("column D has values but no header"). **The same sheet twice** (`Groups` and `groups `) was read twice — now refused. **A value Excel turned into a date** (a name typed as `1-2`) was taken as its date — now an error on that cell asking to format the column as Text (in `parseCell`, so it also covers number and code columns). **A title row above the headers** now says "row 1 must hold the column names (…)" instead of listing every cell as an unknown column. Four tests added (10–13); breaking each fix fails its test. Noted, not changed: a 5 MB `.xlsx` can unzip to far more in memory (it is an admin-only upload, so the size cap is kept as the guard); a blank cell on an existing row means the column's default, as the Read me says, so P2-07's preview should show such changes as updates.

- [x] **P2-05 · Check groups, subgroups and items** — `Done`
  - **Where:** `server/services/billing/importValidate.js`.
  - **Checks:**
    - codes present and unique;
    - a subgroup's group exists, in the file or the database;
    - price ≥ 0 and `kind` is allowed;
    - a named doctor or test exists, and a doctor name that matches more than
      one doctor is refused (use the id instead);
    - a consultation fee for the lab-only provider ("Dr. Hospital Admin",
      recognised with `isLabOnlyDoctor` in `shared/labOnly.js`) is refused:
      samples-only visits have no consultation fee. Any other active staff
      member may have a fee (P1-06 review);
    - no second consultation item for the same doctor + visit type, and at
      most one active hospital default (blank doctor) per visit type;
    - no second item for the same test;
    - **warning** (not an error) when a test's catalogue category doesn't
      match its item's group — e.g. a lab test filed under a Machine or OPD
      subgroup, which would count its revenue in the wrong place on the
      dashboards (P1-17 review);
    - a test name that isn't in the Gini Flow test catalogue is refused with:
      "This test isn't in the test catalogue yet — ask an admin to add it
      (Settings › Test catalogue), then upload again". A test that exists only
      in the lab report catalogue can't be priced until it has a catalogue
      entry (P1-06 review).
  - **Done when:** each bad value produces an error row with a message.
  - **E2E test:** `e2e/billing/phase2/P2-05-check-groups-subgroups-and-items.spec.js` — asserts: each bad value produces an error row with a message.
  - **Result:** Done 2026-09-21. `server/services/billing/importValidate.js`: `loadReference(db)` reads groups, subgroups, items, doctors, catalogue tests, tax codes and machines once; `checkMasterRows(sheets, ref)` is pure and adds `errors` / `warnings` (each `{ column, message }`) to the parsed rows; `validateUpload(parsed, db)` runs both (P2-06 adds its sheets to the same file). The checks work on the **final state** — Scribe's rows with the file's rows laid over them by code (ignoring case) — so a clash is caught whether it is inside the file or against Scribe, and a row that updates an existing item never clashes with itself; messages say where the other row is ("row 3" or "Scribe"). Checks: codes unique in the file (every copy is marked, naming the other rows); a subgroup's group and an item's subgroup exist in the file or Scribe (a parent whose own row has errors says "fix those first" instead of "there is no group"), and an active child can't sit under a deactivated parent; group names unique, subgroup and item names unique within their parent; price ≥ 0 and `kind` (from P2-04's parsing); the kind decides which of doctor, visit type, test name and max quantity may be filled; a doctor by name (ignoring case and extra spaces) or id — a name shared by two doctors, an unknown or inactive doctor, and the lab-only provider are refused; one active consultation item per doctor + visit type and one hospital default per visit type; a test must be an active catalogue test (the planned "isn't in the test catalogue yet — ask an admin…" message; a retired test is named), with one item per test counting inactive items too (the database rule); tax codes exist and are active; deactivating a group or subgroup that keeps active children is refused unless the file deactivates them too. **Warning:** a test whose suggested group (the P0-03 export's `suggestedGroup`, now exported) doesn't fit its item's group name or code ("ABI is a Machine test, but Biochemistry is in the Laboratory group; its revenue will count under Laboratory on the dashboards"); "Lab" fits "Laboratory". Each row also gets `resolved` (doctor, test, tax code) for the save in P2-08. 13 tests (12 on a fixed in-memory reference, 1 on the test database); breaking the duplicate check, the consultation clash, the lab-only refusal, one-item-per-test counting inactive items, the group warning or the active-children check each fails a test. Review (2026-09-21): **far too slow for a real price list** — every row scanned every other row, so 3,000 items against 3,000 in Scribe took 23 s and 5,000 took 60 s (the upload request would time out); every lookup now goes through an index (names by parent, consultations by doctor + visit type, items by test, children by parent, doctors, catalogue tests and tax codes by name/code), and 5,000 + 5,000 takes ~0.3 s (test 14 fails at 55 s if a scan comes back). **A one- or two-letter group code hid the wrong-group warning** — a code like `L` "contained" in "Lab" counted as a fit; a code or name now only fits when it contains the expected group, or is at least 3 letters and contained in it (test 15). **Doctor names typed a little differently** ("Dr. Rahul", "rahul" for "Dr Rahul") now get "did you mean "Dr Rahul"?" — never used silently, and an inactive doctor is never suggested (test 16). Checked and fine: codes are unique ignoring case in the database too (`lower(code)` unique indexes), matching how the file is laid over Scribe; a file that swaps two groups' names passes, because names are compared on the final state.

- [x] **P2-06 · Check categories, category rules and category rates** — `Done`
  - **Where:** `importValidate.js`.
  - **Checks:**
    - a sub-category's parent exists (in the file or the database) and there
      are at most two levels (e.g. `pensioner` with `parent_code = cghs` is
      fine);
    - rule age ranges are valid and `mode` is allowed;
    - a rate's category and item exist, `rate ≥ 0`, dates are valid, and
      date ranges don't overlap.
  - **Done when:** as P2-05.
  - **Also:** the category code `general` is refused (it is reserved for
    "patients with no category"; `RESERVED_CATEGORY_CODES` in
    `importColumns.js`).
  - **Also (P1-37 review):** a `daily_cap` value that differs from the
    category's current one is an error row unless the uploader is an admin —
    the same admin-only rule as the Categories page (P1-31); the message says
    only an admin can change the patients-per-day limit.
  - **E2E test:** `e2e/billing/phase2/P2-06-check-categories-category-rules-and-category.spec.js` — asserts: an upload with a missing parent, a third category level, a bad age range, an unknown item, a negative rate and overlapping dates each produces an error row with the right message.
  - **Result:** Done 2026-09-21. Added to `importValidate.js`, on the same final state as P2-05 (Scribe's rows with the file's laid over them), mirroring the Categories, rules and rates screens. `loadReference` also reads categories, rules and rates; `checkMasterRows(sheets, ref, { canChangeDailyCap })` and `validateUpload(parsed, db, options)` take the uploader's admin right (the P2-10 route passes it). Category codes are lower-cased on the three sheets (the screen does the same). **Categories:** code 2–32 of a–z, 0–9, \_; `general` reserved; codes unique in the file; the parent exists in the file or Scribe, isn't the category itself, isn't a sub-category (only two levels), and isn't retired when the child is active; a category that has sub-categories can't move under another; labels unique under the same parent; retiring a category that keeps active sub-categories is refused unless the file retires them too; a `daily_cap` that differs from the stored one (a blank cell means "no limit", so it counts) is refused unless the uploader is an admin — "Only an admin can change a category's patients-per-day limit (it is 30 now)". **Rules:** category + rule name once per file (matched ignoring case, like the database's unique index; the same name as in Scribe is an update); min_age ≤ max_age and ≤ 150; at least one condition; the category exists, is live, and has no sub-categories; an automatic rule on a category (or parent) that needs a card must require a card. **Rates:** category + item + valid_from once per file; valid_to ≥ valid_from; a rate, bill name or bill code is given; the category exists and is live; the item exists (an item added in the same file counts) and is active; no overlapping dates with Scribe's or the file's rates for the same category and item — as on the screen, a new open-ended rate ends Scribe's current open-ended one the day before, shown as a **warning** ("The rate from 2026-04-01 in Scribe will end on 2027-03-31"); two open-ended rows for one item in the file are refused with the exact fix ("give the rate from 2026-04-01 a valid_to of 2027-03-31"). 13 tests; breaking the third-level, reserved-code, daily-cap, rule-on-parent, automatic-rule-card, overlap or auto-end check each fails a test. Found while testing: a category that named itself as parent was also told it "has sub-categories (itself)" — fixed. Review (2026-09-21): **rules and rates could use a category row the file gets wrong** — a `general` or `cg-hs` row was refused on the Categories sheet, but it still counted as a category, so rules and rates on it passed; the code shape and reserved-code checks now run before the file is laid over Scribe, and such rows say "The category general has errors on the Categories sheet (row 2); fix those first" (test 14). **Adding the first sub-category under a category with rules was silent** — after the import those rules stop applying (a category with sub-categories isn't billed on its own; the screen prompts to move them); the first such row now gets a warning naming the rules and how to fix it in the same file, the warning is gone when the file retires them, and a rule row with active = no is now allowed on a category that has sub-categories so it can be retired from the file (test 15; `loadReference` reads the rules' `is_active`). Checked and fine: every lookup is indexed like P2-05's; the auto-end of Scribe's rate only ever picks an earlier open-ended rate, so its new end date can't fall before its start.

- [x] **P2-07 · Row status and preview** — `Done`
  - **What:** each row is marked new / update / unchanged / error by comparing
    with the database, using the key columns.
  - **Also (P1-15 review):** a "new" row whose code doesn't exist but whose
    name matches an existing row (same parent, ignoring case) gets a
    **warning**: "Looks like LAB-HBA1C, which now has code LAB-A1C — was the
    code changed on the admin screen?" A code changed on screen would
    otherwise make an older copy of the sheet create a duplicate.
  - **Done when:** the preview returns counts per sheet and the error rows.
  - **E2E test:** `e2e/billing/phase2/P2-07-row-status-and-preview.spec.js` — asserts: the preview returns counts per sheet and the error rows.
  - **Result:** Done 2026-09-21. `server/services/billing/importPreview.js`: `previewUpload(buffer, db, options)` reads the file (P2-04), loads Scribe's rows once, runs the P2-05/06 checks and marks each row. **Status:** `error` when the row has any error; otherwise `new` when its key isn't in Scribe, `update` when any compared value differs, else `unchanged`. Keys match ignoring case (codes, and rule names like the database's unique index); values are compared in the sheet's own terms — codes ignoring case, numbers as numbers (`100` = `100.00`), the doctor, test and tax code by what they resolved to. Each update lists its `changes` (`{ column, from, to }`, doctors and tests shown by name) for the preview page. **Warning (P1-15 review):** a row whose code isn't in Scribe but whose name matches a row under the same parent gets "Looks like P207-OLD*…, which now has code P207-I*… — was the code changed on the admin screen?" (also on the error row that the duplicate name causes, which is where it usually shows). **Result shape:** `{ problems, canImport, counts, sheets }` — `counts` has new / update / unchanged / error / warning / notImported for the file and for each sheet; each row carries `row, status, input, values, errors, warnings, changes` (what the P2-09 error file and the P2-11 page need); `canImport` is true only with no problems, no error rows and something to save. `loadReference` now reads every compared column, with rate dates as `YYYY-MM-DD` text whatever pool is used. 6 tests on the test database with their own rows (removed afterwards); breaking the unchanged status, the renamed-code warning, errors blocking the import, or case-insensitive rule names each fails a test. Review (2026-09-21): **the renamed-code warning fired when the file itself renamed the old row** — a file that renames LAB-A1C to "HbA1c (old)" and adds LAB-A1C2 named "HbA1c" told the new row "Looks like LAB-A1C2, which now has code LAB-A1C", which is no longer true after the save; the warning now compares against each row's name as it will be after the file is saved (test 7; the warning still shows when the old row keeps its name). Checked and fine: 5,000 new items against 5,000 in Scribe preview in ~0.25 s and the result is ~1.5 MB; numbers stored with paise (`175.50`) equal the sheet's `175.5`; a blank optional cell on an existing row shows as an update to its default (as the Read me says), so the admin sees it before saving. Noted: Scribe's open-ended rate that a new rate will end is shown as a warning on the new row, not counted as an update, because it isn't a row in the file.

- [x] **P2-08 · Save all or nothing** — `Done`
  - **Where:** `server/services/billing/importCommit.js`.
  - **Steps:**
    1. Refuse to save if any error row exists.
    2. In one transaction, save in dependency order: groups → subgroups →
       tax codes → items → top-level categories → sub-categories → category
       rules → category rates.
    3. Write the `billing_imports` row first, then audit rows carrying its id
       in `import_id` (P2-01 review), and price history for price changes.
    4. Never delete; `active = no` deactivates.
    5. Any failure rolls back everything.
    6. Rows are matched to existing ones by code ignoring case
       (`ON CONFLICT ((lower(code)))` or `lower(code) = lower($1)`), so a
       sheet that writes `lab` updates the existing `LAB` instead of failing.
       Updates set `updated_at` and `updated_by`.
  - **Done when:** a partial failure leaves the database unchanged.
  - **Start dates (from the P0-02 review):** a blank `valid_from` on Payment
    rules, Consultant fees and Discounts (`TODAY_ON_CREATE`) is set to the
    upload day only when the row is created; when the row already exists the
    stored start date is kept. So uploading the same file on another day
    changes nothing and never creates a second rate row.
  - **E2E test:** `e2e/billing/phase2/P2-08-save-all-or-nothing.spec.js` — asserts: a partial failure leaves the database unchanged.
  - **Result:** Done 2026-09-21. `commitUpload(buffer, { fileName, ctx, options }, db)` in `server/services/billing/importCommit.js`. In one transaction, one import at a time (an advisory lock), it reads the file and re-runs every P2-04–P2-07 check against the data as it is now — it never trusts an earlier preview — and returns the preview without writing anything when the file has problems, an error row, or nothing to save. Otherwise it writes the `billing_imports` row first (file name, who, counts per sheet), one `import` audit row, then saves in dependency order: groups → subgroups → items → top-level categories → category updates → sub-categories → category rules → category rates. Nothing is ever deleted; `active = no` deactivates. Codes match ignoring case (a row written `lab` updates `LAB`); updates set `updated_at` / `updated_by`. Every audit row carries the import's id (`importId` added to `auditFields`, stored by `writeAudit` in `billing_audit.import_id`); new items get a "Created" price history row and a price change gets "Bulk import: <file>". A new open-ended rate ends Scribe's current open-ended one the day before, as the screen does. Any failure rolls everything back and records a `failed` import; a database conflict caused by a change made meanwhile comes back as a plain 409 ("Scribe's billing data changed while the file was being saved, so nothing was saved; …"). Also: `createItem` takes an optional `is_active` (not reachable from the API schema), and the checks refuse a **new** row under a retired or deactivated parent even when the row is inactive, as the screens' create services do, so the preview never promises a save that then fails. Start dates (`TODAY_ON_CREATE`) apply to the Phase 3 sheets and arrive with P3-22. **Review (2026-09-21):** the first version saved each row through the screens' services — about 10 queries and 2 savepoints per row, 12.6 s for 2,000 items on the local database, likely minutes over the network to production and thousands of savepoints in one transaction. The writes are now batched per sheet (`jsonb_to_recordset` inserts and updates, one price-history insert, and `writeAuditMany` in `audit.js` for all audit rows, with the same redaction and action rules): **24 queries per file whatever its size, 2,000 items in 1.0 s, 5,000 in 2.1 s**, 4 savepoints. Order inside a table follows the database's unique indexes: items switched off are written before items switched on, then new ones (so two fees for one doctor can swap in one file); new top-level categories, then updates, then new sub-categories (the two-levels trigger sees the parent). 10 tests on the test database with their own rows and doctor (removed afterwards): a failure forced halfway leaves every table and the audit log unchanged; a clean save with its import record, linked audit rows and price history; the same file again saves nothing; codes matched ignoring case; a price change and the auto-ended rate; deactivation with nothing deleted; error rows and a non-admin daily-cap change save nothing; file name and uploader required; the query count stays flat from 5 to 300 items; a fee swap in both directions; a meanwhile conflict is a plain 409. Breaking the switch-off-first order, the batch audit, the rate auto-end, the 409 wording or the price history each fails a test.

- [x] **P2-09 · Error file** — `Done`
  - **What:** download the error rows as `.xlsx` with an extra "error" column,
    so the admin fixes them in place and re-uploads.
  - **Done when:** the downloaded file re-uploads cleanly once fixed.
  - **E2E test:** `e2e/billing/phase2/P2-09-error-file.spec.js` — asserts: the downloaded file re-uploads cleanly once fixed.
  - **Result:** Done 2026-09-22. `errorFile(buffer, preview)` in `server/services/billing/importErrorFile.js` builds the error file from the **admin's own uploaded file**, not a rebuilt one, so nothing they typed is lost: every row, the Phase 3 sheets and the Read me stay as they were, and the row numbers match the preview. On each sheet with error rows an `error` column is added after the last header (or the existing one reused); each error row gets its messages joined with "; ", and the cells at fault and the message are shaded light red. Old messages on rows that are now fixed are cleared, on any sheet that has an `error` column. It returns `null` when the file was refused as a whole or has no error rows. `errorFileName("prices.xlsx")` gives `prices - errors.xlsx`. **Re-upload:** `error` is now a reserved column name (`ERROR_COLUMN` in `importColumns.js`); the reader ignores it in any letter case, never reports it as an unknown or header-less column, and skips a row whose only content is an old message. Each cell gets its own copy of its style before it is shaded — the template's cells share one style object, so shading one cell would otherwise shade the whole row. 6 tests on the test database (rows removed afterwards): the error column, messages and shading on the right rows and cells only; uploaded again unchanged, the same rows are in error and the column raises no problem; fixed in place, it previews with no errors and saves; a second round clears fixed rows' messages and reuses the column; "Error" in any case and message-only rows are ignored; no file when there is nothing to fix. Breaking the ignored column, the clearing of fixed rows, the per-cell style copy or the message-only-row skip each fails a test. Review (2026-09-22), no change needed: the round trip through the admin's own workbook keeps the drop-downs, the frozen header, the Phase 3 sheet notes, and formula cells — plain and Excel's shared (dragged) formulas — with their saved results, so re-uploading the error file raises no "formula with no saved value" errors; a 5,000-row upload with an error on every row previews in ~0.7 s and builds its error file in ~0.9 s (192 KB in, 203 KB out); messages that quote a typed value (e.g. "=X is also on row 4") are written as text, never as formulas. Warnings are left out of the file on purpose — it is for fixing what blocks the upload; warnings show on the preview page (P2-11). **Example rows (2026-09-22, asked for by the user):** each data sheet of the template now starts with two grey, italic example rows that tell one story across the sheets (a Lab group → Biochemistry → HbA1c, an OPD consultation fee, CGHS with its Pensioner sub-category, their rules, rates, payment rules, consultant fees and two discounts). Their first cell starts with `EXAMPLE` (`isExampleKey` in `importColumns.js`), and the reader skips such rows on every sheet — found by the key column's header, so it works when columns are moved — and doesn't count them on the Phase 3 sheets; a new Read me rule says so. The examples live in `SHEET_EXAMPLES` in `importReadme.js` and are checked to be valid for their columns. `templateBuffer({ examples: false })` gives the bare template the specs and the smoke script build their files from, so their row numbers don't move. P2-04 test 14; making the reader keep example rows fails it.

- [x] **P2-10 · Import routes** — `Done`
  - **Where:** `server/routes/billingImport.js`, under `/api/billing/import`.
  - **What:** download template, upload for preview, commit, download errors,
    import history. All behind `BILLING_MASTER`, with a Zod schema for the
    commit request.
  - **Done when:** each works and returns 403 without the capability.
  - **E2E test:** `e2e/billing/phase2/P2-10-import-routes.spec.js` — asserts: each works and returns 403 without the capability.
  - **Result:** Done 2026-09-22 (built by a sub-agent, reviewed). `server/routes/billingImport.js`, all behind `BILLING_MASTER` (route guard plus the `/api/billing/import` path gate): `GET /template` (xlsx); `POST /preview?fileName=` → the P2-07 preview; `POST /commit?fileName=` → always 200, `{ saved: true, importId, importedAt, preview }` or `{ saved: false, preview }` with nothing written (409 when data changed meanwhile); `POST /errors?fileName=` → the P2-09 error file as an attachment named `<file> - errors.xlsx`, or 422 `{ error, problems }` when there is none; `GET /history?limit=&offset=` → `{ total, limit, offset, imports }` newest first with who imported (new `importHistory.js`, 25 a page, at most 100). POST bodies are the raw file (`express.raw`); the file name is checked by `billingImportFileQuerySchema` (required, ≤ 200 characters, `.xlsx`) and paging by `billingImportHistoryQuerySchema`, both in `BILLING_SCHEMAS` with readable labels; an empty or JSON body is a 400. Only an admin may change a daily cap (`canChangeDailyCap` from the role, as on the Categories page). `verify-rbac.mjs` gained the new routes. Review (2026-09-22): the route accepted files up to 6 MB while the reader's limit is 5 MB, so a 5.5 MB file passed the route and was then refused as "larger than 5 MB" — the route now uses the reader's `MAX_UPLOAD_BYTES` and its message (test 8); checked that no global body parser touches the upload, that the capability and file-name checks run before the file is read, and that download names can't break the header. 8 tests; breaking the daily-cap rule, the name check, the empty-body check, the no-error-file branch or the history order each fails a test (the route guard and the path gate back each other up, so only removing both fails the 403 test). Not billing, noted: `verify-rbac.mjs` already fails two nurse cases on Gini Flow routes.

- [x] **P2-11 · Bulk import page** — `Done`
  - **Where:** `src/pages/billing/BillingImportPage.jsx`, router, routes
    config, settings tab.
  - **Steps:**
    1. "Download template" button.
    2. File picker, then a preview table per sheet with counts and error
       rows.
    3. "Import" is enabled only with zero errors; "Download errors" button.
    4. Import history list.
  - **Done when:** a file can be uploaded, previewed and imported from the
    screen.
  - **E2E test:** `e2e/billing/phase2/P2-11-bulk-import-page.spec.js` — asserts: a file can be uploaded, previewed and imported from the screen.
  - **Result:** Done 2026-09-22 (built by a sub-agent, reviewed). Settings → **Bulk import** (`/settings/bulk-import`, `BILLING_MASTER`, placed before Billing settings; `billing-import` would have been read as Billing settings by the tab matcher). `src/pages/billing/BillingImportPage.jsx` and hooks in `useBillingMaster.js`: **Download template**; choosing a file previews it at once (the picker resets so a fixed file can be chosen again; a slow preview of an older file is ignored); a refused file lists its problems; otherwise overall counts and, per sheet, new / to update / unchanged / with errors / with warnings / not imported yet (Phase 3 sheets), with a row table sorted errors → warnings → updates → new — errors show the column, message and what was typed, updates show "column: from → to", unchanged rows are folded away, 50 rows a sheet with "Show more". **Import** is enabled only when the preview can import and asks to confirm with the counts; after saving it shows what was saved and refreshes the billing screens and the floor's price lists; a `saved: false` answer replaces the preview with "Nothing was saved…". **Download errors** appears when there are error rows. **History** lists file, who, when, Saved/Failed and counts, 25 a page. Fits a 360 px phone. P1-28 and P1-38 now include the page, and their turned-away loops use `gotoReady` (the `ERR_NETWORK_CHANGED` flake). 14 tests; enabling Import with errors, forcing the error file name, or gating the tab as `BILLING_SETTINGS` each fails tests.

- [x] **P2-12 · Smoke script: import** — `Done`
  - **Where:** `server/scripts/smoke-billing-import.mjs`,
    `smoke:billing-import`.
  - **Checks:**
    1. A good file (including CGHS with its three sub-categories) imports
       every row.
    2. The same file again is all "unchanged".
    3. A file with one bad row imports nothing.
    4. Everything runs inside a rolled-back transaction.
  - **Done when:** the script passes.
  - **E2E test:** `e2e/billing/phase2/P2-12-smoke-script-import.spec.js` — the same three files uploaded through the Bulk import page in the browser: the good file imports, the repeat is all unchanged, the bad file imports nothing and offers the error download.
  - **Result:** Done 2026-09-22 (built by sub-agents, reviewed). `server/scripts/smoke-billing-import.mjs`, `npm run smoke:billing-import`: (1) a good file — groups, subgroups, a dressing, a real consultant's New fee and a real catalogue test, CGHS with Paid / Referral / Pensioner, a rule and a rate — imports every row, with its import record and linked audit rows; (2) the same file again is all unchanged and saves nothing; (3) a file with one bad row saves nothing; (4) other sessions never see the rows; (5) everything is rolled back and nothing is left. The import's own transaction runs inside the script's through a wrapper that turns `BEGIN`/`COMMIT`/`ROLLBACK` into a savepoint. It refuses a database whose name doesn't contain "test" unless `SMOKE_ANY_DATABASE=1` (the master-data smoke has no such guard). Passes 5/5 on the test database, repeatably; making the wrapper really commit fails it. The browser spec uploads the same three files through the Bulk import page (3 tests) with its own consultant and catalogue test. Note: the good file's test item always carries the wrong-group warning, because its subgroup isn't in a Lab group — the spec expects it.

- [ ] **P2-13 · Import the hospital's data** — `Pending`
  - **Depends on:** P0-05 to P0-07 — the admin team's filled `Groups`, `Subgroups`, `Items`, `Categories`, `Category rules` and `Category rates` sheets. Only this task waits for them; the rest of Phase 2 is built and tested with test data.
  - **What:** upload the Phase 0 workbook (master data, categories and
    sub-categories, category rules, category rates).
  - **Steps:**
    1. Preview, and fix errors with the admin team.
    2. Confirm with them before pressing Import.
    3. Afterwards, the "not priced" list must be empty.
  - **Done when:** every test and consultant has an item with a price, and
    CGHS shows its three sub-categories.
  - **E2E test:** No new spec — the real data is checked by the admin team; the import path itself is covered by P2-08 and P2-11.

- [x] **P2-14 · Update the plan status** — `Done`
  - **E2E test:** No new spec — run `npm run test:e2e:billing`; the whole suite must be green before the phase is marked built.
  - **Result:** Done 2026-09-22. `52-BILLING-PLAN.md`: the status line says Phase 2 is built except P2-13; a new **§0b "Phase 2 as built"** lists where it differs from §9 — `exceljs` and the file limits, every column in row 1 and the reserved `error` column, the Phase 3 sheets marked and counted but not read, the final-state checks and the extra rules, the batched all-or-nothing save with the import id on every audit row, the error file built from the admin's own workbook, the page and routes, and what is in production; §0a's tab note and the phase table updated. `npm run test:e2e:billing`: 478 passed, 0 failed, 1 flaky — P1-33 test 2 lost its page on a bare `page.reload()` (`ERR_NETWORK_CHANGED`, blank page); every bare reload in the billing specs now goes through `gotoReady`, and P1-31 and P1-33 then passed 27/27 with no flakes. `smoke:billing-import` passes 5/5 on the test database.

---

## Phase 2b — Import sessions: triage, overrides, partial import

Goal: an upload becomes a saved session; the admin works through it in
filtered, server-paged lists — Ready, Needs override, Failed, Unchanged —
overrides or keeps every change to an existing row, and saves the good rows
even when others fail. Design: plan §9a (decided 2026-09-24).

- [x] **P2b-01 · Migration: import sessions** — `Done`
  - **Where:** `server/migrations/<date>_billing_import_sessions.sql`.
  - **What:** `billing_import_sessions` (`id` uuid, `file_name`, `uploaded_by`,
    `uploaded_at`, `expires_at`, `status` open / committed / abandoned,
    `counts` JSONB, `import_id` → `billing_imports` once committed) and
    `billing_import_rows` (`session_id` → sessions ON DELETE CASCADE, `sheet`,
    `row_no`, `row_key`, `status` ready / override / unchanged / failed,
    `decision` pending / override / keep, `reason`, `values` JSONB, `before`
    JSONB, `changes` JSONB, `depends_on`, `outcome` after commit). Index for
    the list: `(session_id, status, sheet, row_no)`. RLS on and forced, no
    `anon` / `authenticated`. Review, then apply.
  - **Done when:** both tables exist in production.
  - **E2E test:** `e2e/billing/phase2b/P2b-01-migration-import-sessions.spec.js` — asserts: runs twice, planned columns and checks, the cascade, the lockdown.

  - **Result:** Done 2026-09-24 (built by a sub-agent). `server/migrations/2026-10-21_billing_import_sessions.sql` adds `billing_import_sessions` (the stored file, uploader, 24-hour expiry, status open/committed/abandoned, counts, and the `import_id` → `billing_imports` link with who and when it was committed) and `billing_import_rows` (sheet, row, key, label, status, decision, reason with errors, warnings, values, input, before, changes, `depends_on`, outcome). The database refuses illegal states: an expiry not after the upload; a file only while the session isn't abandoned; committed exactly when linked to an import, by someone, at a time; a decision only on override rows, which also need `before` and changes; a reason with errors exactly when the row failed; `depends_on` only on a failed row and within its own session; an outcome that fits the status and decision; and — through a deferred link on two generated columns — an outcome only once the session is committed, then on every row, and no rows on an abandoned session. Rows go with their session. Indexes cover `(session_id, status, sheet, row_no)`, dependencies and stale sessions. RLS on and forced; no anon/authenticated access. 13 tests. **Applied to production 2026-09-24** (aws-1-ap-south-1 pooler, Postgres 17): the check found both names free and `billing_imports`, `doctors` and `gen_random_uuid()` present; `--apply` ran it in one transaction with a 5 s lock timeout; the read-only verify passed all 23 checks (both tables with exactly the planned columns, types and NOT NULLs, both generated columns, all 38 checks, keys and links, the deferred state link, cascade and RESTRICT deletes, every allowed-value list including the nine sheet names, all 4 indexes, RLS on and forced, no anon/authenticated access, both empty). The migration is additive only — its sole `ALTER`s switch RLS on for the two new tables.
- [x] **P2b-02 · Create a session from an upload** — `Done`
  - **Where:** `server/services/billing/importSessions.js`.
  - **Steps:**
    1. Parse and check the file once, reusing `importParse` / `importValidate` /
       `importPreview` — the checks do not change.
    2. Store every row with its status. A brand-new row that passes is
       **Ready**; an existing row with **any** difference is **Needs
       override**, with `before` (the stored values at upload) and `changes`
       (old → new per column); identical is **Unchanged**; an error is
       **Failed** with its reason.
    3. **Cascade failures** to dependent new rows, naming the row they depend
       on (plan §9a rule 2).
    4. A contradiction (a price below a payment rule, an amount above a price)
       is Failed, never Needs override (rule 1).
  - **Done when:** a file with new, changed, identical and bad rows produces the
    four statuses, and a failed new group fails its subgroups, items and rates.
  - **E2E test:** `e2e/billing/phase2b/P2b-02-create-a-session.spec.js`.

  - **Result:** Done 2026-09-24 (built by a sub-agent). `createSession` in the new `server/services/billing/importSessions.js` parses the file once and runs the unchanged P2-04–P2-07 checks and the dry-run price check, storing each row as Ready (new), Needs override (any difference, with `before` and old→new `changes`), Unchanged, or Failed (with its reason). The checks run again without the failed rows until nothing more fails, so a failed new group, subgroup, item or category fails every row that refers to it — each saying "Depends on Items row 14, which failed" and linked to it — while a failed *existing* row does not fail the rows under it. Contradictions are always Failed (a price under a payment rule, an amount above a price, an unknown code); a daily-cap change fails for reception_admin; a Consultant fees row is one row with one decision covering its rate and its rule. A file that can't be read row by row is refused (422) with its problems. Creating a session saves nothing to the master data and is audited. 9 tests.
- [x] **P2b-03 · Rows: filters and server-side paging** — `Done`
  - **What:** list a session's rows by status, sheet and a search on code or
    name, 50 a page, with the total and counts per status and per sheet for the
    filter chips.
  - **Done when:** each filter and page returns exactly the right rows, and a
    10,000-row session pages without loading everything.
  - **E2E test:** `e2e/billing/phase2b/P2b-03-rows-filters-and-paging.spec.js`.

  - **Result:** Done 2026-09-24 (built by a sub-agent). `listRows` filters by status, outcome, sheet and a search on code or name (case-insensitive, `%` and `_` literal) and returns 50 rows a page **paged in SQL**, with the total, page count and chip counts — each facet applying the other filters but not its own — from one aggregate query. A 10,000-row session pages through 2,500 filtered rows in about a second, and no query returns more than 50 rows. 5 tests.
- [x] **P2b-04 · Override or keep** — `Done`
  - **What:** set a Needs-override row to override or keep, one row at a time
    or for every row matching the current filter. Only Needs-override rows take
    a decision; only the uploader or an admin may decide; a committed, abandoned
    or expired session refuses. Audited.
  - **Done when:** single and filtered decisions are saved, and the refusals are
    in words.
  - **E2E test:** `e2e/billing/phase2b/P2b-04-override-or-keep.spec.js`.

  - **Result:** Done 2026-09-24 (built by a sub-agent). `decideRows` sets override, keep or pending (to undo) on up to 500 rows by id, or on every override row matching a sheet and search filter. Refused in words: a row that doesn't need an override, a filter on another status, a filter matching nothing, rows from another session, and anyone but the uploader or an admin; a committed or abandoned session gives 409, an expired one 410. Every call writes one audit row. 7 tests.
- [x] **P2b-05 · Commit: partial** — `Done`
  - **Steps:** in one transaction —
    1. Save Ready rows and overridden rows; undecided rows are **kept**.
    2. Compare each overridden row with the database; one changed since upload
       **fails** with "changed since you uploaded" (rule 3).
    3. Re-run the price checks on what will be saved; a row that now conflicts
       **fails** with its reason (rule 4).
    4. Cascade those new failures to their dependents.
    5. Record `billing_imports`, the audit rows with `import_id`, and price
       history — as today. Store each row's outcome (saved / kept / failed /
       unchanged) and link the session to the import.
  - **Done when:** a session with ready, overridden, kept and failed rows saves
    exactly the right rows; a row edited on the Services page after upload is
    not overwritten; the report says what happened to every row.
  - **E2E test:** `e2e/billing/phase2b/P2b-05-commit-partial.spec.js`.

  - **Result:** Done 2026-09-24 (built by a sub-agent). `commitSession` saves Ready and overridden rows in one transaction and keeps undecided and kept rows. It **works out the final set before writing**: the stored file is re-parsed, only Ready and overridden rows are checked against the database as it is now, failures and their new dependents are dropped, and the checks repeat until stable. That set is written inside **one savepoint** with the existing batched save and price-conflict check — if rows conflict, it rolls back to the savepoint, fails them and repeats; if not, the savepoint becomes the real save. An overridden row changed since upload fails with "Changed since you uploaded (now base_price ₹550) — upload again"; a Ready row whose code now exists fails as "Added in Scribe after you uploaded"; an overridden row since deleted fails too; the rest is saved. It records `billing_imports` (now with kept and failed counts), audit rows with `import_id` and price history as today, stores every row's outcome and links the session to its import. A kept parent does not fail its dependents; a rule that relied on a kept price fails. A failure that isn't a row check saves nothing and leaves the session open to retry. 5,000 items triage in 3.6 s and commit in 2.1 s locally. 8 tests.
- [x] **P2b-06 · Failed rows download** — `Done`
  - **What:** the Failed rows (before or after commit) as Excel, each with its
    reason, built from the admin's own workbook as the current error file is.
  - **E2E test:** `e2e/billing/phase2b/P2b-06-failed-rows-download.spec.js`.

  - **Result:** Done 2026-09-24 (built by a sub-agent). `failedRowsFile` builds the file from the admin's own stored workbook with the existing `importErrorFile`, covering rows that failed at upload or during the commit, each with its reason and shaded cells, named "<file> - errors.xlsx"; fixed in place, it uploads again cleanly. 422 when no row failed, 409 once abandoned. 4 tests.
- [x] **P2b-07 · Expiry and abandon** — `Done`
  - **What:** a session expires 24 h after upload and can't be committed;
    expired and abandoned sessions are deleted with their rows; committed ones
    keep their rows as the import's report. Abandon on request.
  - **E2E test:** `e2e/billing/phase2b/P2b-07-expiry-and-abandon.spec.js`.

  - **Result:** Done 2026-09-24 (built by a sub-agent). Sessions expire 24 hours after upload; an expired session can't be decided or committed (410) but can be read or abandoned. `abandonSession` deletes the rows and the file at once and is audited. `purgeStaleSessions` deletes expired and abandoned sessions with their rows; committed sessions keep their rows as the import's report. **The sweep runs only on the next upload** — nothing runs it on a schedule yet. 5 tests.
- [x] **P2b-08 · Schemas and routes** — `Done`
  - **Where:** `server/schemas/billing.js`, `server/routes/billingImport.js`,
    behind `BILLING_MASTER`.
  - **What:** create a session (upload), read it, list rows (query: status,
    sheet, q, page), decide (row ids, or a filter), commit, failed-rows
    download, abandon. Every bad parameter a readable 4xx.
  - **E2E test:** `e2e/billing/phase2b/P2b-08-routes.spec.js`.

  - **Result:** Done 2026-09-24 (built by a sub-agent). Seven routes under `/api/billing/import/sessions` behind `BILLING_MASTER`: upload (201), read, rows, decisions, commit, failed download, abandon. Strict Zod schemas (`billingImportRowsQuerySchema`, `billingImportDecisionSchema` — a decision plus exactly one of `row_ids` (1–500) or a `filter`) with readable labels; ctx carries the role. 23 bad-parameter cases each give a readable 4xx; four roles and no login get 403 on every route; `verify-rbac.mjs` has the new paths. The old `/import/preview`, `/import/commit` and `/import/errors` are untouched until P2b-10. 8 tests, run by mounting the real router on a spare port.
- [x] **P2b-09 · Screen** — `Done`
  - **Where:** `src/pages/billing/BillingImportPage.jsx`.
  - **What:** upload → counts → filter chips (All · Ready · Needs override ·
    Failed · Unchanged), sheet filter and search → server-paged table. Needs
    override shows old → new per changed column with **Override** / **Keep**,
    and "Override all" / "Keep all" for the current filter. Failed shows the
    reason. Commit confirms what will be saved, kept and skipped, then shows
    the result. Works at phone width.
  - **Done when:** a whole file can be triaged and committed from the page.
  - **E2E test:** `e2e/billing/phase2b/P2b-09-screen.spec.js`.

  - **Result:** Done 2026-09-24 (built by a sub-agent). `/settings/bulk-import` now works on import sessions, in the page's existing look. Choosing a file creates a session and shows the file, who uploaded it, when it expires, its counts per status, and what a commit would do now (from `live.plan`). Rows are listed 50 a page, paged on the server, with filter chips and counts (All · Ready · Needs override · Failed · Unchanged, taken from the API's `counts`), a sheet filter and a search on code or name. The session and every filter live in the URL (`session`, `status`/`outcome`, `sheet`, `q`, `page`, `row`), following `ServicesSettingsPage`, so a refresh or a shared link keeps the view and a filter change goes back to page 1. A Needs-override row shows old → new for every changed column, its decision in words ("Undecided — will be kept", "Override — will be saved", "Keep — stays as it is") and Override / Keep / Undo; Override all / Keep all decide every override row matching the current sheet and search. A failed row gives its reason and what was typed, and a cascaded failure links to its parent row, which is highlighted. Download failed rows gives "<file> - errors.xlsx". **Commit re-reads the session first** and confirms exactly what `live.plan` says will be saved, kept (with how many are undecided), skipped as failed and unchanged — stating in so many words that kept rows are not saved and that a row changed since upload fails rather than being overwritten — then shows the outcome and switches the list to Saved · Kept · Failed · Unchanged; a committed session stays viewable as that import's report. Abandon asks first. An expired import says so and offers a fresh upload; someone else's import is read-only with a note; 403, 404, 409 and 410 are shown in the server's words. New components `ImportSession.jsx`, `ImportRows.jsx`, `importText.js`; hooks and keys added to `useBillingMaster.js`. 10 tests written; the data they rely on was checked against the test database (57 ready, 3 override, 2 failed, 1 unchanged; the cascade reason; the plan and outcome counts).
  - **Run (2026-09-24):** the browser spec passed **10/10 on its first run** against the test servers (40 s) — upload and counts, every chip, server paging and the filter in the URL, old → new with Override/Keep/Undo, Override all scoped to the filter, a failed row's reason and the jump to its parent, the commit confirmation matching `live.plan` then the outcome view, expired and not-your-import handling, Abandon, and no sideways scroll at 390 px. **The P2-11 and P2-12 browser specs now fail** — they drive the old page — and are P2b-10's to update.
  - **Left for P2b-10:** the old hooks (`usePreviewBillingImport`, `useCommitBillingImport`, `useBillingImportErrorFile`), the old routes and the old CSS classes; the P2-11/P2-12 specs; and a link from Import history to a session's report (needs `session_id` in `/import/history`, whose exact keys P2-10 test 4 pins).
- [x] **P2b-10 · Retire the old flow** — `Done`
  - **What:** remove `POST /import/preview`, `/import/commit` and
    `/import/errors` once P2b-09 replaces them; update the Phase 2 specs that
    use them, and the Read me sheet's "all or nothing" wording.
  - **E2E test:** No new spec — the updated Phase 2 specs.

  - **Result:** Done 2026-09-24 (built by a sub-agent). `POST /api/billing/import/preview`, `/import/commit` and `/import/errors` are removed with their hooks (`usePreviewBillingImport`, `useCommitBillingImport`, `useBillingImportErrorFile`) and five unused CSS rules, each checked unused by grep. The services behind them are **kept**: the sessions reuse their checks and writes, `failedRowsFile` uses `importErrorFile`, and `commitUpload` / `previewUpload` are still called by `p2b-fixture`'s seed, P2-07/08/09, P3-04/05/22 and `smoke:billing-import`. `verify-rbac.mjs` now checks the session paths. `/import/history` rows carry `session_id`, and each committed import links to its session report ("View report"). The Read me intro and rule 16 now describe the partial import with Override, and `billing-template.xlsx` was rebuilt (P0-01/P0-02 pass). P2-10 now tests the session routes — **its intent changed on purpose**: a file with a bad row now saves its good row (§9a), `session_id` is pinned in history, and the old routes return 404. P2-11 and P2-12 drive the session screen; P2-11's mocked "data changed" commit is replaced by a **real race** (override a row, change it in the database, commit — the row fails with "Changed since you uploaded" and nothing is overwritten). The removed checks were for the old Preview screen only. Verified by mounting the real router on a spare port (P2-03 5/5, P2-10 9/9, P2-11 15/15).
- [x] **P2b-11 · Checks** — `Done`
  - **What:** a smoke script over a whole session (`smoke:billing-import`
    extended), the full billing suite green, and plan §0b updated.
  - **E2E test:** No new spec — run `npm run test:e2e:billing`.

  - **Result:** Done 2026-09-24 (built by a sub-agent). `smoke:billing-import` gained check 6, a whole session inside its rolled-back transaction: upload with all four statuses and nothing saved, one Override, the plan (save 4 / keep 1 / failed 1 / unchanged 1), a partial commit with that outcome, the session linked to its import, only the right rows written, every row's outcome stored, the import's counts and audit rows, and the failed-rows file — 8/8, twice, with the test-database guard unchanged. All of Phase 2 and 2b plus P1-25 and P3-22 ran twice back to back: 223 passed each time. The only 4 failures (and the 12 serial tests after them) are the running test API still serving the old code — the old Read me text, no `session_id` in history, no report link — and pass once it restarts. **Confirmed 2026-09-24 after the API restart:** P2-03, P2-10, P2-11 and P2-12 over HTTP — 32/32. Plan §0b now has "Phase 2b as built".
---

## Phase 3 — Payment rules, discounts, pricing engine

Goal: for any patient and any list of items, the server calculates the actual
amount, discounts, tax, what the patient pays, and what is claimed. Admins
manage payment rules and discount codes.

### 3A. Database

- [x] **P3-01 · Migration: payment rules** — `Done`
  - **Where:** `server/migrations/<date>_billing_rules.sql`.
  - **What:** `category_payment_rules` with every column in plan §5.3a:
    - `scheme_code`, `name`;
    - `group_id`, `subgroup_id`, `service_item_id`, `visit_types`;
    - `patient_pays`, `patient_value`, `remainder`;
    - `valid_from`, `valid_to`, `priority`, `is_active`.

    Plus `UNIQUE (scheme_code, name)`, a CHECK that at most one scope column
    is set, a CHECK that `amount`/`percent` has a value, and RLS.

  - **Done when:** the SQL is reviewed.
  - **E2E test:** `e2e/billing/phase3/P3-01-migration-payment-rules.spec.js` — asserts: the migration runs twice on a fresh test database without error; the new tables, columns and indexes exist; RLS is on; no business rows are inserted.
  - **Result:** Done 2026-09-22. `server/migrations/2026-10-14_billing_rules.sql` (P3-02 adds the discount rules to the same file) creates `category_payment_rules` with every §5.3a column plus `created_at/by`, `updated_at/by` like the other billing tables. Rules in the database: a non-blank name, unique per category ignoring case (`(scheme_code, lower(name))`, like category rules); at most one of group / subgroup / item (`num_nonnulls(...) <= 1`); `amount` and `percent` need a value and `full` / `nothing` must not have one; a percent is at most 100 and no value is negative; `visit_types` is NULL (any visit) or a non-empty list of New / Follow Up / Investigation with no blanks; `patient_pays` and `remainder` from the shared vocabulary; `valid_to` not before `valid_from`, which defaults to today in India; priority ≥ 0. Indexes: the unique name, active rules by category and priority, and the group, subgroup and item links. RLS on and forced; no access for anon / authenticated; no rows seeded. **Differs from §5.3a:** the category link is `ON DELETE RESTRICT`, not `CASCADE` — the same as every other billing link — so deleting a category that has payment rules is refused with the list of uses instead of silently deleting its rules; the group, subgroup and item links are `RESTRICT` too, and all four are added to `USAGE_KINDS` in `usage.js` ("2 payment rules cover Lab"). "A claim needs a payer name" stays a service check (P3-04), since it depends on the category's parent. 10 tests; removing the one-scope check, the 100 % limit or a usage link each fails a test (P1-14's database-link check fails too). Not applied to production yet (P3-03). Review (2026-09-22), tried on the test database: **a visit type could be listed twice** (`{New, New}` saved) — a new `billing_array_is_distinct(anyarray)` function refuses repeats (P3-02's discount lists will use it too); **"Same" and "Same " were two different rules**, and a name of only a tab or line break passed the blank check — names must now have a visible character and no leading or trailing whitespace. **The Payment rules sheet had no column map** like Categories, Category rules and Category rates have — `PAYMENT_RULE_DB_COLUMNS` in `importColumns.js` maps every sheet column to a real table column (test 11), ready for P3-22. A refused delete now shows "2 payment rules cover Lab X" / "2 payment rules for X scheme" (test 12). Noted, not changed: a value with more than 2 decimals (12.345 %) is rounded by the database to 12.35 like every other money column; the service refuses it before saving (P3-04). Removing the repeat check, the name check or a column mapping fails its test; P1-09 and P1-14 still pass (29 with P3-01). Follow-up (2026-09-23): a payment rule's name is unique per category by the import's key (trimmed, inner whitespace collapsed, case-folded), not just `lower(name)` — before, "Consultation ₹700" and "Consultation ₹700" could both be saved and the next bulk import merged them. **Noted:** the unique index still folds case only; rebuilding it on the collapsed key needs a de-duplication pass on production first.

- [x] **P3-02 · Migration: discount rules** — `Done`
  - **Where:** same file.
  - **What:** `discount_rules` with every column in plan §5.4:
    - `code` (unique, nullable), `name` (unique);
    - `method` (`auto` / `code`), `kind` (`percent` / `flat` /
      `fixed_price`), `value`, `max_discount`;
    - targets: `group_ids`, `subgroup_ids`, `service_item_ids`, `doctor_ids`,
      `visit_types`, `scheme_codes`;
    - `min_age`, `max_age`, `gender`, dates, usage limits, `applies_per`,
      `priority`, `stackable`, `applies_on_scheme_rate`, `allowed_roles`,
      `is_active`.

    Plus RLS.

  - **Done when:** the SQL is reviewed.
  - **Also:** `max_uses_per_day` and `max_uses_per_doctor_per_day` (both
    nullable integers ≥ 1), for doctor coupons (R15).
  - **Also (P1-14 review):** add the target arrays to `USAGE_KINDS` in
    `usage.js` — `group_ids` (group), `subgroup_ids` (subgroup),
    `service_item_ids` (item), `scheme_codes` (category) — matched with
    `$1 = ANY(column)`, so a group or category a discount rule targets can't be
    deleted. The P1-14 tests don't catch arrays, so this step is manual; add a
    test case for each.
  - **Also (P1-22):** a discount `code` must never equal a category bill code
    (`category_item_rates.bill_code`), and the category rates save (P1-22)
    must then refuse a bill code equal to an existing discount code — both
    directions, ignoring case.
  - **E2E test:** `e2e/billing/phase3/P3-02-migration-discount-rules.spec.js` — asserts: the migration runs twice on a fresh test database without error; the new tables, columns and indexes exist; RLS is on; no business rows are inserted.
  - **Result:** Done 2026-09-22 — SQL ready for review; not applied to production (P3-03). Added to `2026-10-14_billing_rules.sql`: `discount_rules` with every §5.4 column, `max_uses_per_day` and `max_uses_per_doctor_per_day`, and the audit columns. Checks: a code has no spaces and is unique ignoring case; **a `code` rule has a code and an `auto` rule has none**; the name has a visible character, no stray whitespace, and is unique ignoring case; value ≥ 0 and a percent ≤ 100; `max_discount` (≥ 0) only on percent rules; each target list (`group_ids`, `subgroup_ids`, `service_item_ids`, `doctor_ids`, `visit_types`, `scheme_codes`) and `allowed_roles` is NULL or non-empty, without blanks or repeats (`billing_array_is_distinct` from P3-01), visit types from New / Follow Up / Investigation and roles from reception / reception*admin / admin; ages 0–150 in order; end not before start; every usage limit ≥ 1; `applies_per` line / bill (default line), priority ≥ 0, `stackable` and `applies_on_scheme_rate` default off. RLS on and forced. **Arrays in `usage.js`:** a use can be marked `any` and is counted with `$1 = ANY(column)`; discount rules are counted against groups, subgroups, items and categories ("2 discount rules cover Lab", "2 discount rules are for CGHS"), so a target can't be deleted without saying why. **Discount code ≠ bill code, both ways, ignoring case:** a trigger (`billing_codes_dont_clash`) on `discount_rules.code` and `category_item_rates.bill_code` refuses either clash — it also guards the bulk import, whose writes don't go through the services; the Category rates save refuses first with "STAFF10 is already the code of the discount "Staff"; choose another bill code"; and the import preview marks such a rate row as an error. P3-07 adds the same check from the discount side. `DISCOUNT_DB_COLUMNS` in `importColumns.js` maps every Discounts sheet column to a table column (`applies_per` has no sheet column; it defaults to per line). 13 tests; removing the rates trigger, the `ANY` matching, the rate-save check, the import check or the code/method rule each fails a test. P3-01, P1-09, P1-14 and P1-22 still pass (53 together). Review (2026-09-22), tried on the test database: **a category written in capitals was accepted but never counted** — a discount for `RV_CGHS` saved, yet the where-is-it-used check looks for `rv_cghs`, so the category could be deleted under it and the discount could never match; category codes in the list must now look like category codes (lower case, 2–32 of a–z, 0–9, *). **A list could name something that doesn't exist** (category `cghss`, a missing group, subgroup, item or doctor id) — lists can't have foreign keys and the bulk import writes without the services, so a new trigger, `billing_discount_targets_exist`, refuses it and names what is missing ("The discount "X" points at something that does not exist: group 999998, category p302_zz"; `general` is allowed); changing only other columns doesn't re-check. P1-14's "every column that holds a category code" check now also covers `scheme_codes`. Checked and fine: the bill-code trigger adds ~0.1 ms a row (3,000 rates in one statement in 0.36 s). Noted, not changed: a target deleted straight in the database (not through the screens, which refuse) would leave a stale id in a list; two desks saving the same code as a bill code and a discount code at the same instant could both pass. Tests 11b and 11c; removing the shape rule or the target check fails its test.

- [x] **P3-03 · Apply the rules migration** — `Done`
  - **Done when:** both tables exist in production, empty.
  - **E2E test:** No new spec — rebuild the test database and run the whole billing suite.
  - **Result:** Done 2026-09-22. Applied to production by the user with a check-then-apply script (one transaction; before: neither table, after: both tables, 0 category rates touched). The verify script's checks passed: both tables exist and are empty, with 18 / 32 columns, RLS on and forced, no anon / authenticated access, all 8 indexes, 3 triggers and 3 functions, no bill code equal to a discount code, and a rolled-back probe showing a discount naming a missing group is refused. One probe failed on the first run because of how it was written, not because of the database: it tested the one-scope rule by inserting a rule on an existing group and subgroup, and production has none yet (they come with P2-13), so nothing was inserted and nothing was refused. It now reads the one-scope, value and percent constraints from the table definition. Review (2026-09-22): the fixed verify was rerun on production by the user — ALL OK, 20 of 20 (tables, columns, RLS, grants, empty, indexes, triggers, functions, the three payment-rule constraints, no code clashes, and the missing-target probe, rolled back). The whole billing suite on a rebuilt test database, run by the user after the P3-04 review: 521 passed, none failed or flaky (9.5 min).

### 3B. Payment rules

- [x] **P3-04 · Payment rules service** — `Done`
  - **Where:** `server/services/billing/paymentRules.js`.
  - **What:** list by category or sub-category (with scope names), create,
    update, deactivate, delete, audited.
  - **Save checks:**
    1. `percent` is 0–100 and `amount` is ≥ 0.
    2. An `amount` rule is refused if **any item it covers** costs less than
       the amount; the response lists those items (Q19).
    3. `remainder = claim` is refused unless the sub-category or its parent
       (e.g. CGHS) has a payer name.
    4. `valid_to` is not before `valid_from`.
  - **Done when:** each check refuses with a clear message.
  - **E2E test:** `e2e/billing/phase3/P3-04-payment-rules-service.spec.js` — asserts: each check refuses with a clear message.
  - **Result:** Done 2026-09-22. `server/services/billing/paymentRules.js`: `listPaymentRules({ schemeCode, activeOnly })` returns a sub-category's own rules plus its parent's (marked `inherited`), each with the category's display name, its `scope` (item / subgroup / group / category) and the scope's name; `createPaymentRule`, `updatePaymentRule` (checks run on the merged rule), `setPaymentRuleActive` (reactivating re-runs every check) and `deletePaymentRule`, each audited in one transaction like the category rules service. **Check 1:** a percent is 0–100 and an amount is 0 or more, at most 2 decimals; `amount` and `percent` need a value and `full` / `nothing` refuse one (switching a rule to full or nothing clears its old value); at most one of group / subgroup / item; visit types come from the shared list, repeats are dropped. **Check 2 (Q19):** an `amount` rule is refused when any active item it covers costs less, naming the items with their prices ("The patient can't pay ₹700 for items that cost less: Dressing (₹300). Lower the amount, or put the rule on only the items it is meant for."; up to 10 are named, then "and N more", and all are in `items`). An item's price is its category rate for the rule's dates: the category's own rate, else its parent's, else the base price; deactivated items don't count. `itemsPricedBelow` is exported so P3-05 can check the other direction. **Check 3:** when the rest goes to `claim` (and the rule isn't `full`), the category or its parent needs a payer name; otherwise it's refused and the admin is told to add one or send the rest to adjustment. **Check 4:** the To date isn't before the From date, which defaults to today in India. Also: the category must exist and not be retired (unlike category rules, a parent such as CGHS may hold rules, as defaults for its sub-categories); the group, subgroup or item must exist and be active; names are unique per category, ignoring case. The routes and screen come with P3-18. 10 tests; removing the amount check, the payer check, the 100 % limit, the date order or the category's own rate each fails a test. P3-01, P3-02, P1-20 and P1-22 still pass (61 together). ~~**Simplification:** when a category rate covers only part of a rule's dates, the rate is used for the whole period~~ — fixed in the P3-05 review: every day of the rule's dates is checked. Review (2026-09-22), tried on the test database: **a parent's amount rule ignored its sub-categories' prices** — a CGHS rule "patient pays ₹700" saved although CGHS Veteran patients are charged ₹500 for that consultation (the rule applies to them too); the price check now looks at the category and each of its active sub-categories (their own rate, else the parent's, else the base price) and names the sub-category: "Consultant meet (₹500 for Veteran)"; a retired sub-category isn't billed, so its rate doesn't count (test 11). **A payer name could be removed after claim rules were saved on it**, leaving those rules with no one to claim from — from the Categories screen, by moving a sub-category under a parent with no payer, or by a Categories row in the bulk import with the payer left blank. A new `checkClaimPayers` runs after any change of payer name or parent (in `patientSchemes.js` and in the import's category save) and refuses, listing the rules: "This would leave no payer name for 7 payment rules that send the rest to claim: "CGHS default" (CGHS), … Keep a payer name, or send those rules' rest to adjustment first."; the import is rolled back whole (tests 12, 13). Changing a payer name, or a sub-category with its own payer moving, is still fine. Removing the sub-category check, the retired-sub-category filter, or either payer guard fails its test. 13 tests; P1-08, P1-14, P1-19…P1-22, P1-24, P1-25, P2-08, P2-09 and Phase 3 pass (134 together). Noted, not changed: a deactivated claim rule isn't counted by the payer guard (reactivating it re-checks the payer); an item price or category rate lowered below a rule's amount is P3-05.

- [x] **P3-05 · Protect rules when prices change** — `Done`
  - **Where:** `serviceItems.js`, `categoryRates.js`.
  - **What:** lowering an item's base price or category rate below the amount
    of an `amount` rule that covers it is refused, naming the rule.
  - **Done when:** the refusal works from the screen and from the import.
  - **E2E test:** `e2e/billing/phase3/P3-05-protect-rules-when-prices-change.spec.js` — asserts: the refusal works from the screen and from the import.
  - **Result:** Done 2026-09-22. One check in `paymentRules.js` now serves both directions: `itemsPricedBelow` (a rule against today's prices, P3-04) and the new `checkItemPrices(client, itemIds)` (prices against every active `amount` rule) build the same query — which items a rule covers (item, subgroup, group or whole category), and the lowest price each can have for the rule's dates in the rule's category and each of its active sub-categories (own rate, else the parent's, else the base price). `checkItemPrices` runs inside the same transaction after the write, so a refusal saves nothing: in `serviceItems.js` on create, on a price change, on a move to another subgroup and on reactivation; in `categoryRates.js` after a rate is saved and after a rate is cleared (clearing a sub-category's own rate can fall back to a lower parent rate); and in the bulk import after the items and rates are written, for every item on the Items and Category rates sheets — the whole import is rolled back. The refusal names each item, its price, the rule, its category and its amount: "P305 Dressing (₹450) is below the ₹500 the payment rule "CGHS consults ₹500" (CGHS) has the patient pay. Change or deactivate that rule first, or keep the price at or above its amount." (up to 10, then "and N more"; all are in `conflicts`). The Category rates screen shows it in the row, like its other refusals. Both directions take the same transaction lock (`billing_price_rules`), so a rule and a price saved at the same moment can't both slip past each other. Deactivated rules and `percent` / `nothing` / `full` rules don't hold prices; a deactivated item isn't checked until it is brought back. 7 tests (6 on the services and the import, 1 on the Category rates screen); removing the check from item create, price change, move, reactivation, rate save, rate clear or the import, or counting inactive rules, each fails a test. P3-04 test 5 was moved to its own item: it lowered a rate under a ₹700 rule an earlier test had saved, which is now refused as it should be. The specs that touch items, rates, categories and the import pass (387 plus the fix; P1-32 was flaky once on a slow rate box and passed on its own), and format and build pass. ~~Not covered~~ (both fixed in the review below). Review (2026-09-22), tried on the test database: **a rate covering only part of a rule's dates hid a lower price** — a Veteran rule "patient pays ₹1,200" from 1 October saved because Veteran's own ₹1,500 rate existed, although it only starts on 1 December and until then Veteran pays ECHS's ₹1,000; and clearing a later rate could expose a lower price further on without being noticed. The check now builds each item's price timeline per category once (own rate, else the parent's, else the base price, changing only where a rate starts or ends) and compares every rule with each stretch of its own dates; the message says when: "P305 Scan (₹1,000 from 2027-02-01)" (tests 8, 9). This also removes P3-04's "Simplification". **Moving a subgroup to another group** put its items under that group's rules unchecked — `serviceGroups.js` now checks the moved items (test 10). **A sub-category moved under a parent, or brought back**, could bring a lower rate under the parent's rules — `patientSchemes.js` now runs `checkCategoryPrices` on a move or reactivation (test 11). **The import preview said "ready" and only the save refused** — the preview now runs the same writes inside a transaction it always rolls back (`tryUploadWrites`) and marks the rows that cause a conflict (the rate, base price, subgroup's group or category's parent/active cell) with the same message; a conflict with no row of its own, or any other refusal (e.g. a payer name), becomes a file problem; the save and the preview share `writeSheets` (test 12). **Speed:** at 2,000 items with rules in place the check took 2.3 s, of which 1.9 s was Postgres compiling it (JIT, triggered by an inflated cost estimate); it now runs with JIT off for that transaction and takes 0.3 s; a 2,000-item + 2,000-rate import saves in 2.3 s and previews in 1.4 s. 12 tests; removing the price-end or rule-end date test, the subgroup check, the category check or the preview dry-run each fails a test. Phase 3 passes (50 without the screen test); every spec touching items, groups, rates, categories or the import passes (429; P2-11's phone test was flaky once opening the page, before any preview). Noted, not changed: a group can't move (only subgroups belong to groups), and groups / subgroups can't be deactivated while they have active items, so no other structural change can bring an item under a rule.

- [x] **P3-06 · Payment rule resolver** — `Done`
  - **Where:** `paymentRules.js`.
  - **What:** `ruleForLine({ category, item, visitType, date })`.
  - **Steps:**
    1. Look in the sub-category first (e.g. Pensioner), then its parent
       (CGHS).
    2. Within each: an item rule, then a subgroup rule, then a group rule,
       then a whole-category rule.
    3. Only active rules valid on the date, matching the visit type (or with
       no visit type).
    4. Ties go to the lower `priority`.
    5. No rule means `full`.
  - **Done when:** each level beats the one below it, and a Pensioner rule
    beats a CGHS rule.
  - **E2E test:** `e2e/billing/phase3/P3-06-payment-rule-resolver.spec.js` — asserts: each level beats the one below it, and a Pensioner rule beats a CGHS rule.
  - **Result:** Done 2026-09-22. `ruleForLine({ category, item, visitType, date })` in `paymentRules.js` returns `{ rule, patient_pays, patient_value, remainder, scope, from_parent }` — `scope` is item / subgroup / group / category and `from_parent` says the rule came from the parent (e.g. CGHS for a Pensioner line). One query: active rules of the category and its parent, valid on the date (today in India when not given), for the line's visit type or for any visit, covering the item directly, through its subgroup or its group, or the whole category; ordered sub-category first, then item → subgroup → group → whole category, then lower priority, then the rule saved first (a stable tie-break). No rule, or no category (General), means `full`. A line with no visit type (a lab test) only gets rules without visit types. Refuses an unknown item (404), a bad item id, date or visit type (400). 7 tests; putting specificity before the sub-category, priority before specificity, newer-first ties, group above subgroup, or dropping the visit-type, end-date or active filter each fails a test. Phase 3 passes (57 without the screen test); format and build pass. Review (2026-09-22), tried on the test database: **a mistyped or unknown category priced the line as "patient pays in full"** — `cghs_paidx`, or a number instead of a code, returned `full` with no error, so a CGHS patient could have been charged the whole price; an unknown code is now refused (404) and a non-text value too (400). **A retired category, or a parent that has active sub-categories (CGHS itself), was accepted** — the category resolver already asks the desk to choose a sub-category for such a parent and the category rules call it "can't be billed on its own"; the resolver now refuses both (409: "P306 CGHS has sub-categories, so a line can't be billed under it: choose one of its sub-categories" / "… is retired"). No category, a blank one or `general` (any case) still means General and pays in full, and the item is still checked first; codes are matched ignoring case and spaces. The spec now bills on CGHS Paid and Pensioner under CGHS instead of on CGHS itself (test 3 puts the CGHS rule on the parent), plus test 8. Removing the category check, the retired or sub-category refusal, or the `general` shortcut each fails a test. Phase 3 passes (58); format and build pass. Noted for P3-15: pricing a bill calls this once per line (three small queries); the bill engine can batch it if bills get long.

### 3C. Discount rules

- [x] **P3-07 · Discount rules service** — `Done`
  - **Where:** `server/services/billing/discountRules.js`.
  - **What:** list (with usage count from `bill_line_discounts` once it
    exists), create, update, deactivate, delete, audited.
  - **Save checks:**
    1. `code` is required for `code` rules and empty for `auto` rules.
    2. `percent` is 0–100.
    3. Every target id exists.
    4. The code doesn't equal any category bill code; `categoryRates.js` also
       refuses a bill code equal to a discount code.
    5. Choosing CGHS in `scheme_codes` covers its sub-categories; choosing a
       sub-category covers only that one.
  - **Done when:** each check refuses with a clear message.
  - **E2E test:** `e2e/billing/phase3/P3-07-discount-rules-service.spec.js` — asserts: each check refuses with a clear message.
  - **Result:** Done 2026-09-22. `server/services/billing/discountRules.js`: `listDiscountRules({ activeOnly, method })` (each rule with the names of its groups, subgroups, items, doctors and categories, for the screen), `createDiscountRule`, `updateDiscountRule` (checks run on the merged rule), `setDiscountRuleActive` (turning a rule back on re-checks every target, code and category) and `deleteDiscountRule`, each audited in one transaction. **Check 1:** a `code` discount needs a code (no spaces) and an `auto` one has none; switching a rule to automatic clears its code. **Check 2:** a percent is 0–100 with at most 2 decimals; a flat amount or fixed price is 0 or more in rupees and paise; the largest-discount cap only on percent rules (switching away from percent clears it); a fixed price can't apply to the whole bill (it sets each line's price); ages 0–150 in order; dates in order; every usage limit a whole number ≥ 1; kind, method, gender, roles, visit types and applies-per from the shared lists. **Check 3:** every group, subgroup, item and doctor exists ("That group doesn't exist (id …)") and a newly added one is active; ids are de-duplicated. **Check 4:** the code isn't any category bill code, ignoring case ("CC02 is already the bill code of Consultant meet for CGHS › CGHS Paid; choose another discount code"), nor another discount's code; `categoryRates.js` already refuses the other direction and the P3-02 trigger backs both up. Names are unique ignoring case. **Check 5:** category codes are matched ignoring case, must exist (or be `general`) and a newly added one can't be retired; choosing CGHS covers its sub-categories, so listing CGHS and CGHS Paid together is refused ("CGHS already covers its sub-categories … choose the category or its sub-categories, not both"); the matcher (P3-08) applies a parent to its sub-categories. The date, priority and visit-type input checks moved from `paymentRules.js` to `common.js` and are shared. 7 tests; removing the code rule, the 100 % limit, the target check, the active-target check, the parent-and-child check, case-insensitive bill-code matching or the name check each fails a test. Phase 3 passes (65); format and build pass. **Not yet:** the usage count in the list waits for `bill_line_discounts` (Phase 4); routes and screen come with P3-19. Review (2026-09-22), tried on the test database: **a discount that takes nothing off could be saved** — 0 % off, ₹0 off, and a percent discount capped at ₹0 all saved; a desk could enter such a code, see it "applied" and use up its limits for nothing. They are now refused ("A 0% discount takes nothing off; enter more than 0", "A ₹0 discount…", "A largest discount of ₹0 would take nothing off; enter more than 0, or leave it empty for no limit"); a fixed price of ₹0 (free) is still allowed. **An automatic discount could list desk roles** ("who may enter this code"), which means nothing for a discount nobody enters and reads as if it limited who gets it; it is now refused, and switching a code discount to automatic clears its roles along with its code. Checked and left: a coupon's doctors can be any active doctor, the same as a consultation item's doctor in `serviceItems.js`; a coupon for someone who never appears on a line simply never applies. A code or name clash that slips past the service between its check and its write is still stopped by the P3-02 trigger and the unique indexes, and comes back as a 409 with the trigger's message. Test 8; removing any of the five new checks fails it. Phase 3 passes (66); format and build pass. Follow-up (2026-09-23): a discount's name is now unique by the **import's** key — trimmed, inner whitespace collapsed, case-folded — so "Staff 10%" and "staff 10%" are one name (before, both could be saved and the next import merged them); and `listDiscountRules` now also returns `groups` / `subgroups` / `items` / `doctors` as `{ id, name, is_active }` and `categories` as `{ code, label, display_label, is_active }`, each in the order of the rule's own id array and including targets since switched off, so the Discounts screen names exactly what was chosen without fetching the whole master list (the old `*_names` fields stay).

- [x] **P3-08 · Discount matcher** — `Done`
  - **Where:** `discountRules.js`.
  - **What:**
    - `autoRulesFor(line, context)` returns the active automatic rules that
      match.
    - `checkCode(code, context)` returns the rule, or a refusal reason:
      unknown, inactive, expired, not yet valid, not for this category, not
      for these items, not for this consultant or visit type, total limit
      reached, patient limit reached, role not allowed, too many codes on this
      bill.
  - **Done when:** every refusal reason can be produced.
  - **Doctor coupons and daily limits:**
    - a code with `doctor_ids` only applies to lines for those doctors
      (refusal: "not for this doctor");
    - usage is counted from `bill_line_discounts` on final, non-cancelled
      bills, per calendar day (Asia/Kolkata) and per doctor per day
      (refusals: "daily limit reached — N of N used today", "daily limit for
      Dr X reached");
    - the check runs when the code is entered and again at finalise with the
      rule row locked (`SELECT … FOR UPDATE`);
    - a cancelled bill releases its use;
    - `usageToday(ruleId)` returns today's count overall and per doctor for
      the screen.
  - **E2E test:** `e2e/billing/phase3/P3-08-discount-matcher.spec.js` — asserts: every refusal reason can be produced.
  - **Result:** Done 2026-09-22 (built by a sub-agent, reviewed by another). `discountRules.js` now matches discounts to lines. `autoRulesFor(line, context)` returns the active automatic rules that match, ordered by priority then id; a rule past a usage limit drops out. `checkCode(code, line, context)` returns `{ ok: true, rule }` or `{ ok: false, reason, message }`, matching codes ignoring case and spaces; reasons, in order: unknown, inactive, role, not_yet_valid, expired ("…expired: it was valid until 2026-10-14"), too_many_codes (against `max_codes_per_bill` and `codesOnBill`), category, patient (age / gender), items, doctor ("…is only for Dr A, and this line has no doctor"), visit_type, total_limit, patient_limit, daily_limit ("Daily limit reached — 2 of 2 used today"), doctor_daily_limit ("Daily limit for Dr A reached — 1 of 1 used today"). `line` = `{ item_id, subgroup_id, group_id, doctor_id, visit_type }` (null = the whole bill); `context` = `{ category, patient: { id, age, gender }, date, role, codesOnBill }`. Matching: listed groups / subgroups / items are a union (none = every line); a doctor or visit-type rule never matches a line without one; a parent category covers its sub-categories and `general` means no category; an unknown age or gender doesn't match an age / gender rule; dates inclusive; roles apply to codes only; bill-level rules are left to P3-15 (`autoRulesFor(null)` returns only them). Usage (`ruleUsage`, `usageToday`) counts distinct final bills with live lines from `bill_line_discounts → bill_lines → bills` as in §5.5 — total, per patient, per bill date, per doctor per bill date — and is zero until those tables exist (Phase 4); the spec proves it on scratch tables in a rolled-back transaction. Every function takes a client, so finalise can re-check with the rule locked. Review (2026-09-22), tried on the test database: **usage was read with two queries per limited rule** (a 20-line bill against 6 capped rules made 260 queries) — one grouped query now counts every candidate rule, at most 3 queries a line (60 for the same bill); **an impossible patient age (176 from a date-of-birth typo) made the whole line fail** although the category resolver accepts that patient — an age outside 0–150 now counts as unknown; clearer "no doctor" and "expired" messages; **specs left catch-all automatic rules switched on in the shared test database**, which leaked into later pricing tests — P3-07, P3-08 and the end-to-end pricing spec now switch off their automatic rules in `afterAll`, and ~420 leftovers were switched off in the test database. 12 tests; 29 deliberate breaks at build time and 4 more in review each failed a test. **Noted:** Phase 4 must lock the rule row (`FOR UPDATE`) at finalise and call `checkCode` / `ruleUsage` with the same client, and confirm the §5.5 column names the usage query assumes; drafts aren't counted; a per-patient limit needs a patient id; unrecognised gender text counts as "Other"; a bill-level rule can be saved with groups, doctors or visit types, whose meaning at bill level (e.g. "off the subtotal of those lines") P3-15 decides; `usageToday` gets its route with P3-19.

### 3D. Pricing engine

- [x] **P3-09 · Line pricing: actual amount** — `Done`
  - **Where:** `server/services/billing/priceLine.js`.
  - **Steps:**
    1. Take the item's base price.
    2. Apply the category rate (sub-category first, then parent, valid on the
       bill date), including its bill name and bill code.
    3. Actual amount = quantity × rate, in paise.
  - **Done when:** a CGHS rate replaces the base price for a Pensioner patient
    too, and the bill name/code come through.
  - **E2E test:** `e2e/billing/phase3/P3-09-line-pricing-actual-amount.spec.js` — asserts: a CGHS rate replaces the base price for a Pensioner patient too, and the bill name/code come through.
  - **Result:** Done 2026-09-22 (built by a sub-agent, reviewed by another). `server/services/billing/priceLine.js`: `lineActual({ item, quantity, category, date })` does steps 1–3 — base price, the category rate valid on the date (each of rate, bill name and bill code from the sub-category's row if set, else the parent's, else the item's price / name / none, exactly like `rateGrid`), actual = quantity × rate in whole paise — and refuses an unknown (404) or deactivated (409) item, a quantity other than 1 without `allow_quantity` or above `max_quantity`, a line too large to store, and a category that can't be billed (`checkBillable`, now exported from `paymentRules.js`). `priceLine(input)` is the whole line (§6 steps 1–7): `lineActual` → `ruleForLine` → on full-pay lines the automatic rules and the entered codes (P3-08), de-duplicated → `applyDiscounts` (P3-10) → `lineTax` (P3-11) → `linePayable` (P3-12). Input `{ item, quantity, category, date, visitType, doctorId, patient: { id, age, gender }, role, codes, codesOnBill, settings }`; output: the item snapshot (ids, codes incl. `group_code` / `subgroup_code`, name, kind, unit, the doctor and visit type used), price-list figures (`base_price`, `rate`, `rate_source`, `bill_name`, `bill_code` and their sources, `listed_actual`, `listed_discount`), `actual`, `discount`, `discounts[]` (`rule_id, code, name, kind, value, amount, method`), `refused_codes[]` (`code, reason, message`), the tax fields, `patient_payable`, `claim`, `adjustment`, `remainder`, `capped` and the payment-rule snapshot (`payment_rule_id`, `_text`, `_name`, `_scope`, `_from_parent`); all money in whole paise, and **actual − discount + tax = total = patient_payable + claim + adjustment** on every line. Review (2026-09-22), tried on the test database: the actual amount itself was right. The wider pipeline had eight faults, all fixed with tests: **a price that includes tax didn't balance** — `actual` and `discount` now leave out the tax inside the price and the price-list figures are kept as `listed_actual` / `listed_discount`, so the invariant holds for inclusive and exclusive items alike; **the visit's type and doctor overrode a consultation item's own** — the item's now win; **an unknown doctor id was accepted** (now 404); **refused codes used up the bill's code limit**; **`codesOnBill` sent as text was glued on** ("1" + 0 = "10"); `group_code`, `subgroup_code` and each discount's `method` were missing for the saved line; **a switched-off tax code was still applied** (now 409 while GST is on); **a bill-level code entered on a line was dropped silently** (now reported as `bill_level`). Also: `linePayable` gets the quantity and the line carries the rule's scope. P3-09 8 tests, end-to-end `P3-12-line-pricing-end-to-end.spec.js` 13 tests (CGHS table, plan discount example, per-rule stacking, GST 9 % + 9 %, inclusive prices, quantity); every fix was undone once to confirm its test fails. **Noted for P3-15:** a line costs 3–6 small queries (`checkBillable` runs twice, `ruleForLine` re-reads the item) — pass `settings` once per bill and consider letting `ruleForLine` take the line's ids; re-pricing a draft line whose item was later switched off is refused.

- [x] **P3-10 · Line pricing: discounts on full-pay lines** — `Done`
  - **What:** for lines whose payment rule is `full`, apply automatic rules and
    entered codes.
  - **Steps:**
    1. With `best_only`, only the largest discount applies; ties go to the
       lower priority.
    2. With `per_rule`, the largest non-stackable rule applies first, then
       stackable rules one after another on what remains.
    3. `max_discount` caps a percent rule.
    4. The total discount never exceeds the actual amount.
  - **Done when:** both stacking modes give the expected numbers.
  - **E2E test:** `e2e/billing/phase3/P3-10-line-pricing-discounts-on-full-pay-lines.spec.js` — asserts: both stacking modes give the expected numbers.
  - **Result:** Done 2026-09-22 (built by a sub-agent, reviewed by another). `server/services/billing/lineDiscounts.js`, pure (no database): `applyDiscounts({ actual, quantity, rules, stacking })` → `{ discount, applied: [{ rule_id, code, name, kind, value, amount }] }` in paise. A percent takes its share of what is left, rounded half-up to the paisa and capped at `max_discount`; a flat amount comes off once per line; a fixed price takes the line down to price × quantity (nothing if that isn't lower); no step takes more than what is left, so the total never exceeds the actual. **best_only:** only the single largest discount; ties go to the lower priority number, then the lower id. **per_rule:** the largest non-stackable rule first (the other non-stackables are dropped), then the stackable rules one after another on what remains, by priority then id. Bill-level rules are skipped here (P3-15). In `priceLine` the plan's example comes out exactly: a General 72-year-old's ₹1,000 Follow Up with CC50 pays ₹500 (CC50 −₹500 beats the age rule's −₹100); under per_rule the age rule then takes ₹50 more. Review (2026-09-22): **a percent was a paisa off on lines above ~₹90 crore** (the product passed JavaScript's safe-integer range) — the maths is now exact (BigInt); **the same rule given twice was applied twice** under per_rule — the module now keeps the first of each id itself, so P3-13 and P3-15 can call it safely; **a broken rule row was quietly misread** (a 150 % rule took the whole line, a cap of "abc" or −5 dropped the discount, a blank value became ₹0, a priority of "soon" won every tie) — each is now refused naming the rule. Checked: a smaller non-stackable applies when the top one takes nothing on this line; the same rules in any order give the same result; P3-13 can reuse the module unchanged by passing the patient payable as the amount. 17 tests; every deliberate break failed a test.

- [x] **P3-11 · Line pricing: tax** — `Done`
  - **Steps:**
    1. With GST off: tax is 0 and the exempt code is recorded.
    2. With GST on:
       - taxable = actual − discount, or back-calculated when
         `price_includes_tax`;
       - CGST and SGST are each half the rate;
       - rounding is to the paisa.
  - **Done when:** GST off gives 0, and GST on at 18% gives 9% + 9%.
  - **E2E test:** `e2e/billing/phase3/P3-11-line-pricing-tax.spec.js` — asserts: GST off gives 0, and GST on at 18% gives 9% + 9%.
  - **Result:** Done 2026-09-22 (built by a sub-agent, reviewed by another). `server/services/billing/lineTax.js`, pure: `lineTax({ net, taxCode, gstEnabled, priceIncludesTax })` → `{ tax_code_id, tax_code, sac_hsn, tax_rate, taxable, cgst, sgst, tax, total }` in paise. **GST off, or no tax code:** no tax code, 0 % and 0 tax — the plan's P1-05 decision (no exempt code is seeded or hardcoded), not the "exempt code is recorded" in this task's step text; an admin-made 0 % code with GST on is recorded (code, SAC/HSN, 0 %) with 0 tax for the GST summary, so plan §6 step 5's "non-zero tax code" should read "a tax code". **Exclusive:** CGST and SGST are each half the rate on the net, rounded to the paisa; ₹1,000 at 18 % → ₹90 + ₹90. **Inclusive:** the tax is taken out of the price; `taxable` is always the amount before tax and `total` what the payment rule splits; always CGST + SGST, never IGST. Review (2026-09-22): **CGST and SGST could differ by a paisa on inclusive prices** (₹100 at 18 % gave ₹7.63 + ₹7.62) — the halves are now always equal and the total still equals the price (taxable ₹84.74, ₹7.63 + ₹7.63); **a paisa could be lost near the top of the money range** — exact BigInt maths; **a total too large for a bill line wasn't refused** — now 400; **a blank, true/false or over-precise rate was read as 0 % or 1 %** — refused like P1-16's `cleanRate`; **"false" as text for the GST switch still charged tax** — both switches must be real true/false. 16 tests; every deliberate break failed a test.

- [x] **P3-12 · Line pricing: patient payable and the rest** — `Done`
  - **Steps:**
    1. Resolve the payment rule (P3-06).
    2. The patient pays:
       - `full`: the net amount;
       - `amount`: the rule's amount, capped at the net only as a last safety
         net;
       - `percent`: that % of the net;
       - `nothing`: ₹0.
    3. The rest goes to `claim` or `adjustment` per the rule.
    4. Record the rule id and a text snapshot (e.g. "amount ₹700").
  - **Done when:** the CGHS examples in plan §6 give:
    - CGHS Paid: ₹700 paid, ₹800 claimed (New) and ₹700 paid, ₹300 claimed
      (Follow Up);
    - CGHS Referral and Pensioner: ₹0 paid, the full amount claimed.
  - **E2E test:** `e2e/billing/phase3/P3-12-line-pricing-patient-payable-and-the-rest.spec.js` — asserts: the CGHS examples in plan §6 give: - CGHS Paid: ₹700 paid, ₹800 claimed (New) and ₹700 paid, ₹300 claimed (Follow Up); - CGHS Referral and Pensioner: ₹0 paid, the full amount claimed.
  - **Result:** Done 2026-09-22 (built by a sub-agent, reviewed by another). `server/services/billing/linePayable.js`, pure: `linePayable({ total, payment, quantity })` takes the line's tax-inclusive total and the `ruleForLine` result and returns `{ patient_payable, claim, adjustment, payment_rule_id, payment_rule_text, remainder, capped }`: full → the whole total; amount → the rule's amount per unit, and as the last safety net only, if that is above the line the patient pays the line and nothing is claimed (`capped`, text "amount ₹700 (capped at ₹500)"); percent → that share, rounded to the paisa; nothing → ₹0; the rest goes to `claim` or `adjustment` per the rule; the total always adds up. With GST on, the fixed amount stays fixed and the tax goes to the rest (CGHS Paid ₹700 on ₹1,000 + 18 % → ₹700 paid, ₹480 claimed), as §6 step 5 says. **Done-when met, on real rules:** CGHS Paid ₹700 paid / ₹800 claimed (New, ₹1,500) and ₹700 / ₹300 (Follow Up, ₹1,000); CGHS Referral and Pensioner ₹0 paid, all claimed — including per-doctor consultation items with Pensioner / Referral category fees of ₹350 and ₹700, and through the full `priceLine` (end-to-end spec). Review (2026-09-22), tried on the test database: **an amount rule ignored quantity** (3 dressings at ₹500 under "patient pays ₹200" charged ₹200 and claimed ₹1,300) — the amount is now per unit, like the price guard and the fixed-price discount; **a percent share was a paisa off on the largest lines** — exact maths; **`true` or `[5]` passed as a rule value** — refused; **a capped line's saved text didn't say it was capped** — it now does. 15 tests plus the end-to-end spec; every deliberate break failed a test. **Noted for P3-15:** snapshot the payer name on the bill (the category's own, else its parent's) and refuse a claim line without one.

- [x] **P3-13 · Line pricing: discounts on payment-rule lines** — `Done`
  - **What:** only rules with `applies_on_scheme_rate` apply. They reduce the
    patient payable, never below ₹0; the claim is unchanged. The stacking
    setting applies.
  - **Done when:** with the switch off nothing changes, and with it on the
    patient payable drops.
  - **E2E test:** `e2e/billing/phase3/P3-13-line-pricing-discounts-on-payment-rule-lines.spec.js` — asserts: with the switch off nothing changes, and with it on the patient payable drops.
  - **Result:** Done 2026-09-22 (built by a sub-agent, reviewed by another). `priceLine` now does §6 step 8: on a line under a payment rule (amount, percent or nothing) only discount rules with `applies_on_scheme_rate` apply — matching automatic rules and entered codes that pass `checkCode` — and they come off the **patient payable** after `linePayable`, with the same `applyDiscounts` and stacking setting, never below ₹0; the claim and the adjustment never change. Tax stays on the undiscounted net, as §6 orders it (step 5 before step 8). `discount` / `listed_discount` include the step-8 amount so the line still balances; new fields `payable_discount` and `discounts[].taken_from` (`actual` | `patient_payable`); nothing renamed. A valid code without the switch is refused as `payment_rule` ("The code CC10 doesn't apply here: this line is under the payment rule "Paid consults ₹700", and the code only applies to lines where the patient pays in full"); bill-level codes stay `bill_level`; only accepted codes count towards the bill's limit. **Done-when met:** the same code with the switch off gives exactly the numbers of no code; switched on, CGHS Paid pays ₹630 instead of ₹700 and ₹300 is still claimed. Review (2026-09-22), tried on the test database: step 8 was right (capped lines, percent lines with the rest written off, quantity × fixed price, both stackings); an automatic rule with the switch is an ordinary step-4 discount on a full-pay line (now tested). **A price that includes tax threw a 500 on a correct line** — a 1-paisa discount can lower the tax by 2 paise, so the part without tax went up and the discount came out at −1 paisa (about 1 whole-rupee inclusive price in 13 at 18 %: ₹4, ₹12, ₹20…); the actual is now the larger of the taxable before and after the discount (test 10; a 200k-case search found no other size). Left as decided: a code that can take nothing (a "nothing" line, or one that loses under best only) is accepted and uses its slot (P3-15 reports it with ₹0); a step-8 fixed price sets what the patient pays including tax, a step-4 one the price before tax (for the rule screen's help text). 10 tests.

- [x] **P3-14 · Line invariant** — `Done`
  - **What:** after pricing, check actual − discount + tax = patient payable +
    claim + adjustment, in paise. A mismatch throws, and the line is never
    saved.
  - **Done when:** a deliberately broken input throws.
  - **E2E test:** `e2e/billing/phase3/P3-14-line-invariant.spec.js` — asserts: a deliberately broken input throws.
  - **Result:** Done 2026-09-22 (built by a sub-agent, reviewed by another). `server/services/billing/lineInvariant.js`, pure: `assertLineBalances(line)` returns the line or throws a 500 listing every fault ("The priced line "Consultation (FU)" doesn't balance: …") — a line that doesn't balance is a programming error, so it is never returned or saved; `priceLine` returns every line through it. It checks every money field is whole paise ≥ 0; quantity ≥ 1 and listed actual = quantity × rate; **actual − discount + tax = patient payable + claim + adjustment**; total − payable discount = the same three; taxable + tax = total, CGST = SGST, CGST + SGST = tax; the payable discount ≤ the discount and the patient payable ≤ the total; the listed discounts are whole paise > 0 and add up, each says what it was taken from, and those taken from the patient payable add up to the payable discount; the remainder is `claim`, `adjustment` or none and matches the claim / adjustment; a payment-rule line has no discount off the actual. "Discount ≤ actual" is deliberately not checked (a step-8 discount can exceed the pre-tax actual). `assertBillLineBalances(line)` does the same for a line of a priced bill with its bill-level share (`bill_discount` and its steps add up; total − payable discount − bill discount = patient payable + claim + adjustment; the message names the line number); `priceBill` checks every line with it. Review (2026-09-22), tried on the test database: the balance was right, but four faulty lines got through — a discount that didn't say what it was taken from, a missing or unknown remainder (which let a full-pay line carry a payable discount), and an unexplained discount off the actual on a payment-rule line or step-4 and step-8 discounts on one line; each is now a named fault. A 500 never reaches the desk (the route logs it and returns a reference). 13 tests; 12 deliberate breaks each failed a test; a 200k-case search over the pricing maths raised no false faults; breaking `priceBill`'s bill share is caught by `assertBillLineBalances` naming the line.

- [x] **P3-15 · Bill pricing** — `Done`
  - **Where:** `server/services/billing/priceBill.js`.
  - **Steps:**
    1. Resolve the category once.
    2. Price every line.
    3. Apply bill-level (`applies_per = bill`) rules.
    4. Total everything.
    5. Round the patient payable to the rupee and record `round_off`.
  - **Done when:** the totals equal the sum of the lines plus the round-off.
  - **E2E test:** `e2e/billing/phase3/P3-15-bill-pricing.spec.js` — asserts: the totals equal the sum of the lines plus the round-off.
  - **Result:** Done 2026-09-22 (built by a sub-agent, reviewed by another). `server/services/billing/priceBill.js`: `priceBill({ lines: [{ item, quantity, visitType, doctorId }], patientId, appointmentId, category, patient: { age, gender }, date, visitType, doctorId, role, codes }, db)` prices a whole bill without saving it (1–100 lines; the same item may be on two lines; at most 20 codes). Settings are read once; the category is resolved once — the desk's choice, else the patient's / appointment's through the category resolver; a parent that needs a sub-category is refused (409 with the choices), as are a retired or unknown category; `category: ""` / `null` means General, so callers leave it out when nothing was chosen. The appointment supplies the patient, the visit type (via the shared `billingVisitType`, so blank = New and Investigation reaches Investigation rules) and the doctor. **Codes are entered once per bill:** each is checked once, line codes are tried on every line, a code that applies to several lines counts once towards `max_codes_per_bill`, later codes over the limit are refused, and a code that applies nowhere takes no slot and is refused once with the reason from the line where it got furthest; a code taking ₹0 is listed as applied with ₹0. **Bill-level rules** (automatic, and entered codes) come off the patient payable after line discounts, so claims never change; their groups / subgroups / items / doctors / visit types choose the lines they cover (none = the whole bill); they reach payment-rule lines only with `applies_on_scheme_rate`; stacking is a separate step; each is shared back over its lines in proportion, largest remainder first, so the paise add up; a bill-level fixed price is never applied (refused as `fixed_price`). **Totals** are the sums of the lines; the patient payable is rounded half-up to the rupee and `round_off` (paise, −49…+50) recorded; a claim with no payer name on the category or its parent is refused, and the payer name is returned. **Done-when met:** totals = sum of the lines + round-off on bills with −49 / −32 / 0 / +1 / +50 round-offs. Review (2026-09-22), tried on the test database: **a bill-level fixed-price rule (inserted straight into the database) set a 100-line ₹10,950 bill to ₹1** — now skipped / refused; **the appointment's visit type didn't follow `billingVisitType`** (a blank type charged a CGHS Paid Follow Up ₹1,000 instead of ₹700; Investigation rules could never apply); **a typed-in age of "abc" blamed "Line 1"** — the bill's patient facts are checked up front, and a real patient's recorded facts can't be overridden from the input; **a 20-line CGHS bill with two codes made 249 queries** — identical reads within one pricing now run once (68; 45 for General; 15 for three lines). 16 tests; undoing each fix fails its test. **Decisions for later (recorded, not changed):** with GST on, a bill-level or step-8 discount comes off the tax-inclusive payable and doesn't lower the taxable value, though a discount on the invoice normally does (CGST s.15(3)(a)) — decide before GST is switched on (Phase 7); under `best_only` a line can take its best line discount **plus** a bill-level discount — confirm whether bill rules should compete with line rules; a per-doctor daily limit on a bill-level code isn't checked; a database check should forbid bill-level fixed prices (`CHECK (kind <> 'fixed_price' OR applies_per <> 'bill')`, next migration); `ruleForLine` re-reads the item and batching item / rule reads would bring a 20-line bill to ~15 queries. Follow-up (2026-09-23): the bill's category is now checked **once, up front**, in the query that already describes it — 404 "That category doesn't exist", 409 "<category> is retired", or the bill-level 409 with `needs_sub_category` and `suggestions`, with no `line_no`, for a chosen category exactly as for a resolved one (before, a chosen parent got the line-level wording with nothing to act on); the separate `checkBillable` round trip is gone, so a bill costs one query fewer (test 8). The recorded database check is also done: `server/migrations/2026-10-16_discount_rules_bill_fixed_price.sql` adds `CHECK (kind <> 'fixed_price' OR applies_per <> 'bill')`, covered by the new `P3-02a-migration-no-bill-fixed-price.spec.js`; **before applying it to production**, run `SELECT id, name, is_active FROM discount_rules WHERE kind = 'fixed_price' AND applies_per = 'bill';` and fix any row it returns.

- [x] **P3-16 · Preview endpoint** — `Done`
  - **Where:** `server/routes/billing.js`.
  - **What:** input: patient, visit, item ids, quantities, codes. Output:
    priced lines, the reason for any refused code, and totals. Behind
    `BILLING_DESK`. The schema rejects any price, rate or discount amount.
  - **Done when:** a request carrying a price is rejected with 400.
  - **E2E test:** `e2e/billing/phase3/P3-16-preview-endpoint.spec.js` — asserts: a request carrying a price is rejected with 400.
  - **Result:** Done 2026-09-22 (built by a sub-agent, reviewed by another). `POST /api/billing/preview` in the new `server/routes/billing.js` (mounted in `server/index.js`), behind `BILLING_DESK` (route check + the `/api/billing` gate; reception, reception_admin and admin; others 403; no login 403 "Doctor account required"). Body `{ patient_id?, appointment_id?, category?, date?, visit_type?, doctor_id?, lines: [{ item_id, quantity?, visit_type?, doctor_id? }], codes? }`, checked by `billingPreviewSchema` in `server/schemas/billing.js`: a patient or an appointment is required; 1–100 lines, at most 20 codes (limits from `priceBill.js`); the body and every line are strict, so any price, rate, base price, discount, amount, total, patient payable, claim, settings, role or patient-facts field is a 400 "Unknown field: price" (the done-when); the category is a code only — left out it goes to the resolver, General is named `general`, blank or null is refused, so an empty select can't quietly bill a CGHS patient as General. The role always comes from the login. The response is `priceBill`'s result: priced lines, applied and refused codes with reasons, bill-level discounts, totals with round-off; errors come back as readable JSON with their status, and `billingHttp.js` now passes through `needs_sub_category`, `suggestions`, `line_no`, `items` and `rules` so the desk can act on them. Review (2026-09-22), tried on the test API: **the desk never got what it needs to fix a refused bill** (the sub-category choices and the failing line's number were dropped) — passed through now (test 7b); **several 400s were unreadable** (" is not valid", "Line is not valid", "Discount codes is not valid", "Category is not valid", and 2026-02-30 passing the schema) — now "Send the bill as an object", "Line must be an item, like { item_id: 12 }", "Discount codes must be a list of codes", "Category must be a category code", "Bill date must be a date like 2026-10-01" (tests 6b, 7c). Checked: 101 lines / 21 codes / a 41-character code get readable 400s; `__proto__` / `constructor` are "Unknown field"; no SQL or stack traces in JSON errors. `verify-rbac.mjs` lists the route. Full billing suite (2026-09-22): 686 of 687 passed; P1-38's permission check couldn't read the new file's routes — `billing.js` now declares `const BASE = "/billing"` like the other billing route files, and P1-38 accepts `/billing` itself as a base, so both new routes are now in its every-role checks (P1-38, P3-16, P3-17: 32 passed). 11 tests. **Noted:** a body that isn't JSON still gets Express's HTML error page (a JSON error handler after the body parser in `server/index.js` would fix it app-wide); the preview has no rate limit (~3–6 queries a line) — consider one in Phase 4. Follow-up (2026-09-23): a body that isn't JSON now gets JSON back — an error handler after the body parser in `server/index.js` returns `{ error: "The request body isn't valid JSON" }` with the parser's 400, and the same shape with 413 for a body that is too large; every other error path is unchanged (no spec: the handler can't be imported without starting a server, so it was checked by hand and over HTTP after the restart).

- [x] **P3-17 · "Test this rule" endpoint** — `Done`
  - **What:** input: age, gender, category or sub-category, visit type, items,
    codes (no real patient). Output: the same as the preview. Behind
    `BILLING_MASTER`.
  - **Done when:** it returns the same numbers as the preview for the same
    inputs.
  - **E2E test:** `e2e/billing/phase3/P3-17-test-this-rule-endpoint.spec.js` — asserts: it returns the same numbers as the preview for the same inputs.
  - **Result:** Done 2026-09-22 (built by a sub-agent, reviewed by another). `POST /api/billing/master/test-rule` in `server/routes/billing.js`, behind `BILLING_MASTER` (reception_admin and admin; reception and others 403). Body `{ age?, gender?, category?, date?, visit_type?, doctor_id?, lines, codes?, role? }` (`billingRuleTestSchema`): age a whole number 0–150 or null, gender Male / Female / Other or null, lines / codes / category as in the preview; a real `patient_id` or `appointment_id` is refused ("a rule test uses an age, gender and category, not a real patient"), and so is any money field. Optional `role` (reception / reception_admin / admin, default the tester's own) lets an admin see how a role-limited code behaves at the desk — it only affects the trial, nothing is saved. It calls the same `priceBill` and returns the same shape as the preview. **Done-when met:** for three pairs (a patient with New and codes; an appointment with Follow Up and a doctor; an earlier date) the rule test returns exactly the preview's lines, totals, applied / refused / bill-level discounts, payer, category, date, age, gender, visit type, doctor, settings and warnings for a real patient with the same facts. Review (2026-09-22), tried on the test API: **the "same numbers" check didn't compare everything the desk sees, and one pair used different ages** (69 vs 70, passing only because both are over 60) — the comparison now covers date, age, gender, the full category and warnings; **the tester could only price with their own role** — optional `role` added, and testing as reception gives exactly the reception preview's numbers (test 5b); a failing line's `line_no` comes back; readable 400s. 7 tests. P1-25 test 7's "already an active Follow Up consultation item" was leftover data from earlier runs, not a regression — the spec now retires its leftovers (P1-17's race item has the same habit). Fixed 2026-09-23: P1-17 now cleans up too — its `afterAll` switches off the items it created and deletes the one linked to a catalogue test (the database won't let a test item drop its link), so repeat runs pass (P1-17 and P1-25 together, 18 tests, three runs). Follow-up (2026-09-23): the rule test can now price a rule the admin is still typing. It takes an optional `draft_rule` (`{ patient_pays, patient_value?, remainder?, group_id | subgroup_id | service_item_id, visit_types? }`, validated exactly like a saved payment rule), which `priceBill` / `priceLine` use instead of `ruleForLine` on the lines it covers, so the payment-rules panel no longer has to work the share out in the browser and discounts are included; a covered line shows `payment_rule_name: "Draft rule"` and its text suffixed "(draft)", and the line invariant still holds. It is on the BILLING_MASTER route only — the desk preview's strict schema refuses it (tests 7, 8).

- [x] **P3-17a · Consultant fees service** — `Done`
  - **Where:** `server/services/billing/consultantFees.js`.
  - **What:** one grid for R14: every active consultant × visit type (rows) ×
    General and every category / sub-category (columns). Each cell is that
    doctor's fee and what the patient pays.
  - **Steps:**
    1. **Read:** join each doctor's consultation items with
       `category_item_rates` (fee, bill name, bill code, dates) and the
       item-level `category_payment_rules` (patient pays, value, remainder).
       Mark a cell "inherited" when the value comes from the parent category
       or a group-level rule.
    2. **Save a cell:** in one transaction, upsert the rate row and the
       item-level payment rule for that doctor's item and category; run the
       P3-04 checks (e.g. an `amount` above the fee is refused); audit.
    3. **Clear a cell:** delete the doctor's own rate and rule, so the
       inherited value applies again.
    4. **Copy a column:** copy every doctor's fee and rule from one
       category to another (e.g. Pensioner → CGHS Referral) in one
       transaction.
    5. Doctors with no consultation item are returned as "not priced".
  - **Done when:** saving ₹350 / pays nothing for Dr Rahul and Dr Beant and
    ₹700 / pays nothing for Dr Banshali under Pensioner reloads correctly,
    and copying the column to CGHS Referral gives the same values there.
  - **Start date:** a cell saved from the screen or an upload without a start
    date gets today only when it is new; editing an existing cell keeps its
    start date unless the admin changes it.
  - **E2E test:** `e2e/billing/phase3/P3-17a-consultant-fees-service.spec.js` — asserts: through the API as `reception_admin`, the three doctors' Pensioner cells save and reload, a pays-amount above the fee is refused, clearing a cell falls back to the inherited value, and copying Pensioner to CGHS Referral gives identical cells; `reception` gets 403.
  - **Result:** Done 2026-09-22 (built by a sub-agent). `server/services/billing/consultantFees.js`: `consultantFeeGrid({ doctorId, schemeCode, date })` returns one grid for R14 — rows are active consultants (plus any doctor with an active consultation item, and the hospital default when unfiltered) × New / Follow Up; columns are General and every active category, parents followed by their sub-categories ("CGHS › Pensioner"); each cell gives the fee (own category rate, else the parent's, else the item's base price; General = base price) with bill name / code and their sources, the own rate row and the next scheduled start, and what the patient pays resolved like `ruleForLine`, with `fee_inherited`, `pays_inherited` and `inherited` flags; a doctor × visit type with no active item is listed in `not_priced`. `saveConsultantFee` writes the rate through `saveRate` and the item-level payment rule through the payment-rules service in one transaction, so every P3-04 / P3-05 check and audit runs (a pays-amount above the fee is refused with `items`); a new cell starts today, an edit keeps its start date. `clearConsultantFee` removes the cell's own rate and item-level rules so the inherited values apply again; `copyConsultantFees` copies every consultation item's own fee, bill name / code and rule from one category to another in one transaction (additive: a target cell with its own values is kept when the source has none). General is read-only here (its fee is the item's price, changed on the Services page). Routes in `billingMaster.js`: `GET` / `PUT /consultant-fees`, `DELETE /consultant-fees/:code/items/:itemId`, `POST /consultant-fees/copy`. The same agent added the routes the screens need: `GET/POST /payment-rules`, `PATCH/DELETE /payment-rules/:id`, `PUT /payment-rules/:id/active` (the list marks the parent's rules `inherited`; the "items cost less" 409 carries `items`), and `GET/POST /discounts`, `PATCH/DELETE /discounts/:id`, `PUT /discounts/:id/active` (the list gives target names, `uses_total` and `usage_today: { date, count, by_doctor }`, zero until Phase 4). **Done-when met** on tagged test doctors: ₹350 / ₹350 / ₹700 "pays nothing" under Pensioner reload, and copying to CGHS Referral gives identical cells. 10 service tests + 8 route tests (`P3-18-rules-routes.spec.js`); 11 of 12 deliberate breaks failed a test (the survivor, a removed route-level check, is backed by the `/api/billing/master` gate); P1-38 covers every new route for every role. Review (2026-09-22), tried on the test database: **a cell's payment rule could be saved over one already scheduled for a later date** — "nothing from 2027-03-01" then "full from 2027-02-01" left two overlapping item rules and the grid kept showing the older one (rates were refused in that case, rules weren't); saving a new rule, or pushing a rule's end date later, now refuses with "<item> in <category> already has the payment rule "X" from 2027-03-01; give this one a To date of 2027-02-28 or earlier, or change that rule" (shared with the import; test 11). Checked: saving or copying into a retired category is 409; copying into a parent with sub-categories works; clearing General is 400 and an empty cell 404; route bodies refuse unknown fields, impossible dates and huge ids; a copied bill code can't clash; `usage_today` counts on the India date. **Noted:** copying 500 cells takes ~15 s and the grid ~3 s on the test database's 162 categories (fine for the hospital's ~60 cells); clearing a cell deletes rows that started in the past, which Phase 4's bill links will turn into a 409; an inactive doctor with an active item is editable here but refused by the import. 11 service tests.

### 3E. Screens

- [x] **P3-18 · Payment rules on the Categories page** — `Done`
  - **Steps:**
    1. Add a "What the patient pays" panel for each category and
       sub-category: a list of rules with scope (whole category / group /
       subgroup / item), visit types, patient pays (full / amount ₹ / % /
       nothing), value, claim or adjustment, dates, priority.
    2. On a sub-category, also show the parent's rules as inherited
       (read-only), so the admin sees what applies when the sub-category has
       no own rule.
    3. Add/edit form with a live preview: pick an item, see actual → patient
       pays → rest.
    4. Show the "these items cost less than this amount" refusal as a list.
  - **Done when:** the CGHS Paid, CGHS Referral and Pensioner rules from plan
    §6 can be entered under CGHS and previewed.
  - **E2E test:** `e2e/billing/phase3/P3-18-payment-rules-on-the-categories-page.spec.js` — asserts: the CGHS Paid, CGHS Referral and Pensioner rules from plan §6 can be entered under CGHS and previewed.
  - **Result:** Done 2026-09-22 (built by a sub-agent). `src/components/billing/PaymentRules.jsx` + `PaymentRuleForm.jsx` (styles `src/pages/billing/paymentRules.css`), mounted on the Categories page under "Who belongs". Each category and sub-category has a "What the patient pays" panel: its own rules (applies to whole category / group / subgroup / item with its name; visit types; patient pays full / ₹ / % / nothing; the rest to claim or adjustment; dates; priority; active) with Edit, Deactivate / Activate and Delete (asks first); on a sub-category the parent's rules are listed separately as "From <parent> · inherited", read-only. The add / edit form has scope pickers, visit-type checkboxes (none = every visit), patient pays, an Amount (₹) / Percent (%) field (digits only; hidden for full and nothing), the rest (defaults to "Claimed from <payer>" when there is one), dates, priority and Cancel; a live preview prices a chosen item through `test-rule` ("With this rule: Actual → Patient pays → Rest" next to "With the saved rules"); the "items cost less" refusal is shown as a list (item — price, for which sub-category, from when). **Done-when met:** as reception_admin, CGHS Paid (₹700, New + Follow Up; preview 1,500 → 700 → 800 and 1,000 → 700 → 300), CGHS Referral and Pensioner (nothing) are entered under CGHS's sub-categories, previewed and saved. 10 tests; removing the inherited section, the cheaper-items list, the draft preview or the delete confirmation each fails a test; P1-28, P1-31, P1-32, P1-38 still pass. Review (2026-09-22), tried in the browser: **the "With this rule" preview rounded percents differently from the bill** (₹205 at 12.7 % showed ₹26.03, the bill charges ₹26.04) — the browser now uses the server's whole-paisa half-up maths (test 10 checks the preview against the real test-rule result); **the preview left out tax** — the draft now uses the line total with tax and says "(₹X with tax)", the saved-rules Rest is claim + adjustment, and a line with discounts says "Before discounts" (test 13); **with no payer, editing a Full price rule to Nothing pre-selected Claim and the save was refused** (the server stores `claim` on every full rule) — a full rule's stored remainder is now ignored (test 12); **keyboard focus was lost** when the form opened or closed — Rule name gets focus, Cancel / Save return it (test 14); delete now uses the page's inline "Confirm delete" / "Cancel" like "Who belongs" (test 9); the item picker says "Showing the first 50 of N — type more…" instead of cutting off silently (test 17). Also covered: scope item → group, no visit types = "Any visit" (test 11), a failed load says so (15), no sideways scroll at 390 px (16). 17 tests; 6 deliberate breaks each failed a test. **Noted:** an exact draft preview with discounts needs test-rule to accept a draft rule (backend); Edit still shows on a retired category (the server refuses readably). Review 2 (2026-09-23): **Edit, Deactivate, Delete and "+ Payment rule" still showed on a retired category**, so an admin could fill a whole form before the server refused it — the panel is now read-only there (the rules, the inherited section and the explanation stay visible; the actions column is gone) and says "This category is retired; bring it back to change its rules.", matching how "Who belongs" and the category tree already treat a retired category (test 18). 19 tests. Follow-up (2026-09-23): the "With this rule" preview no longer works the share out in the browser — the panel asks `test-rule` twice behind one debounce, once plain and once with `draft_rule`, and shows the draft line the server returns, so the numbers are the bill's with discounts included (a 12.7 % draft on a ₹205 item under a 10 % automatic discount shows ₹23.44, not the old pre-discount ₹26.04, and the "Before discounts" caveat is gone); coverage is now the server's answer rather than a client-side check, and a bad draft shows the server's message instead of stale numbers (test 10b). 21 tests.

- [x] **P3-18a · Consultant fees screen** — `Done`
  - **Where:** `src/pages/billing/ConsultantFeesPage.jsx`, settings tab
    "Consultant fees", router, routes config (`BILLING_MASTER`).
  - **Steps:**
    1. Grid: rows = doctors (with New / Follow Up), columns = General and
       each category / sub-category shown as "CGHS › Pensioner".
    2. Each cell shows the fee and "pays ₹X / nothing / full"; inherited
       values are shown greyed.
    3. Clicking a cell opens a small editor: fee, patient pays (full /
       amount / % / nothing), value, claim or adjustment, bill name, bill
       code, valid from/to; Save / Clear.
    4. Filters by doctor and category; "Copy column to…" action; "Not
       priced" doctors listed at the top with "Create item".
  - **Done when:** the admin can set the hospital's Pensioner and CGHS
    Referral fees for Dr Rahul, Dr Beant and Dr Banshali from this screen.
  - **E2E test:** `e2e/billing/phase3/P3-18a-consultant-fees-screen.spec.js` — asserts: in the browser as `reception_admin`, the three doctors' Pensioner and CGHS Referral cells are set to ₹350 / ₹350 / ₹700 with "pays nothing", the grid shows them after reload, and the page is not reachable as `reception`.
  - **Result:** Done 2026-09-22 (built by a sub-agent). `/settings/consultant-fees` (`ConsultantFeesPage.jsx`, with `ConsultantFeeEditor`, `ConsultantFeeCopy`, `ConsultantFeeCreateItem` and `consultantFeeText.js`; styles `consultantFees.css`): one grid of each doctor's New and Follow Up consultation item against General and every category / sub-category ("CGHS › Pensioner"), filtered by doctor and category. General shows the item's price, read-only. Every other cell is a button showing the fee and "pays ₹X / nothing / full / N%"; an inherited fee or rule is greyed, dashed and says "inherited", and the button's name spells out where each value comes from. The cell editor has fee, patient pays (as inherited / full / amount / percent / nothing), value, claim (payer shown) or adjustment, bill name, bill code, dates; Save / Clear (confirmed) / Cancel; only what changed is sent, so an edit keeps its start date; refusals ("The patient can't pay ₹400 … the fee there is ₹350") show in the dialog. "Copy column to…" (confirmed) copies one category's own fees and rules to another. Doctors without a consultation item are listed at the top as **Not priced** with **Create item**. Fits a 390 px phone (the grid scrolls in its own box). **Done-when met:** the three doctors' Pensioner fees (₹350 / ₹350 / ₹700, pays nothing) set from the screen survive a reload, and Copy Pensioner → CGHS Referral gives the same cells. 9 tests; 7 deliberate breaks each failed a test. Review (2026-09-22), tried in the browser: **a cell whose own rule was "The full fee" defaulted the rest to Claim when changed to Nothing, even with no payer**, so the save was refused — the editor now uses the payer-based default (test 13); the percent field reads "Percent (%)" like the payment-rules form. Added tests: a failed load says "Could not load the consultant fees." (10); a bill code already used by a discount shows the server's 409 and saves nothing (11); keyboard use of the grid — Enter opens the editor with focus in Fee, Escape and Save return focus to the cell (12). Checked: fee and rule saves refresh every billing query, so other pages aren't stale. 13 tests. **Noted:** if the categories or doctor list fail to load, the filters don't say so; focus falls to the page after "Create item" removes its row. Review 2 (2026-09-23): **the Doctor and Category filters stayed silent when their lists failed to load** — each now carries its own message ("Could not load the doctors — the grid below still shows every doctor."), tied to the select with `aria-describedby`, while the grid keeps working because its rows and columns come from the fees request (tests 14, 15); **keyboard focus fell to the page body after "Create item" removed its Not-priced row** — it now moves to the "Create item" button of the row that took its place, or to the grid's "Fees" heading when the list empties (test 16). 16 tests.

- [x] **P3-19 · Discounts page** — `Done`
  - **Where:** `src/pages/billing/DiscountsSettingsPage.jsx`.
  - **Steps:**
    1. List: name, code, automatic or code, value, what it covers, dates,
       uses, active.
    2. Add/edit form in sections:
       - type and value;
       - covers (groups, subgroups, items, consultants, visit types);
       - who (categories and sub-categories, age, gender);
       - when and how much (dates, limits);
       - control (priority, stackable, also on scheme rates, roles).
    3. Deactivate and delete.
  - **Done when:** `CC50` and an age rule can be created and edited.
  - **Also:** "Doctors" picker (coupon for specific doctors); limits per day and
    per doctor per day; the list shows today's usage against each limit
    (e.g. "7 / 10 today").
  - **E2E test:** `e2e/billing/phase3/P3-19-discounts-page.spec.js` — asserts: `CC50` and an age rule can be created and edited.
  - **Result:** Done 2026-09-22 (built by a sub-agent). `/settings/discounts` (`DiscountsSettingsPage.jsx`, with `DiscountForm.jsx`, `DiscountItemPicker.jsx`, `discountText.js`; styles `discounts.css`). **List:** name and code, automatic or code, value ("50%", "50% up to ₹200", "₹100 off", "fixed ₹300", "… on the bill"), what it covers (or "Every service"), who (General, "CGHS › Pensioner", ages, gender, or "Everyone"), dates, uses against each limit ("42 / 500 in all", "7 / 10 today", "Dr A: 2 / 3 today"), status; search, automatic / codes filter, active only. **Add / edit dialog** in five fieldsets — type and value; what it covers (groups with their subgroups, item search, a Doctors picker for coupons, visit types); who gets it (General and the category tree, ages, gender); when and how much (dates, uses in all / per patient / per day / per doctor per day); control (priority, stackable, also on payment-rule lines, roles for codes only) — digits-only numbers, only changed fields sent on edit, server refusals shown word for word; Edit, Deactivate / Activate, Delete (confirmed). **Done-when met:** CC50 (code, 50 % on the OPD group) and a 10 % automatic 70+ rule are created and edited through the UI. 8 tests (incl. the doctors coupon, limits with today's usage per doctor — mocked, since usage is 0 until Phase 4 — readable refusals, reception turned away); 8 deliberate breaks each failed a test. Review (2026-09-22), tried in the browser: **pressing Enter in the "Items" search saved the discount** — the search sits inside the dialog's form, so an admin typing an item name and pressing Enter saved an unfinished rule without the item; Enter there now does nothing (test 9); **switching Kind to Fixed price left "Applies to" on the disabled "The whole bill"**, so the save was always refused — a fixed price now moves it back to "Each line" (test 10); **an automatic discount with nothing chosen saved silently although it takes money off every bill for every patient** — creating one, or editing a rule into one, now asks first ("Discount every bill?", "Go back" focused) (test 11). Also: the form says what a whole-bill rule's targets mean; field hints are read out with their fields; a coupon's doctors aren't labelled "(inactive)" while the list loads; Delete / Cancel keep keyboard focus; the page fits a 390 px phone. 13 tests; 12 deliberate breaks (with P3-20) each failed a test. **Noted:** Cancel closes a changed form without asking (as `ItemDialog`; Escape and a click outside do ask); chosen items beyond the first 1,000 show as "Item <id>" until the list returns names as `{ id, name }` pairs (backend). Follow-up (2026-09-23): the list and the form now use the discounts list's `groups` / `subgroups` / `items` / `doctors` / `categories` objects, so **the 1,000-item lookup in the form is gone** along with the "Item <id>" and "Doctor <id> (inactive)" fallbacks — an edited rule names exactly what it covers, however large the catalogue; a target switched off since it was chosen reads as "<name> (switched off)" in words, in the list and on the form's chips (test 9b; test 6b covers the doctors being named while the choices list loads). 14 tests.

- [x] **P3-20 · "Test this rule" box** — `Done`
  - **Where:** Discounts page.
  - **What:** enter age, gender, category or sub-category, visit type, items
    and codes → see the priced lines and which rules applied or were refused,
    and why.
  - **Done when:** it matches the preview endpoint.
  - **E2E test:** `e2e/billing/phase3/P3-20-test-this-rule-box.spec.js` — asserts: it matches the preview endpoint.
  - **Result:** Done 2026-09-22 (built by a sub-agent). `RuleTestBox.jsx` + `RuleTestResult.jsx` on the Discounts page: age, gender, category or sub-category (blank = General), visit type, doctor, date, "Test as role", items (with quantity where allowed) and codes → `POST /api/billing/master/test-rule`; shows "Priced as <category> · claim to <payer>", warnings, the priced lines (actual, discount with each step, tax, patient pays, claim, adjustment, payment rule text), the discounts that applied, the codes refused with the server's message, and the totals with a signed round-off; a pricing refusal shows as an alert. **Done-when met:** the spec builds a case in the box (age 70, Female, a tagged sub-category, New, four items incl. quantity 3, a valid, an expired and an unknown code) and checks the box's numbers line by line against a direct `POST /api/billing/preview` for a real patient with the same facts; testing as reception gives the reception preview's numbers. 4 tests; 6 deliberate breaks each failed a test. Review (2026-09-22), tried in the browser: **the category list offered parents with sub-categories (CGHS itself)**, which can never be priced (and the refusal said "Line 1: …") — they are now headings, only their sub-categories can be chosen; **a refused line wasn't pointed at** — items are listed as "Line N" and the refused one says "This line was refused — see below" in words, following the item if others are removed; **numbers from an earlier test stayed on screen as if current** after the inputs changed or a discount was edited — they are now greyed with "…these numbers are out of date. Press Test again."; Enter in the item search no longer runs the test. 5 tests. **Noted for the server:** check a chosen category once, up front in `priceBill`, so its refusal isn't blamed on line 1; a quantity above the maximum is a 400 while other line refusals are 409. Checked 2026-09-23 against the follow-ups: the box needed no change — it prices saved rules through `test-rule` and reads discounts from the pricing result, and the draft rule belongs to the payment-rules panel. 5 tests.

- [x] **P3-21 · Register Phase 3 pages** — `Done`
  - **What:** router (`lazyWithRetry`), routes config, and the settings tab
    for Discounts.
  - **E2E test:** `e2e/billing/phase3/P3-21-register-phase-3-pages.spec.js` — asserts the behaviour described in **What**, through the API and (for screens) the browser.
  - **Result:** Done 2026-09-22. `src/router.jsx` (`lazyWithRetry`), `src/config/routes.js` (`BILLING_MASTER`) and the settings tabs in `SettingsLayout.jsx` now have **Consultant fees** (`/settings/consultant-fees`) and **Discounts** (`/settings/discounts`), between Category rates and Bulk import (the payment rules panel lives on the Categories page, so it needs no page of its own). `useBillingMaster.js` has the hooks for every new route (payment rules, discounts, consultant fees, test-rule, preview), so P1-28's "a hook for every endpoint" check keeps passing. P1-28 and P1-38 list the two new pages (tabs for admin and reception_admin; turned away for everyone else) and pass.

### 3F. Import and checks

- [x] **P3-22 · Switch on the Payment rules and Discounts sheets** — `Done`
  - **Where:** `importTemplate.js`, `importValidate.js`, `importCommit.js`.
  - **Steps:**
    1. Validate payment rule rows with the P3-04 checks.
    2. Validate discount rows with the P3-07 checks.
    3. Save them after category rates in the commit order.
  - **Done when:** a workbook with both sheets previews and imports.
  - **Also:** the `Consultant fees` sheet — each row saved through
    `consultantFees.js` (rate + item-level payment rule); doctor matched by
    name or id; the new discount limit columns.
  - **E2E test:** `e2e/billing/phase3/P3-22-switch-on-the-payment-rules-and-discounts-sheets.spec.js` — asserts: a workbook with both sheets previews and imports.
  - **Result:** Done 2026-09-22 (built by a sub-agent). `LATER_SHEETS` is now empty: the **Payment rules**, **Consultant fees** and **Discounts** sheets are parsed, checked, previewed and saved like the others; the template and `docs/gini-flow/billing-template.xlsx` were rebuilt. **Payment rules** (key category_code + rule_name) get the P3-04 checks through shared helpers (`paymentRuleShapeProblem`, `claimPayerProblem`), including the amount-vs-price check found by the preview's rolled-back dry run and shown on the rule's row. **Consultant fees** (doctor + visit type + category; blank visit type = both): the doctor is matched by name or id (two doctors with the same name are refused with their ids); `general` is refused; a doctor with no consultation item for that visit type is told to create it first; each row is saved as `consultantFees.js` saves a cell (rate checked like a Category rates row + the item's own payment rule; an amount above the fee is refused). **Discounts** (key rule_name) get the P3-07 checks including its review fixes (`discountShapeProblem`); targets are written as codes / doctor names or ids / category codes; codes unique ignoring case and never equal to a bill code in Scribe or in the file (both ways). Commit order: … category rates → payment rules → consultant fees → discounts, batched and audited under the import, then `checkClaimPayers` and the price-conflict check. The import smoke covers the new sheets (7 / 7). 10 tests; 204 service-level specs pass; 7 deliberate breaks each failed a test. **Done-when met:** a workbook with all three sheets previews and imports, and a bad row in each is reported and blocks the save. Review (2026-09-22), tried on the test database: **a Payment rules row and a Consultant fees row for the same cell both saved**, and the fee's "patient pays" was silently lost under the other rule — the fee row is now refused ("The Payment rules sheet (row N) also sets what the patient pays for <item> in <category>; set it in one place"), only when the other row is active, item-level, covers that visit type and overlaps in dates (test 11); **a fee row with a blank To date stretched the cell's current rule over a rule scheduled later** — refused with the service's wording (test 12); **fee rows showed the same problem twice** — each problem now shows once, on the column at fault (test 13). Checked: doctors matched regardless of case or spacing; the same cell twice refused; a fee row and a Category rates row for the same item and category refused; claim-without-payer and bad values use the service's wording; a rule switched off via `active = no` saves even above the price, switching it back on is refused; audit rows carry the import id; the error file lists the new sheets; 500 fee rows preview in 0.45 s and save in 0.48 s. **Noted:** a price conflict found at save time still throws the P3-05 409 instead of returning a marked preview (the preview does mark the row); the import treats names differing only in inner spaces as one, the database doesn't; a blank `valid_from` on the Discounts sheet means today while the screen means no start date (documented in the Read me). 13 tests.

- [ ] **P3-23 · Import the hospital's rules** — `Pending`
  - **Depends on:** P0-07 and P0-08 — the admin team's filled `Payment rules`, `Consultant fees` and `Discounts` sheets, and their decisions on the duplicate doctor records.
  - **What:** upload the Phase 0 `Payment rules` and `Discounts` sheets and fix
    errors with the admin team.
  - **Done when:** the admin team confirms the imported rules, including all
    three CGHS sub-categories.
  - **E2E test:** No new spec — the admin team confirms the rules; the import path is covered by P3-22.

- [x] **P3-24 · Smoke script: pricing** — `Done`
  - **Where:** `server/scripts/smoke-billing-pricing.mjs`,
    `smoke:billing-pricing`.
  - **Checks:**
    1. **CGHS table from plan §6:**
       - CGHS › CGHS Paid, New ₹1,500 → patient ₹700, claim ₹800;
       - CGHS › CGHS Paid, Follow Up ₹1,000 → patient ₹700, claim ₹300;
       - CGHS › CGHS Referral → ₹0 every visit, full amount claimed;
       - CGHS › Pensioner → ₹0, full amount claimed.
    2. **Rule order:** item beats subgroup beats group beats category;
       sub-category beats CGHS; visit type filter.
    3. **Amount checks:** an amount above an item's price is refused at save;
       lowering a price below a rule is refused.
    4. **Automatic discounts:** an age rule at 69 / 70 / 71.
    5. **Stacking:** `best_only` vs `per_rule`, and caps.
    6. **Scheme-rate switch:** `applies_on_scheme_rate` off and on.
    7. **Code refusals:** every refusal reason from P3-08.
    8. **Invariant:** holds on every line.
    9. **GST:** off gives zero tax; on splits CGST/SGST.

    Everything runs inside a rolled-back transaction.

  - **Done when:** the script passes.
  - **Also checked:**
    - Pensioner and CGHS Referral with Dr Rahul / Dr Beant → actual ₹350,
      patient ₹0, claim ₹350; with Dr Banshali → ₹700, ₹0, ₹700;
    - a doctor coupon refused for another doctor;
    - a coupon with `max_uses_per_day = 2` accepted twice and refused the
      third time the same day, and accepted again the next day;
    - `max_uses_per_doctor_per_day` counted separately per doctor;
    - a cancelled bill gives its use back.
  - **E2E test:** `e2e/billing/phase3/P3-24-smoke-script-pricing.spec.js` — the same scenarios as the smoke script, end to end: rules and codes created on screen as `reception_admin`, then priced through the preview API as `reception` for the fixture General, 72-year-old, CGHS Paid, CGHS Referral and Pensioner patients; every expected rupee value is asserted.
  - **Result:** Done 2026-09-22 (built by a sub-agent). `server/scripts/smoke-billing-pricing.mjs`, `npm run smoke:billing-pricing`: everything runs in one transaction that is always rolled back, each check in its own savepoint, with its own tagged data created through the real services (doctors Rahul / Beant / Banshali, CGHS › Paid / Referral / Pensioner, OPD and LAB groups, an 18 % tax code, the per-doctor ₹350 / ₹700 rates and the three CGHS payment rules); it first switches off every automatic discount and sets the billing settings it needs (rolled back). 37 checks, all passing: the §6 CGHS table (Paid New ₹1,500 → ₹700 / ₹800, Follow Up ₹1,000 → ₹700 / ₹300, Referral ₹0 on every visit including 400 days later, Pensioner ₹0; Dr Rahul / Dr Beant ₹350 and Dr Banshali ₹700); rule order and the visit-type filter; the amount-vs-price refusals both ways; the age rule at 69 / 70 / 71; best_only vs per_rule and caps; `applies_on_scheme_rate` off / on; every one of the 15 `CODE_REFUSALS` reasons (a guard fails if the list changes); a doctor coupon refused for another doctor; `max_uses_per_day = 2` accepted twice, refused the third time, accepted the next day; per-doctor daily limits; a cancelled bill giving its use back; the invariant on all 46 priced lines and a 3-line bill; GST off / on (₹90 + ₹90). Usage is counted on scratch bill tables (temp tables that shadow the real ones once Phase 4 exists). It refuses (exit 2, before connecting) a database whose name doesn't contain "test" unless `SMOKE_ANY_DATABASE=1`, like the import smoke; table counts are identical before and after a run. `P3-24-smoke-script-pricing.spec.js` runs it against the test database (2 tests). **Not yet:** the on-screen E2E (rules and codes created as reception_admin, then priced through the preview as reception) — after the P3-18 / P3-19 screens.

- [x] **P3-25 · Update the plan status** — `Done`
  - **E2E test:** No new spec — run `npm run test:e2e:billing`; the whole suite must be green before the phase is marked built.
  - **Result:** Done 2026-09-23. `52-BILLING-PLAN.md`'s status line now reads "Phase 3 built (2026-09-23)" except the hospital's own data (P2-13 and P3-23, both with the admin team), and a new **§0c "Phase 3 as built"** records where the build differs from §5.3a / §5.4 / §6: every link is RESTRICT, money is exact whole paise with a per-line balance check, tax-inclusive prices keep `actual` and `discount` tax-exclusive, an `amount` rule is per unit, tax stays on the undiscounted net (to confirm with the accountant before GST), bill-level discounts come off the patient payable and are shared back over their lines, a bill-level fixed price is refused in the service and in the database, `best_only` still lets a bill discount sit on top of a line discount (open decision), preview and "test this rule" are two endpoints that refuse any price in the request and the rule test can price a draft rule, consultant fees have their own grid, and code usage limits count from the Phase 4 bill tables (zero until they exist). The whole billing suite passed on the test database: **786 tests**, none failed (one slow smoke-script test was flaky and passed on retry). Two failures found by those runs were test-only: `P3-17a` and `P3-18-rules-routes` called services without handing over the test database connection, so the service fell back to the server's pool, which has no URL inside the suite; both now pass the test pool in, like every other spec.

---

## Phase 4 — Bills, payments, Billing Counter

Goal: reception bills any patient on the Billing Counter page, takes cash,
card or UPI, prints the bill and receipt, and paid tests are cleared for the
floor. Nothing about the existing "Clear payment" changes.

### 4A. Database

- [x] **P4-01 · Migration: bills and requests** — `Done`
  - **Where:** `server/migrations/<date>_billing_bills.sql`.
  - **What:**
    1. `bills` with every column in plan §5.5:
       - `bill_no`, `series`, `fy`, `bill_type`, `original_bill_id`;
       - `patient_id`, `visit_id` (NOT NULL), `appointment_id`, `bill_date`,
         `status`;
       - snapshots: `scheme_code` (the sub-category, e.g. `pensioner`),
         `scheme_label` (e.g. "CGHS › Pensioner"), `payer_name`;
       - encrypted `scheme_ref_enc` and `referral_no_enc`,
         `referral_doc_id`, `patient_age`, `pay_later`;
       - totals: `actual_amount`, `discount_amount`, `tax_amount`,
         `patient_payable`, `claim_amount`, `adjustment_amount`, `round_off`,
         `paid_amount`;
       - `version`, and the finalise and cancel fields.
    2. `billing_requests` with every column in plan §5.5.
    3. RLS for both.
  - **Done when:** the SQL is reviewed.
  - **Also:** `bills.claim_status` (`none` / `pending` / `cleared`, default
    `none`) and `bills.claim_settlement_id`; an index on
    `(claim_status, bill_date)` for the register.
  - **Also (P1-14 review):** `bills.scheme_code` is a text copy of the category,
    so add it to the category uses in `usage.js` ("N bills are billed as
    CGHS"); the P1-14 category-column test fails until it is. Any bill-line
    column that links to an item is caught the same way.
  - **E2E test:** `e2e/billing/phase4/P4-01-migration-bills-and-requests.spec.js` — asserts: the migration runs twice on a fresh test database without error; the new tables, columns and indexes exist; RLS is on; no business rows are inserted.
  - **Result:** Done 2026-09-23 (built by a sub-agent). `server/migrations/2026-10-17_billing_bills.sql` (P4-02 and P4-03 add their tables to the same file) creates `bills` with every §5.5 column plus `claim_status` / `claim_settlement_id`, `version`, the finalise and cancel fields and the audit columns, and `billing_requests` with every §5.5 column. Rules in the database: a draft never carries a bill number and a final bill always carries one with its series, financial year and finalise time; a cancelled bill has a time and a reason in words; a credit note points at another bill, never itself; a cleared claim has a settlement and nothing else does; a pending or cleared claim is for more than ₹0; the age is 0–150 and the round-off is −0.49…+0.50. A request is either a `new_item` with a proposed name or a `repeat_item` naming the item, never both; an item is only created against an approved new-item request. Indexes: the unique bill number, the visit, the patient's day, the day's board, `(claim_status, bill_date)` for the pending register, and the appointment / original bill / category links. Money `NUMERIC(12,2)`, every link `ON DELETE RESTRICT`, RLS on and forced, no access for anon / authenticated, nothing seeded. Card and referral numbers are stored encrypted (`scheme_ref_enc` / `referral_no_enc`), which needs `AADHAAR_ENCRYPTION_KEY` set or they stay in the clear. **Differs from §5.5:** `referral_doc_id` is an INT with no foreign key (the repo's `documents` table has a SERIAL id, and a bill must never block document housekeeping); `claim_settlement_id` has no foreign key until `claim_settlements` exists. **P1-14 review done:** `usage.js` now counts `bills.scheme_code` ("3 bills are billed as CGHS") and both `billing_requests` item links. 12 tests; not yet applied to production (P4-04). Review (2026-09-23), tried on the test database: **a visit could carry two open drafts** — §7 and P4-06 assume one, and two desks pressing Bill at the same moment would have split a visit's lines across two bills; a unique index on the visit's open invoice draft is now the database's own guard, and the next draft is allowed once the first is final or cancelled. **Nothing tied the stored totals together** — a bill with an actual of ₹1,000 and a payable of ₹100 was accepted; the check now holds `actual − discount + tax + round-off = patient payable + claim + adjustment`, exactly what `priceBill` produces, which pins the P4-13 contract that a bill stores the **rounded** payable. **A bill could be banked for more than it came to** — `paid ≤ payable` now. **`referral_doc_id` pointed at nothing** — it now references `documents(id) ON DELETE SET NULL`, so the ten places that tidy documents away still work and the bill simply loses the link. **A repeat request needed no visit**, though P4-09 matches an approval to an item _and_ a visit. Added the dues index (P4-16, P4-34) and the key a line needs to be tied to its own bill's visit. Checked and left: the round-off range matches the engine's; `version` suits P4-13's lock; the encrypted columns suit `aadhaarCrypt` (the key is set); a bill number is never reused after a cancel; draft / final / cancelled is enough, because a due is a final bill with `paid < payable`. 14 tests; each fix undone once failed its test.

- [x] **P4-02 · Migration: lines and discounts** — `Done`
  - **Where:** same file.
  - **What:**
    1. `bill_lines` with every column in plan §5.5, including `visit_id`
       (NOT NULL), `is_live`, `repeat_request_id`, the snapshots, amounts and
       payment rule snapshot.
    2. The invariant CHECK.
    3. The partial unique index on `(visit_id, service_item_id)` where
       `is_live` and `repeat_request_id IS NULL`.
    4. `bill_line_discounts`.
    5. RLS for both.
  - **Done when:** the SQL is reviewed.
  - **E2E test:** `e2e/billing/phase4/P4-02-migration-lines-and-discounts.spec.js` — asserts: the migration runs twice on a fresh test database without error; the new tables, columns and indexes exist; RLS is on; no business rows are inserted.
  - **Result:** Done 2026-09-23 (built by a sub-agent). Same file. `bill_lines` carries every §5.5 column — `visit_id` (NOT NULL), `line_no`, `source`, `lab_order_id`, `doctor_id`, `is_live`, `repeat_request_id`, the item / bill-code / tax snapshots, the payment-rule snapshot and the amounts — plus `listed_actual`, `listed_discount`, `payable_discount` and `bill_discount` on the P3-14 review's recommendation, without which the invariant can't be written (a tax-inclusive line's `actual` isn't quantity × rate, a step-8 discount can exceed the pre-tax actual, and a bill-level share is folded into the line's discount). **The invariant CHECK** is `actual − discount + cgst + sgst = patient payable + claim + adjustment`, with a second form over the total; also CGST = SGST, `listed_actual = quantity × rate`, the discount is at least its payable and bill parts, the patient never pays more than the line, never a claim and a write-off together, and a line with no payment rule has no claim, write-off or payable discount. **The partial unique index** `(visit_id, service_item_id) WHERE is_live AND repeat_request_id IS NULL` is the database's own guard against billing an item twice on one visit. `bill_line_discounts` records the rule, code, method, amount and `taken_from` (`actual` / `patient_payable` / `bill`) so the saved steps reconcile with the line. The Phase 3 discount usage counting needed no change: a test prices a real CGHS line with an `applies_on_scheme_rate` code (₹700 → ₹630, ₹300 still claimed), saves it and reads the count back. 12 tests: ten real line shapes accepted, eighteen broken ones refused. Review (2026-09-23), tried on the test database: the invariant and the never-twice index were right, but the approval rules were half there. **The same approval could be used on two lines**, and **an approval given for another patient's visit, or another item, was accepted** — both are what P4-09 and P4-20 forbid; one approval now buys exactly one line, for that visit and that item, and a new-item request can never be used as one. **A line's visit did not have to be its bill's visit** — a line could name another patient's visit and slip past the never-twice index; it is now tied to its bill's visit. **The counter's own query (a visit's live lines) had no index** — a sequential scan, now an index. A new test prices a whole four-line CGHS bill through `priceBill` — a payment-rule line with a step-8 code discount, a ₹0 line, a quantity of three, a whole-bill 5 % share and a claim — and saves the bill, every line and every discount step, so everything the pricing engine makes fits the tables. 15 tests; six deliberate breaks each failed a test. **Noted for P4-08 / P4-17:** cancelling every test on a lab order deletes the order, which a billed line now blocks — the billing service must remove the draft line, or test cancellation must refuse with "this test is on bill …".

- [x] **P4-03 · Migration: payments and shifts** — `Done`
  - **Where:** same file.
  - **What:**
    1. `cash_shifts`.
    2. `payments`: mode `cash` / `card` / `upi`; direction `in` only;
       `amount > 0`; `reference`; `receipt_no` unique; `shift_id`.
    3. RLS for both.
  - **Done when:** the SQL is reviewed.
  - **E2E test:** `e2e/billing/phase4/P4-03-migration-payments-and-shifts.spec.js` — asserts: the migration runs twice on a fresh test database without error; the new tables, columns and indexes exist; RLS is on; no business rows are inserted.
  - **Result:** Done 2026-09-23 (built by a sub-agent). Same file. `cash_shifts` (`user_id`, `opened_at`, `closed_at`, `opening_cash`, `expected_cash`, `counted_cash`, `difference`, `note`) and `payments` (`bill_id`, `direction` — `in` only, `mode` cash / card / UPI, `amount > 0`, `reference`, `received_by/at`, `shift_id`, unique `receipt_no`). A desk can have only one open shift; a shift closes only with both an expected and a counted drawer and `difference = counted − expected`, and can't close before it opened. A receipt number is never reused. RLS on and forced, no access for anon / authenticated, nothing seeded. A cash payment is deliberately **not** forced into a shift yet — shift management comes later in Phase 4 and the check would block the payments service before it exists. 9 tests. Review (2026-09-23), tried on the test database: the shift rules and the receipt numbering were right. Two gaps: **a card or UPI payment could be saved with no reference**, though P4-15 requires one (cash still needs none), and **a bill could be banked for more than it came to** (`paid ≤ payable` now backs the payments service). 10 tests; two deliberate breaks each failed a test.

- [x] **P4-04 · Apply the bills migration** — `Done`
  - **Done when:** all Phase 4 tables exist in production, empty.
  - **Result:** Done 2026-09-23. Applied to production by the user with a check-then-apply script (it refuses if any of the six names is already taken, or if `pgcrypto` or `documents` is missing). Before: none of the six tables existed. After: all six exist. The verify script passed every check: the six tables exist, are empty, have row level security on and forced and no access for anon / authenticated; all 8 key indexes are there (the visit's open draft, the bill's own visit, the dues list, the never-twice item lock, a visit's live lines, the repeat approval, receipt numbers, one open shift per desk); and the bill totals, paid, payment reference and line balance checks exist. `bill_series` already holds rows for the numbering P4-05 needs. Scripts: `p404-apply.mjs` / `p404-verify.mjs` in the session scratchpad.
  - **E2E test:** No new spec — rebuild the test database and run the whole billing suite.

### 4B. Numbering

- [x] **P4-05 · Bill and receipt numbers** — `Done`
  - **Where:** `server/services/billing/billNumber.js`.
  - **Steps:**
    1. `nextNumber(client, series, date)` works out the financial year
       (April–March) and locks the `bill_series` row with
       `SELECT … FOR UPDATE`.
    2. It builds `prefix + zero-padded next_no` and increments `next_no`.
    3. With no series row for that year, it throws "Ask the admin to set the
       bill series for 2026-27".
    4. Reuse `financialYear`, `formatNumber` and `BILL_SERIES` (`MAIN` for
       bills, `RCPT` for receipts) from `server/services/billing/billSeries.js`
       (P1-23 / P1-27).
    5. **Once a number has been issued** in a series + financial year (any
       bill or receipt carries it), `saveSeries` refuses to change that
       year's `prefix` or `number_width` (409): GST invoices need one
       consistent, consecutive serial per year. Raising `next_no` stays
       allowed (P1-23 review).
    6. From **1 March**, the billing settings screen (and `listSeries`) warns
       when next financial year's series (`MAIN`, `RCPT`) is missing, so
       billing doesn't stop at midnight on 1 April; the prefix contains the
       year, so it is never created automatically (P1-23 review).
  - **Done when:** two concurrent finalises get consecutive numbers with no gap.
  - **E2E test:** `e2e/billing/phase4/P4-05-bill-and-receipt-numbers.spec.js` — asserts: two concurrent finalises get consecutive numbers with no gap.
  - **Result:** Done 2026-09-23 (built by a sub-agent). `server/services/billing/billNumber.js`: `nextNumber(client, series, date)` works out the April–March financial year, locks that `bill_series` row with `SELECT … FOR UPDATE`, formats `prefix + zero-padded next_no` and increments it, returning `{ number, series, fy, no }` — all of which go onto the bill (`bill_no`, `series`, `fy`), or the number onto `payments.receipt_no`. It must be handed the finalising transaction's client (a pool, or a client with no `BEGIN`, is refused), so a failed finalise **releases** the number instead of burning it; `financialYear`, `formatNumber` and `BILL_SERIES` are reused from `billSeries.js`, with `seriesFor("bill" | "receipt")` so nothing hardcodes MAIN / RCPT. With no row for that year: 409 "Ask the admin to set the bill series for 2038-39"; with `next_no` grown past the width: 409 asking the admin to widen it. **P1-23 review done:** once a number has been issued in a series and year, `saveSeries` refuses (409) to change that year's prefix or number of digits — a GST serial must stay consistent and consecutive for the year — while raising `next_no` stays allowed and resending the same values is still a no-op. "Issued" is read from the new tables, never from `next_no`: a bill with `series`/`fy`/`bill_no`, or a payment whose receipt's own IST date falls in that financial year (so a bill paid late counts against the year its receipt was written). And from 1 March `listSeries` marks each current-year row `next_fy_missing` when next year's MAIN / RCPT row is absent, as data for the settings screen; nothing is created automatically, because the prefix contains the year. **Done-when met:** 10 tests including two real transactions racing — the second waits on the locked row and gets the very next number, with no gap and no duplicate. Dropping the lock, the prefix rule, the missing-series refusal or the March condition each fails its test. **Noted:** `nextNumber` writes no audit row (every number is already on the bill or payment that carries it); the receipt "issued" check scans `payments` (fine at this size; a `series`/`fy` pair on payments would index it if it ever matters). Test hygiene fixed the same day: P1-23 and P1-27 left their `bill_series` rows behind, so a rerun without a database reset failed (the same habit as P1-17 and P1-25); both now clear their own year in `beforeAll` and `afterAll`, and P1-23 counts only the audit rows from its own run, since `billing_audit` is append-only and can't be cleared. P4-05's last check no longer leans on a row P1-23 happened to leave. P1-23 and every Phase 4 spec now pass on three runs in a row (76 tests).

### 4C. Bills

- [x] **P4-06 · Open or create a draft bill** — `Done`
  - **Where:** `server/services/billing/bills.js`.
  - **What:** `openDraft(visitId)` returns the visit's open draft, or creates
    one with the category resolved (P1-21), the payer name (from the
    sub-category or CGHS), and the patient's age on that date.
  - **Done when:** calling it twice returns the same draft.
  - **E2E test:** `e2e/billing/phase4/P4-06-open-or-create-a-draft-bill.spec.js` — asserts: calling it twice returns the same draft.
  - **Result:** Done 2026-09-23 (built by a sub-agent). `server/services/billing/bills.js`: `openDraft(visitId, ctx, db)` returns the visit's open invoice draft or creates one, with the category from the resolver (P1-21), the payer name (the sub-category's own, else its parent's), the display label and the patient's age on the **visit's** date, which is also the bill date — a back-dated visit is billed on its own day, not today. A category that still needs a sub-category is not guessed: the bill is created with no category and carries `needs_category` and the choices, and P4-13 refuses to finalise it. The unique index on the visit's open draft is the referee: the insert sits inside a savepoint and a 23505 becomes a re-read of the row the other desk just committed, not an error. 7 tests, including two real transactions racing: the second blocks on the index, gets 23505 and comes back with the first desk's bill, leaving one draft. A cancelled or final bill lets the next draft open beside it. Turning the 23505 into a rethrow fails its test.
  - **Review:** (2026-09-23), tried on the test database: nothing wrong found. Opening a draft twice returns the same bill; the insert sits in its own savepoint and a 23505 from the unique index on the visit's open draft comes back as the other desk's bill, which two real transactions racing confirm; a cancelled or final bill lets the next draft open beside it; the category, payer, label and the age on the visit's own date are all taken at creation. Checked also that the visit-bills lock every add-line path takes covers this path, so a draft opened at the same moment as a line is added cannot split a visit's lines across two bills.

- [x] **P4-07 · Draft at check-in** — `Done`
  - **Where:** the check-in path (`receptionStation.js` check-in functions)
    calls a new `billing/visitLines.js`.
  - **Steps:**
    1. After a successful check-in, create the draft with the consultation
       line: the item for this doctor + visit type, else the hospital default
       consultation item. An **Investigation** visit gets no consultation line
       (no consultation fee, decided 2026-09-17).
       - Convert the appointment's visit type first with the shared
         `billingVisitType` in `shared/billingVisitType.js` (built in P1-24;
         plan §7): Investigation → no fee; a type
         `isNewVisitType` calls new (`New`, `New Patient`) → `New`; anything
         else (`Follow-Up`, `Follow-up`, `Tele`, `OPD`) → `Follow Up`
         (decided 2026-09-18: Tele is charged as Follow Up).
    2. A walk-in or lab-only visit with no consultant gets an empty draft.
    3. A billing failure must never block check-in: log it and continue.
  - **Note (P1-27 review):** the desk needs a few settings (pay-later
    allowed, codes per bill, footer). Read them in the desk's own service with
    `getSettings()` — never through `/api/billing/settings`, which is admin
    only.
  - **Done when:** checking in a patient creates a draft with the right
    consultation line.
  - **E2E test:** `e2e/billing/phase4/P4-07-draft-at-check-in.spec.js` — asserts: checking in a patient creates a draft with the right consultation line.
  - **Result:** Done 2026-09-23 (built by a sub-agent). New `server/services/billing/visitLines.js`. `draftAtCheckIn(visitId, ctx, db)` is called after a successful check-in from both reception paths (`transition` when the status becomes `checked_in`, and `checkInWalkIn`), after the commit, so nothing about check-in changes. It opens the draft and adds the consultation line: the appointment's visit type through the shared `billingVisitType` (Investigation → no line, Tele/OPD → Follow Up), then the item for **this doctor and that visit type**, else the hospital's default item for it. A walk-in with no appointment gets an empty draft. Checking in twice adds nothing twice. A billing failure never blocks check-in: it is logged (`[billing] no draft bill at check-in for visit …`) and swallowed, proved with a category whose claim has no payer name — the patient is checked in and no half-made bill is left behind. The desk's settings come from `getSettings()` through `deskSettings()`, never `/api/billing/settings`. 7 tests; giving an Investigation visit a fee fails its test.
  - **Review:** (2026-09-23), tried on the test database: the hook is safe where it matters. It runs after the commit on both reception paths, it cannot throw — every failure inside it is logged and swallowed — and the check-in transaction is closed before it starts, so a billing failure cannot undo a check-in or report a finished check-in as an error. Two stations checking the same patient in at once give one draft and one consultation line: the visit row is locked for the whole of the check-in, and the second tap returns "unchanged" without calling billing at all. The hook is awaited, which costs the desk about a tenth of a second and is worth it, because the next screen reads the draft it creates. Nothing changed.

- [x] **P4-08 · Lines from test orders** — `Done`
  - **Where:** `billing/visitLines.js`, called wherever a lab / machine / ECHO /
    X-ray order is created (including the plan 51 bill sync).
  - **Steps:**
    1. Add one line per ordered test, using the item linked to that test.
    2. Put it on the open draft, or on a new draft when every earlier bill is
       final.
    3. A test with no item is added to the "not priced" list and reported to
       the desk, not silently skipped.
    4. A failure never blocks the order.
  - **Done when:** ordering HbA1c and ABI adds two lines.
  - **E2E test:** `e2e/billing/phase4/P4-08-lines-from-test-orders.spec.js` — asserts: ordering HbA1c and ABI adds two lines.
  - **Result:** Done 2026-09-23 (built by a sub-agent). `linesForOrder(visitId, { labOrderId, testNames }, ctx, db)` adds one line per ordered test, using the item linked to that test's `giniflow_test_catalog` row, onto the visit's open draft — or onto a new draft once every earlier bill is final (P4-06 does the choosing). It is called wherever an order is created: `moStation` (each kind's order), `machineStation.addMachineTestOn`, `journey.raiseOrdersFromSteps` and `machineSync.raiseOrder`, always with the caller's client so the billing work sits in a savepoint and can never fail the order; each test is its own savepoint too. A test with no item is returned in `not_priced`, logged, and stays findable afterwards through `notPricedForVisit(visitId)` — never silently skipped. **The P4-02 warning is answered by removing the draft line and refusing only when the line is final:** `releaseOrderLines(client, labOrderId, testNames?)`, wired into `testCancel.js` at both delete sites, deletes the draft lines and reprices their bills (so the cancel goes through, which the `ON DELETE RESTRICT` foreign key would otherwise block outright), and refuses with "… is on bill GAC/…, so it can't be cancelled here — cancel that bill first" when the line is on a final one, because a GST document can't quietly lose a row. 8 tests; skipping the unpriced test silently, or letting a final bill's test be cancelled, each fails a test.
  - **Review:** (2026-09-23), tried on the test database: two things were wrong. **A test on a cancelled bill could never be cancelled on the floor** — the line still pointed at the order, and the refusal told the desk to "cancel that bill first" about a bill that was already cancelled; the dead lines are now left on the cancelled bill for the record but their order link is released, so the floor's cancel and the order's own delete go through, while a line on a *final* bill still refuses exactly as before. **A throw sat outside the service's own try** — `linesForOrder` normalised its arguments before the `try`, so an order raised with no test names took the whole order down with a TypeError; the whole body is now inside the try. **Removing a billed test left no audit row**, though a desk removing the same line by hand must give a reason and is audited; the cancel now writes the line's last state with the actor who cancelled it. Checked and left: all four real order paths are wired (only the demo seeder is not), and a test that cannot be priced rolls back to its own savepoint while its order and the other tests on it survive, proved inside a real caller transaction. 11 tests; each of the three fixes fails a test when undone.

- [x] **P4-09 · Never-twice check** — `Done`
  - **Where:** `bills.js`, used by every "add line" path.
  - **Steps:**
    1. Lock the visit's bills.
    2. If a live line with the same item exists on any bill of the visit,
       refuse with "Already billed on bill GAC/…" — unless the request
       carries an approved, unused repeat approval for this item and visit.
    3. The database index is the final guard.
  - **Done when:** a second add is refused, and it is allowed once with an
    approval.
  - **E2E test:** `e2e/billing/phase4/P4-09-never-twice-check.spec.js` — asserts: a second add is refused, and it is allowed once with an approval.
  - **Result:** Done 2026-09-23 (built by a sub-agent). Every add-line path goes through one check: lock the visit's bills (`SELECT id FROM bills WHERE visit_id = $1 FOR UPDATE`), then `liveLineFor` (P4-19). A live line with the same item anywhere on the visit refuses with "Already billed on bill GAC/… — ask an admin to approve billing <item> again", carrying the bill's id and number. Unless there is an approved, unused repeat approval for that item and visit: `repeatApprovalFor` finds it (or the caller names one), `useRepeatApproval` spends it, and only then is the line inserted, carrying `repeat_request_id`. The database's partial unique index is the last word. 6 tests: a second add refused, allowed once with an approval (the request becomes `used`), refused again after it is spent, an approval for another item refused as another item's, a hand-written duplicate refused with 23505, and a cancelled line freeing the item again. Dropping either the check or the `useRepeatApproval` call fails a test.
  - **Review:** (2026-09-23), tried on the test database: nothing wrong found. The lock on the visit's bills really is taken before the check, so two desks adding the same item to one visit at the same moment give one line and a readable refusal naming the bill — never a raw duplicate-key error — and two desks spending the same approval at the same moment end with one spent approval, one extra line and a plain refusal for the loser; the approval row is locked on top of that, so the same is true across visits. The database index remains the last word.

- [x] **P4-10 · Add, change and remove lines** — `Done`
  - **Where:** `bills.js`.
  - **Steps:**
    1. Add by item id: active items only, draft bills only.
    2. Change quantity: only for `allow_quantity` items, 1 to `max_quantity`.
    3. Remove from a draft: reason required, audited.
    4. Every change reprices the bill (P3-15) and bumps `version`.
  - **Done when:** each action works and wrong ones are refused.
  - **E2E test:** `e2e/billing/phase4/P4-10-add-change-and-remove-lines.spec.js` — asserts: each action works and wrong ones are refused.
  - **Result:** Done 2026-09-23 (built by a sub-agent). `addLine` (active items, draft bills only — an unknown item is a 404, a deactivated one a 409), `changeQuantity` (only `allow_quantity` items, 1…`max_quantity`, and the line's listed actual moves with it so the database's quantity × rate check never breaks mid-change) and `removeLine` (a reason is required and is audited with the line's last state). Every change reprices the whole bill through `priceBill`, rewrites every line and its discount steps, renumbers the lines 1…n and bumps `version`. Nothing can be added, changed or removed once the bill is final. 6 tests; dropping the reason or the renumbering each fails a test. The quantity rule is guarded twice — removing the check here still passes, because `priceLine` refuses the same thing.
  - **Review:** (2026-09-23), tried on the test database: the builder's own note was right — the quantity rule was double-guarded and nothing pinned it to the bill. It is pinned now: the two guards word the maximum differently (the pricing engine names the item's unit, the bill does not), so a test that gives the item a unit of its own and reads the refusal fails the moment the bill's own check is dropped, and it also holds that the line and the bill's version do not move on a refusal. Checked and left: every change reprices and bumps the version exactly once; line ids, the order link and the approval link all survive a reprice; a refused change leaves the bill untouched. Two latent hazards in `bills.js` were patched afterwards, once both reviewers had handed the file back: the reprice no longer shifts the lines into a fixed `+100000` band (which a line parked there by a future dead-on-a-draft line could collide with) but by the bill's own highest line number, and `changeQuantity`/`removeLine` now find only live lines. The whole of Phase 4 (149 tests) and P3-08 are green after both patches.

- [x] **P4-11 · Discount codes on a bill** — `Done`
  - **What:** add or remove a code on a draft. The code is checked (P3-08) and
    the bill repriced. Applied discounts are written to `bill_line_discounts`
    at finalise.
  - **Done when:** a valid code changes the totals, and an invalid one returns
    its reason.
  - **E2E test:** `e2e/billing/phase4/P4-11-discount-codes-on-a-bill.spec.js` — asserts: a valid code changes the totals, and an invalid one returns its reason.
  - **Result:** Done 2026-09-23 (built by a sub-agent). `addCode` / `removeCode` on a draft: the code goes through `checkCode` (P3-08, inside `priceBill`), the bill is repriced, and a code that is valid but applies to nothing on this bill is refused with the reason from the line it got furthest on (`items`, `payment_rule`, `expired`, `daily_limit`, …), as `{ status: 409, reason, message }`. The applied steps are written to `bill_line_discounts` with their rule, code, method and `taken_from`, and **that is where a draft's entered codes live** — there is no `codes` column on `bills`, so the codes are read back from those rows, which keeps them on the bill as lines are added and removed and means finalise has nothing extra to write. 6 tests: a valid code moves the totals and saves its step, it survives a new line, unknown/expired/duplicate are refused with their reasons, removing it puts the totals back, and a final bill takes no codes.
  - **Review:** (2026-09-23) P4-11 held up apart from one hole the builder had already flagged: a code that is valid but currently takes ₹0 was accepted with a 200 and then silently disappeared, because a draft's codes are read back from `bill_line_discounts` and that table only keeps steps worth more than nothing — the desk entered a coupon, saw no error, and the patient was billed in full even after the item the coupon pays for was added. Rather than give `bills` a `codes` column (a second source of truth that every reprice would have to reconcile, and which would resurrect codes that had stopped applying), `addCode` now refuses such a code in the same voice as its other refusals — "The code X takes nothing off this bill as it stands, so it can't be kept — add the items it pays for first", `reason: "no_effect"` — so the codes on a bill are exactly the codes taking money off it. A seventh test covers it; removing the refusal fails that test.

- [x] **P4-12 · Category, card and referral on a bill** — `Done`
  - **Steps:**
    1. Set or confirm the category on a draft; the desk picks a sub-category
       (CGHS Paid, CGHS Referral or Pensioner), not bare CGHS, when CGHS has
       sub-categories. The bill is repriced.
    2. Store the card number and referral number encrypted with
       `server/utils/aadhaarCrypt.js`; return only the last 4 digits.
    3. Attach a referral scan through the existing documents upload when the
       sub-category requires it (e.g. CGHS Referral).
  - **Done when:** the numbers are encrypted in the database and masked in
    responses, and a bill can't be confirmed as bare "CGHS" once CGHS has
    sub-categories.
  - **E2E test:** `e2e/billing/phase4/P4-12-category-card-and-referral-on-a-bill.spec.js` — asserts: the numbers are encrypted in the database and masked in responses, and a bill can't be confirmed as bare "CGHS" once CGHS has sub-categories.
  - **Result:** Done 2026-09-23 (built by a sub-agent). `setCategory(billId, { category, scheme_ref, referral_no, referral_doc_id })` on a draft. The category is checked before it is written — unknown is a 404, retired a 409, and a parent that has active sub-categories a 409 carrying `needs_sub_category` and the choices, so bare CGHS can never be confirmed — then the bill is repriced and its `scheme_label` and `payer_name` (own, else the parent's) are re-snapshotted. The card and referral numbers are stored encrypted with `server/utils/aadhaarCrypt.js` (`scheme_ref_enc` / `referral_no_enc`) and only ever returned masked as the last 4 (`XXXX1122`); the plain value never leaves the service. The referral scan is an existing `documents` row, refused (409) if it belongs to another patient and 404 if it doesn't exist. 6 tests: choosing CGHS › Paid takes a ₹2,000 consultation to ₹700 paid and ₹1,300 claimed, the stored columns are three-part ciphertext and the response carries no plain number, and storing the card in the clear fails its test.
  - **Review:** (2026-09-23) P4-12's encryption is sound — the plain card and referral numbers leave the service only through `maskTail`, the ciphertext round-trips, a corrupt one reads back as nothing instead of crashing, and `billing_audit` stores ciphertext, never the plain number. One real gap: with `AADHAAR_ENCRYPTION_KEY` unset, `encryptAadhaar` hands the value back unchanged, so a CGHS card number would have been written in the clear into `bills.scheme_ref_enc` and into the audit row (which redacts `scheme_ref`, not `scheme_ref_enc`). The card and referral numbers are now sealed through a helper that refuses to store a value the cipher didn't change — "Card numbers can't be stored until the encryption key is set; ask an admin". A seventh test proves it by running `setCategory` in a child process with no key.

- [x] **P4-13 · Finalise** — `Done`
  - **Checks, in one transaction:**
    1. The category is confirmed.
    2. The referral number (and scan) is present when required.
    3. Every line passes the invariant.
    4. Payments equal the patient payable, or the payable is ₹0, or pay-later
       is allowed (global or category) and chosen.
    5. The version matches.
  - **Then:** assign the bill number (P4-05), set `final`, write
    `bill_line_discounts`, and audit.
  - **Done when:** each failed check returns a clear message and nothing is
    saved.
  - **Also:** a bill with a claim amount > 0 is saved with
    `claim_status = pending`. A ₹0-payable bill (Pensioner, CGHS Referral)
    finalises with no payment and opens the bill PDF for printing; no receipt
    is created. Coupon daily limits are re-checked here with the rule row
    locked.
  - **E2E test:** `e2e/billing/phase4/P4-13-finalise.spec.js` — asserts: each failed check returns a clear message and nothing is saved.
  - **Result:** Done 2026-09-23 (built by a sub-agent). `finaliseBill(billId, { version, pay_later }, ctx, db)` in one transaction, in this order: lock the bill (draft only); the version must match (409 "This bill changed while you were working on it — open it again"); the bill must have a line; the category must be settled (the resolver is asked again — if the patient's recorded category still needs a sub-category and the bill hasn't chosen one, it refuses with the choices); the entered codes are re-checked with `checkCode` **after locking their `discount_rules` rows `FOR UPDATE`**, so a coupon's daily limit is enforced at the moment the bill is banked; the bill is repriced and every line passes `assertBillLineBalances`; the referral number and scan are there when the category (or its parent) asks for them; the payments must equal the payable, or the payable is ₹0, or pay-later is allowed (the category's `allow_pay_later`, else the global setting) and chosen. Only then `nextNumber(client, seriesFor("bill"), bill_date)` (P4-05, inside this transaction so a failed finalise releases the number), status `final`, `claim_status = pending` when the claim is more than ₹0, the discount steps already written by the reprice, and an audit row. A ₹0-payable bill finalises with no payment and no receipt. 8 tests including the whole visit end to end — check in → two test lines → an added item → a code → a category → finalise — where the stored totals equal a fresh `priceBill` of the same lines and the line sums reconcile with the rounded payable. Every failed check leaves the bill a draft with no number and the series' `next_no` untouched; removing any one of the five checks fails its test.
  - **Review:** (2026-09-23) P4-13 is safe under concurrency, and the probes found nothing to change there: the bill row is locked before the version is compared, so two desks finalising at once give one final bill and one "already final" with a single number taken and none burnt; a payment cannot slip in between the payable check and the commit, because the payments foreign key blocks on the same locked row; and two finalises of a coupon's last daily use cannot both succeed, since the `discount_rules` rows are locked before `checkCode` is asked again. The stored totals equal a fresh `priceBill`, and `bills_totals_check` balances exactly on claim bills and on odd roundings either way. One defect: once money had been taken, shrinking the bill hit the database's `paid_amount <= patient_payable` constraint as a raw 500, and finalise then quoted negative rupees ("₹-800.00 is still to be collected"). Every reprice now checks what has already been taken (`paid_amount` or the payments, whichever is larger) and refuses in words, in line with refunds being on hold. An eighth test covers both halves. `finaliseBill` also now returns the codes read after its own reprice, not before.

- [x] **P4-14 · Cancel an unpaid bill** — `Done`
  - **Steps:**
    1. Only a final bill with no payments.
    2. Reason required.
    3. Status becomes `cancelled`; lines become not live, which frees their
       items for re-billing.
    4. The bill number is kept.
    5. Audited.
    6. A paid bill is refused with "Refunds are not available yet".
  - **Done when:** both cases behave as described.
  - **Also:** cancelling a `pending` bill is allowed (it leaves the register);
    a `cleared` bill is refused with "Already paid by CGHS".
  - **E2E test:** `e2e/billing/phase4/P4-14-cancel-an-unpaid-bill.spec.js` — asserts: both cases behave as described.
  - **Result:** Done 2026-09-23 (built by a sub-agent). `cancelBill(billId, { reason }, ctx, db)`: only a final bill, only with no payments, and a reason in words is required. The status becomes `cancelled`, every line becomes not live (which frees its items to be billed again), `claim_status` goes back to `none` so the bill leaves the CGHS pending register, the bill number is kept, and the whole thing is audited with the before and after. A paid bill is refused with "Refunds are not available yet"; a `cleared` claim with "Already paid by CGHS"; a draft is told to have its lines removed instead; a second cancel is refused. 6 tests; inverting the payment guard fails its test.
  - **Review:** (2026-09-23) P4-14 came through every probe unchanged. A cleared claim is refused, a pending one is cancelled and leaves the register, a partially paid bill is refused with "Refunds are not available yet", the bill number is kept, the lines go not live and the item really is billable again — the never-twice index is partial on `is_live`, so the next draft takes it without an approval. Two desks cancelling the same bill at the same moment leave one cancellation, one "already cancelled" and exactly one audit row; that race is now its own test. The only change to the service that touches cancel is that it now reads what has been taken as the larger of `bills.paid_amount` and the payment rows, so a bill marked paid without payment rows can't be cancelled either.

### 4D. Payments and the test gate

- [x] **P4-15 · Take payments** — `Done`
  - **Where:** `server/services/billing/payments.js`.
  - **Steps:**
    1. One or more payments, each with mode (cash / card / UPI), amount and
       reference (required for card and UPI).
    2. The total can't exceed the outstanding patient payable.
    3. Each payment gets a receipt number and the user's open shift.
    4. Uses the version lock; audited.
  - **Done when:** overpaying is refused and the receipt numbers are
    sequential.
  - **E2E test:** `e2e/billing/phase4/P4-15-take-payments.spec.js` — asserts: overpaying is refused and the receipt numbers are sequential.
  - **Result:** Done 2026-09-23 (built by a sub-agent). `server/services/billing/payments.js`: `takePayments(billId, { version, payments: [{ mode, amount, reference }] }, ctx, db)` takes one or more payments in one transaction — cash, card or UPI, with a reference required for card and UPI (the database's own `payments_reference_check` behind it). The bill row is locked before the outstanding amount is read, so two desks can't both take the last rupee, and the version must match (409 "This bill changed while you were working on it — open it again"); a cancelled bill takes nothing. Overpaying is refused naming what is left — "₹500.00 is left to collect on bill …, so ₹500.01 can't be taken" — and a settled bill with "Nothing is left to collect on …". Each payment gets its own receipt number from `nextNumber(client, seriesFor("receipt"), bill_date)` **inside the same transaction**, so a failed payment releases the number, and the taker's open shift. **A cash payment with no open shift is refused** ("Open your shift first, so this cash is in a drawer that can be counted at the end of it") because cash outside a shift can never be counted at closing; card and UPI may go unattached, and are stamped with the shift when one is open so collections by shift cover every mode. `bills.paid_amount` is rewritten from the payment rows in the same transaction, so the column the `paid ≤ payable` check guards and the bills service reads is always exactly Σ payments. Every payment is audited. Also `listPayments(billId)` for the receipt and the counter. Money is whole paise inside the service and rupees at the SQL edge, as in `bills.js`. 8 tests, including the whole visit end to end — check in → two test orders → finalise → a card and a cash payment, consecutive receipts, both lab orders open, the shift's expected drawer equal to opening cash plus the cash taken. Three deliberate breaks each failed a test.
  - **Review:** (2026-09-23), tried on the test database. One thing was wrong: **a receipt was numbered from the bill's date, not the day it was written**, so a bill dated 30 March and paid in April took its receipt out of the old year's series — while `billSeries` counts a receipt against the year of its own `received_at`. The two disagreeing let the admin change the prefix of the year the number really came from, and locked the year it did not; the receipt now takes the day it is written, which is also what the GST serial needs. The spec's racing test also released a hand-held client without a rollback, which poisons the test database when it fails, and now rolls back. Checked and left: the bill is locked before the outstanding is read, so two desks can't both take the last rupee; a reprice, a finalise and a cancel racing a payment all serialise on the same row and are refused in words; overpaying, a settled bill and a cancelled bill are refused in words, never as a raw constraint; `paid_amount` equals Σ payments after every path; a failed payment burns no receipt number and leaves the bill untouched; the biggest amount the columns hold and the last paisa both come out exact; cash without an open shift is refused on the cash leg alone and a mixed card-and-cash call is refused whole, before anything is written; and a payment taken while a shift closes underneath it makes the close wait, so the drawer is right. 9 tests; each fix undone once failed its test.

- [x] **P4-16 · Pay later and dues** — `Done`
  - **Steps:**
    1. Pay-later is only offered when allowed.
    2. A pay-later bill is final with an outstanding balance, and appears on
       the dues list.
    3. Later payments on any day reduce the balance.
    4. The bill leaves the list when fully paid.
  - **Done when:** it works with the setting on, and is refused with it off.
  - **E2E test:** `e2e/billing/phase4/P4-16-pay-later-and-dues.spec.js` — asserts: it works with the setting on, and is refused with it off.
  - **Result:** Done 2026-09-23 (built by a sub-agent). Pay-later is `finaliseBill`'s rule and is not duplicated: the category's `allow_pay_later`, else the global setting, refused in words when neither allows it. The dues list is `listDues({ patientId, from, to, limit })` in `payments.js` — every final, uncancelled bill with `paid_amount < patient_payable`, oldest first, with the patient, the bill number and date, what is payable, paid and outstanding, whether it was a pay-later, and how many days old it is (IST). It reads exactly the predicate the `bills_dues_idx` index carries. Later payments on any day go through `takePayments` and reduce the balance; the bill leaves the list the moment it is fully paid, and nothing more can be taken on it. 6 tests: refused with the setting off, allowed with it on, refused again when the category says no while the global setting says yes, a part payment leaving it on the list, a full payment taking it off, the list oldest-first with a patient and a date range, and a draft, a fully paid bill and a cancelled bill never appearing.
  - **Review:** (2026-09-23), tried on the test database. Nothing was wrong. Pay-later is `finaliseBill`'s one rule and is not repeated in the dues list; the list is exactly the predicate the dues index carries — final, uncancelled, paid under payable — and a draft, a fully paid bill and a cancelled one never appear. A part payment on any later day reduces the balance and the bill drops off the list the moment it is settled, after which nothing more can be taken. The oldest-first order, the patient filter, the date range, the backwards date range and the IST day count all behave. 6 tests, unchanged.

- [x] **P4-17 · Paid test lines open the gate** — `Done`
  - **Where:** `payments.js` / `bills.js` → `giniflow_lab_orders`.
  - **Steps:**
    1. When a test line's patient payable is fully paid, write it through to
       its order's `amount_paid` (and the claim part to `amount_claimed`),
       using the order's version and the existing `amounts_within_total`
       check.
    2. A line with ₹0 payable (CGHS Referral, Pensioner) does this at
       finalise.
    3. The order's `payment_status` is derived as today, so the existing gate
       opens with no change to gate code.
  - **Done when:** paying HbA1c on the bill lets the lab start it, and a
    Pensioner's HbA1c is cleared at finalise.
  - **E2E test:** `e2e/billing/phase4/P4-17-paid-test-lines-open-the-gate.spec.js` — asserts: paying HbA1c on the bill lets the lab start it, and a Pensioner's HbA1c is cleared at finalise.
  - **Result:** Done 2026-09-23 (built by a sub-agent). When a test line's patient payable is fully paid, `settleTestOrders` writes it through to `giniflow_lab_orders`: `amount_claimed` takes the line's claim (capped at the order's total) and `amount_paid` the rest, so the two always add up to `amount_total` and the existing `amounts_within_total` check holds; `claim_state` becomes `approved` when there is a claim and `payment_status` is then the shared `derivePaymentStatus` — `paid` for a patient-paid test, `claim_approved` for a CGHS one. **Both open the gate with no change to gate code.** The write uses the order's version, moves `sample_status`, writes the same two ledger events and calls `syncLabStepsFromLab`, exactly as reception's own clear does. A ₹0-payable line (CGHS Referral, Pensioner) does this at **finalise**, with no payment and no receipt. **The rule for a bill with several test lines: the money settles the live lines in line order, each filled to its full payable before the next gets anything, and an order is written through only when every live line pointing at it is settled** — proportional sharing would part-pay every line and open nothing until the whole bill was paid. An order carrying a submitted or approved insurance claim of its own is left to reception. **Cancelling gives it back:** the settle event records the order's money before the write, and `cancelBill` restores it and closes the sample again, so no cancelled bill leaves an order looking paid. 6 tests: paying HbA1c lets the lab draw it (refused before, drawn after), a Pensioner's HbA1c is cleared at finalise with no payment, two orders settling one at a time, a part-claimed test splitting into paid and claimed, an insurance-claimed order left alone, and a cancel putting it back to pending. Three deliberate breaks each failed a test.
  - **Review:** (2026-09-23), tried on the test database. Two things were wrong. **A fully claimed test did not open the gate when an unpaid line sat above it** — with the check-in consultation at line 1 and a CGHS-claimed HbA1c at line 2, the order stayed pending after finalise, though the patient owes nothing for that test; a ₹0 line was inheriting the debt of the lines before it. Each line is now settled when the money still unspent at its turn covers its own payable, which leaves the "line order, each filled fully" rule exactly as it was for paying lines and clears a ₹0 line always. **A cancel could leave the order looking paid, and could take back money another desk had collected** — the restore read the *last* payment event on the order, so anything written after the settle (the HealthRay repricing job, a test cancellation, reception's own drift repair) hid it and the cancelled bill left the gate open; and it replayed the old amounts blindly, so a claim rejected and then paid in cash at the desk was wiped. The settle now records what it wrote as well as what it found, and the cancel restores only its own settle event, and only while the order's money is still exactly what that settle left. Checked and left: a settled order is indistinguishable from one reception cleared, column for column and event for event; several lines on one order settle together; a part-claimed test splits into paid and claimed that add up to the total; an order carrying its own submitted or approved claim is left to reception; a line removed on the floor afterwards is refused or repriced safely; and a bill can never be repriced below what has been taken. 8 tests; each fix undone once failed its test.

- [x] **P4-18 · Existing "Clear payment" untouched** — `Done`
  - **What:** confirm `clearPayment` and `getPaymentQueue` in
    `receptionStation.js` are unchanged and still open the gate, and that
    using both paths on the same order can't collect it twice.
  - **Done when:** the check passes with no edits to those functions.
  - **E2E test:** `e2e/billing/phase4/P4-18-existing-clear-payment-untouched.spec.js` — asserts: the check passes with no edits to those functions.
  - **Result:** Done 2026-09-23 (built by a sub-agent). No service was edited. The spec lifts the bodies of `clearPayment` and `getPaymentQueue` out of `receptionStation.js` and shows them byte-for-byte identical to git HEAD, pinned by md5 (`c7e6c3f6…` and `5f9a03a4…`), then shows they still work: a desk clear opens the gate, the order moves pending → awaiting sample → cleared on the queue, and the lab draws it. On the order the two paths cannot collect twice in either direction — a bill that has paid an order through makes reception's clear a no-op (`alreadySettled`, amounts and version unchanged), and an order reception already cleared is skipped by the bill. **But the patient can still be charged twice:** the bill line for that test stays payable, so reception can collect ₹250 on the order while the counter collects ₹250 on the bill — ₹500 for a ₹250 test, and the spec proves it. The smallest safe fix is inside `clearPayment`: before taking money, refuse an order that has a live bill line, in the words `releaseOrderLines` already uses ("… is on bill …"), which is one `SELECT` inside the transaction it already holds. Left as a finding rather than a rewrite — see **P4-40**. 4 tests.
  - **Review:** (2026-09-23), tried on the test database. No service was edited and the finding stands. The md5 pin genuinely bites — a trailing comment, an added parameter or one line moved in either guarded function changes the digest, and a renamed function fails the lookup — but it covered only `receptionStation.js`, so "the gate opens with no change to gate code" rested on nothing; the pin now also covers `shared/labPayment.js`, which is byte-identical to HEAD. A new test shows the two paths really are the same on the order: every column of a bill-settled order equals that of one reception cleared, and the ledger is the same two events, differing only in the meta that records which bill did it. The double charge is real and reproduces exactly as described — ₹250 on the order at reception and ₹250 on the bill line, ₹500 for a ₹250 test. 5 tests.

### 4E. Desk requests

- [x] **P4-19 · Requests service** — `Done`
  - **Where:** `server/services/billing/billingRequests.js`.
  - **Steps:**
    1. Create a **new item** request: name, group hint, reason. No price is
       accepted.
    2. Create a **repeat** request: item, visit, bill, reason. Only allowed
       when the never-twice check blocked that item.
    3. List pending requests (admin), and "my requests" (desk).
    4. Audit every change.
  - **Done when:** both kinds can be created and listed.
  - **E2E test:** `e2e/billing/phase4/P4-19-requests-service.spec.js` — asserts: both kinds can be created and listed.
  - **Result:** Done 2026-09-23 (built by a sub-agent). `server/services/billing/billingRequests.js`. A **new-item** request takes a proposed name, a group hint and a reason, and **no price** — a price, rate or amount in the body is a 400 naming the field, because the admin sets the price when the item is created. A **repeat** request takes the item, visit, bill and reason, and is only allowed when the never-twice rule actually blocks that item on that visit: nothing on the bill yet → "That item isn't on this visit's bill yet, so it doesn't need an approval"; already waiting → "… is already waiting for an admin's answer on this visit"; already approved and unused → "An admin has already approved billing … again on this visit". The requester is always the signed-in user; a `requested_by` in the body is ignored. `listPendingRequests` is the admin's inbox (oldest first) and `listMyRequests` the desk's panel (newest first, only their own); both return the patient (name, file no, age), the item or proposed name, who asked and when, the reason, the decision note and whether an approval is **still usable**, so the screens need no second query. Two helpers are exported for P4-09: `liveLineFor` (the blocking line and its bill number) and `repeatApprovalFor`. Every create is audited. 10 tests; six deliberate breaks each failed a test.

- [x] **P4-20 · Approve or reject** — `Done`
  - **Steps:**
    1. **New item:** approved by creating the service item in the same
       transaction (linked by `created_item_id`); rejected with a note.
    2. **Repeat:** approved or rejected with a note. An approved repeat can
       be used for exactly one line, then becomes `used`.
  - **Done when:** a second use of the same approval is refused.
  - **E2E test:** `e2e/billing/phase4/P4-20-approve-or-reject.spec.js` — asserts: a second use of the same approval is refused.
  - **Result:** Done 2026-09-23 (built by a sub-agent). Same file. Approving a **new item** creates the service item in the same transaction through the items service, so every P1 check and its audit row run, and links it as `created_item_id`; the admin gives the code, subgroup, price and kind at approval time. The items service's refusals come through as they are (a bad kind, a duplicate code, no subgroup) and the whole approval rolls back, leaving the request pending with no item created. Rejecting requires a note. A **repeat** is approved or rejected with a note, and approving is refused if the line it was asked about has since gone. `useRepeatApproval` is what the bills service calls before writing the line: it locks the request and refuses a new-item request, a pending or rejected one, another visit's or another item's, or one already used ("That approval has already been used on bill … — one approval allows one extra line"), then marks it used. Three guards stand behind one approval = one line, with the database's unique index and composite foreign key as the last word — the test inserts the line by hand and shows a second refused (23505) and a mismatched item or visit refused (23503). Decisions record who and when and are audited. Who may do what is the route's job (P4-26): the desk creates and uses, `BILLING_MASTER` decides. 8 tests; six deliberate breaks each failed a test. **Noted for P4-21:** publish the event after the call returns, never inside the transaction; a new-item request sent with no visit has no visit to publish to, so the inbox needs its own channel or a poll.

- [x] **P4-21 · Live updates** — `Done`
  - **Where:** `server/services/giniflow/realtimeBus.js` (`publishEvents`).
  - **What:** publish request created / approved / rejected events, so the
    desk and the inbox update without refreshing.
  - **Done when:** approving on one screen updates the other within seconds.
  - **E2E test:** `e2e/billing/phase4/P4-21-live-updates.spec.js` — asserts: approving on one screen updates the other within seconds.
  - **Result:** Done 2026-09-23 (built by a sub-agent). `server/services/billing/billingRequests.js` now announces every request it commits, over the same Supabase Realtime Broadcast the flow board already uses: one envelope kind, `billing_request`, with `action` `created`, `approved` or `rejected`, carrying the request id and kind, its status, the visit, bill and item (or the item the approval created), who asked and who decided — ids only, no patient name, file number or item name, the same rule the flow envelopes keep. `realtimeBus.js` gains `publishBillingRequest`, which sends it to `giniflow:station:billing-requests` for the admin inbox and to `giniflow:day:<visit date>` for the desk; the station topic is deliberate rather than a new topic family, because the deployed RLS policy already authorises exactly those two shapes and a new-item request with no visit has no day to publish to. The publish happens **after** the COMMIT — the services hold the result and announce outside the transaction, and `announce` returns silently when it was handed a caller's client, so a row inside somebody else's open transaction is never announced; the test proves it by re-reading the row on a separate connection at the moment of publishing and seeing the decision already committed. It also cannot break a decision: the lookup is wrapped and logged, the send is fire-and-forget behind a bus that already swallows, and a publish forced to throw during an approval leaves the approval, its row and its audit trail intact. Nothing is announced when a request is refused — a second approval, a rejection of a decided request, a duplicate repeat request. What the screens must do is subscribe (`{ station: "billing-requests" }` for the inbox, the day they already open for the desk) and add `billing_request` to the client's INVALIDATES map. 8 tests; six deliberate breaks each failed a test. Delivery to a real browser is the one thing untested — it needs a configured Supabase project and a running server.
  - **Review:** (2026-09-23), tried on the test database. The service was close to right; the test was not. **The spec proved nothing about publishing** — its "published" counter counted a database lookup inside the announce, so deleting the call that sends the event left all eight tests green. It now watches the bus itself and asserts the real topics each call reached. **"After the commit" was not proved either**: moving the publish inside the approval's transaction also passed, because a fire-and-forget send lands after a fast local commit anyway; the test now holds the COMMIT open and asks for the row with `FOR UPDATE NOWAIT` at the moment of the publish, so a publish from inside the transaction is caught by the lock. **The envelope named the staff who asked and who decided**, on a topic every Gini Flow login may join and which, unlike a day topic, has no day gate; those two ids buy a refetch-only screen nothing and are gone. **Every announce ran an extra database query after the commit and made the caller wait for it** — the request's own row now carries `visit_date`, so the announce does no input/output at all and a bus that hangs cannot hold up a decision. **Spending an approval announced nothing**, so a second desk kept offering an approval already used; it now announces `used` — but the bills service spends approvals inside its own transaction, where the announce is correctly silent, so **`bills.js` must announce the request after its own commit** or that event never fires on the real add-line path. The spec also failed twice on a busy database (a deadlock and a wall-clock assertion that measured the database rather than the delivery) and left fixture rows behind when it did; the timing assertions are gone and the cleanup now survives a failing run. Checked and left: the deployed RLS policy does cover both topic shapes, so no migration is needed; one announce per decision with no retry, and a `created` arriving after its own `approved` is harmless to a screen that only refetches; the joined-client test is the same predicate the transaction helper uses, so a pool-like object with a `release` is refused by the transaction before anything could be published. 10 tests; eight deliberate breaks each failed a test. Delivery to a real browser is still untested — it needs a configured Supabase project and a running server.
  - **Follow-up (done 2026-09-23):** `bills.js` now announces the spent repeat approval after its own COMMIT — `addLineIn` returns the approval it spent, `addLine` announces it once the transaction has committed, through the new `announceUsed(requestId, db)` in `billingRequests.js` (silent when handed a caller's client, and its own failure is logged and swallowed). A line added inside somebody else's transaction (`addLineIn`, `visitLines`) still announces nothing; those paths raise test-order lines, which do not spend approvals today. **Still open:** The screens must subscribe the admin inbox to `{ station: "billing-requests" }`, the desk to that station **as well as** its day (a visit-less new-item request has no day topic), and wire `billing_request` into `INVALIDATES` in `src/queries/hooks/useGiniflowLive.js` — the `|| ALL` fallback only invalidates `["giniflow", …]` keys and would refresh no billing screen at all. Actions to handle: `created`, `approved`, `rejected`, `used`.

### 4F. Cash closing

- [x] **P4-22 · Shifts** — `Done`
  - **Where:** `server/services/billing/cashShifts.js`.
  - **Steps:**
    1. Open a shift with opening cash; one open shift per user.
    2. The shift view shows expected cash, card and UPI from its payments.
    3. Close with counted cash; the difference is recorded.
    4. reception_admin and admin can list every shift.
  - **Done when:** a shift's expected totals equal the sum of its payments.
  - **E2E test:** `e2e/billing/phase4/P4-22-shifts.spec.js` — asserts: a shift's expected totals equal the sum of its payments.
  - **Result:** Done 2026-09-23 (built by a sub-agent). `server/services/billing/cashShifts.js` opens a shift with its opening cash (`openShift`), shows it (`getShift`, `currentShift`, `listShifts`, `listMyShifts`) and closes it with the counted cash (`closeShift`, `closeCurrentShift`). The view works the shift's money out from its own payments — cash, card and UPI collected, the payment count and the number of bills — and expected cash is the drawer: opening cash plus the cash taken in this shift, so `difference = counted − expected` measures what the drawer should hold. Because the database refuses a close without both totals, the close recomputes the expected amount and writes `closed_at`, `expected_cash`, `counted_cash` and `difference` together in one transaction, with `closed_at = GREATEST(NOW(), opened_at)` so it can never close before it opened. A second shift for the same desk is refused in words naming when the open one started (the unique index's 23505, turned into a 409); closing twice is refused naming when it was closed; closing another desk's shift is refused unless the caller holds `BILLING_MASTER` (the service takes `ctx.role`). The admin list takes a user, a date range (IST days), open/closed and a limit, newest first; the desk reads only its own open shift. Opening and closing are audited. `openShiftIdFor(client, userId)` is there for the payments service to stamp `payments.shift_id`. 15 tests; four deliberate breaks each failed a test.
  - **Review:** (2026-09-23), tried on the test database. Three things were wrong. **A payment could land in a shift closed underneath it** — `openShiftIdFor` read the open shift with no lock, so between that read and the payment's insert a close could commit; a probe left a closed shift recording an expected drawer of ₹10 with ₹555 of cash against it. It now reads `FOR SHARE`, so the close waits for the payment in hand, and a close that gets there first makes the payment find no open shift. **A drawer bigger than the column could hold crashed** — a shift whose cash passed ₹9,999,999,999.99 failed the close with a raw `numeric field overflow`, a 500 rather than a refusal; it is now a plain 409 naming the limit, and the shift stays open. **`ctx.anyUser` was a boolean trusted from the caller** and appeared nowhere else in the repo; the service now takes the user's `role` and asks `hasAnyCapability(role, BILLING_MASTER)`, the way the other services take a role, so reception_admin and admin close another desk's shift and reception and coordinator don't. The spec also poisoned the test database when it failed — a hand-held transaction was released without a rollback — and now cleans up after a failing run. Checked and left: the money maths (4,005 pairs through both JS and `numeric(12,2)`, no mismatch, so the DB's `difference = counted − expected` check can't be tripped); the IST day filter across 23:45 and 00:15 (now with fixtures on both sides of midnight); the 23505 path on a racing open and the `FOR UPDATE` on a racing close (both now tested); and that opening and closing are each audited with the acting user. Left for later: who may call each of these is still the route's job (P4-26/P4-34) and the request shapes are P4-25; refunds (`direction = 'out'`) are out of the drawer maths until such a payment exists. 15 tests; each fix undone once failed its test.

### 4G. Printouts

- [x] **P4-23 · Bill PDF** — `Done`
  - **Where:** `server/services/billing/billPdf.js`, using `renderHtmlToPdf`
    from `server/services/prescriptionHtmlPdf.js`.
  - **Contents:**
    - hospital name, logo and letterhead from the prescription settings;
    - bill number and date;
    - patient name and UHID;
    - category as "CGHS › Pensioner" (etc.) and card/referral (last 4 digits)
      when `print_category_on_bill`;
    - lines: bill name, bill code, quantity, actual, discount, patient pays;
    - totals: actual, discount, patient payable, claimed, round-off, paid,
      balance;
    - tax columns, SAC/HSN and GSTIN only when GST is on;
    - footer text from the settings.
  - **Escape every admin- or desk-entered text** before it goes into the
    HTML — footer, legal name, bill names, category names, patient name —
    so `<b>` or `<script>` prints as text, never as markup (P1-23 review).
  - **Done when:** the PDF prints cleanly for a General bill, a CGHS Paid bill
    and a CGHS Referral bill.
  - **E2E test:** `e2e/billing/phase4/P4-23-bill-pdf.spec.js` — asserts: the PDF prints cleanly for a General bill, a CGHS Paid bill and a CGHS Referral bill.
  - **Result:** Done 2026-09-23 (built by a sub-agent). `server/services/billing/billPdf.js` builds the bill as HTML in pure functions and renders it with the prescription pipeline: `billView(billId, db)` gathers the bill (`readBill`), the patient, the category with its parent, each line's SAC/HSN and tax rate, the billing settings and the prescription letterhead and logo; `buildBillHtml(view)` prints it; `generateBillPdf(billId, ctx, db)` returns `{ pdf, filename, bill }` through `renderHtmlToPdf`. The page carries the hospital's own letterhead (name, address, phone, mark — all from the prescription settings, nothing hardcoded), the bill number and date, the patient and UHID, the items with bill code, quantity, actual, discount and what the patient pays, and the totals — actual, discount, patient payable, claimed from the payer, round-off, paid and balance. The category prints as "CGHS › Pensioner" with the payer and the **last four digits only** of the card and referral number, and only when `print_category_on_bill` is set on the bill's category or its parent; the plain number never leaves `bills.js`, which hands the service a value already masked. The tax columns (SAC/HSN, taxable, GST %, CGST, SGST), the tax total and the GSTIN and legal name appear only while GST is switched on, and the footer is the one the admin typed. A draft is banded "DRAFT — NOT A BILL … not proof of payment" and shows no bill number; a cancelled bill is banded "CANCELLED BILL" with when and why. Every admin- or desk-entered string — footer, legal name, bill names and codes, category and payer names, patient name, cancel reason — is escaped, so `<script>` prints as text. 9 tests, covering a General, a CGHS Paid and a CGHS Referral bill, GST on and off, the category flag on and off (including inherited from the parent), the plain card number absent from the whole page, the escaping, a draft, a cancelled bill, a bill with a round-off and a claim, and every printed total equal to the stored column; four deliberate breaks each failed a test (one of them only after the Balance row was asserted cell by cell, which is why it now is). Chrome was present, so the three bills really rendered as PDFs; the render test skips with the launch error, rather than failing, where Chrome is missing. **Unproven:** how the page paginates in print — column widths for a wide GST table and page breaks in a long item list; nobody has looked at a rendered page, only at its bytes.
  - **Review:** (2026-09-24), tried on the test database. One thing was wrong: **a finalised bill lost its GST when the setting was switched off.** The page decided its whole tax block from the live `billing_settings.gst_enabled`, so a bill stored as `actual 1000.00, tax 180.00, payable 1180.00` reprinted as Actual ₹1,000.00, Discount ₹0.00, Round-off ₹0.00, Patient payable ₹1,180.00 — the ₹180 gone from the page, with no Tax row, no SAC/HSN and no GSTIN, and totals that no longer add up. `printsTax(view)` now prints the tax block whenever the setting is on **or the bill itself carries tax**, so a bill's own document follows the bill. The PDF filename was also unbounded — a long patient name gave a 430-character `Content-Disposition` — and each slug is now capped at 40 characters. Checked and left: every interpolation on the page is escaped (now proved field by field for the bill code, payer name, legal name, UHID and SAC/HSN, including a `</td>` breakout attempt and a 300-character unbroken string, with `<td>`/`</td>` counts asserted equal); the masked card and referral numbers, which `bills.js` masks before this service ever sees them; and every printed total equal to its stored column. Left for later: a bill finalised *before* GST registration still grows zero-valued tax columns and a GSTIN when reprinted after — it is arithmetically honest and indistinguishable in the schema from a GST-era bill of untaxed items, and telling them apart needs a `gst_enabled` snapshot column on `bills`. Print pagination is still unlooked-at. 11 tests; the fix undone once failed its test.

- [x] **P4-24 · Receipt PDF** — `Done`
  - **Where:** `server/services/billing/receiptPdf.js`.
  - **Contents:** receipt number and date, bill number, patient, amount, mode,
    reference, received by. Escape all entered text, as in P4-23.
  - **Done when:** one receipt prints per payment.
  - **E2E test:** `e2e/billing/phase4/P4-24-receipt-pdf.spec.js` — asserts: one receipt prints per payment.
  - **Result:** Done 2026-09-23 (built by a sub-agent). `server/services/billing/receiptPdf.js` prints one receipt per payment: `receiptViews(billId, input, db)` returns a view per payment — all of them, or the one named by `payment_id` or `receipt_no` — each with its receipt number and date, the bill number, the patient and UHID, the amount, the mode, the reference and the name of whoever took the money; `buildReceiptsHtml` puts each on its own sheet with a page break between them, and `generateReceiptPdf(billId, input, ctx, db)` returns `{ pdf, filename, receipts }` so the caller can see which payments it just printed. It shares the bill's letterhead, field markup and footer, so a bill and its receipt cannot look like two hospitals. A payment id that belongs to another bill is refused with "That payment isn't on this bill", and a bill with nothing taken on it with "No payment has been taken on this bill yet". Every entered string is escaped, the payment reference included. 6 tests: three payments give three receipts with three different numbers, each field matched exactly against what is stored, card and UPI references (one of them carrying `<script>`) print as text while cash shows none, a single receipt prints by id and by number, both refusals, and a real PDF whose amount matches the stored payment. Four deliberate breaks each failed a test (the wrong-amount one only after the amount field was asserted on its own, which it now is). The spec also no longer leaves the test footer setting behind.
  - **Review:** (2026-09-24), tried on the test database. Nothing was wrong in the receipt itself. Checked and left: one receipt per payment with its own number; every field matched against what is stored; both refusals ("That payment isn't on this bill", "No payment has been taken on this bill yet") reached over HTTP as plain 404s; and the escaping, now proved field by field on a view carrying markup in the **received-by name**, the **reference** (a `</td><td>` breakout attempt), the receipt number, the bill number, the UHID, the patient name and the footer, with the cell counts asserted balanced. The filename was the one defect and it belongs to `billPdf.slug` — a 300-character patient name produced a 430-character `Content-Disposition`; slugs are now capped and the receipt filename is asserted ≤ 100 characters. 7 tests; the fix undone once failed its test.

### 4H. Routes

- [x] **P4-25 · Schemas** — `Done`
  - **Where:** `server/schemas/index.js`.
  - **What:** schemas for every Phase 4 request. Desk schemas **reject** any
    `price`, `rate`, `bill_name`, `bill_code` or discount amount field.
  - **Done when:** a desk request with a price returns 400.
  - **E2E test:** `e2e/billing/phase4/P4-25-schemas.spec.js` — asserts: a desk request with a price returns 400.
  - **Result:** Done 2026-09-23 (built by a sub-agent). `server/schemas/billing.js`, re-exported through `server/schemas/index.js`. Every Phase 4 request has a strict Zod schema in the project's style: open a draft, add/change/remove a line, add a code, set category/card/referral, finalise, cancel, take payments, open/close a shift, the dues, shift, request and receipt query filters, and the new-item, repeat, approve and reject request bodies. Every desk body is built by one `deskObject` helper that spreads a `NO_PRICE` block, so `price`, `rate`, `base_price`, `mrp`, `bill_name`, `bill_code`, `discount`, `discount_amount` and `discount_value` are each refused by name with "can't be sent from the billing desk — the admin sets prices and bill names" — including one hidden inside a single payment of a batch, and `amount` too on a request to create an item. The money rules live here, not in the routes: an amount is rupees, more than zero, at most 2 decimals and within `MONEY_MAX`; card and UPI need a reference and it is capped at the service's own 60; at most `PAYMENTS_AT_ONCE` (10) payments per request and never none; finalise and takePayments both require `version`; removing a line and cancelling both require a reason. Every bound is imported from the service that owns it, so nothing is hardcoded twice. The receipt query allows `token` so a `?token=` printout URL still validates. 15 tests, run twice; one deliberate break (dropping `NO_PRICE` from `deskObject`) failed its test. **Found and fixed from an earlier, interrupted pass:** `deskObject` never actually spread `NO_PRICE`, so a desk request with a price was refused only as an unknown field.
  - **Review:** (2026-09-24), probed directly against the schemas. One thing was wrong: **the receipt printout accepted `payment_id` and `receipt_no` together** and the service silently served the payment, ignoring a receipt number that matched nothing — a 200 and the wrong document. It is now refused with "ask for the payment or the receipt number, not both". Checked and left: every desk body really is strict and really spreads `NO_PRICE`; `Infinity`, `1e400`, `NaN`, booleans, objects, `null`, `"1e3"`, `"-5"`, a third decimal, `MONEY_MAX + 1`, a 15-digit string, an unknown key, a non-object body, `version: -1`, `version: 1.5`, `quantity: 0` and `1.5`, a 61-character reference, an 11-payment batch and an empty one are each refused in words, while `MONEY_MAX` and ten payments are accepted; the bounds are all imported from the services that own them. The boundary cases now have their own test. 16 tests; the fix undone once failed its test. **The 400 is live over HTTP only after the API is restarted.**

- [x] **P4-26 · Billing routes** — `Done`
  - **Where:** `server/routes/billing.js`.
  - **Behind `BILLING_DESK`:**
    - visit bills, open draft, add/change/remove line;
    - add/remove code, set category, card and referral;
    - finalise, cancel, take payment;
    - bill PDF, receipt PDF, dues;
    - my shift (open/close);
    - create request, my requests.
  - **Behind `BILLING_MASTER`:** request inbox, approve/reject, all shifts.
  - **Done when:** each endpoint works and is refused without its capability.
  - **E2E test:** `e2e/billing/phase4/P4-26-billing-routes.spec.js` — asserts: each endpoint works and is refused without its capability.
  - **Result:** Done 2026-09-23 (built by a sub-agent). `server/routes/billing.js`. 31 endpoints, HTTP only, every one delegating to `server/services/billing/*` with no domain logic in the route: behind `BILLING_DESK`, a visit's bills, open draft, tests without a price, read bill, add/change/remove line, add/remove code, category+card+referral, finalise, cancel, take payment, list payments, the bill and receipt PDFs, the dues list, the desk's own shift (current/mine/open/close) and requests (new item, repeat, mine); behind `BILLING_MASTER`, the request inbox, approve, reject, all shifts and closing another desk's shift. `ctx` is `{ ...auditContext(req), role: req.doctor.role }` everywhere, because a discount code is refused without the role and `closeShift` decides "may close another desk's" from it. The PDF routes self-authenticate from `?token=` (`/api/billing` is a doctor-only prefix, so an unsigned URL is a plain 403) and send `application/pdf` with the service's own `Bill_…` / `Receipt_…` filename and a content length. `shared/permissions.js` needed no change — both capabilities already existed with the right roles. 13 tests. **Found and fixed from an earlier, interrupted pass:** both PDF routes were mounted on guessed names and a guessed receipt-per-payment path through a dynamic `import()` with a silent fallback; they now call `generateBillPdf`/`generateReceiptPdf` directly, and the receipt is a filter on its bill. Five deliberate breaks each failed a test.
  - **Review:** (2026-09-24), the 13 route tests were run for the first time and all passed, so the "not yet run" note is closed. Nothing was wrong in the routes. The bug class that bit `not-priced` was hunted properly: **every** route parameter on all 31 endpoints was driven with `not-a-uuid` and every one came back a plain 400 in words, never a 500 — each service cleans its own ids before the query. The `?token=` printout URLs were pushed past the happy path: a signed URL works, an unsigned one is 403, a **coordinator's valid token is 403 "Insufficient permissions"**, and a garbage or empty token is 403 "Doctor account required". `Content-Length` matches the body byte for byte, `Content-Disposition` is `inline` with a slug-safe filename, a draft with no items still prints real `%PDF` bytes, and a receipt asked for a payment on another bill is a 404 in words. Three tests added for these. Two stale assertions in the spec itself were also corrected: the shift payload exposes `user.id`, not `user_id`, and has no `status` field — the closed shift is `is_open: false` with `closed_at`, `counted_cash` and a `difference` that must equal counted minus expected. 16 tests.

### 4I. Billing Counter page

- [x] **P4-27 · Page shell** — `Done`
  - **Where:** `src/pages/billing/BillingCounterPage.jsx` at
    `/giniflow/station/billing`, router (`lazyWithRetry`), routes config
    (`BILLING_DESK`), menu entry, `src/queries/hooks/useBilling.js`.
  - **What:** left: patient search and today's visits. Right: the selected
    visit's bills. `?patient=` or `?visit=` in the URL opens a patient
    directly.
  - **Done when:** reception can open a patient's billing view.
  - **E2E test:** `e2e/billing/phase4/P4-27-page-shell.spec.js` — asserts: reception can open a patient's billing view.
  - **Result:** Done 2026-09-24 (built by a sub-agent). `src/pages/billing/BillingCounterPage.jsx` at `/giniflow/station/billing`, registered in `src/router.jsx` through `lazyWithRetry`, in `src/config/routes.js` behind `BILLING_DESK`, and on the Gini Flow stations launcher as a "Billing Counter" tile (the launcher showed only stations the server summary names, so a tile may now declare its own capability instead — no new work on every launcher poll). It is a station page, not a settings page: the same `.gf` / `.top-rail` / `.ar-split` shell as Reception and Rx. Left, today's floor from the existing arrivals endpoint — Expected and On the floor, with the rail's server-side search; right, the selected visit's bills. `?visit=` opens a visit and `?patient=` resolves that patient's visit on today's floor and rewrites the URL to `?visit=`, so the link P4-35 puts on the reception row lands on the right person. `src/queries/hooks/useBilling.js` holds the desk's queries and mutations — visit bills, not-priced, open draft, re-read, set category, change quantity, remove line, the scheme vocabulary, and the token-signed bill/receipt PDF hrefs — following `useBillingMaster.js`'s conventions, with the desk's keys added to the one `billingKeys` object (`visitBills`, `visitNotPriced`, `bill`, and `billPayments`/`dues`/`myShifts`/`currentShift`/`myRequests` reserved for P4-32/33/34). The page holds one working copy of the draft: every mutating call's whole-bill response replaces it, so `version` is carried, never refetched behind the screen's back, and `useRereadBill()` is the 409 path P4-32 needs. 5 tests (pick from the list, search, `?visit=`, `?patient=`, and a coordinator refused the page).
  - **Review:** (2026-09-24), run against the test servers. Two things were wrong. **"Pay later" leaked from one patient to the next**: `payLater` lives on the page and was never reset when a different bill was opened, so ticking it for one patient and then clicking the next in the rail brought up that patient's pad already ticked, with Finalise enabled on an unpaid balance and `pay_later: true` on the wire — a bill banked as a due nobody chose; it is now cleared wherever the working copy is. **The counter did not fit a phone**: the totals table wears `.ltable`'s `min-width: 460px` but, alone among the screen's tables, sits outside `.ltablewrap`, so at 390px it rendered 460px inside a 362px card and pushed the amounts off-screen with no scrollbar of its own; one rule (`min-width: 0` on `.bc-totals`, a two-column key/value table) fixes it and the shift panel's drawer table with it. Checked and left: `?visit=`/`?patient=` and the rewrite to `?visit=`; the working copy being replaced by every mutating call's whole-bill response rather than refetched; the capability gate; the rail's server-side search. 6 tests; both breaks taken red.

- [x] **P4-28 · Patient header** — `Done`
  - **Contents:**
    - name, UHID, age;
    - category badge showing the sub-category, e.g. "CGHS › Pensioner", with
      any suggestions (one tap to apply);
    - a "Confirm category" control whose list shows sub-categories under
      their parent;
    - card number and referral number fields (and scan upload) shown only
      when the sub-category needs them.
  - **Done when:** changing CGHS Paid to Pensioner reprices the bill on screen.
  - **E2E test:** `e2e/billing/phase4/P4-28-patient-header.spec.js` — asserts: changing CGHS Paid to Pensioner reprices the bill on screen.
  - **Result:** Done 2026-09-24 (built by a sub-agent). `src/components/billing/counter/PatientHeader.jsx`. Name, UHID and age, with the category badge showing the **sub-category** as the server labels it ("CGHS › Pensioner") and the payer beside it. `openDraft`'s `suggestions` appear as one-tap buttons while the category is unconfirmed, and the same buttons come back from a `needs_sub_category` 409 with the choices the server names — so a bare parent is refused in words and answered in one tap. The "Confirm category" control is a `<select>` whose optgroups are the parents and whose options are only their sub-categories: a parent that has sub-categories is a group label and cannot be chosen, a parent without them is an option in its own right. Card number, referral number and the referral scan appear **only** when the chosen sub-category or its parent asks for them (`requires_ref` / `requires_referral` / `requires_referral_doc`, read from `/api/patient-schemes`, inheriting from the parent exactly as the server's own `categoryRules` does). The stored card and referral numbers arrive masked (`XXXX1122`) and are shown only as the input's placeholder, never as a value, so a mask can never be saved back as a number and an empty field means "leave it alone". The scan reuses the existing documents pipeline — create the document row, upload the file — and then sets `referral_doc_id` on the bill. 5 tests: the header's three facts; changing CGHS Paid to Pensioner repricing the bill on screen (₹700 → ₹0 on the line, and the badge changing); the bare parent absent from the list while all three sub-categories are in it; referral number and scan appearing for Referral and not for Pensioner; a suggested sub-category applied in one tap.
  - **Review:** (2026-09-24), run against the test servers. No code changes. The header reads the sub-category label the server writes, the parent-inheriting `requires_ref`/`requires_referral`/`requires_referral_doc` match `categoryRules`'s own `OR` across the parent, the masked card and referral numbers are placeholders only so a mask can never be saved back as a number, and the `needs_sub_category` 409 is answered in the server's words with its own suggestions in one tap. The `<select>`'s optgroups keep a bare parent unchoosable. Every mutation goes out as named fields, never a spread of the variables bag. 5 tests, green twice.

- [x] **P4-29 · Previous bills and lines** — `Done`
  - **Steps:**
    1. List the visit's earlier bills (number, status, totals, print).
    2. The current draft's lines table: bill name, bill code, quantity (editable
       only when allowed), actual, discount, payment rule, patient pays,
       remove (reason).
  - **Done when:** the table matches the server's priced lines.
  - **E2E test:** `e2e/billing/phase4/P4-29-previous-bills-and-lines.spec.js` — asserts: the table matches the server's priced lines.
  - **Result:** Done 2026-09-24 (built by a sub-agent). `src/components/billing/counter/PreviousBills.jsx`, `BillLinesTable.jsx` and `NotPricedTests.jsx`, with the shared wording in `counter/lineText.js`. The visit's earlier bills list their number (or "Not numbered"), status, actual, discount, patient pays and paid, each with a Print link to the bill PDF that self-authenticates from `?token=`. The draft's lines table is bill name, bill code, quantity, actual, discount, payment rule, patient pays and Remove; removing asks for a reason in the repo's own `ConfirmModal` and cannot be confirmed without one. Every money cell goes through one converter, `fromPaise` in `components/billing/format.js`, which is `shared/labPayment.js`'s `rupeesFromPaise` plus the existing `rupees` formatter — the screen never does money arithmetic of its own, and sends no money at all. Quantity is an input **only where the item allows it**, capped at the item's own maximum: that needed a signal the desk could not see, so `bills.js`'s `liveLines` now joins `service_items` and `shapeLine` returns `allow_quantity` and `max_quantity` (additive; the ten service specs that read lines were re-run, 88 checks green). `GET /visits/:id/not-priced` is surfaced as its own panel — ordered tests nobody can bill yet, named, with the reason. 5 tests: every rendered cell matched against `readBill`'s own priced lines; the earlier final bill with its number, totals and print href; the unpriceable test named; quantity editable on the dressing and not on the brace, and a change repricing on screen and in the database; a line removed with a reason and gone from both.
  - **Review:** (2026-09-24), run against the test servers. No code changes. Every money cell goes through `fromPaise` on a paise figure — no arithmetic, nothing sent — and the quantity cell keeps an `sr-only` copy of the number beside the input, which the repo's `.gf .sr-only` really does hide, so the value is still readable as text. Quantity is an input only where `allow_quantity` says so and is capped at `max_quantity`; a rejected quantity reverts and shows the server's refusal. Removing a line cannot be confirmed without a reason. 5 tests, green twice.

- [x] **P4-30 · Add items, repeat and new-item requests** — `Done`
  - **Steps:**
    1. Item search shows active items only.
    2. Already-billed items are greyed out with **"Ask admin to bill again"**
       (reason box).
    3. When the search finds nothing, **"Request new item"** (name, group,
       reason).
    4. A "My requests" panel shows live status; an approved item or repeat
       can then be added.
  - **Done when:** both request flows work end to end.
  - **E2E test:** `e2e/billing/phase4/P4-30-add-items-repeat-and-new-item-requests.spec.js` — asserts: both request flows work end to end.
  - **Result:** Done 2026-09-24 (built by a sub-agent). `src/components/billing/counter/AddItems.jsx`. The desk had **no item search at all** — everything under `/billing/master/items` is behind `BILLING_MASTER` — so the counter now has its own: `GET /api/billing/items/search?q=` behind `BILLING_DESK`, `searchDeskItems` in `serviceItems.js`, `billingItemSearchQuerySchema` in `server/schemas/billing.js`. It returns **active items only** (item, subgroup and group all active), at most 30, and carries **no price of any name** — `base_price`, `price`, `rate`, `mrp`, `bill_name`, `bill_code`, `discount` are all absent, so it gives back nothing a desk schema would refuse to accept. An item already live on the visit is greyed and offers **"Ask admin to bill again"** with a reason box instead of Add — from the bill's own lines, and from the never-twice 409, which needed a second fix: `billingHttp.js`'s `DETAILS` allow-list dropped `bill_id`, `bill_no` and `service_item_id`, so the refusal reached the browser as bare words. When the search finds nothing, **"Request new item"** opens a form pre-filled with what was typed (name, group, reason) and sends it with the visit and bill. A **My requests** panel polls every 15s and shows each request's live status and the admin's note; an approved repeat, or the item an approved new-item request created, carries an **Add to bill** button, and a repeat is spent through `repeat_request_id` so the server marks the approval `used`. 6 tests.
  - **Review:** (2026-09-24), run against the test servers, which was the first time the screen tests ran at all. No code changes. The desk search returns active items with no price field of any name; an item already live on the visit is greyed from the bill's own lines and from the never-twice 409's `service_item_id`; both request forms send exactly the fields their strict schemas name, with no visit-id spread; an approved repeat is spent through `repeat_request_id`. Every button is disabled while its mutation is in flight. 6 tests, green twice.

- [x] **P4-31 · Discount code box** — `Done`
  - **Contents:**
    - one input for a code, then an accept or refuse message with the
      reason;
    - applied codes as removable chips;
    - automatic discounts shown by name, not removable.

    There is no manual discount field anywhere.

  - **Done when:** the totals update on accept.
  - **E2E test:** `e2e/billing/phase4/P4-31-discount-code-box.spec.js` — asserts: the totals update on accept.
  - **Result:** Done 2026-09-24 (built by a sub-agent). `src/components/billing/counter/DiscountCodeBox.jsx`. One input for a code, and the server's answer in its own words: accepted ("`CODE` applied", with the whole bill replacing the working copy) or refused with the exact refusal — an unknown code, a code that takes nothing off, a code past its daily limit. Applied codes are chips with a × that removes them; automatic discounts are listed **by name** with what they took off and no remove control at all. Showing them by name needed the bill to say so: `bills.js` now returns `discounts: [{ code, method, name, amount }]` (summed from `bill_line_discounts`, joined to `discount_rules`) on every response, and `openDraft` returns `codes` as well. **There is no manual discount field anywhere on the counter** — no amount box, no percent box, no "give discount" button — and a test asserts their absence rather than trusting it. 5 tests.
  - **Review:** (2026-09-24), run against the test servers. No code changes. The accept path replaces the whole working copy from the server's response, and a refusal is the server's own sentence — unknown code, nothing taken off, past its daily limit — never a generic one. Applied codes are removable chips, automatic discounts are named and have no remove control, and the test that asserts the *absence* of any manual discount field still holds. 5 tests, green twice.

- [x] **P4-32 · Totals and payment** — `Done`
  - **Steps:**
    1. Totals: actual, discount, tax (only when GST is on), patient payable,
       claimed, adjustment, round-off, paid, balance.
    2. Payment rows: mode, amount, reference; add or remove rows; the
       remaining balance is shown live.
    3. "Pay later" appears only when allowed.
    4. When the patient payable is ₹0 (CGHS Referral, Pensioner), no payment
       is needed.
  - **Done when:** "Finalise" is enabled only when the finalise checks would
    pass.
  - **Also:** for a ₹0-payable bill the button reads **Finalise & print** and
    the bill shows the badge **CGHS pending** after finalising.
  - **E2E test:** `e2e/billing/phase4/P4-32-totals-and-payment.spec.js` — asserts: "Finalise" is enabled only when the finalise checks would pass.
  - **Result:** Done 2026-09-24 (built by a sub-agent). `src/components/billing/counter/TotalsAndPayment.jsx`, with the readiness rules in `counter/finaliseChecks.js`. Totals are actual, discount, **tax only when GST is on**, patient payable, claimed, adjustment, round-off, paid and balance, every figure through `fromPaise`. GST and pay-later are settings the desk could not read — `/billing/settings` is behind `BILLING_SETTINGS` — so a second desk route, `GET /api/billing/desk-settings`, returns those flags and nothing else (no GSTIN, legal name or footer). Payment rows carry mode, amount and, for card and UPI, a reference (max 60); rows are added and removed, at most ten, and the remaining balance is live. **This is the first place the screen sends money**: it is typed in rupees and sent in rupees, and comes back in paise. `takePayments` is the one call that does not return the whole bill, so the hook re-reads it and hands `onBill` the whole thing — the working copy is never patched. The pad names the shift and offers to open one, and the server's "Open your shift first…" is shown as it is written. When the payable is ₹0 there are no payment rows at all and the bill finalises with no payment and no receipt, coming back `claim_status: pending`, which the actions bar shows as the badge **CGHS pending**. "Pay later" appears only where `scheme.allow_pay_later ?? settings.allow_pay_later` allows it. **Finalise & print** is enabled only when the server's own finalise checks would pass — lines, a confirmed sub-category, the referral number and letter where they are asked for, and the balance settled or pay-later chosen and allowed — and the reasons are listed while it is not. The 409 path was blind until now: `billingHttp.js`'s `DETAILS` did not include `version`, so the new number never reached the browser; it now does, and the screen re-reads the bill as the actual recovery. 6 tests.
  - **Review:** (2026-09-24), run against the test servers. Three things were wrong, all of them money. **Pay-later readiness did not mirror the server**: the screen read only the sub-category's `allow_pay_later` and then fell to the hospital setting, while `categoryRules` is `COALESCE(sub, parent)` and only then the setting — with a parent that forbids it and a setting that allows it, Finalise was enabled on a bill the server refuses, and the mirror case disabled it forever on one the server would take; the check now inherits from the parent exactly as the SQL does. **The 409 path was blind**: a stale payment showed the refusal and the new version but left the dead version in the working copy, so every further press failed identically and only Save draft could recover; it now re-reads the bill, the way finalise already did. **A payment that was taken but could not be read back said it had not been taken** — the POST and the re-read are one call, and a failure between them invited the desk to charge the patient twice; that case now says so in words, and the drawer and dues are invalidated either way. Checked and left: every total through `fromPaise` on paise; the one place money is sent types and sends rupees; the tax row only when GST is on; a card or UPI reference required exactly where `cleanPayment` requires it; the ₹0-payable bill finalising with no payment and coming back CGHS pending; ten rows at most. 10 tests (4 added); every fix undone once failed its test.

- [x] **P4-33 · Actions and printing** — `Done`
  - **Buttons:** Save draft · Finalise & print (opens the bill PDF) · Print
    receipt · Cancel unpaid bill (reason). A paid bill shows no cancel button.
  - **Done when:** every action works from the page.
  - **E2E test:** `e2e/billing/phase4/P4-33-actions-and-printing.spec.js` — asserts: every action works from the page.
  - **Result:** Done 2026-09-24 (built by a sub-agent). `src/components/billing/counter/BillActions.jsx`. **Save draft** re-reads the bill from the server and replaces the working copy — the same `useRereadBill()` that recovers a 409, so the button people press when something looks stale is the recovery. **Finalise & print** finalises with the bill's `version` (and `pay_later` when it was chosen) and opens `/api/billing/bills/<id>/bill.pdf` in a new tab, self-authenticating from `?token=`; on a 409 it shows the refusal, names the new version and re-reads. **Print receipt** appears once money has been taken and links to the receipt PDF. **Cancel unpaid bill** appears only on a final bill with nothing paid on it and asks for a reason in the repo's own `ConfirmModal`, which cannot be confirmed without one — **a paid bill shows no cancel button**, matching the service, which refuses it because refunds do not exist yet. The claim badge **CGHS pending** sits at the head of the bar. 3 tests.
  - **Review:** (2026-09-24), run against the test servers. No code changes — this was the one place already recovering from a 409 properly, and it is now the tested one. Save draft and the 409 recovery are the same re-read; Finalise & print opens the real PDF URL in a tab it opened before the await (and closes it on a refusal); Print receipt appears only once money is in; Cancel is offered only on a final bill with nothing paid, matching the service, which refuses it because refunds do not exist. Added the stale-finalise test the task had claimed but never proved: a line added underneath the screen, Finalise refused in the server's words, the bill re-read with that line on it, and the second Finalise carried through to `final`. 4 tests, green twice.

- [x] **P4-34 · Dues list and shift panel** — `Done`
  - **What:**
    - a "Dues" tab (only when pay-later is on), listing unpaid balances with
      "Take payment";
    - a shift panel to open or close a shift with counted cash.
  - **Done when:** a due can be paid from the list, and a shift can be closed.
  - **E2E test:** `e2e/billing/phase4/P4-34-dues-list-and-shift-panel.spec.js` — asserts: a due can be paid from the list, and a shift can be closed.

- [x] **P4-35 · "Bill" button on reception check-in** — `Done`
  - **Where:** `src/pages/giniflow/ReceptionStationPage.jsx`.
  - **What:** a **Bill** button on each patient row that opens
    `/giniflow/station/billing?visit=…`. Shown only to users with
    `BILLING_DESK`. Nothing else on that page changes.
  - **Done when:** the button opens the right patient.
  - **E2E test:** `e2e/billing/phase4/P4-35-bill-button-on-reception-check-in.spec.js` — asserts: the button opens the right patient.
  - **Result:** Done 2026-09-24 (built by a sub-agent). `src/pages/giniflow/ReceptionStationPage.jsx`, purely additive — 22 lines added, nothing deleted or reordered. A `BillButton` on each live patient row of the Arrivals (check-in) tab, in both the Expected and On-the-floor columns, wearing the row's existing secondary idiom (`st-btn st-btn-ghost`, the same classes as No-show, Cancel and Pause) and appended at the end of the actions group so no existing control moves. It is a router `<Link>` to `/giniflow/station/billing?visit=<that visit's id>` opened in a **second tab**: Arrivals is reception's standing screen and holds a polling queue, a typed search, an open walk-in search and a half-filled check-in panel, all of which a same-tab navigation would throw away. It is shown only to holders of `BILLING_DESK` — reception, reception_admin and admin — through the same `hasCapability` check this page already makes for `GINIFLOW_TEST_CANCEL`; a coordinator can open the page and sees no Bill button at all. A row with **no visit id shows nothing** rather than a disabled control, and "Not coming" rows get no button either, since a no-show or cancelled visit is not billed. One additive CSS rule, `.gf a.st-btn { text-decoration: none; }`, so an anchor can wear the button idiom — it is the first anchor in the app to carry `st-btn`, so it changes nothing that existed. 6 tests written.
  - **Review:** (2026-09-24), run against the test servers. One thing was wrong: **a due from any earlier day opened a bill with no patient on it** — the header's name and UHID came only from today's arrivals rail, and the bill payload carries no name, so the commonest dues case put a payment pad under a blank header; the dues row's own patient is now carried across. Checked hard and left alone: the paise/rupee boundary these two panels sit either side of — `listDues` answers in paise and the list uses `fromPaise`, `cashShifts` answers in rupees and the panel uses `rupees` throughout (opening, per-mode collected, expected, counted, difference), and the difference is computed rupee-on-rupee; the Dues tab appearing only while pay-later is on; the drawer's figures matching `cash_shifts` to the paisa after a real payment; the close asking for counted cash and refusing without it. 5 tests (1 added), green twice, and the shifts table is empty after the run.
  - **Not yet proved:** both test servers (3100/3101) were down, so none of the six tests has been run and the two deliberate breaks (dropping the capability gate; dropping the visit id from the URL) were exercised on the file and md5-restored but never taken red. The Billing Counter page was also not yet in the router, so test 6 asserts the navigation target rather than the landed page. Run once the servers are up: `cd e2e && DATABASE_URL=postgres://user:pass@localhost:5435/gini_scribe_test npx playwright test --config .tmp-p435.config.js`, then delete that throwaway config.

### 4J. Admin requests inbox

- [x] **P4-36 · Desk requests page** — `Done`
  - **Where:** `src/pages/billing/DeskRequestsPage.jsx`, settings tab with a
    pending-count badge.
  - **Steps:**
    1. Pending list first, then history.
    2. **New item:** "Create item" opens the item form pre-filled with the
       requested name; saving approves the request. "Reject" asks for a note.
    3. **Repeat:** shows the patient, visit, earlier bill line and reason;
       Approve / Reject with a note.
    4. Live updates.
  - **Done when:** both kinds can be handled from the page.
  - **E2E test:** `e2e/billing/phase4/P4-36-desk-requests-page.spec.js` — asserts: both kinds can be handled from the page.

### 4K. Checks

  - **Result:** Done 2026-09-24 (built by a sub-agent). `src/pages/billing/DeskRequestsPage.jsx` at `/settings/desk-requests`, behind `BILLING_MASTER`, in the router through `lazyWithRetry` and on the settings tab strip with a pending-count badge. Pending first, decided below. A waiting row carries everything the answer needs — who asked and when, the patient (name, file no, age, visit date) or "No patient — a new item only" for a visit-less request, the proposed name and group hint or the item and the bill it is already live on, and the reason. **A new-item request shows no price anywhere**, because the desk sends none: "Create item" opens the master's own item form pre-filled with the requested name, and the admin types the code, subgroup, kind and **price** there; saving is the approval, so the item is created inside the same transaction and `created_item_id` is linked. A repeat is Approve (note optional) or Reject, and **rejecting sends whatever was typed so the server's own refusal is what the admin reads** — nothing is faked on the client. A decided request is offered no buttons at all, matching the server's 409, and the decided list shows the answer: the note, the created item's code and name, or for a repeat "Usable — waiting for the desk to bill it" until the desk spends it and then "Used on bill …". Live updates: the inbox subscribes with `createRealtimeConnection({ station: "billing-requests" })` through its own small hook (`useDeskRequestsLive.js`, kept out of the settings shell's chunk), and `billing_request` is now wired into `INVALIDATES` in `useGiniflowLive.js` as `[billingKeys.requests()]` — the `|| ALL` fallback would have refreshed the whole floor and no billing screen. `billingKeys` gained two additive keys, `requests` and `requestInbox`. 7 tests.
  - **Review:** (2026-09-24), run against the test servers. The screen was right about the things it was designed around — a new-item request carries no price anywhere (the table has no price column to carry one), the create-item dialog is the only place a price is typed, a decided request is offered no buttons, and the server's refusal is shown verbatim rather than guessed at. Two things were missing. **A refused decision taught the screen nothing:** the mutation invalidated only on success, so when a second admin answered a request first, the 409 appeared in the dialog and the row stayed in "Waiting for an answer" with both buttons live forever; it now invalidates on settled, and the row moves to the answered list as soon as the refusal lands. **The inbox had no fallback refresh:** with Supabase unconfigured — which is how the servers actually run, `realtime-token` answering `{enabled:false}` — there was no broadcast, no SSE and no poll, so an admin watching the inbox never saw a request arrive, although the bus's own dormant message promises exactly that poll; the page's two queries now carry the house 15 s `refetchInterval` (background off), left off the settings-tab badge so it costs nothing on the other tabs. Checked and left as they were: the approval transaction really does roll back — a duplicate code and a bad subgroup each leave the request pending with no item created, now proved through the UI as well as the API; the client's station string matches the server's `BILLING_REQUESTS_STATION`, so the hook joins `giniflow:station:billing-requests`, and because it keys only on `kind`, all four actions (`created`, `approved`, `rejected`, `used`) invalidate; `billing_request → billingKeys.requests()` is in `INVALIDATES` and is a prefix of both inbox keys. The capability holds on both sides, and a non-master's browser now provably never even asks for the inbox. Dialogs focus, trap, escape and restore focus correctly; the page fits 390 px with no horizontal page scroll. 10 tests (was 7); two deliberate breaks each took a new test red. Still unproven: real broadcast delivery to a browser, which needs a configured Supabase project.
  - **Follow-up (open):** the "Already answered" list is fetched unfiltered and trimmed in the browser, so past the server's 200-row cap decided history is silently truncated, and every load fetches the pending rows twice. The fix is to ask for `status: ["approved","rejected","used"]`, which wants a shared request-status vocabulary that does not exist yet (`STATUSES` lives in the service, `REQUEST_STATUSES` in `server/schemas/billing.js`).
- [x] **P4-37 · Smoke script: bills** — `Done (browser spec not built)`
  - **Where:** `server/scripts/smoke-billing-bill.mjs`,
    `smoke:billing-bill`.
  - **Checks:**
    1. **Finalise and pay:**
       - finalise twice (second refused);
       - pay more than the balance (refused);
       - two concurrent finalises get gap-free numbers.
    2. **Never twice and repeats:**
       - the same item on a second bill of the visit is refused;
       - after an approved repeat it is allowed once;
       - a second use of the approval is refused.
    3. **New-item request:** the item is created, then the line can be added.
    4. **Zero payable:** a CGHS Referral bill and a Pensioner bill finalise
       with ₹0 and no payment, and open the test gate.
    5. **Bare CGHS:** confirming a bill as bare "CGHS" (no sub-category) is
       refused.
    6. **Pay later:** off refuses an unpaid finalise; on allows it and lists
       it as due.
    7. **Cancel:** an unpaid bill cancels and frees its items; a paid bill is
       refused.
    8. **Test gate:**
       - paying a test line updates the order and opens the gate;
       - "Clear payment" still works;
       - no double collection.
    9. **No prices from the desk:** a request carrying a price is rejected.
    10. **Privacy:** card and referral numbers are encrypted and masked.

    Everything runs inside a rolled-back transaction.

  - **Done when:** the script passes.
  - **Also checked:** a Pensioner bill for Dr Banshali finalises at ₹700 with
    no payment, no receipt, `claim_status = pending`; cancelling it is
    allowed; a coupon at its daily limit is refused at finalise even if it was
    accepted when entered.
  - **E2E test:** `e2e/billing/phase4/P4-37-smoke-script-bills.spec.js` — the same scenarios as the smoke script, driven through the Billing Counter page in the browser as `reception` (with approvals done as `reception_admin` in a second browser context), asserting on-screen totals, bill numbers, the PDF download, and the lab station seeing the cleared test.

  - **Result:** Done 2026-09-24 (built by a sub-agent). `server/scripts/smoke-billing-bill.mjs`, run as `npm run smoke:billing-bill` from `server/`, calls the real services in one transaction that is rolled back, with a savepoint per check; `clearPayment` joins it through a small stand-in that turns its BEGIN/COMMIT/ROLLBACK into savepoints. It covers every check the block lists: finalising twice and overpaying refused; never twice, one extra line per approved repeat, a second use refused; a new-item request creating the item that can then be billed; CGHS Referral and Pensioner bills finalising at ₹0 with no payment and opening the gate; the Dr Banshali Pensioner bill at ₹700 with no payment, no receipt, `claim_status = pending`, and cancellable; a coupon at its daily limit refused at finalise; bare CGHS refused; pay later off refusing and on allowing and listing the due; an unpaid bill cancelling and freeing its items while a paid one is refused; paying a test line opening the gate, Clear payment still working, and reception unable to collect an order the bill already paid; priced requests refused; card and referral numbers encrypted and masked, and never in the audit log. **Concurrent finalises** are proved against a throwaway 2091-92 series: the second waits on the locked row, and when the first rolls back it gets the same number — no gap, no number burnt. It refuses any database whose name lacks "test" unless `SMOKE_ANY_DATABASE=1`, the same guard the other billing smoke scripts use, checked before any connection is opened. 14/14 on the test database, nothing left behind; three deliberate breaks each took a check red.
  - **Not built:** the browser spec `P4-37-smoke-script-bills.spec.js` — the test servers were down.
  - **Fixture change (same task):** `e2e/billing/phase4/p4-bills-fixture.mjs` now cleans up only its own tag, so parallel P4 specs no longer delete each other's rows. Each run holds an advisory lock on its tag while alive, and `setUp` sweeps any tag whose lock is free — a crashed run is cleaned up by the next `setUp`, a live one is never touched. Scoping the sweep exposed a second collision it had been hiding: the three test consultation items are unique across the database (`service_items_consultation_key`), so a second fixture now waits up to 45 s for them and then fails naming the run that holds them. Fixture-owned bill series are removed only when no P4 fixture is left. Proved by seven concurrent specs run twice (54/54 each, zero rows left), a four-spec run (28/28), a crashed run swept, and a live run left alone. Still open: P4-15, P4-17 and P4-24 delete `cash_shifts` for the shared reception user in their own teardown, so running those three at once can still interfere.

- [ ] **P4-38 · Floor trial** — `Pending`
  - **Depends on:** P2-13, P3-23 and P0-09 (GSTIN, bill footer, bill and receipt number prefixes entered in Billing settings).
  - **What:** one reception user bills real patients for one session with a
    reception_admin present, including at least one General, one CGHS Paid,
    one CGHS Referral and one Pensioner patient. Note every problem.
  - **Done when:** the problems found are fixed or logged as tasks.
  - **E2E test:** No new spec — a manual floor trial. Every problem found becomes a fix **with** a new e2e test that reproduces it first.

- [ ] **P4-39 · Update the plan status** — `Pending`
  - **E2E test:** No new spec — run `npm run test:e2e:billing`; the whole suite must be green before the phase is marked built.

- [x] **P4-40 · One test, one payment** — `Done` (found by P4-18; behind a valve, off until P4-38)
  - **Where:** `clearPayment` in `server/services/giniflow/receptionStation.js`.
  - **Why:** the two payment paths can't double-write an order, but they can
    double-charge the patient — reception collects ₹250 on the order while the
    counter collects ₹250 on the bill line for the same test, and nothing
    refuses it. P4-18's spec proves it.
  - **What:** before taking money, refuse an order that has a live bill line,
    in the words `releaseOrderLines` already uses ("… is on bill …, take the
    payment there") — one `SELECT 1 FROM bill_lines WHERE lab_order_id = $1
    AND is_live` inside the transaction `clearPayment` already holds.
  - **When:** gated on the Billing Counter being live on the floor; until then
    reception's path is the only one, and this refusal would block it.
  - **Done when:** the double-charge in P4-18's spec is refused, and every
    existing reception-clear test still passes.
  - **Also (found by P4-18's review):** the same double charge exists on a
    second route — an order carrying its own submitted or approved insurance
    claim is deliberately skipped by the bill while its line stays payable, so
    the patient can pay on the bill and reception can collect the remainder on
    the order. The one `SELECT` closes both routes. Nothing cheaper is worth
    doing first: every half-measure is a screen change, and the service-side
    guard is the same one line either way.

  - **Result:** Done 2026-09-24 (built by a sub-agent). Reception now refuses to take money for a test that has a live bill line, behind a valve: `SCRIBE_BILL_TAKES_TEST_PAYMENTS`, off unless it is exactly `1` (`billTakesTestPayments()` in `shared/manualFloor.js`, documented in the README's env table). It is off by default because every priced test ordered on the floor already gets a draft bill line, so a guard that was on by default would stop reception collecting for tests the moment it deployed; it is turned on the day the Billing Counter goes live (P4-38). The change to `clearPayment` is one line, after the "already settled" no-op and before any money is taken, for `paid`, `split` and `insurance_claim` only: `refuseOrderOnBill` (new in `visitLines.js`) runs one `SELECT` on `bill_lines WHERE lab_order_id = $1 AND is_live` inside the transaction `clearPayment` already holds and refuses in the `releaseOrderLines` words: "HbA1c is on bill …, take the payment there" (or "…on this visit's draft bill…"). **Both double-charge routes are closed:** a test on the bill (₹500 with the valve off, ₹250 once with it on) and an order carrying its own submitted claim that the bill skips (the remainder at the desk, ₹350 with the valve off, refused with it on). Claim approval and rejection still go through; a test with no price, a removed draft line and a cancelled bill's order still clear at reception. P4-18's md5 pin was re-taken deliberately: `getPaymentQueue` and `shared/labPayment.js` are still byte-identical to HEAD, `clearPayment` is pinned to its new digest `218f621d…`, and the guard (`c1ea3665…`) and the valve line are pinned too; its test 4 now proves the refusal instead of the double charge. The reception clear endpoint needs an API restart to pick this up. New spec `P4-40-one-test-one-payment.spec.js`, 5 tests; P4-17, P4-18, P4-07, P4-08, P4-13, P4-14 and P4-15 all pass.
  - **Before turning the valve on:** if a claim is rejected on a final bill where the patient paid ₹0 (Pensioner / CGHS Referral), reception is refused until someone cancels that bill (P4-40 test 5 shows the cancel-then-collect path); the refusal's wording, "take the payment there", is slightly off for that case.
  - **Follow-up (open) — the hospital can collect twice:** on the claim route the patient pays the full ₹250 on the bill while the order's own ₹150 insurance claim still stands, so the hospital is paid ₹400 for a ₹250 test (the patient is not overcharged; the payer is). Not fixed here; needs its own task — the bill should either honour the order's standing claim or the claim should be withdrawn when the bill takes the test.


- [x] **P4-41 · One claim per test** — `Done` (found by P4-40)
  - **Where:** `server/services/billing/payments.js` (`refuseStandingClaims`), called from `takePayments` and `finaliseBill`.
  - **Why:** an order carrying its own insurer claim is skipped by `settleTestOrders`, but its bill line stayed fully payable — a ₹250 test with a ₹150 claim standing was paid ₹250 on the bill and ₹150 by the insurer, ₹400 in all; on a CGHS / Pensioner bill the bill's ₹250 category claim was banked beside the order's ₹150 claim.
  - **What:** the bill refuses to take money for, or finalise with, a live test line whose order has a submitted or approved claim that the bill did not write; the counter removes the line (or cancels a final bill) and reception collects the rest.
  - **Done when:** the ₹400-for-₹250 outcome is refused on both the payment and the finalise route, a rejected claim lets the bill take the test, and a claim the bill wrote itself never blocks the rest of the bill.
  - **E2E test:** `e2e/billing/phase4/P4-41-one-claim-per-test.spec.js`.
  - **Result:** Done 2026-09-24 (built by a sub-agent). Reproduced first on the test database: with a ₹150 Star Health claim standing on a ₹250 HbA1c the patient paid ₹250 on the bill and the insurer approved ₹150 — the hospital held ₹400; the same happened with the P4-40 valve on (line removed, claim raised, test re-added to the draft by its order) and through finalise (a Pensioner bill banked a ₹250 CGHS claim beside the order's ₹150 claim). Three designs were weighed: **honouring the claim on the bill** (rejected — the bill's `claim_amount` belongs to the category payer, with its own register and payer name, the database refuses a claim on a line with no payment rule, and a later rejection on a final bill would leave the patient's share uncollectable); **withdrawing the order's claim** (rejected — it withdraws nothing at the insurer and makes an insured patient pay what the policy covers); and **refusing on the bill** (chosen, since reception is where insurer claims live today). `refuseStandingClaims` runs one query over the bill's live test lines and their orders; a submitted or approved claim is refused unless the order's money is still exactly what this bill's own settle wrote (the `sameMoney` test `releaseOrder` uses), so a CGHS claim the bill itself settled never blocks the bill's other lines. The refusal is a 409 with `code: "order_claim"`: "HbA1c has its own insurance claim of ₹150.00 at reception, so it can't also be paid on this visit's draft bill — remove it from this bill and collect the rest at reception" (on a final bill: "… cancel this bill and collect the rest at reception"). It runs in `takePayments` before any money is taken and in `finaliseBill` before a number is taken. Now: a standing claim is refused, and once the line is removed reception collects the remainder (₹150 claim + ₹100 desk = ₹250); a rejected claim lets the bill take the test once; a cancelled bill leaves the order's own claim exactly as it was; CGHS category bills are unchanged. No schema, pricing or `clearPayment` change — P4-18's pins still hold. P4-17 test 5 and P4-40 test 4, which asserted the old double collection, now assert the refusal. 6 tests; three deliberate breaks (dropping the own-claim test, the payment guard, the finalise guard) each failed a test and were restored by md5. P4-07, 08, 13, 14, 15, 16, 17, 18, 24, 40 and 41 pass (80/80).
  - **Still open:** the **cash version** of the same route (cancel → reception collects cash → the order's line re-added → paid again) is not covered; widening the guard to any order money the bill did not write would close it but changes P4-40 test 2. The counter only learns of the claim when payment or finalise is refused — a line flag on `readBill` would let it show "claim at reception" up front. **P4-23's test 6 renames a patient outside its tag**, so its teardown leaves a bill the fixture sweep can't find, which breaks the sweep for every P4 spec run after it.
---

## Phase 4b — Refunds and credit notes

- [ ] **P4B-01 · On hold** — `Pending`
  - **What:** nothing is built until the hospital decides how refunds work
    (plan Q14: same mode as the payment, cash only, or chosen each time).
  - **Done when:** the decision is recorded in the plan; this phase then gets
    its own detailed tasks.
  - **E2E test:** None until the phase is designed.

---

## Phase 5 — Claims and dashboards

Goal: the amounts owed by CGHS and other payers are tracked to settlement,
and management sees revenue and discounts by group, subgroup, test,
consultant, category and sub-category.

### 5A. Claims

- [ ] **P5-01 · Migration: claim settlements** — `Pending`
  - **Where:** `server/migrations/<date>_billing_claim_settlements.sql`.
  - **What:**
    1. `claim_settlements`: `id`, `payer_name`, `received_on`, `reference`
       (UTR), `amount > 0`, `note`, `cleared_by`, `cleared_at`, `voided_at`,
       `voided_by`, `void_reason`.
    2. `claim_settlement_bills`: `settlement_id`, `bill_id`, `amount`, with a
       partial unique index so a bill is in at most one non-voided
       settlement.
    3. Foreign key from `bills.claim_settlement_id`.
    4. RLS for both. Review, then apply.
  - **Done when:** the tables exist in production, empty, with RLS on.
  - **E2E test:** `e2e/billing/phase5/P5-01-migration-claim-settlements.spec.js` — asserts: the migration runs twice on a fresh test database without error; both tables, the unique index and the foreign key exist; RLS is on.

- [ ] **P5-02 · Pending register service** — `Pending`
  - **Where:** `server/services/billing/cghsRegister.js`.
  - **What:** `listPending(filters)` and `listCleared(filters)`.
  - **Steps:**
    1. Pending: final, non-cancelled bills with `claim_status = pending`,
       with bill number, bill date, patient, UHID, sub-category (e.g. "CGHS ›
       Pensioner"), doctor, bill codes, masked referral number, claim
       amount, days pending.
    2. Filters: date range, sub-category, doctor, payer; totals (count and
       amount) for the filtered list.
    3. Cleared: the same columns plus date received, reference and cleared
       by; search by reference.
  - **Done when:** the pending total equals the claim amounts of those bills.
  - **E2E test:** `e2e/billing/phase5/P5-02-pending-register-service.spec.js` — asserts: after billing the fixture Pensioner patient with Dr Banshali (₹700) and the CGHS Referral patient with Dr Rahul (₹350), the pending list shows both with total ₹1,050, filters by doctor and sub-category work, and a cancelled bill is not listed.

- [ ] **P5-03 · Clear one or many bills** — `Pending`
  - **Where:** `cghsRegister.js`.
  - **Steps:**
    1. `clearBills({ billIds, receivedOn, reference, amount, note })` in one
       transaction, with the bills locked.
    2. Every bill must be `pending`, final, not cancelled, and from the same
       payer.
    3. `amount` must equal the sum of their claim amounts (CGHS always pays
       in full); otherwise refuse and return the difference.
    4. Write one `claim_settlements` row and one `claim_settlement_bills` row
       per bill; set each bill `cleared` with the settlement id; if the bill
       has test lines, write the claim part through to the orders'
       `amount_claimed` as approved; audit.
    5. `undoClear(settlementId, reason)` — admin only: void the settlement,
       set its bills back to `pending`; audit.
  - **Done when:** one bill and three bills can each be cleared; a wrong
    amount, a mixed-payer selection and an already-cleared bill are refused;
    undo returns bills to pending.
  - **E2E test:** `e2e/billing/phase5/P5-03-clear-one-or-many-bills.spec.js` — asserts: through the API as `reception_admin`, clearing one ₹700 bill with amount 700 succeeds; clearing two bills (₹350 + ₹700) with 1,050 succeeds and both share one reference; amount 1,000 is refused with "difference ₹50"; clearing a cleared bill is refused; undo as `admin` returns them to pending and undo as `reception_admin` returns 403.

- [ ] **P5-04 · Register export** — `Pending`
  - **What:** Pending and Cleared lists (with the current filters) as `.xlsx`,
    and a printable pending list with subtotals per sub-category and doctor.
  - **Done when:** the export totals equal the screen totals.
  - **E2E test:** `e2e/billing/phase5/P5-04-register-export.spec.js` — asserts: the downloaded Pending file has one row per pending bill and the same total as the API; the Cleared file shows the reference and date for each cleared bill.

- [ ] **P5-05 · CGHS register routes and page** — `Pending`
  - **Where:** `server/routes/billingClaims.js`, under `/api/billing/claims` (`BILLING_CLAIMS`; undo clear
    needs admin), `src/pages/billing/CghsRegisterPage.jsx`, router, routes
    config, a menu entry "CGHS register" shown only to admin and reception
    admin.
  - **Steps:**
    1. Pending tab: filters, totals, checkboxes, "Select all filtered",
       "Mark cleared" per row, "Clear selected".
    2. Clear dialog: date received, reference, amount (pre-filled with the
       selected total, editable), note; a live "difference ₹X" message and a
       disabled Save until it is zero.
    3. Cleared tab: search by reference; admin sees "Undo" with a reason box.
    4. Export buttons.
  - **Done when:** the register works end to end from the screen and is
    invisible to reception.
  - **E2E test:** `e2e/billing/phase5/P5-05-cghs-register-routes-and-page.spec.js` — asserts: in the browser as `reception_admin`, two pending bills are selected and cleared with one reference, they move to the Cleared tab, and the Billing Counter shows "Cleared on <date>" for them; as `reception` the menu entry is absent and the page and API are refused.

### 5B. Dashboards

- [ ] **P5-06 · Reports service** — `Pending`
  - **Where:** `server/services/billing/reports.js`.
  - **What:** every report reads **final, non-cancelled** bills and the
    snapshots on `bill_lines` (never live master data). Filters: date range,
    group, subgroup, category, sub-category, consultant, user.
  - **Done when:** the shared filter builder is used by every report.
  - **E2E test:** `e2e/billing/phase5/P5-06-reports-service.spec.js` — asserts: the shared filter builder is used by every report.

- [ ] **P5-07 · Revenue reports** — `Pending`
  - **What:**
    1. By group → subgroup → item, per day / week / month.
    2. By consultant.
    3. By category → sub-category (e.g. CGHS → CGHS Paid / CGHS Referral /
       Pensioner), with actual, collected, to be claimed and adjusted side by
       side.
  - **Done when:** each total equals the sum of the matching lines.
  - **E2E test:** `e2e/billing/phase5/P5-07-revenue-reports.spec.js` — asserts: each total equals the sum of the matching lines.

- [ ] **P5-08 · Collection and dues reports** — `Pending`
  - **What:**
    1. Collections by mode (cash / card / UPI), by user, by shift.
    2. Dues (only when pay-later is on).
  - **Done when:** collections equal the sum of payments.
  - **E2E test:** `e2e/billing/phase5/P5-08-collection-and-dues-reports.spec.js` — asserts: collections equal the sum of payments.

- [ ] **P5-09 · Discount report** — `Pending`
  - **What:** discounts by rule, code, method (automatic / code), category,
    sub-category, group, consultant and applying user; discount as a % of
    actual per group.
  - **Done when:** the totals equal `bill_line_discounts`.
  - **E2E test:** `e2e/billing/phase5/P5-09-discount-report.spec.js` — asserts: the totals equal `bill_line_discounts`.

- [ ] **P5-10 · Receivables, cancellations and requests reports** — `Pending`
  - **What:**
    1. CGHS receivables: pending amount by sub-category and doctor, ageing
       (0–30 / 31–60 / 61–90 / 90+ days), and amount cleared per month.
    2. Coupon usage: uses per code per day and per doctor, against the
       limits.
    3. Cancellations with reasons.
    4. Desk requests by user, approved vs rejected.
  - **Done when:** each report returns data for a test period.
  - **E2E test:** `e2e/billing/phase5/P5-10-receivables-cancellations-and-requests-reports.spec.js` — asserts: each report returns data for a test period.

- [ ] **P5-11 · Excel export** — `Pending`
  - **What:** every report downloads as `.xlsx` with the same filters, using
    `xlsx`.
  - **E2E test:** `e2e/billing/phase5/P5-11-excel-export.spec.js` — asserts the behaviour described in **What**, through the API and (for screens) the browser.

- [ ] **P5-12 · Reports routes and page** — `Pending`
  - **Where:** `server/routes/billingReports.js`, under `/api/billing/reports` (`BILLING_REPORTS`),
    `src/pages/billing/BillingReportsPage.jsx` at `/billing/reports`, router,
    routes config, menu.
  - **What:** one page with a filter bar, a tab per report, and an export
    button.
  - **Done when:** admin and reception_admin see it; reception doesn't.
  - **E2E test:** `e2e/billing/phase5/P5-12-reports-routes-and-page.spec.js` — asserts: admin and reception_admin see it; reception doesn't.

### 5C. Checks

- [ ] **P5-13 · Smoke script: claims and reports** — `Pending`
  - **Where:** `server/scripts/smoke-billing-reports.mjs`,
    `smoke:billing-reports`.
  - **Checks:**
    1. Report totals equal the sum of final bills for the period.
    2. Cancelled bills are excluded.
    3. CGHS sub-category totals add up to the CGHS total.
    4. A settlement's amount equals its bills' claim amounts.
    5. A bill can't be in two non-voided settlements.

    Everything runs inside a rolled-back transaction.

  - **Done when:** the script passes.
  - **E2E test:** `e2e/billing/phase5/P5-13-smoke-script-claims-and-reports.spec.js` — bills created through the API for all fixture patients, then the reports page and claims page are checked in the browser: totals match, cancelled bills are excluded, CGHS sub-categories add up, a settlement matches its bills, and a bill can't be cleared twice.

- [ ] **P5-14 · Update the plan status** — `Pending`
  - **E2E test:** No new spec — run `npm run test:e2e:billing`; the whole suite must be green before the phase is marked built.

---

## Phase 6 — Pharmacy billing

- [ ] **P6-01 · Write the pharmacy billing plan** — `Pending`
  - **What:** a separate plan: each medicine as a service item in group
    Pharmacy (from `medicine_catalog`), how dispensed medicines become bill
    lines, stock/batch needs, and category payment rules for medicines.
  - **Done when:** the plan is agreed.
  - **E2E test:** No code.

- [ ] **P6-02 · Build from that plan** — `Pending`
  - **What:** follow the pharmacy plan's own task list.
  - **E2E test:** Defined in the pharmacy plan's own tasks.

---

## Phase 7 — GST on

Only when the hospital decides to charge GST.

- [ ] **P7-01 · Tax codes for taxable items** — `Pending`
  - **What:** the admin creates the tax codes the accountant names (SAC/HSN,
    rate) and assigns them to those items only.
  - **Done when:** the accountant confirms the list.
  - **E2E test:** No code — admin data entry.

- [ ] **P7-02 · Switch GST on** — `Pending`
  - **What:** the admin confirms the GSTIN and state, then turns GST on in
    Billing settings.
  - **Done when:** a new bill for a taxable item shows CGST and SGST.
  - **E2E test:** `e2e/billing/phase7/P7-02-switch-gst-on.spec.js` — asserts: a new bill for a taxable item shows CGST and SGST.

- [ ] **P7-03 · Check old bills** — `Pending`
  - **What:** bills finalised before the switch still show zero tax and
    unchanged totals.
  - **E2E test:** `e2e/billing/phase7/P7-03-check-old-bills.spec.js` — asserts the behaviour described in **What**, through the API and (for screens) the browser.

- [ ] **P7-04 · GST on the printed bill** — `Pending`
  - **What:** the bill PDF shows GSTIN, SAC/HSN per line, taxable value, CGST,
    SGST and totals.
  - **E2E test:** `e2e/billing/phase7/P7-04-gst-on-the-printed-bill.spec.js` — asserts the behaviour described in **What**, through the API and (for screens) the browser.

- [ ] **P7-05 · GST summary report** — `Pending`
  - **What:** a report by SAC/HSN and rate (taxable value, CGST, SGST) for a
    date range, with Excel export, on the reports page.
  - **E2E test:** `e2e/billing/phase7/P7-05-gst-summary-report.spec.js` — asserts the behaviour described in **What**, through the API and (for screens) the browser.
