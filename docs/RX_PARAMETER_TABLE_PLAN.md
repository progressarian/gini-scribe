# Scribe prescription — layout changes and the parameter table — Plan

Status: draft, awaiting review. No code changed yet.

Requested on 2026-10-15, from three PDFs:

- Scribe Rx for Priya Jain, annotated;
- the HealthRay Rx for KIP Singh, with a hand-drawn table;
- the Clinicea Rx for Sandeep Mangla, whose Vitals list is the reference.

## 1. What changes on the printed prescription

| #   | Change                                                                                                                                                                                                                | Decided                            |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| 1   | **Visit Summary paragraph** removed from the printed prescription. It is shown instead on the screen where the prescription is made.                                                                                  | ✓                                  |
| 2   | **Investigations ordered** chips stay on the print, as their own small block, because they were inside the summary block.                                                                                             | default; say if they should go too |
| 3   | **New parameter table**, placed **just before Diagnosis**. Rows are parameters; columns are the **last 5 follow-up visit dates + today**. Cells show values only, with "—" for no reading.                            | ✓ values only                      |
| 4   | **Diagnosis** unchanged.                                                                                                                                                                                              | ✓                                  |
| 5   | **Biomarker Trends** placed **at the end**, after Referrals / Next visit and before the footer. It was removed from the template on 10 Sep (`bdcc4b36`), so it is restored from the previous version and placed last. | ✓                                  |
| 6   | Label **"FBG/FBS" → "FPG"** wherever the print shows fasting glucose.                                                                                                                                                 | ✓                                  |
| 7   | Medicines section: no change for now.                                                                                                                                                                                 | ✓                                  |

New print order:

```
letterhead → patient bar → Investigations ordered → [Parameter table]
→ Complaints → History → Diagnosis → Goals → Medicines → Advice
→ Referrals & tests for next visit → Next visit → [Biomarker Trends] → footer
```

## 2. The parameter table

### 2.1 Default rows

The default rows follow the Clinicea Vitals list:

Height, Weight, BMI, Waist, Body Fat, BP, FPG, HbA1c, Fasting Insulin, C-Peptide, HOMA-IR, HOMA-B, Creatinine, eGFR, uACR, LDL-C, Triglycerides, Non-HDL, Fundus, VPT, ABI.

Each default row carries:

- **key**, **label** and **unit**;
- **source**: `vitals` column, `lab_results.canonical_name` (via `server/utils/labCanonical.js`), or machine report;
- **display order**.

The list is stored in `app_kv` (key `rx_parameter_defaults`), the same mechanism as the prescription footer. Admins edit it in **Settings → Prescription** (`/settings/prescription`): add, rename, re-order, set unit, remove.

### 2.2 Columns and values

- **Columns:** the last **5 dates on which any parameter was recorded** before today (newest on the right), plus **Today**. Columns that fall on a doctor visit are marked as visits; the print labels the last column "Last visit" only when it is one.
- **Value for a date:** the reading taken on that date. If there are several, the latest one is used. A reading is never moved onto a later visit's column. (Changed on 2026-10-22: the first version put every reading since the previous visit under the next visit, so a 02 Sep HbA1c printed under "Today (22 Oct 26)".)
- **Today:** only readings taken today. Any value entered at the station (§3) overrides it.
- **Hiding:** a row with no value in any column is hidden on the print by default. Staff can force it to show.
- **One loader, used by both print paths:** a new `server/services/rxParameterTable.js`. It is used by:
  - the Gini Flow / server path: `buildVisitPayloadFromDb` in `prescriptionAutoSave.js`, which currently loads only 2 vitals rows;
  - the `/visit` page path: `POST /visit/:pid/prescription.pdf`.

  This way every reprint (Rx desk reissue, regenerate, HealthRay sync) shows the same table.

## 3. At the station where the prescription is made

The consultant's screen is **`DoctorConsultPage`** (`/giniflow/station/doctor/:visitId`), where the Rx is built, finalised and printed.

1. **Visit Summary panel:** shows the summary text that used to print. It uses the same source as the PDF: `appointments.post_visit_summary`, AI-generated if empty, as today. It is read-only and has a Refresh button. Its purpose is for the doctor or explainer to read it to the patient.
2. **Parameter table editor:** the same grid the PDF will print, with the history columns read-only and **Today editable**. Staff can:
   - edit or clear a Today value;
   - **add a row**, picking from the default list or typing a custom parameter with name, unit and value;
   - **remove a row** from this prescription;
   - re-order rows.

   Changes apply **to this prescription only**. The Settings default list is unchanged.

3. **Storage:** new table `giniflow_rx_parameters`, holding `visit_id`, the `rows` JSONB of per-prescription overrides (added, removed, Today values, order), `updated_by` and `updated_at`. It has its own migration. It is read when the PDF is built, and it is audited like other Rx edits.
4. **API:** in `server/routes/giniflowStations.js`, under the doctor station's existing capability:
   - `GET /giniflow/stations/doctor/:visitId/rx-parameters` returns the merged table (history, Today and overrides);
   - `PUT /giniflow/stations/doctor/:visitId/rx-parameters` saves the overrides.

   Both have Zod validation (labels ≤ 60 characters, values ≤ 40, at most 40 rows). After the visit is finalised, editing goes through the existing Re-issue flow.

5. **Settings defaults:** `GET/PUT /api/settings/rx-parameters` on the prescription settings capability.

## 4. Tests (e2e DB only)

**`e2e/giniflow/G94-rx-layout.spec.js`** (template level, the same pattern as G81):

1. No "Visit summary" text on the print; the Investigations ordered chips still print.
2. Section order: the table comes before Diagnosis, and Biomarker Trends comes after Referrals / Next visit.
3. FPG label, not FBG/FBS.
4. Table: dates in order, "—" for missing values, rows with no values hidden, a forced row shown.

**`e2e/giniflow/G95-rx-parameter-table.spec.js`** (service + API):

1. Seeded vitals, labs and machine readings across 6 visits: the last 5 visits appear as columns, each value sits on the date it was taken, and Today holds only today's readings.
2. GET merges the defaults. PUT can edit Today, add a custom row, remove and re-order. A second GET returns the saved state.
3. The PDF data from both paths contains the same table: Gini Flow finalise and `/visit` print.
4. Validation errors and a wrong role are refused (400 / 403). After finalise, editing returns 409, pointing to Re-issue.
5. Settings defaults: edit the list, and a new prescription uses the new list. Existing prescriptions with their own edits keep them.

**`e2e/giniflow/G96-doctor-station-rx-panel.spec.js`** (UI):

1. The Visit Summary panel shows the summary text.
2. Editing Today, adding a custom row and removing a row is reflected in the print preview.

**Plus:** `npm run format:check`, the build, the existing G81 / PH02 / Rx-desk tests, and one sample PDF rendered for your visual review before anything goes live.

## 5. Build order

1. Template: remove the summary, restore Biomarker Trends at the end, FPG label. Tests 1–3.
2. `rxParameterTable.js` loader, wired into both print paths. Table rendered in the template. Tests on the table data.
3. Migration (test DB first; prod with your OK) and the station API.
4. DoctorConsultPage: Visit Summary panel + table editor.
5. Settings defaults page.
6. Full regression, a sample PDF for you, then commit only when you say.

## 6. Not in scope

Medicines-section changes (the handwritten notes on page 2) and the Rx-desk screen. The Rx desk keeps showing the stored PDF.

## 7. Built (2026-10-15)

- **Template** (`server/templates/prescriptionTemplate.js`):
  - Visit Summary removed. The Investigations ordered chips are kept as their own block.
  - The parameter table prints before Diagnosis (`prescriptionParameterTable.js`).
  - Biomarker Trends is restored from the version before `bdcc4b36` (`prescriptionTrends.js`) and prints last, after Referrals and before the signature and footer.
  - "FBS" became "FPG" on the diagnosis tags and the trend card.
- **Loader** (`server/services/rxParameterTable.js`): wired into `generatePrescriptionPdf`, so every print path gets the table. If it fails, the prescription prints without the table rather than not printing. Columns are the last 5 attended doctor visits (lab-only visits excluded) plus the prescription date.
- **Per-prescription edits:** table `rx_parameter_overrides`, keyed by patient and visit date (migration `2026-11-30_rx_parameter_overrides.sql`). It is applied to the e2e DB only. Prod needs your OK; until then prints still show the table, just without station edits.
- **Station API** (`server/routes/rxParameters.js`):
  - GET/PUT `/giniflow/stations/doctor/:visitId/rx-parameters`, which returns 409 once the consult is finalized.
  - GET/POST `.../visit-summary`.
  - Settings: GET/PUT `/admin/rx-parameters`.
- **Screens:**
  - DoctorConsultPage has a Visit summary panel (read-only, with Write/Rewrite) and the parameter table editor.
  - Settings → Prescription has the default list editor.
- **Tests:**
  - G94: layout, 5 tests.
  - G95: data and API, 5 tests.
  - G96: station screen, 3 tests.
  - With G81, G83, PH02, G15 and G90: 32 passed.
  - A sample PDF was reviewed.
