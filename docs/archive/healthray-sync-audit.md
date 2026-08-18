# HealthRay Sync — Audit & Bug Tracker

**Generated:** 2026-04-10
**Scope:** End-to-end audit of the HealthRay → Gini Scribe data pipeline — ingestion, storage, display.
**Purpose:** Single source of truth for known bugs, tech debt, and data-loss in the HealthRay integration. Use this to plan multi-sprint cleanup.

---

## Executive summary

The HealthRay integration mostly works, but it has **silent data quality issues** that compound over time. Ten things to fix first:

1. 🔴 **Prescription "PDFs" are 100×100 JPEG thumbnails.** HealthRay's `/medical_records` endpoint never returns a full document URL — only `thumbnail`. We currently store that thumbnail in `documents.file_url` and serve it as if it were a real PDF. Worse, **Claude vision extraction is being run on those 100px thumbnails**, so AI-extracted medications/diagnoses from prescriptions are unreliable.
2. 🔴 **Sync failures are silently swallowed in 8+ places** via `.catch(() => {})`. Insertion errors on diagnoses, medications, labs, symptoms etc. don't bubble up, the appointment is marked enriched anyway, and the next sync's fast-path skips re-enrichment — so missing data stays missing forever.
3. 🔴 **Timezone double-shifting risk.** `toISTDate()` adds +5.5h to every timestamp. If HealthRay's response is already in IST (we don't actually know), we shift it by another 5.5h. There's no test pinning down which way it is.
4. 🔴 **`document_url` re-fetched from HealthRay on every view.** No caching, no race protection. Two simultaneous "View" clicks = two HealthRay API calls + two doc table writes.
5. 🔴 **In-memory diagnosis dedup missing.** AI sometimes extracts "Hypertension", "HTN", and "Essential Hypertension" in the same payload — all three normalize to the same `diagnosis_id`, but the loop tries to insert all three. The `ON CONFLICT DO UPDATE` makes it look like one row, but old rows can orphan if `diagnosis_id` changes between syncs.
6. 🟠 **`healthray_diagnoses` / `healthray_medications` JSONB on `appointments` is read directly by frontend without sorting or dedup.** Same diagnosis can appear multiple times. Insertion order is unpredictable.
7. 🟠 **Symptoms, lifestyle data, follow-up dates, "investigations to order", and clinical advice are all extracted by the AI but never displayed.** Hours of Claude tokens silently going to `/dev/null`.
8. 🟠 **Diagnosis details (CKD staging, severity) are dropped during normalization.** AI extracts `details: "G2 A1"` for diabetic nephropathy, but `normalizeDiagnosisId()` only reads `name`. Disease progression tracking is impossible.
9. 🟠 **`fast-path` re-enrichment skip is buggy.** Skips re-parse if BOTH diagnoses AND medications JSONB are non-empty. If only one is populated (because the other failed silently per #2), every future sync re-parses the entire appointment via Claude — burning AI cost and producing the same broken result.
10. 🟡 **Medications partial dedup.** Old rows without `pharmacy_match` can persist alongside new canonical rows, showing duplicates in the UI.

**Total findings in this doc:** 48 (8 critical, 8 high, 20 medium, 12 low) + 8 categories of lost data.

---

## Table of contents

- [Part 1 — How the sync works](#part-1--how-the-sync-works)
- [Part 2 — Bugs by category](#part-2--bugs-by-category)
  - [A. Data integrity / dedup](#a-data-integrity--dedup)
  - [B. Field mapping](#b-field-mapping)
  - [C. Time / date](#c-time--date)
  - [D. Document / file handling](#d-document--file-handling)
  - [E. Display issues from sync](#e-display-issues-from-sync)
  - [F. Error handling](#f-error-handling)
  - [G. Performance / cost](#g-performance--cost)
  - [H. Schema drift / hardcoded](#h-schema-drift--hardcoded)
- [Part 3 — Data we're losing](#part-3--data-were-losing)
- [Part 4 — HealthRay API endpoints we touch](#part-4--healthray-api-endpoints-we-touch)
- [Severity legend](#severity-legend)

---

## Part 1 — How the sync works

### Entry point
`server/services/cron/healthraySync.js:syncAppointment()` at line 176. Called on a cron schedule and via manual trigger from `server/routes/sync.js`.

### Per-appointment pipeline

1. **Fetch appointments** — `client.js:fetchAppointments()` calls `/appointment/data?doctor_id=X&app_date_time=YYYY-MM-DD`. Returns array; we only fetch page 1, no multi-page handling.

2. **Build patient data** — `mappers.js:buildPatientData()` (line 41-75) extracts `mobile_no`, `birth_date` (DD-MM-YYYY), `blood_group`, `abha_health_number`, `gender`. Stored via `upsertPatient()`.

3. **Build vitals + biomarkers** — `healthraySync.js:buildVitalsAndBiomarkers()` (line 78-106). Parses `weight` and `height` (oddly stored as JSON strings by HealthRay), calculates BMI, stamps `_source: "healthray"` and `_prescriptionDate: apptDate` into `opd_vitals` JSONB.

4. **Fetch clinical notes** — `healthraySync.js:fetchClinicalText()` (line 109-165) calls `client.js:fetchClinicalNotes()`. If empty AND `show_previous_appointment === true`, falls back to `fetchPreviousAppointmentData()`. If that fails, falls back to last sync's `healthray_clinical_notes` from DB.

5. **Flatten clinical text** — `parser.js:extractClinicalText()` (line 12-33) walks the menu→category→topic→answers tree, joins with `---` separators.

6. **AI parse** — `parser.js:parseClinicalWithAI()` calls Claude Haiku, expects JSON with: `diagnoses`, `medications`, `previous_medications`, `labs`, `vitals`, `lifestyle`, `investigations_to_order`, `follow_up`, `advice`, `symptoms`. Has JSON repair for truncated responses. On failure → returns null, sync continues with empty arrays.

7. **Upsert appointment** — `db.js:upsertAppointment()` (line 187-308). Single row in `appointments`. Sets `healthray_id`, `healthray_clinical_notes`, `healthray_diagnoses`, `healthray_medications`, `healthray_previous_medications`, `healthray_labs`, `healthray_investigations`, `healthray_follow_up`, `healthray_advice`, `opd_vitals`, `biomarkers`, `compliance`. **Fast-path** at line 188-193: skips re-enrichment if appointment is `completed` AND has clinical notes AND has BOTH diagnoses AND medications JSONB populated.

8. **Normalized table writes** (lines 312-324):
   - `syncVitals()` → inserts row in `vitals`
   - `syncLabResults()` → inserts/dedup rows in `lab_results` with `source='healthray'`
   - `syncMedications()` → upserts rows in `medications` with `source='healthray'` and `pharmacy_match`
   - `syncStoppedMedications()` → marks old medications inactive
   - `stopStaleHealthrayMeds()` → stops any active HealthRay-sourced med not in current sync
   - `syncDiagnoses()` → upserts rows in `diagnoses` with normalized `diagnosis_id`
   - `syncDocuments()` → calls `fetchMedicalRecords()` and inserts into `documents` table

### Display

| Entity | DB location | Frontend reader |
|---|---|---|
| Vitals | `appointments.opd_vitals` (JSONB) + `vitals` table | `OPD.jsx` OverviewTab line 824, `VitalsTab` line 2132 |
| Diagnoses | `appointments.healthray_diagnoses` (JSONB) + `diagnoses` table | `OPD.jsx` line 727 (JSONB), `VisitDiagnoses.jsx` (DB rows) |
| Medications | `appointments.healthray_medications` (JSONB) + `medications` table | `VisitMedications.jsx`, `ComplianceTab` |
| Labs | `appointments.biomarkers` (JSONB) + `lab_results` table | `BiomarkersTab`, `VisitLabsPanel.jsx` |
| Documents | `documents` table (`source='healthray'`) | `VisitDocsPanel.jsx`, `ComplianceTab` View buttons |
| Clinical notes | `appointments.healthray_clinical_notes` (raw text) | Not currently displayed anywhere |
| Investigations to order | `appointments.healthray_investigations` (JSONB) | **Not displayed anywhere** |
| Follow-up | `appointments.healthray_follow_up` (JSONB) | **Not displayed anywhere** |
| Advice | `appointments.healthray_advice` (text) | **Not displayed anywhere** (folded into compliance.diet on sync) |
| Symptoms | (extracted but never stored) | n/a |
| Lifestyle | (only diet folded into `compliance`, rest dropped) | n/a |

---

## Part 2 — Bugs by category

### A. Data integrity / dedup

#### 🔴 [1] Thumbnail mistaken for full PDF in `documents.file_url`
**File:** `server/services/healthray/db.js:932` and `server/routes/documents.js:294`

`syncDocuments()` writes:
```js
rec.url || rec.file_url || rec.attachment_url || rec.thumbnail || null
```
Confirmed via runtime log on appointment 241233460: HealthRay's `/medical_records` endpoint returns **only** `thumbnail` for prescription records — no `url`/`file_url`/`attachment_url`. The thumbnail is a 100×100 JPEG signed-S3 URL. We store it in `documents.file_url` and serve it as if it were a PDF.

**Cascading effect:** `prescriptionExtractor.js:extractPrescription()` is invoked on this URL, meaning **Claude vision is reading 100×100 pixel JPEGs to extract medications and diagnoses**. The extracted data is unreliable.

**Fix:** Find a different HealthRay endpoint that returns the full file (open question — see end of doc). Until then, do NOT run prescription extraction on records whose `file_url` only has `thumbnail` available, and surface a "low-resolution preview" warning in the UI.

---

#### 🔴 [2] No in-memory diagnosis dedup before DB loop
**File:** `server/services/healthray/db.js:614-629` (`syncDiagnoses()`)

If AI returns `[{name: "Hypertension"}, {name: "HTN"}, {name: "Essential Hypertension"}]`, all three normalize to the same `diagnosis_id="hypertension"`. The loop INSERTs three times with `ON CONFLICT (patient_id, diagnosis_id) DO UPDATE` — so visually only one row appears, but on every re-sync the row is rewritten three times in a row (last write wins, prior status fields are overwritten before the final one lands).

**Fix:** Group `parsed.diagnoses` by `normalizeDiagnosisId(name)` in memory before the loop. Pick the first occurrence per group (or merge `details`/`status` if non-conflicting).

---

#### 🔴 [3] Partial sync — operation failures swallowed silently
**File:** `server/services/healthray/db.js`

`.catch(() => {})` blocks at lines 377 (labs), 598 (diagnoses dedup), 628 (diagnoses upsert), 651 (symptoms), 693 (stopped meds), 722 (stopped med insert), 809 (medications upsert), 857 (meds dedup).

If any of these fail (constraint violation, conflict, type error), the appointment sync still reports success. Combined with the fast-path at `db.js:188-193`, **the next sync skips re-enrichment**, so the missing data stays missing forever. Silent corruption.

**Fix:**
1. Replace `.catch(() => {})` with `.catch((e) => log("DB error", e.message))`. Don't swallow.
2. Wrap all per-appointment writes in a single transaction (`BEGIN ... COMMIT/ROLLBACK`).
3. Return `{ ok, errors }` from each helper so `syncAppointment()` can refuse to mark the appointment enriched if any write failed.

---

#### 🔴 [4] Document fetching race condition
**File:** `server/routes/documents.js:226-350` (`/api/documents/:id/file-url` HealthRay branch)

When user clicks "View" on a HealthRay document, the code re-fetches from HealthRay's `/medical_records` API every time (no caching), and inside that branch it can also write to the documents table. Two simultaneous View requests = two API calls + two writes that could race.

**Fix:** Cache `fetchMedicalRecords(appointmentId)` results in-process with a 5-minute TTL keyed on `(appointment_id, record_type)`. Optionally serialize writes per appointment_id with a per-key mutex.

---

#### 🟠 [5] Fast-path re-enrichment is too eager (or too lazy)
**File:** `server/services/cron/healthraySync.js:188-193`

```js
const alreadyEnriched =
  existing?.healthray_diagnoses?.length > 0 && existing?.healthray_medications?.length > 0;
```

Two failure modes:
- **False positive:** Both arrays populated but stale (HealthRay clinical notes have changed). We skip enrichment so the sync silently uses stale data.
- **False negative:** One array empty due to silent insert failure (#3). Every subsequent sync re-parses from scratch, burning Claude tokens, and silently re-failing the same way.

**Fix:** Hash the raw clinical text (sha256). Store `clinical_notes_hash` on appointment row. Skip re-enrichment iff hash matches AND last enrichment didn't error.

---

#### 🟠 [6] Medications display filter excludes HealthRay rows
**File:** `server/routes/visit.js` (medication SELECT, exact line varies)

Some patients have HealthRay-synced medications with `consultation_id IS NULL` (because they predate any local consultation). The visit page query joins to `latest_cons` and may exclude rows with NULL consultation_id, hiding HealthRay meds entirely.

**Fix:** Change the medication query to include `consultation_id IS NULL OR consultation_id IN latest_cons`.

---

#### 🟠 [7] Lab dedup by string-normalized test name misses variants
**File:** `server/services/healthray/db.js:335` and `server/utils/labNormalization.js`

`"HEMOGLOBIN A1C (CONTROL)"`, `"HBA1C"`, `"HbA1c"` all should collapse to one canonical key. Current normalization is regex-based but doesn't strip parentheticals consistently. Documented in detail in the lab section ordering plan (separate doc).

**Fix:** Build a canonical lab registry — see `Approach B` in the lab-ordering plan. Stamp `canonical_key` column at ingest time. Dedup by canonical_key, not by string.

---

### B. Field mapping

#### 🟠 [8] `healthray_id` type inconsistency
**File:** `server/services/healthray/db.js:229`

`upsertAppointment()` receives `healthrayId` as a string from `String(appt.id)` (`healthraySync.js:177`), but writes to a column whose schema definition is unclear (TEXT vs INTEGER — needs `\d+` lookup in `schema.sql`). Postgres will silently coerce, but a mismatch can cause subtle bugs in later JOIN queries.

**Fix:** Inspect `schema.sql` for `healthray_id` definition, then standardize on TEXT (since IDs are opaque strings to us).

---

#### 🟠 [9] Vitals computed twice with conflicting precedence
**File:** `server/services/cron/healthraySync.js:78-106` and lines 240-246

Vitals come from two places:
1. The appointment object (`appt.weight`, `appt.height`) — parsed in `buildVitalsAndBiomarkers()`.
2. The clinical notes parsed by AI — at lines 240-246, AI vitals are merged into `opdVitals` with `if (v.weight && !opdVitals.weight)` (skip-if-exists).

**Bug:** Precedence is "appointment data wins". This is undocumented and probably wrong — clinical notes are usually more accurate (they're what the doctor actually wrote down). Plus, BMI calculated from appointment weight may not match what the doctor manually computed.

**Fix:** Document the precedence rule in a comment. Reverse it (clinical notes win) if Dr. Bhansali agrees — clinical notes reflect doctor judgment.

---

#### 🟠 [10] Diagnosis details / staging dropped at normalization
**File:** `server/services/healthray/db.js:383-523` (`normalizeDiagnosisId()`)

AI extracts:
```json
{ "name": "NEPHROPATHY", "details": "G2 A1", "status": "Present" }
```

`normalizeDiagnosisId()` only reads `name`. The `details` field — which contains CKD G-stage, A-stage, severity markers — is **completely discarded**. We can't track "G1A1 → G2A2 → G3B3" disease progression.

**Fix:** Parse `details` for staging markers (`G[1-5]`, `A[1-3]`, "Stage [1-4]") and store in `diagnoses.complication_stage` or `diagnoses.key_value` (these columns already exist per the diagnosis spec doc).

---

#### 🟠 [11] Medication route defaults to "Oral" silently
**File:** `server/services/healthray/db.js:754`

`med.route || "Oral"` — if AI doesn't extract a route, defaults to Oral. **Wrong for insulins, eye drops, ointments, injectables.**

**Fix:** Either (a) make the AI prompt explicitly require route extraction with allowed enum, or (b) add a name-based inference table: insulin → SC, ointment → topical, drops → topical, etc.

---

#### 🟠 [12] Lab dates fall back to appointment date silently
**File:** `server/services/healthray/db.js:338`

If AI doesn't extract a date for a lab value, code uses appointment_date. No log, no flag. Means a "FOLLOW UP ON 2026-02-15" lab from clinical notes could be silently dated 2026-04-10 because AI didn't pull the date string.

**Fix:** Log a warning when fallback is used. Better: tighten the AI prompt to ALWAYS extract a date (use appointment date if explicitly stated as "today", otherwise extract from text).

---

### C. Time / date

#### 🔴 [13] `toISTDate()` shifts unconditionally — risks double-shifting
**File:** `server/services/healthray/mappers.js:64-68`

```js
function toISTDate(timestamp) {
  if (!timestamp) return null;
  const istMs = new Date(timestamp).getTime() + 5.5 * 60 * 60 * 1000;
  return new Date(istMs).toISOString().split("T")[0];
}
```

This adds +5.5h regardless of the input timezone. We don't actually know whether HealthRay returns UTC or naive-IST timestamps — there's no test pinning it. If HealthRay starts (or already does) return IST, every date in the system is off by 5.5h, which around midnight rolls over to the wrong day.

**Fix:** Add a unit test with a known appointment whose date you can verify in HealthRay's UI. Determine actual timezone empirically. Document the answer in this file.

---

#### 🟠 [14] Birth date parsing has no validation
**File:** `server/services/healthray/mappers.js:5` (`calcAge()`)

Splits on `-` assuming `DD-MM-YYYY`, never checks ranges. `"13-32-2000"` becomes `new Date(2000, 31, 13)` which JS auto-corrects to mid-2002 — wrong age silently computed.

**Fix:** `if (m < 1 || m > 12 || d < 1 || d > 31) return null`.

---

#### 🟠 [15] Lab dates from AI extraction can be in future, no sanity check
**File:** `server/services/healthray/db.js:338`

AI extracts a date string, code parses to Date, stores. No upper bound — a misread "06/04/2026" interpreted as "April 6 2026" stores fine even if the appointment is from 2025 (year hallucination).

**Fix:** Reject any extracted lab date >7 days in the future relative to appointment date. Reject any lab date >2 years before appointment date.

---

### D. Document / file handling

#### 🔴 [16] Same as #1 — thumbnail mistaken for PDF
See [1] above. This is the highest-impact document bug.

---

#### 🟠 [17] `documents.file_url` re-fetched on every view, no cache
**File:** `server/routes/documents.js:264`

Every "View PDF" click triggers `fetchMedicalRecords()` against HealthRay. High-traffic documents (viewed by 5 doctors) = 5 API calls.

**Fix:** Cache `fetchMedicalRecords` result for 5 minutes per `(appointment_id)`. Also: store the full record JSON in `documents.healthray_record_raw` JSONB column at sync time so we don't have to re-fetch at all (only refresh signed URLs).

---

#### 🟠 [18] Document dedup by `file_name` only
**File:** `server/services/healthray/db.js:917-921`

```sql
WHERE patient_id = $1 AND file_name = $2 AND source = 'healthray'
```

Two different documents with the same file_name (e.g., two prescriptions both named `prescription_dr_bhansali.pdf`) — only the first is stored. The second is silently dropped.

**Fix:** Add `file_hash` (SHA256 of binary content) column. Dedup on `(patient_id, file_hash, source)`.

---

#### 🟠 [19] Prescription extraction not transactional with medication insert
**File:** `server/routes/documents.js:662-666`

`extractPrescription()` returns extracted data, then code does `UPDATE documents SET extracted_data = $1::jsonb` in one query and `INSERT INTO medications` in separate queries. If extraction succeeds but medication insert fails partway, document has `extracted_data` set but the meds table is inconsistent with what `extracted_data` says.

**Fix:** Wrap extraction-result-application in a single transaction.

---

### E. Display issues from sync

#### 🟠 [20] `healthray_diagnoses` JSONB rendered without sort or dedup
**File:** `src/OPD.jsx:727` (the `dxChips` block in `OverviewTab`)

```js
const dxList = appt.healthray_diagnoses || [];
```

No sort, no dedup. Same diagnosis can appear multiple times across syncs. Order is whatever insertion order JSONB happens to have.

**Fix:** Already partially addressed today — `server/routes/opd.js:283` now applies `sortDiagnoses()` to each row's JSONB before returning. Still need: dedup by `name` (or `diagnosis_id` once stamped) before render.

---

#### 🟡 [21] Diagnosis status "Absent" not visually distinguished
**File:** `src/OPD.jsx:752-775` (dxChips loop)

The chip block already shows `(+)` / `(-)` / `(?)` for status, but the visual styling (color) is identical for present and absent. Doctors should see absent findings differently (e.g., gray/strikethrough).

**Fix:** Apply `text-decoration: line-through` and `color: var(--t4)` for `dx.status === "Absent"`.

---

#### 🟡 [22] Compliance notes are stale strings, not regenerated on med change
**File:** `server/services/healthray/mappers.js:124-137` (`buildCompliance()`)

`compliance.notes` is a plain text string built once at sync time: `"1. Metformin — 500mg — BD — (NEW)"`. If the doctor later edits a medication, this string is stale.

**Fix:** Regenerate compliance notes on every medication save. Or — better — don't store as a string at all; render from the live medication list at display time.

---

#### 🟡 [23] Biomarkers contain stale lab values with no date
**File:** `server/services/cron/healthraySync.js:248-253` (`mapLabsToBiomarkers()`)

Biomarkers JSONB stores values like `{ hba1c: 7.2 }` without timestamps. If the lab was synced 2 weeks ago, the doctor sees "HbA1c 7.2" today with no indication that it's old.

**Fix:** Stamp `_date` per biomarker: `{ hba1c: 7.2, hba1c_date: "2026-03-25" }`. Frontend can show the age inline.

---

### F. Error handling

#### 🔴 [24] Same as #3 — silent `.catch(() => {})` blocks
See [3] above.

---

#### 🔴 [25] Partial sync continues silently when `fetchClinicalText()` fails
**File:** `server/services/cron/healthraySync.js:261-263`

If `fetchClinicalText()` throws, the try/catch logs and continues. Appointment is still upserted with empty diagnoses/medications. The fast-path then skips re-enrichment forever.

**Fix:** If clinical-text fetch fails, **do not** mark the appointment as enriched. Set a `clinical_notes_fetch_error` column or `clinical_notes_failed_at` timestamp so a retry job can re-attempt.

---

#### 🔴 [26] No retry on Claude API failures
**Files:** `server/services/healthray/parser.js`, `server/services/healthray/prescriptionExtractor.js:68-101`

Both `parseClinicalWithAI()` and `extractFromFile()` make a single Claude call. On 5xx or rate-limit, they throw. Sync moves on.

**Fix:** Wrap Claude calls in retry-with-exponential-backoff (3 attempts: 1s, 2s, 4s). Existing `server/utils/retryWithBackoff.js` may already exist — check.

---

#### 🟠 [27] HealthRay session expiry retry only at lowest level
**File:** `server/services/healthray/client.js:51-84`

`healthrayFetch()` detects session expiry (HTML response), re-logs in, retries once. But callers like `syncAppointment()` wrap individual calls in try/catch; if re-login itself fails, the entire appointment is skipped without surfacing the auth issue.

**Fix:** Distinguish "auth failed permanently" from "transient API error" in error types. Halt the entire sync (not just the appointment) on persistent auth failure and alert.

---

#### 🟡 [28] `syncDateRange()` background errors invisible
**File:** `server/services/cron/healthraySync.js:429-453`

Backfill runs in background, errors only logged to console. Caller (the user who triggered the backfill via UI) has to poll `getRangeSyncStatus()` manually.

**Fix:** Send a toast/notification when backfill completes (success or error). Store last backfill status + error in DB so the UI can display it.

---

#### 🟡 [29] Lab case detail fetch errors don't trigger immediate retry
**File:** `server/services/lab/labSync.js:68-74`

If `fetchLabCaseDetail()` fails, sets `results_synced=false` and moves on. Recovery job picks up failed cases every 15 min — but that's a long delay for a critical lab.

**Fix:** Retry once immediately within the same sync run before marking failed.

---

### G. Performance / cost

#### 🟡 [30] Re-syncing identical clinical text wastes Claude tokens
**File:** `server/services/cron/healthraySync.js:220`

Fast-path compares "are diagnoses+meds present" but not "is the text the same". If text is byte-identical to last sync, we still re-parse via Claude.

**Fix:** Hash clinical text (sha256), store as `clinical_notes_hash` column, skip re-parse if hash matches.

---

#### 🟡 [31] Two queries to find an appointment
**File:** `server/services/healthray/db.js:61-81` (`findAppointment()`)

First tries by `healthray_id`, then by `(file_no, appointment_date)`. Two sequential queries per sync.

**Fix:** Single query with `WHERE healthray_id = $1 OR (file_no = $2 AND appointment_date = $3) LIMIT 1`.

---

#### 🟡 [32] Doctor mapping not cached between calls
**File:** `server/services/cron/healthraySync.js:349, 431`

`syncDoctors()` re-queries the DB on every sync run. For 50 doctors × 100 appointments/day = ~5000 doctor lookups/day.

**Fix:** Cache the HealthRay-doctor → local-doctor mapping in-memory with 24h TTL.

---

#### 🟡 [33] Medication dedup runs 3 sequential SQL passes
**File:** `server/services/healthray/db.js:816-857`

For each appointment with N medications, runs ~3N+ DELETE/SELECT statements during dedup.

**Fix:** Consolidate into one DELETE with a CASE-aware subquery, or do dedup in JS for small batches.

---

#### 🟡 [34] Document re-fetched on every view
See [4] / [17] above.

---

#### 🟡 [35] Claude vision called on 100×100 thumbnails
**File:** `server/routes/documents.js:656`

`extractPrescription(doc.file_url)` is called whenever a HealthRay prescription is opened. Since `file_url` is the thumbnail (per #1), we burn Claude vision tokens on a 100×100 image that produces unreliable output.

**Fix:** Detect image dimensions before calling Claude. Skip extraction if width < 400px. Surface "image too low resolution to extract" error to user.

---

### H. Schema drift / hardcoded

#### 🟡 [36] Hardcoded HealthRay org ID
**File:** `server/services/healthray/client.js:8` — `ORG_ID = process.env.HEALTHRAY_ORG_ID || "1528"`

If org_id changes, sync silently breaks (HealthRay API will return errors but they may be parsed as "no data").

**Fix:** Validate org_id on startup by calling `/organization/get_doctors/{ORG_ID}`. Fail loudly if it returns empty.

---

#### 🟡 [37] Hardcoded record_type list in `fetchMedicalRecords`
**File:** `server/services/healthray/client.js:113`

`record_type=Invoice/Bill,Prescription/Rx,Lab Report,X-Rays,Other,Certificate` — if HealthRay adds new types (e.g., "Imaging Reports", "Discharge Summaries"), we won't fetch them.

**Fix:** Either fetch all types (no filter) and filter client-side, or move to env config.

---

#### 🟡 [38] Hardcoded concurrency limit
**File:** `server/services/cron/healthraySync.js:378`

`runBatch(appointments, 5, syncAppointment)` — concurrency hardcoded at 5. No backoff on 429.

**Fix:** Make configurable. Detect 429 and back off.

---

#### 🟡 [39] Hardcoded diagnosis name regex map (50+ patterns)
**File:** `server/services/healthray/db.js:383-523` (`normalizeDiagnosisId()`)

Each new diagnosis variant requires editing JS code. New labels HealthRay introduces will fall through to a generic snake_case slug.

**Fix:** Move mappings to a database table (`diagnosis_aliases`) editable by an admin. Or use a fuzzy/embedding-based matcher.

---

## Part 3 — Data we're losing

These fields are extracted from HealthRay but discarded or never displayed:

#### 🟠 [40] Diagnosis details / CKD staging
See #10 above. AI extracts `details: "G2 A1"` for diabetic nephropathy, code drops it.

#### 🟠 [41] Medication dose-change history
**File:** `server/services/healthray/db.js:656-726` (`syncStoppedMedications()`)

AI extracts `previous_medications[].reason` like `"dose changed from 10mg to 20mg"`. We store the raw reason string in `stop_reason` but never parse it. Can't query "show all dose changes for this patient".

**Fix:** Parse the reason string for `\bdose changed from (.+) to (.+)\b` and store old/new doses in dedicated columns.

#### 🟠 [42] BP sitting/standing distinction
**File:** `server/services/healthray/mappers.js:64-68`

Clinical notes: `"BP SITTING: 165/97, BP STANDING: 152/93"`. AI extracts both, code keeps only one (last-write-wins via COALESCE). No `bp_position` column.

**Fix:** Add `bp_position` enum (`sitting`, `standing`, `lying`) to `vitals` table.

#### 🟠 [43] Follow-up date — synced but not displayed
**File:** `server/services/healthray/db.js:237` — `healthray_follow_up` JSONB written, but no frontend reads it.

**Fix:** Add follow-up display to OPD OverviewTab and patient visit page.

#### 🟠 [44] "Investigations to order" — synced but not displayed
**File:** `server/services/cron/healthraySync.js:309` — `healthray_investigations` JSONB written, no frontend reads it.

**Fix:** Add a Lab Orders / Investigations section to the visit page that surfaces this list with one-click "create lab order" buttons.

#### 🟠 [45] Clinical advice — synced but only folded into compliance.diet
**File:** `server/services/healthray/mappers.js:157`

`healthray_advice` is a free-text string. We currently fold it into `compliance.diet` if no lifestyle data exists. The structured advice content is lost.

**Fix:** Display `healthray_advice` directly in OverviewTab as "Doctor's Notes" or similar.

#### 🟠 [46] Symptoms — extracted by AI but never inserted into any table
**File:** `server/services/cron/healthraySync.js:235`

The parser produces `symptoms: [{ name, duration, severity }]`. There's a `syncSymptoms()` function in `db.js` but it's **never called**. Symptoms are lost on every sync.

**Fix:** Add `await syncSymptoms(patientId, localApptId, parsed.symptoms)` to `syncAppointment()` after `upsertAppointment()`.

#### 🟠 [47] Lifestyle data (exercise, smoking, alcohol)
**File:** `server/services/cron/healthraySync.js:236`

AI extracts lifestyle: `{ diet, exercise, smoking, alcohol }`. Only `diet` is folded into compliance. Exercise/smoking/alcohol are dropped.

**Fix:** Either add columns to `patients` table (`smoking_status`, `alcohol_use`, `exercise_freq`) or create a `patient_lifestyle` table with timestamps.

---

## Part 4 — HealthRay API endpoints we touch

All defined in `server/services/healthray/client.js`.

| Function | URL template | Method | Pagination | Cache | Notes |
|---|---|---|---|---|---|
| `fetchDoctors()` | `/organization/get_doctors/{ORG_ID}` | GET | None implemented | None | Returns array of doctor objects |
| `fetchAppointments(doctorId, date, page, perPage)` | `/appointment/data?organization_id={ORG_ID}&doctor_id={doctorId}&app_date_time={date}T00:00:00&page={page}&per_page={perPage}` | GET | Page param exposed but **only page 1 is ever fetched** | None | Returns appointments array |
| `fetchClinicalNotes(appointmentId, doctorId)` | `/appointment/medical_clinical_notes?appointmentId={x}&organization_id={ORG_ID}&doctorId={y}` | GET | None | None | Returns menu→category→topic tree |
| `fetchPreviousAppointmentData(appointmentId, patientId, doctorId)` | `/appointment/get_previous_appt_data?patient_id={x}&organization_id={ORG_ID}&appointment_id={y}&copy_previous=1&is_opd=1&doctor_id={z}` | GET | None | None | Same shape as clinical notes; called as fallback when current visit has no selected topics |
| `fetchMedicalRecords(appointmentId)` | `/medical_records?record_type=Invoice/Bill,Prescription/Rx,Lab Report,X-Rays,Other,Certificate&appointment_id={x}` | GET | None | None | **Only returns `thumbnail` field for prescriptions** — no full file URL |

### Auth
- Cookie-based session: `connect.sid`
- Login at `https://node.healthray.com/api/v2/users/sign_in` (note: `v2` for login, `v1` for everything else)
- Session expiry detected by HTML response (HealthRay redirects to login page returning 200 + HTML)
- Re-login retried once at the `healthrayFetch()` level

### Open question
**We need an endpoint that returns full-resolution prescription PDFs.** The current `/medical_records` endpoint only gives thumbnails. Possible candidates (need to be confirmed by HealthRay docs or a network capture from their web UI):
- `GET /medical_records/{id}` (detail by id)
- `GET /medical_records/{medical_record_id}/download`
- `GET /medical_records/{id}/file`
- `GET /attachments/{id}/download`

Until this is resolved, prescription extraction is broken (extracting from a 100×100 JPEG).

---

## Severity legend

| Symbol | Meaning |
|---|---|
| 🔴 | Critical — broken, data loss, or security |
| 🟠 | High — wrong data shown to doctor |
| 🟡 | Medium — bad UX or tech debt |
| 🟢 | Low — cleanup, polish |

---

## Suggested fix order

If you have one sprint, fix these in this order:

1. **#3 / #24** — Stop swallowing errors. Replace `.catch(() => {})` everywhere. Highest leverage: every other "data missing silently" bug becomes visible immediately.
2. **#5** — Fast-path hash check. Stops the perpetual re-parse of broken appointments.
3. **#13** — Pin down the timezone story with one test. Document the answer here.
4. **#1 / #16** — Resolve the thumbnail/PDF issue. Either find HealthRay's full-file endpoint or stop running extraction on thumbnails.
5. **#46** — Wire up `syncSymptoms()`. Trivial fix, immediate value.
6. **#43 / #44 / #45** — Display the data we already have (follow-up, investigations, advice). Trivial frontend additions.
7. **#10 / #41** — Stop dropping diagnosis details and dose-change history.
8. **#2** — In-memory diagnosis dedup before the DB loop.

After that, the medium-severity items can be tackled in any order based on what the doctors are complaining about most.

---

## Changes already shipped today (2026-04-10)

These items from this audit have already been addressed in the current uncommitted branch:

- ✅ Vitals source/date metadata — `_source` and `_prescriptionDate` now stamped on `opd_vitals` JSONB; UI displays "From HealthRay · {date}" in OverviewTab.
- ✅ Diagnosis ordering — `sortDiagnoses()` now correctly detects T2DM/T3CDM/MODY/early-onset variants; applied across all backend endpoints (`opd.js`, `patients.js`, `summary.js`, `reports.js`, `visit.js`); HealthRay JSONB diagnoses sorted by `opd.js:283` before returning.
- ✅ R5 unreviewed-document alert removed from summary rules; per-rule freshness checks (3-day window) added to R3/R7/G2/G5/A_bp/A_tsh/G_ldl.
- ✅ PDF viewer modal wired into OPD Medicines and Labs tabs (no longer downloads via `window.open`); click-to-zoom on images.
- ✅ Diagnostic logging in `documents.js` file-url HealthRay branch confirmed the thumbnail-only response — see #1.

These are not yet committed. See `git status` for the current uncommitted changes.
