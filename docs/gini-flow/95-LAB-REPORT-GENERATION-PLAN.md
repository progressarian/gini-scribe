# 95 — Lab report from typed results (verify, PDF, record, app)

Status: **plan, not built; decisions taken** — 13 Nov 2026. Builds on plan 94 (test parameters) and plan 32 (typed results).

## 1. Goal

When the lab types a test's values on Lab Station 2, Scribe produces the lab report itself:

1. a **provisional** copy the lab can preview/print straight away,
2. a **verified** final PDF once a lab admin / pathologist checks the values and clicks **Verify**,
3. the final PDF lands in the **patient's record** (Labs tab, like any uploaded report) and in the
   **MyHealth Genie** app,
4. it looks like the **HealthRay** lab report the hospital already uses.

Decided by the user (13 Nov 2026): verify first; deliver to print + patient record + Genie; HealthRay
layout.

## 2. What exists today (checked in code)

| Area                      | Today                                                                                                                                                                                                                                                                                               | Where                                                               |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Typed values              | `lab_results` rows, `source='manual'`, linked by `lab_order_id` or `lab_case_no`. Saving **overwrites in place** — no history, no `entered_by`, no `updated_at`. A value already in `lab_results` for that patient/test/date from another source (HealthRay, extracts) is **skipped**, not written. | `server/services/giniflow/labResults.js:346-430`                    |
| Saving finishes the order | `saveResults` moves the order to `uploaded` and the MO dashboard reads "Results ready". A case gets `results_ready`.                                                                                                                                                                                | `labResults.js:441-500`                                             |
| Who types                 | Processing room needs `GINIFLOW_STATION_LAB_PROCESS` → only **lab_admin** and **admin**. No pathologist role.                                                                                                                                                                                       | `shared/permissions.js:366-382`, `src/config/routes.js:149`         |
| Doctor details            | `doctors`: name, qualification, `license_no` (registration). No designation, no signature image.                                                                                                                                                                                                    | `server/schema.sql:63-75`                                           |
| PDF engine                | `renderHtmlToPdf` (Puppeteer, A4, page X of Y) — used by prescriptions, bills, medicine cards, referral letters. Needs Chrome on the host.                                                                                                                                                          | `server/services/prescriptionHtmlPdf.js:66`                         |
| HealthRay-style PDF       | `generateLabReportPdf` (pdfkit) draws the HealthRay layout but is **never called**, has no logo, signatures disabled, and **cannot split a long test across pages** (a CBC overflows).                                                                                                              | `server/services/lab/labPdfGenerator.js`                            |
| Logo                      | `app_kv.rx_logo` via `getPrescriptionLogo()`; hospital name/address only hard-coded in the pdfkit file.                                                                                                                                                                                             | `server/services/prescriptionLogo.js:76`                            |
| File storage              | Private bucket `patient-files`, `storeReportObject` writes `giniflow/lab/{patientId}/…`, served through `/giniflow/stations/lab/:orderId/report.file` and `/api/documents/:id/stream`.                                                                                                              | `labStation.js:1254`, `routes/documents.js:696`                     |
| Patient record            | One `documents` row with `doc_type='lab_report'` puts a report on the Labs tab. Gini orders: `promoteLabReport` inserts it with `giniflow_lab_order_id` — **unique per order**. Cases: inserted with `notes='lab_case:<caseNo>'`.                                                                   | `server/services/giniflow/promote.js:73-120`, `labStation.js:~1964` |
| Genie app                 | No push any more — the app reads Scribe's DB directly under row security. It sees **every** `documents` and `lab_results` row of the patient, immediately.                                                                                                                                          | `server/migrations/2026-10-11_patient_app_rls.sql:111,121`          |
| Verify / provisional      | Does not exist anywhere for lab.                                                                                                                                                                                                                                                                    | —                                                                   |
| Audit                     | `lab_catalog_audit` is append-only; nothing audits `lab_results` value changes.                                                                                                                                                                                                                     | plan 94                                                             |

Two facts shape the design:

- **Typed values are already visible** to the doctor (Scribe) and to the patient (app) the moment they
  are saved. "Verify first" therefore needs a decision on whether values wait too (§4, O2/O3).
- **One `documents` row per order** today — an order can have an uploaded scan _and_ a generated report,
  so the generated report needs its own link.

## 3. How it will work (the flow)

```
Lab types values ──Save──▶ report v1 = PROVISIONAL ──Verify──▶ v1 = VERIFIED ──▶ PDF stored
      ▲                       │ Preview (watermarked)            │                 ├─ documents row (Labs tab)
      │                       │ not in record / app              │                 └─ app sees it
      └── value changed after verify ─▶ v2 PROVISIONAL (v1 kept, marked "replaced") ─▶ Verify again
```

1. **Save values** (unchanged screen). Each save writes `lab_results` as today and creates/refreshes the
   order's current report **version** with status `provisional`, a snapshot of exactly what was saved
   for _this_ order/case, and who entered it.
2. **Preview / print provisional** — PDF rendered on demand with a large "PROVISIONAL — NOT VERIFIED"
   watermark. Not stored, not in the record, not in the app.
3. **Verify** (lab admin / admin): a confirm box shows the patient (name, UHID, age/sex), the tests, every
   **H/L** and **critical** value highlighted, and any required field left blank (blocks verify). On
   confirm: status `verified`, verifier + time stamped, final PDF rendered and stored, `documents` row
   written.
4. **Correct after verify**: changing any value of a verified report starts version 2 as `provisional`;
   version 1 stays stored and is marked `replaced`. The record keeps showing v1 until v2 is verified, then
   shows v2 titled "Amended lab report". Nothing is ever deleted.
5. **Scan uploaded too**: unaffected — the uploaded file keeps its own `documents` row.

## 4. Decisions (13 Nov 2026)

- **O1 — Same person may enter and verify.** One-person shifts keep working; the report, PDF and history
  record both the person who entered and the person who verified.
- **O2 — Doctor/MO see typed values at once, tagged Provisional.** The order still reads "Results ready"
  on save (today's speed); the tag goes when the report is verified.
- **O3 — Patient app hides unverified typed values.** A row-security change on `lab_results`: rows with
  `source='manual'` are visible to the app only once their report version is verified. Rows from other
  sources (HealthRay, the patient's own entries) are unchanged. Production policy change, run with
  approval.
- **O4/O5 — Header and signature:** prescription logo (`rx_logo`) + hospital name/address/phone in a new
  `app_kv` key `lab_report_header`, editable by admin; verifier's printed name, qualification and
  registration no. (`doctors.license_no`). No signature image.

## 5. Design

### 5.1 Data (one migration, on test DB first, then production with approval)

`lab_reports` — one row per version:

| Column                                             | Notes                                                                                                       |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `id` bigserial                                     |                                                                                                             |
| `patient_id` int                                   |                                                                                                             |
| `lab_order_id` uuid NULL / `lab_case_no` text NULL | exactly one set (CHECK)                                                                                     |
| `version` int                                      | 1, 2, … per order/case; unique (order or case, version)                                                     |
| `status` text                                      | `provisional` · `verified` · `replaced` (CHECK)                                                             |
| `snapshot` jsonb                                   | tests → rows: name, value/text, unit, range text, flag, critical, calculated, heading — exactly what prints |
| `entered_by` int, `entered_at`                     | last saver of this version                                                                                  |
| `verified_by` int, `verified_at`                   | NULL until verified                                                                                         |
| `storage_path` text, `document_id` int             | final PDF + its `documents` row (verified only)                                                             |
| `created_at`, `updated_at`                         |                                                                                                             |

- `documents.lab_report_id` (new, unique where not null) — the generated report's row, separate from the
  uploaded scan's `giniflow_lab_order_id`.
- `lab_report_audit` — append-only (same trigger + RLS pattern as `lab_catalog_audit`): created, saved,
  previewed-printed, verified, replaced, with before/after snapshot.
- `lab_results`: add `entered_by`, `updated_at` (for the record of who changed a value).
- `lab_results.verified_at` (new): set on every row of the report when it is verified, cleared when a
  value changes. The app policy on `lab_results` becomes "own patient AND (source <> 'manual' OR
  verified_at IS NOT NULL)", so after a correction the app keeps hiding the changed value until it is
  verified again. R6 first checks which `source` the app itself writes, so patients' own entries stay
  visible.
- New capability `LAB_REPORT_VERIFY` → lab_admin, admin (both sides of RBAC).

### 5.2 Server

- `server/services/labReports/snapshot.js` — builds the snapshot from `lab_results` rows of this
  order/case + catalog order/headings (`catalogRowsFor`), so the PDF follows the test's field order.
- `server/services/labReports/versions.js` — `onResultsSaved(order|case)` (called inside `saveResults` /
  `saveCaseResults`, same transaction): create v1, refresh the current provisional version, or open a new
  version if the current one is verified and the values differ. `verifyReport(id, {expectedVersion},
actor)` with stale guard.
- `server/services/labReports/pdf.js` — HTML template rendered with `renderHtmlToPdf` (not the pdfkit file:
  it cannot break long tests across pages and has no logo/signature). HealthRay look: logo + hospital
  block, gold rule, patient grid (name, age/sex, UHID, referred by, registered / collected / received /
  reported), per test a section with headings, TEST · RESULT · UNIT · REFERENCE, abnormal values bold with
  H/L, critical marked, page breaks between rows not inside them, "~ End of report ~", page X of Y,
  verified-by block; provisional adds the watermark.
- Store final PDF with `storeReportObject` under `giniflow/lab/{patientId}/report_{order|case}_v{n}.pdf`.
- `documents` row: `doc_type='lab_report'`, title `Lab report — <tests>` (or `Amended lab report — …`),
  `source='scribe_lab'`, `doc_date` = visit/case date, `lab_report_id`.

Routes (`server/routes/giniflowStations.js`):

| Method                                                  | Path                                                        | Capability                                                |
| ------------------------------------------------------- | ----------------------------------------------------------- | --------------------------------------------------------- |
| GET                                                     | `/giniflow/stations/lab/:orderId/typed-report`              | PROCESS — status, versions, snapshot summary              |
| GET                                                     | `/giniflow/stations/lab/:orderId/typed-report.pdf?version=` | PROCESS — provisional (watermarked) or stored final       |
| POST                                                    | `/giniflow/stations/lab/:orderId/typed-report/verify`       | LAB_REPORT_VERIFY — body `{ version, expectedUpdatedAt }` |
| same three for `/giniflow/stations/lab/cases/:caseNo/…` |                                                             |                                                           |

### 5.3 Screen — Lab Station 2 (LabRoom.jsx, between "Enter results" and "Upload")

New **Lab report** section:

- Status chip: `Provisional` (amber) · `Verified by <name>, <time>` (green) · `Amended — v2 provisional`.
- Buttons: **Preview** (opens the watermarked PDF) · **Verify…** (lab admin/admin only; confirm box per §3
  step 3) · **Print / Download** (final, once verified) · version list when there is more than one.
- Shown only when at least one typed value exists for the order/case.
- Loading, error ("Could not make the report — try again"), and Chrome-missing message ("Report printing
  is not available on this server") states.

Doctor/MO screens: the verified PDF appears in the Labs tab by itself (existing `documents` reader).
Typed values show a small **Provisional** tag until `verified_at` is set (O2).

### 5.4 Patient app

The final report appears automatically (the app reads `documents`). Unverified typed values are hidden from the app (O3).

## 6. Steps (one at a time, each tested before the next)

| Step | What                                                                                                                                  | Test                                                                                                                                            |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| R1   | Migration (`lab_reports`, `lab_report_audit`, `documents.lab_report_id`, `lab_results.entered_by/updated_at/verified_at`), capability | apply on test DB; existing lab specs still pass                                                                                                 |
| R2   | Snapshot builder + versions on save (orders and cases)                                                                                | v1 created on first save, refreshed on re-save, v2 opened after verify + change, skipped HealthRay rows not in snapshot                         |
| R3   | PDF template + provisional preview route                                                                                              | PDF text contains patient, tests, H/L, watermark; a 30-row CBC spans pages without cutting rows                                                 |
| R4   | Verify route + storage + `documents` row                                                                                              | verify blocked with blank required field / stale version / wrong role; stored file streams; Labs tab lists it once; amended version replaces it |
| R5   | Lab Station 2 section (order + case)                                                                                                  | on screen: preview, verify confirm text, chips, print; phone width                                                                              |
| R6   | Provisional tag for doctors + app policy on `lab_results`                                                                             | app user cannot read unverified typed values but sees HealthRay and own entries; MO tag shows and clears                                        |
| R7   | Header setting (O5) + signature block (O4)                                                                                            | admin edits header; PDF reflects it                                                                                                             |
| R8   | Docs (README API row, plan 94 link), full lab suite                                                                                   | all pass                                                                                                                                        |

## 7. Risks and limits

- **Chrome on the server**: the PDF needs Puppeteer's Chrome, like prescriptions. If it is missing,
  verify must still record the verification and show "PDF could not be made" with a retry, not fail
  silently.
- **Skipped values**: a test already present for that date from HealthRay is not written by the lab
  save, so it is not in the typed report — the report prints only what this order/case saved, and the
  verify box lists any skipped tests.
- **Production**: the migration and any app policy change run on production only with approval; no bulk
  writes (reports are made one at a time, no backfill of old orders).
- **Not in scope**: generating reports for old orders, report e-mail/WhatsApp, a pathologist role (lab
  admin verifies), editing the HealthRay case's own PDF.

## 8. Review (13 Nov 2026) — gaps found and how the plan changes

Checked again against the code before building. Each item below changes the design above; where they
conflict, this section wins.

1. **Values also leak through biomarkers.** Saving typed values calls `syncBiomarkersFromLatestLabs`,
   which copies them into `appointments.biomarkers` (`server/services/healthray/db.js:~2104`) — and the
   app can read `appointments`. Hiding `lab_results` rows alone would not hide them. **Change:** the
   biomarker sync skips `source='manual'` rows with `verified_at IS NULL`; verify runs the sync again. R6.
2. **Existing typed values would vanish from the app.** The new app rule hides manual rows without
   `verified_at` — every value typed before this feature has none. **Change:** a one-off script marks
   existing manual rows `verified_at = created_at` (they were released under the old rules), in batches
   of 100, dry run first, before the policy changes. New step R6a.
3. **One value per patient, test and day.** `writeEntries` keeps one manual row per patient + test +
   date and moves it to whichever order saved last (`labResults.js:358-364`). A repeat test the same day
   on a second order overwrites the first order's row. **Change:** the report prints from its own
   `snapshot` (never re-reads `lab_results`), so a verified PDF can never change underneath; the verify box
   warns when a value in the snapshot no longer matches `lab_results`.
4. **Tests finished at different times.** An order often holds tests that finish hours apart (Lipid now,
   HbA1c later). **Change:** a test with no value yet prints "Result awaited" and does not block verify;
   the required-field check applies only to tests that have at least one value. When the later test is
   typed, the verified report opens version 2 (amended) as in §3.
5. **Outsourced and machine orders.** A sent-out test is performed by the outside lab, whose PDF is the
   report; machine orders (ECG, echo…) have their own reports. **Change:** typed reports are made only for
   in-house lab orders (`kind='lab'`, not `is_outsourced`). Typing values for the others still works as
   today, with no generated report.
6. **HealthRay cases already get HealthRay's own PDF** (lab sync, `server/services/lab/db.js:390`).
   **Decision O6 (13 Nov 2026): Scribe always makes its own report for a case too, labelled.** Both stay in
   the record: the Scribe one is titled "Lab report (Gini lab, verified) — <tests>", HealthRay's keeps its
   own title, so a reader can tell them apart. The Scribe PDF footer says "Generated in Gini Scribe from
   values entered at the Gini lab".
7. **No re-extraction loop.** The document classifier only picks `source='healthray'` + `doc_type='other'`
   (`documentClassification.js:52`) and extraction only runs for `extracted_data.extraction_status =
'pending'`. **Change:** the generated report's `documents` row is written with `source='scribe_lab'`
   and no `extracted_data`, so it is never read back into values.
8. **`documents` link per order, not per version.** One generated-report row per order/case, pointed at
   the latest verified version. **Change:** `documents.typed_report_key` (`order:<id>` / `case:<no>`,
   unique) instead of `documents.lab_report_id`.
9. **Step times on the PDF.** Collected/received times come only from Scribe's own bench presses
   (`giniflow_lab_order_events`, case actions) — never HealthRay's stamps, which are all set at sign-out.
   A step with no press is left off; "Reported" is the verify time.
10. **Patient identity on the PDF** is taken from the patient row at verify time and stored in the
    snapshot: name, age/sex, UHID (file no.) and Health ID, so a later UHID reassignment cannot change an
    issued report.
11. **Release order.** R1–R6a must reach production together: verify without the app rule would publish
    unverified values; the app rule without R6a would hide old values.
12. **Critical values** are highlighted in the verify box only; recording "critical value informed to …"
    is out of scope (separate plan if wanted).

Updated steps: R1 migration also adds `documents.typed_report_key` (replaces `lab_report_id`); R2 skips
outsourced/machine orders and handles "Result awaited"; R6 also gates the biomarker sync; **R6a**
batched backfill of `verified_at` for existing manual rows (dry run, then production with approval).
