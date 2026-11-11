# HealthRay backfill plan: missing patients and the 2024 recording gap

**Why:** HealthRay shows about 23,892 patients; Scribe holds 19,432 patient records. Scribe only imports
new registrations (from the day that sync was switched on) and recent days' appointments, so older
patients and the April 2024 – February 2025 recording gap were never fetched.

**Decisions (11 Nov 2026):**
- Run after clinic hours, from tonight.
- Option B covers the gap first: 1 April 2024 – 28 February 2025.
- Count first. The AI note-reading cost is approved separately before any `--apply` run.

## Scripts

Both scripts count only (no writes) unless `--apply` is passed. They resume from a state file in
`reports/healthray-backfill/` and stop at the first HealthRay block or error. They limit themselves to
about 0.5 HealthRay requests a second (`HEALTHRAY_MAX_RPS`).

| Script | Does | Count only | Apply |
|---|---|---|---|
| `server/scripts/backfill-healthray-patients.mjs` | Pages through HealthRay's patient list and compares each patient with Scribe by HealthRay id and UHID | Missing patients, by registration year | Imports the missing patients' demographics through `importHealthrayPatient` (same path as the live sync) |
| `server/scripts/backfill-healthray-days.mjs` | For each day, asks every active doctor's appointments one at a time | Appointments per day, already in Scribe, new, new and completed (≈ AI note reads) | Runs the normal day sync `runSync(date)`: patients, visits, notes read by AI, diagnoses, medicines, labs, vitals, documents |

Options: `--per-page`, `--pause` (patients); `--from`, `--to`, `--every=7` (sample one day a week), `--day-pause`, `--max-days` (days); `--reset` to start over.

## Order

1. Tonight: `backfill-healthray-days.mjs --every=7` (sample count, gives the AI estimate) → `backfill-healthray-patients.mjs` (count).
2. Review the counts and the estimated AI note reads. Approve or adjust.
3. One-day `--apply` test (`--from=2024-06-03 --to=2024-06-03`). Check the new visits, diagnoses and HbA1c in Scribe.
4. Month by month at night with `--apply`. Then `backfill-healthray-patients.mjs --apply`.
5. Rebuild the outcomes report into a **new** folder (the 11 November press snapshot stays frozen), verify it, and get clinical sign-off.

## Risks

- **HealthRay blocking:** this machine shares its IP with the local worker that reads bills. A block pauses live sync too, so pacing is slow and both scripts stop on the first block.
- **AI cost:** one Claude call per new visit with notes; approved after the count.
- **Database load:** per-visit writes at HealthRay's pace; run only when the database is calm.
- **Patient identity:** imports go through the existing `upsertPatient`, which keys on `health_id` and handles reassigned UHIDs.
