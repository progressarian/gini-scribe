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
- Every create / update / delete / cancel writes a `billing_audit` row.
- **Codes** on new billing tables are unique ignoring case (unique index on
  `lower(code)`), non-blank and without spaces (plan §5, decided in the P1-04
  review). Lookups compare `lower(code)`; upserts use
  `ON CONFLICT ((lower(code)))`. Store the code as typed.
- **Every update sets `updated_at = NOW()` and `updated_by`** — there is no
  database trigger for it.
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

- [ ] **P1-12 · Apply the categories migration** — `Pending`
  - **Steps:** review, run, confirm the new columns, tables and the single
    settings row. Two files, in order: `2026-10-09_billing_categories.sql`,
    then `2026-10-10_billing_settings_audit.sql`. Neither drops anything (the
    scheme price tables are dropped later, in P1-10, after P1-24 is live).
  - **Done when:** everything exists in production; `patient_schemes` data is
    unchanged.
  - **E2E test:** No new spec — after applying, rebuild the test database and run the whole billing suite.

### 1D. Server services

- [ ] **P1-13 · Audit helper** — `Pending`
  - **Where:** `server/services/billing/audit.js`.
  - **What:** `writeAudit(client, { entity, entityId, action, before, after, actorId, ip })`,
    always inside the caller's transaction.
  - **Done when:** every later service uses it, and a rolled-back transaction
    leaves no audit row.
  - **E2E test:** `e2e/billing/phase1/P1-13-audit-helper.spec.js` — asserts: every later service uses it, and a rolled-back transaction leaves no audit row.

- [ ] **P1-14 · "Where is it used" helper** — `Pending`
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

- [ ] **P1-15 · Service groups and subgroups service** — `Pending`
  - **Where:** `server/services/billing/serviceGroups.js`.
  - **What:** list (with item counts), create, update (name, code, order),
    deactivate, delete.
  - **Steps:**
    1. Codes are unique ignoring case; a duplicate (including `lab` when
       `LAB` exists) returns 409 with a message. Find by code with
       `lower(code) = lower($1)`.
    2. Delete calls `usage.js` and returns 409 with the list when the row is
       used.
    3. Every write is audited, and every update sets `updated_at = NOW()` and
       `updated_by`.
  - **Done when:** all operations work and a used group can't be deleted.
  - **E2E test:** `e2e/billing/phase1/P1-15-service-groups-and-subgroups-service.spec.js` — asserts: all operations work and a used group can't be deleted.

- [ ] **P1-16 · Tax codes service** — `Pending`
  - **Where:** `server/services/billing/taxCodes.js`.
  - **What:** list, create, update, deactivate, delete (blocked when used).
    `rate_pct` must be 0–100.
  - **Steps:** deactivating a tax code that active items still use is refused
    with 409 and the list of those items (P1-05 review).
  - **Done when:** as P1-15.
  - **E2E test:** `e2e/billing/phase1/P1-16-tax-codes-service.spec.js` — asserts: create, update, deactivate and delete tax codes through the API; `rate_pct` outside 0–100 is refused; deleting a used tax code returns 409 with the "used in" list; deactivating a tax code used by an active item returns 409 with those items.

- [ ] **P1-17 · Service items service** — `Pending`
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
  - **Done when:** all operations work and each rule is refused with a clear
    message.
  - **E2E test:** `e2e/billing/phase1/P1-17-service-items-service.spec.js` — asserts: all operations work and each rule is refused with a clear message.

- [ ] **P1-18 · "Not priced" list** — `Pending`
  - **Where:** `serviceItems.js`.
  - **What:** every active catalogue test (lab, machine, ECHO, X-ray) that has
    no service item yet, and every active consultant missing a New or Follow Up
    item.
  - **Done when:** creating the missing item removes it from the list.
  - **E2E test:** `e2e/billing/phase1/P1-18-not-priced-list.spec.js` — asserts: creating the missing item removes it from the list.

- [ ] **P1-19 · Categories and sub-categories service (extend `patientSchemes.js`)** — `Pending`
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

- [ ] **P1-20 · Category rules service** — `Pending`
  - **Where:** `server/services/billing/categoryRules.js`.
  - **What:** list by category or sub-category, create, update, deactivate,
    delete. `min_age <= max_age`; names are unique per category, ignoring
    case.
  - **Steps:** refuse a rule on a category that has sub-categories (e.g. bare
    CGHS): such a category can't be billed on its own, so the rule must name
    the sub-category (P1-09 review).
  - **Done when:** all operations work.
  - **E2E test:** `e2e/billing/phase1/P1-20-category-rules-service.spec.js` — asserts: all operations work; a rule on a category that has sub-categories is refused.

- [ ] **P1-21 · Category resolver** — `Pending`
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
    3. Matching `suggest` rules are returned as suggestions.
    4. Otherwise General (no category).
  - **Done when:** each of the four cases returns the expected result.
  - **E2E test:** `e2e/billing/phase1/P1-21-category-resolver.spec.js` — asserts: each of the four cases returns the expected result.

- [ ] **P1-22 · Category rates service** — `Pending`
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

- [ ] **P1-23 · Billing settings and bill series services** — `Pending`
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

- [ ] **P1-24 · Move test prices to the service master** — `Pending`
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

### 1E. Routes

- [ ] **P1-25 · Validation schemas** — `Pending`
  - **Where:** `server/schemas/index.js`.
  - **What:** Zod schemas for create/update of groups, subgroups, tax codes,
    items, categories, category rules, category rates, settings, series.
  - **Steps:** unknown fields are rejected; money fields are non-negative
    numbers with at most 2 decimals.
  - **Done when:** each endpoint in P1-26/27 uses its schema.
  - **E2E test:** `e2e/billing/phase1/P1-25-validation-schemas.spec.js` — asserts: each endpoint in P1-26/27 uses its schema.

- [ ] **P1-26 · Master data routes** — `Pending`
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
  - **Done when:** each endpoint works and returns 403 without the capability.
  - **E2E test:** `e2e/billing/phase1/P1-26-master-data-routes.spec.js` — asserts: each endpoint works and returns 403 without the capability.

- [ ] **P1-27 · Settings routes** — `Pending`
  - **Where:** `server/routes/billingSettings.js`, mounted in
    `server/index.js`, under `/api/billing/settings`.
  - **What:** read/update settings, list/update series, behind
    `BILLING_SETTINGS`. Tax code CRUD also sits here.
  - **Done when:** only admin can change these.
  - **E2E test:** `e2e/billing/phase1/P1-27-settings-routes.spec.js` — asserts: only admin can change these.

### 1F. Admin screens

- [ ] **P1-28 · Billing section in settings** — `Pending`
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

- [ ] **P1-29 · Services page** — `Pending`
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

- [ ] **P1-30 · "Not priced" tab** — `Pending`
  - **Where:** Services page.
  - **What:** the P1-18 list, each row with "Create item" that opens the item
    form pre-filled (name, test link or consultant + visit type).
  - **Done when:** creating an item removes the row.
  - **E2E test:** `e2e/billing/phase1/P1-30-not-priced-tab.spec.js` — asserts: creating an item removes the row.

- [ ] **P1-31 · Categories page (extend `SchemesSettingsPage.jsx`)** — `Pending`
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

- [ ] **P1-32 · Category rates page** — `Pending`
  - **Where:** `src/pages/billing/CategoryRatesPage.jsx`.
  - **What:** pick a category or sub-category → grid of items (group,
    subgroup, item, base price, category rate, bill name, bill code, valid
    from/to, inherited from parent or own), inline edit, filter by group, clear
    a row.
  - **Done when:** a CGHS rate with bill code `CC02` can be saved for a
    consultation item and shows as inherited under CGHS Paid, CGHS Referral
    and Pensioner.
  - **E2E test:** `e2e/billing/phase1/P1-32-category-rates-page.spec.js` — asserts: a CGHS rate with bill code `CC02` can be saved for a consultation item and shows as inherited under CGHS Paid, CGHS Referral and Pensioner.

- [ ] **P1-33 · Billing settings page** — `Pending`
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

- [ ] **P1-34 · Test catalogue page stops editing price** — `Pending`
  - **Where:** `/settings/tests` page.
  - **What:** the price becomes read-only, showing the service item's price,
    with a link to that item (or "Create item" when missing).
  - **Done when:** no price can be typed on the test catalogue page.
  - **E2E test:** `e2e/billing/phase1/P1-34-test-catalogue-page-stops-editing-price.spec.js` — asserts: no price can be typed on the test catalogue page.

### 1G. Checks

- [ ] **P1-35 · Smoke script: master data** — `Pending`
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

- [ ] **P1-36 · Regression checks** — `Pending`
  - **Steps:**
    1. `npm run build` is clean.
    2. `npm run smoke:ghm-categories` and `npm run smoke:ghm-pill-filters`
       pass.
    3. The MO test ordering screen and reception's payment queue show
       unchanged prices.
  - **Done when:** all pass.
  - **E2E test:** `e2e/billing/phase1/P1-36-regression-checks.spec.js` — asserts: all pass.

- [ ] **P1-38 · Permission check on every billing screen and API** — `Pending`
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

- [ ] **P1-37 · Update the plan status** — `Pending`
  - **What:** mark Phase 1 as built in `52-BILLING-PLAN.md`, with any
    differences from the plan written down.
  - **E2E test:** No new spec — run `npm run test:e2e:billing`; the whole suite must be green before the phase is marked built.

---

## Phase 2 — Bulk Excel import

Goal: the admin uploads the Phase 0 workbook, sees exactly what will change,
and saves it all at once or not at all.

- [ ] **P2-01 · Migration: import history** — `Pending`
  - **Where:** `server/migrations/<date>_billing_imports.sql`.
  - **What:** `billing_imports` (`id`, `file_name`, `imported_by`,
    `imported_at`, `counts` JSONB per sheet, `status`), RLS on. Review, then
    apply.
  - **Done when:** the table exists in production.
  - **E2E test:** No new spec — the table is exercised by P2-08's test. Rebuild the test database after applying.

- [ ] **P2-02 · Column definitions in one place** — `Pending`
  - **Where:** `server/services/billing/importColumns.js`.
  - **What:** for each sheet: column name, required or not, type, allowed
    values, the key columns. Both the template builder and the parser read
    this, so they can never disagree.
  - **Done when:** every column in plan §9 is defined.
  - **Note:** `importColumns.js` already exists from P0-01; this task adds
    whatever the parser still needs (e.g. per-column parsing) to the same file.
  - **E2E test:** `e2e/billing/phase2/P2-02-column-definitions-in-one-place.spec.js` — asserts: every column in plan §9 is defined.

- [ ] **P2-03 · Template download** — `Pending`
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

- [ ] **P2-04 · Parse the upload** — `Pending`
  - **Where:** `server/services/billing/importParse.js`.
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

- [ ] **P2-05 · Check groups, subgroups and items** — `Pending`
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
    - a test name that isn't in the Gini Flow test catalogue is refused with:
      "This test isn't in the test catalogue yet — ask an admin to add it
      (Settings › Test catalogue), then upload again". A test that exists only
      in the lab report catalogue can't be priced until it has a catalogue
      entry (P1-06 review).
  - **Done when:** each bad value produces an error row with a message.
  - **E2E test:** `e2e/billing/phase2/P2-05-check-groups-subgroups-and-items.spec.js` — asserts: each bad value produces an error row with a message.

- [ ] **P2-06 · Check categories, category rules and category rates** — `Pending`
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
  - **E2E test:** `e2e/billing/phase2/P2-06-check-categories-category-rules-and-category.spec.js` — asserts: an upload with a missing parent, a third category level, a bad age range, an unknown item, a negative rate and overlapping dates each produces an error row with the right message.

- [ ] **P2-07 · Row status and preview** — `Pending`
  - **What:** each row is marked new / update / unchanged / error by comparing
    with the database, using the key columns.
  - **Done when:** the preview returns counts per sheet and the error rows.
  - **E2E test:** `e2e/billing/phase2/P2-07-row-status-and-preview.spec.js` — asserts: the preview returns counts per sheet and the error rows.

- [ ] **P2-08 · Save all or nothing** — `Pending`
  - **Where:** `server/services/billing/importCommit.js`.
  - **Steps:**
    1. Refuse to save if any error row exists.
    2. In one transaction, save in dependency order: groups → subgroups →
       tax codes → items → top-level categories → sub-categories → category
       rules → category rates.
    3. Write audit rows, price history for price changes, and a
       `billing_imports` row.
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

- [ ] **P2-09 · Error file** — `Pending`
  - **What:** download the error rows as `.xlsx` with an extra "error" column,
    so the admin fixes them in place and re-uploads.
  - **Done when:** the downloaded file re-uploads cleanly once fixed.
  - **E2E test:** `e2e/billing/phase2/P2-09-error-file.spec.js` — asserts: the downloaded file re-uploads cleanly once fixed.

- [ ] **P2-10 · Import routes** — `Pending`
  - **Where:** `server/routes/billingImport.js`, under `/api/billing/import`.
  - **What:** download template, upload for preview, commit, download errors,
    import history. All behind `BILLING_MASTER`, with a Zod schema for the
    commit request.
  - **Done when:** each works and returns 403 without the capability.
  - **E2E test:** `e2e/billing/phase2/P2-10-import-routes.spec.js` — asserts: each works and returns 403 without the capability.

- [ ] **P2-11 · Bulk import page** — `Pending`
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

- [ ] **P2-12 · Smoke script: import** — `Pending`
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

- [ ] **P2-14 · Update the plan status** — `Pending`
  - **E2E test:** No new spec — run `npm run test:e2e:billing`; the whole suite must be green before the phase is marked built.

---

## Phase 3 — Payment rules, discounts, pricing engine

Goal: for any patient and any list of items, the server calculates the actual
amount, discounts, tax, what the patient pays, and what is claimed. Admins
manage payment rules and discount codes.

### 3A. Database

- [ ] **P3-01 · Migration: payment rules** — `Pending`
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

- [ ] **P3-02 · Migration: discount rules** — `Pending`
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
  - **E2E test:** `e2e/billing/phase3/P3-02-migration-discount-rules.spec.js` — asserts: the migration runs twice on a fresh test database without error; the new tables, columns and indexes exist; RLS is on; no business rows are inserted.

- [ ] **P3-03 · Apply the rules migration** — `Pending`
  - **Done when:** both tables exist in production, empty.
  - **E2E test:** No new spec — rebuild the test database and run the whole billing suite.

### 3B. Payment rules

- [ ] **P3-04 · Payment rules service** — `Pending`
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

- [ ] **P3-05 · Protect rules when prices change** — `Pending`
  - **Where:** `serviceItems.js`, `categoryRates.js`.
  - **What:** lowering an item's base price or category rate below the amount
    of an `amount` rule that covers it is refused, naming the rule.
  - **Done when:** the refusal works from the screen and from the import.
  - **E2E test:** `e2e/billing/phase3/P3-05-protect-rules-when-prices-change.spec.js` — asserts: the refusal works from the screen and from the import.

- [ ] **P3-06 · Payment rule resolver** — `Pending`
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

### 3C. Discount rules

- [ ] **P3-07 · Discount rules service** — `Pending`
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

- [ ] **P3-08 · Discount matcher** — `Pending`
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

### 3D. Pricing engine

- [ ] **P3-09 · Line pricing: actual amount** — `Pending`
  - **Where:** `server/services/billing/priceLine.js`.
  - **Steps:**
    1. Take the item's base price.
    2. Apply the category rate (sub-category first, then parent, valid on the
       bill date), including its bill name and bill code.
    3. Actual amount = quantity × rate, in paise.
  - **Done when:** a CGHS rate replaces the base price for a Pensioner patient
    too, and the bill name/code come through.
  - **E2E test:** `e2e/billing/phase3/P3-09-line-pricing-actual-amount.spec.js` — asserts: a CGHS rate replaces the base price for a Pensioner patient too, and the bill name/code come through.

- [ ] **P3-10 · Line pricing: discounts on full-pay lines** — `Pending`
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

- [ ] **P3-11 · Line pricing: tax** — `Pending`
  - **Steps:**
    1. With GST off: tax is 0 and the exempt code is recorded.
    2. With GST on:
       - taxable = actual − discount, or back-calculated when
         `price_includes_tax`;
       - CGST and SGST are each half the rate;
       - rounding is to the paisa.
  - **Done when:** GST off gives 0, and GST on at 18% gives 9% + 9%.
  - **E2E test:** `e2e/billing/phase3/P3-11-line-pricing-tax.spec.js` — asserts: GST off gives 0, and GST on at 18% gives 9% + 9%.

- [ ] **P3-12 · Line pricing: patient payable and the rest** — `Pending`
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

- [ ] **P3-13 · Line pricing: discounts on payment-rule lines** — `Pending`
  - **What:** only rules with `applies_on_scheme_rate` apply. They reduce the
    patient payable, never below ₹0; the claim is unchanged. The stacking
    setting applies.
  - **Done when:** with the switch off nothing changes, and with it on the
    patient payable drops.
  - **E2E test:** `e2e/billing/phase3/P3-13-line-pricing-discounts-on-payment-rule-lines.spec.js` — asserts: with the switch off nothing changes, and with it on the patient payable drops.

- [ ] **P3-14 · Line invariant** — `Pending`
  - **What:** after pricing, check actual − discount + tax = patient payable +
    claim + adjustment, in paise. A mismatch throws, and the line is never
    saved.
  - **Done when:** a deliberately broken input throws.
  - **E2E test:** `e2e/billing/phase3/P3-14-line-invariant.spec.js` — asserts: a deliberately broken input throws.

- [ ] **P3-15 · Bill pricing** — `Pending`
  - **Where:** `server/services/billing/priceBill.js`.
  - **Steps:**
    1. Resolve the category once.
    2. Price every line.
    3. Apply bill-level (`applies_per = bill`) rules.
    4. Total everything.
    5. Round the patient payable to the rupee and record `round_off`.
  - **Done when:** the totals equal the sum of the lines plus the round-off.
  - **E2E test:** `e2e/billing/phase3/P3-15-bill-pricing.spec.js` — asserts: the totals equal the sum of the lines plus the round-off.

- [ ] **P3-16 · Preview endpoint** — `Pending`
  - **Where:** `server/routes/billing.js`.
  - **What:** input: patient, visit, item ids, quantities, codes. Output:
    priced lines, the reason for any refused code, and totals. Behind
    `BILLING_DESK`. The schema rejects any price, rate or discount amount.
  - **Done when:** a request carrying a price is rejected with 400.
  - **E2E test:** `e2e/billing/phase3/P3-16-preview-endpoint.spec.js` — asserts: a request carrying a price is rejected with 400.

- [ ] **P3-17 · "Test this rule" endpoint** — `Pending`
  - **What:** input: age, gender, category or sub-category, visit type, items,
    codes (no real patient). Output: the same as the preview. Behind
    `BILLING_MASTER`.
  - **Done when:** it returns the same numbers as the preview for the same
    inputs.
  - **E2E test:** `e2e/billing/phase3/P3-17-test-this-rule-endpoint.spec.js` — asserts: it returns the same numbers as the preview for the same inputs.

- [ ] **P3-17a · Consultant fees service** — `Pending`
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

### 3E. Screens

- [ ] **P3-18 · Payment rules on the Categories page** — `Pending`
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

- [ ] **P3-18a · Consultant fees screen** — `Pending`
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

- [ ] **P3-19 · Discounts page** — `Pending`
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

- [ ] **P3-20 · "Test this rule" box** — `Pending`
  - **Where:** Discounts page.
  - **What:** enter age, gender, category or sub-category, visit type, items
    and codes → see the priced lines and which rules applied or were refused,
    and why.
  - **Done when:** it matches the preview endpoint.
  - **E2E test:** `e2e/billing/phase3/P3-20-test-this-rule-box.spec.js` — asserts: it matches the preview endpoint.

- [ ] **P3-21 · Register Phase 3 pages** — `Pending`
  - **What:** router (`lazyWithRetry`), routes config, and the settings tab
    for Discounts.
  - **E2E test:** `e2e/billing/phase3/P3-21-register-phase-3-pages.spec.js` — asserts the behaviour described in **What**, through the API and (for screens) the browser.

### 3F. Import and checks

- [ ] **P3-22 · Switch on the Payment rules and Discounts sheets** — `Pending`
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

- [ ] **P3-23 · Import the hospital's rules** — `Pending`
  - **Depends on:** P0-07 and P0-08 — the admin team's filled `Payment rules`, `Consultant fees` and `Discounts` sheets, and their decisions on the duplicate doctor records.
  - **What:** upload the Phase 0 `Payment rules` and `Discounts` sheets and fix
    errors with the admin team.
  - **Done when:** the admin team confirms the imported rules, including all
    three CGHS sub-categories.
  - **E2E test:** No new spec — the admin team confirms the rules; the import path is covered by P3-22.

- [ ] **P3-24 · Smoke script: pricing** — `Pending`
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

- [ ] **P3-25 · Update the plan status** — `Pending`
  - **E2E test:** No new spec — run `npm run test:e2e:billing`; the whole suite must be green before the phase is marked built.

---

## Phase 4 — Bills, payments, Billing Counter

Goal: reception bills any patient on the Billing Counter page, takes cash,
card or UPI, prints the bill and receipt, and paid tests are cleared for the
floor. Nothing about the existing "Clear payment" changes.

### 4A. Database

- [ ] **P4-01 · Migration: bills and requests** — `Pending`
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
  - **E2E test:** `e2e/billing/phase4/P4-01-migration-bills-and-requests.spec.js` — asserts: the migration runs twice on a fresh test database without error; the new tables, columns and indexes exist; RLS is on; no business rows are inserted.

- [ ] **P4-02 · Migration: lines and discounts** — `Pending`
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

- [ ] **P4-03 · Migration: payments and shifts** — `Pending`
  - **Where:** same file.
  - **What:**
    1. `cash_shifts`.
    2. `payments`: mode `cash` / `card` / `upi`; direction `in` only;
       `amount > 0`; `reference`; `receipt_no` unique; `shift_id`.
    3. RLS for both.
  - **Done when:** the SQL is reviewed.
  - **E2E test:** `e2e/billing/phase4/P4-03-migration-payments-and-shifts.spec.js` — asserts: the migration runs twice on a fresh test database without error; the new tables, columns and indexes exist; RLS is on; no business rows are inserted.

- [ ] **P4-04 · Apply the bills migration** — `Pending`
  - **Done when:** all Phase 4 tables exist in production, empty.
  - **E2E test:** No new spec — rebuild the test database and run the whole billing suite.

### 4B. Numbering

- [ ] **P4-05 · Bill and receipt numbers** — `Pending`
  - **Where:** `server/services/billing/billNumber.js`.
  - **Steps:**
    1. `nextNumber(client, series, date)` works out the financial year
       (April–March) and locks the `bill_series` row with
       `SELECT … FOR UPDATE`.
    2. It builds `prefix + zero-padded next_no` and increments `next_no`.
    3. With no series row for that year, it throws "Ask the admin to set the
       bill series for 2026-27".
  - **Done when:** two concurrent finalises get consecutive numbers with no gap.
  - **E2E test:** `e2e/billing/phase4/P4-05-bill-and-receipt-numbers.spec.js` — asserts: two concurrent finalises get consecutive numbers with no gap.

### 4C. Bills

- [ ] **P4-06 · Open or create a draft bill** — `Pending`
  - **Where:** `server/services/billing/bills.js`.
  - **What:** `openDraft(visitId)` returns the visit's open draft, or creates
    one with the category resolved (P1-21), the payer name (from the
    sub-category or CGHS), and the patient's age on that date.
  - **Done when:** calling it twice returns the same draft.
  - **E2E test:** `e2e/billing/phase4/P4-06-open-or-create-a-draft-bill.spec.js` — asserts: calling it twice returns the same draft.

- [ ] **P4-07 · Draft at check-in** — `Pending`
  - **Where:** the check-in path (`receptionStation.js` check-in functions)
    calls a new `billing/visitLines.js`.
  - **Steps:**
    1. After a successful check-in, create the draft with the consultation
       line: the item for this doctor + visit type, else the hospital default
       consultation item. An **Investigation** visit gets no consultation line
       (no consultation fee, decided 2026-09-17).
       - Convert the appointment's visit type first with one shared function
         in `shared/` (plan §7): Investigation → no fee; a type
         `isNewVisitType` calls new (`New`, `New Patient`) → `New`; anything
         else (`Follow-Up`, `Follow-up`, `Tele`, `OPD`) → `Follow Up`
         (decided 2026-09-18: Tele is charged as Follow Up).
    2. A walk-in or lab-only visit with no consultant gets an empty draft.
    3. A billing failure must never block check-in: log it and continue.
  - **Done when:** checking in a patient creates a draft with the right
    consultation line.
  - **E2E test:** `e2e/billing/phase4/P4-07-draft-at-check-in.spec.js` — asserts: checking in a patient creates a draft with the right consultation line.

- [ ] **P4-08 · Lines from test orders** — `Pending`
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

- [ ] **P4-09 · Never-twice check** — `Pending`
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

- [ ] **P4-10 · Add, change and remove lines** — `Pending`
  - **Where:** `bills.js`.
  - **Steps:**
    1. Add by item id: active items only, draft bills only.
    2. Change quantity: only for `allow_quantity` items, 1 to `max_quantity`.
    3. Remove from a draft: reason required, audited.
    4. Every change reprices the bill (P3-15) and bumps `version`.
  - **Done when:** each action works and wrong ones are refused.
  - **E2E test:** `e2e/billing/phase4/P4-10-add-change-and-remove-lines.spec.js` — asserts: each action works and wrong ones are refused.

- [ ] **P4-11 · Discount codes on a bill** — `Pending`
  - **What:** add or remove a code on a draft. The code is checked (P3-08) and
    the bill repriced. Applied discounts are written to `bill_line_discounts`
    at finalise.
  - **Done when:** a valid code changes the totals, and an invalid one returns
    its reason.
  - **E2E test:** `e2e/billing/phase4/P4-11-discount-codes-on-a-bill.spec.js` — asserts: a valid code changes the totals, and an invalid one returns its reason.

- [ ] **P4-12 · Category, card and referral on a bill** — `Pending`
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

- [ ] **P4-13 · Finalise** — `Pending`
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

- [ ] **P4-14 · Cancel an unpaid bill** — `Pending`
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

### 4D. Payments and the test gate

- [ ] **P4-15 · Take payments** — `Pending`
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

- [ ] **P4-16 · Pay later and dues** — `Pending`
  - **Steps:**
    1. Pay-later is only offered when allowed.
    2. A pay-later bill is final with an outstanding balance, and appears on
       the dues list.
    3. Later payments on any day reduce the balance.
    4. The bill leaves the list when fully paid.
  - **Done when:** it works with the setting on, and is refused with it off.
  - **E2E test:** `e2e/billing/phase4/P4-16-pay-later-and-dues.spec.js` — asserts: it works with the setting on, and is refused with it off.

- [ ] **P4-17 · Paid test lines open the gate** — `Pending`
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

- [ ] **P4-18 · Existing "Clear payment" untouched** — `Pending`
  - **What:** confirm `clearPayment` and `getPaymentQueue` in
    `receptionStation.js` are unchanged and still open the gate, and that
    using both paths on the same order can't collect it twice.
  - **Done when:** the check passes with no edits to those functions.
  - **E2E test:** `e2e/billing/phase4/P4-18-existing-clear-payment-untouched.spec.js` — asserts: the check passes with no edits to those functions.

### 4E. Desk requests

- [ ] **P4-19 · Requests service** — `Pending`
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

- [ ] **P4-20 · Approve or reject** — `Pending`
  - **Steps:**
    1. **New item:** approved by creating the service item in the same
       transaction (linked by `created_item_id`); rejected with a note.
    2. **Repeat:** approved or rejected with a note. An approved repeat can
       be used for exactly one line, then becomes `used`.
  - **Done when:** a second use of the same approval is refused.
  - **E2E test:** `e2e/billing/phase4/P4-20-approve-or-reject.spec.js` — asserts: a second use of the same approval is refused.

- [ ] **P4-21 · Live updates** — `Pending`
  - **Where:** `server/services/giniflow/realtimeBus.js` (`publishEvents`).
  - **What:** publish request created / approved / rejected events, so the
    desk and the inbox update without refreshing.
  - **Done when:** approving on one screen updates the other within seconds.
  - **E2E test:** `e2e/billing/phase4/P4-21-live-updates.spec.js` — asserts: approving on one screen updates the other within seconds.

### 4F. Cash closing

- [ ] **P4-22 · Shifts** — `Pending`
  - **Where:** `server/services/billing/cashShifts.js`.
  - **Steps:**
    1. Open a shift with opening cash; one open shift per user.
    2. The shift view shows expected cash, card and UPI from its payments.
    3. Close with counted cash; the difference is recorded.
    4. reception_admin and admin can list every shift.
  - **Done when:** a shift's expected totals equal the sum of its payments.
  - **E2E test:** `e2e/billing/phase4/P4-22-shifts.spec.js` — asserts: a shift's expected totals equal the sum of its payments.

### 4G. Printouts

- [ ] **P4-23 · Bill PDF** — `Pending`
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
  - **Done when:** the PDF prints cleanly for a General bill, a CGHS Paid bill
    and a CGHS Referral bill.
  - **E2E test:** `e2e/billing/phase4/P4-23-bill-pdf.spec.js` — asserts: the PDF prints cleanly for a General bill, a CGHS Paid bill and a CGHS Referral bill.

- [ ] **P4-24 · Receipt PDF** — `Pending`
  - **Where:** `server/services/billing/receiptPdf.js`.
  - **Contents:** receipt number and date, bill number, patient, amount, mode,
    reference, received by.
  - **Done when:** one receipt prints per payment.
  - **E2E test:** `e2e/billing/phase4/P4-24-receipt-pdf.spec.js` — asserts: one receipt prints per payment.

### 4H. Routes

- [ ] **P4-25 · Schemas** — `Pending`
  - **Where:** `server/schemas/index.js`.
  - **What:** schemas for every Phase 4 request. Desk schemas **reject** any
    `price`, `rate`, `bill_name`, `bill_code` or discount amount field.
  - **Done when:** a desk request with a price returns 400.
  - **E2E test:** `e2e/billing/phase4/P4-25-schemas.spec.js` — asserts: a desk request with a price returns 400.

- [ ] **P4-26 · Billing routes** — `Pending`
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

### 4I. Billing Counter page

- [ ] **P4-27 · Page shell** — `Pending`
  - **Where:** `src/pages/billing/BillingCounterPage.jsx` at
    `/giniflow/station/billing`, router (`lazyWithRetry`), routes config
    (`BILLING_DESK`), menu entry, `src/queries/hooks/useBilling.js`.
  - **What:** left: patient search and today's visits. Right: the selected
    visit's bills. `?patient=` or `?visit=` in the URL opens a patient
    directly.
  - **Done when:** reception can open a patient's billing view.
  - **E2E test:** `e2e/billing/phase4/P4-27-page-shell.spec.js` — asserts: reception can open a patient's billing view.

- [ ] **P4-28 · Patient header** — `Pending`
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

- [ ] **P4-29 · Previous bills and lines** — `Pending`
  - **Steps:**
    1. List the visit's earlier bills (number, status, totals, print).
    2. The current draft's lines table: bill name, bill code, quantity (editable
       only when allowed), actual, discount, payment rule, patient pays,
       remove (reason).
  - **Done when:** the table matches the server's priced lines.
  - **E2E test:** `e2e/billing/phase4/P4-29-previous-bills-and-lines.spec.js` — asserts: the table matches the server's priced lines.

- [ ] **P4-30 · Add items, repeat and new-item requests** — `Pending`
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

- [ ] **P4-31 · Discount code box** — `Pending`
  - **Contents:**
    - one input for a code, then an accept or refuse message with the
      reason;
    - applied codes as removable chips;
    - automatic discounts shown by name, not removable.

    There is no manual discount field anywhere.

  - **Done when:** the totals update on accept.
  - **E2E test:** `e2e/billing/phase4/P4-31-discount-code-box.spec.js` — asserts: the totals update on accept.

- [ ] **P4-32 · Totals and payment** — `Pending`
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

- [ ] **P4-33 · Actions and printing** — `Pending`
  - **Buttons:** Save draft · Finalise & print (opens the bill PDF) · Print
    receipt · Cancel unpaid bill (reason). A paid bill shows no cancel button.
  - **Done when:** every action works from the page.
  - **E2E test:** `e2e/billing/phase4/P4-33-actions-and-printing.spec.js` — asserts: every action works from the page.

- [ ] **P4-34 · Dues list and shift panel** — `Pending`
  - **What:**
    - a "Dues" tab (only when pay-later is on), listing unpaid balances with
      "Take payment";
    - a shift panel to open or close a shift with counted cash.
  - **Done when:** a due can be paid from the list, and a shift can be closed.
  - **E2E test:** `e2e/billing/phase4/P4-34-dues-list-and-shift-panel.spec.js` — asserts: a due can be paid from the list, and a shift can be closed.

- [ ] **P4-35 · "Bill" button on reception check-in** — `Pending`
  - **Where:** `src/pages/giniflow/ReceptionStationPage.jsx`.
  - **What:** a **Bill** button on each patient row that opens
    `/giniflow/station/billing?visit=…`. Shown only to users with
    `BILLING_DESK`. Nothing else on that page changes.
  - **Done when:** the button opens the right patient.
  - **E2E test:** `e2e/billing/phase4/P4-35-bill-button-on-reception-check-in.spec.js` — asserts: the button opens the right patient.

### 4J. Admin requests inbox

- [ ] **P4-36 · Desk requests page** — `Pending`
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

- [ ] **P4-37 · Smoke script: bills** — `Pending`
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

- [ ] **P4-38 · Floor trial** — `Pending`
  - **Depends on:** P2-13, P3-23 and P0-09 (GSTIN, bill footer, bill and receipt number prefixes entered in Billing settings).
  - **What:** one reception user bills real patients for one session with a
    reception_admin present, including at least one General, one CGHS Paid,
    one CGHS Referral and one Pensioner patient. Note every problem.
  - **Done when:** the problems found are fixed or logged as tasks.
  - **E2E test:** No new spec — a manual floor trial. Every problem found becomes a fix **with** a new e2e test that reproduces it first.

- [ ] **P4-39 · Update the plan status** — `Pending`
  - **E2E test:** No new spec — run `npm run test:e2e:billing`; the whole suite must be green before the phase is marked built.

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
