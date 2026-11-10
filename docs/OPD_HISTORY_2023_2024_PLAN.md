# OPD history 2023–2024 from HealthRay — Plan

Status: draft for review · 2026-11-10 · nothing fetched, nothing written

## 1. Goal

Add 2023 and 2024 as their own years to the OPD year-by-year report (`docs/OPD_YOY_DATA_PLAN.md`), with the same 11 figures and the same rules as 2025–2026.

## 2. Why Scribe can't answer this today

- `appointments` starts on 2025-01-01. The HealthRay appointment sync never loaded earlier years.
- The ~37,000 consultations dated 2021–2024 were bulk-loaded on 24 Mar 2026. Their dates are not visit dates (17% fall on a Sunday against 0.5% of real visits), and 2024 has fewer than 2023 (11,284 vs 17,466 patient-days), which looks like an incomplete import.
- The per-visit diagnosis / medicine lists that drive #5–8 and #11 exist only on 2025+ appointments.

## 3. Where 2023–2024 can come from

| Source                                                                                    | Calls                      | Gives                                                                  | Problem                                                                                                         |
| ----------------------------------------------------------------------------------------- | -------------------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| **A. HealthRay appointment list** `fetchAppointments(doctorId, date)`, per doctor per day | doctors × ~600 OPD days    | Every visit: date, patient (Health ID, UHID), age, sex, status, type   | Many calls; must confirm HealthRay still returns 2023 days                                                      |
| **B. HealthRay clinical note per visit** `fetchClinicalNotes(appointmentId, doctorId)`    | one per visit (~25–35k)    | Diagnosis (AOO, dual adiposity, nephropathy stage, CAD±), prescription | The note is cumulative; must confirm whether a 2023 appointment returns the note as it was then or as it is now |
| C. Cumulative notes already stored on 2025+ appointments                                  | none                       | Dated FOLLOW UP blocks of earlier visits                               | Only patients who came back in 2025+, so 2023–24 would be biased toward patients who stayed                     |
| D. `lab_results` with test dates in 2023–24                                               | none (one read-only query) | HbA1c, LDL (#9, #10)                                                   | Coverage unknown; BP is not a lab                                                                               |

Recommendation: **A for the visit list, B for the clinical figures, D for labs where present**, and C only to cross-check A.

## 4. Phases

**Phase 0 — probe (needs your OK; 3 HealthRay requests, 1 read-only DB query).**

1. `fetchDoctors()` (usually cached) → doctor count, so the request budget can be stated exactly.
2. `fetchAppointments` for one doctor on one 2023 OPD day → does history come back, and in what shape.
3. `fetchClinicalNotes` for one appointment from that day → is it the note as it was in 2023 or today's cumulative note.
4. Read-only: count `lab_results` HbA1c / LDL per year 2023–2024.

Phase 0 decides whether phases 1–2 are possible and how long they take.

**Phase 1 — visit list (figures #1–3 for 2023–24).** About doctors × 600 requests. Gives visits, unique patients, ≥3-visit set and age.

**Phase 2 — notes (figures #4–8, #11).** About one request per attended in-person visit.

**Phase 3 — report.** `report-opd-yoy.mjs` reads the fetched files for 2023–24 and the database for 2025+, and the page gains two more years automatically.

## 5. HealthRay safety (the main risk)

This machine is currently the **only one HealthRay lets read bills** (the production IP is blocked; see memory "Railway IP blocked; local worker reads bills"). A block on this IP would stop bill reading at reception.

- Run only **outside OPD hours** (e.g. 21:00–07:00), never while the floor depends on bill reads, or from another machine / `HEALTHRAY_PROXY_URL` if one exists.
- **Strictly one request at a time**, a fixed gap between requests (start at 5 s; `--gap-ms`), plus the existing client limits (`HEALTHRAY_MAX_CONCURRENT=1`).
- **Honour the shared cooldown**: never set `HEALTHRAY_IGNORE_SHARED_BLOCK` for this job; check `healthray_login_cooldown` before starting and between batches.
- **Stop at the first 403, HTML response or login failure.** No retries in a loop.
- **Reuse the shared session** (`app_kv`), no extra logins.
- **Resumable**: a checkpoint file records each finished doctor-day / appointment, so a stopped run continues instead of starting over.
- Log progress and request counts every batch.

Rough time at a 5 s gap: phase 1 ≈ doctors × 600 × 5 s (10 doctors ≈ 8 h, one night); phase 2 ≈ 30,000 × 5 s ≈ 42 h (four to five nights).

## 6. Storage and privacy

- **No writes to the production database.** Fetched data goes to local files under `server/reports/healthray-history/` (gitignored): `visits-<year>.ndjson`, `notes-<year>.ndjson`, `checkpoint.json`.
- These hold patient data (DPDP): kept on this machine only, never committed or shared, deleted once the report is final.
- Patient identity keys on **Health ID**, not UHID (UHIDs get reassigned). Patients not in Scribe are still counted by their HealthRay patient id.

## 7. Turning notes into figures without AI

The 2025+ figures use the AI-parsed lists. Parsing ~30k old notes with Claude would cost money and time, so phase 2 applies the same rules to the **raw note text**:

- Dual adiposity, CAD+/CAD− (last sign, POST/S-P dash = separator), nephropathy KDIGO stage, AOO / "since" year — regex rules already written for the report.
- GLP-1 / Awiqli — `drugNormalizer` on each prescription line.
- Labs — `lab_results` by test date; BP from the note's vitals block if present.

**Calibration before trusting it:** run the raw-text rules on the stored 2025–26 notes and compare with the current (AI-list) results for the same patients. Use them for 2023–24 only if each figure agrees ≥ 95% at patient level; otherwise mark that figure "not available" for 2023–24.

## 8. Tests

- `smoke-opd-yoy.mjs`: add raw-text cases (cumulative note with several dated blocks, CAD− POST PTCA, NEPHROPATHY (G3aA2), Rx lines with brand names, deferred drugs).
- Fetch script: `--dry-run` that prints the doctor-day plan and request count without calling HealthRay; a fake-client unit check of the stop-on-403 and resume logic.
- Calibration report (§7) saved alongside the output.

## 9. Open questions

1. Which machine / IP should run the fetch (this one is the bill reader)?
2. Is a night window acceptable, and which hours?
3. Phase 1 only first (visits, patients, age), or plan for phases 1 + 2 together?
4. Should patients seen only by non-endocrine / visiting doctors be included (same as 2025–26: all consultants)?

## 10. What Scribe already holds for 2023–2024 (read-only count, 2026-11-10)

Patients with at least one record in the year (demo / test / blocked excluded):

| Record                           | 2023  | 2024  | 2025  | 2026 to date |
| -------------------------------- | ----- | ----- | ----- | ------------ |
| HbA1c (`lab_results`)            | 3,339 | 915   | 5,587 | 5,878        |
| LDL (`lab_results`)              | 2,928 | 433   | 5,228 | 5,602        |
| BP (`vitals`)                    | 190   | 2,317 | 3,402 | 5,964        |
| Weight (`vitals`)                | 4,960 | 3,961 | 6,091 | 6,449        |
| Waist (`vitals`)                 | 306   | 52    | 2,705 | 5,069        |
| Medicine started (`medications`) | 4,706 | 3,474 | 5,986 | 6,684        |

- 2024 is far thinner than 2023 (and than 2025) for labs, matching the consultations import: an incomplete import, not a smaller OPD.
- 2023 has almost no BP, so #10 cannot be computed from Scribe; waist is near-absent in both years.
- 2022–2024 medicine rows have started ≈ last-prescribed counts, i.e. they carry the imported consultation dates and share their unreliability.
- Lab rows come from bulk loads (`baseline_table`, `import`, `vitals_sheet`, `vendor_import`), not a live sync.
- Conclusion: Scribe alone cannot give 2023–2024 figures comparable with 2025–2026.

Decided so far: the fetch, if run, runs on this laptop at night (§9 Q1).
