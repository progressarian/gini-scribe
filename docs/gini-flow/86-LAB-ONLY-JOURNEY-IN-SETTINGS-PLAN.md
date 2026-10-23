# 86 — Lab only journey managed in Settings → Flow

Status: **approved 2026-10-23**, decisions in §5

## 1. Today

- "Lab only" is not a visit type. Reception's check-in shows a **Lab only** button, and both reception (`ReceptionStationPage.jsx`) and the server (`giniflow/journey.js` `labOnlyPlan`) build the journey in code with `labOnlyJourney()` (`shared/labOnly.js`):
  1. take the journey of the tests visit type,
  2. drop every consultation step (vitals → pharmacy) and the normal Billing,
  3. put **Lab Billing → Check-in → Lab Collection → Lab Processing → Report Upload** in front (Lab Billing left out when the visit already has one), with the fixed display names in `LAB_ONLY_STEP_NAMES`.
- Settings → Flow lists only saved visit types, so Lab only never appears there. Only the step minutes can be changed today (Step catalog).

## 2. Goal

Admins see and edit the Lab only journey in **Settings → Flow → Journey**, like any other visit type: reorder steps, change minutes, add or remove steps (e.g. ECG, X-ray, Report Upload), set the benchmark. Reception and the floor follow what is saved, immediately, with no code change.

## 3. Design

### Data
- Migration `2026-11-02_flow_lab_only_type.sql` (dated to sort after the `2026-11-01` catalog seed it relies on) (rerunnable):
  - `flow_visit_types.for_lab_only BOOLEAN NOT NULL DEFAULT FALSE`.
  - Insert type `LAB_ONLY`, label "Lab only", benchmark 77 min, `for_lab_only = TRUE`, all other flags FALSE (so it is never suggested for an ordinary booking).
  - Seed its journey with today's five steps (lab_billing, check_in, blood_sample, lab_processing_2, report_upload) — only if it has no journey yet, so a rerun never overwrites an admin's edits.

### Who uses it
- `labOnlyJourney()` gains a `template` input. When the Lab only type has a saved journey, that journey **is** the plan (Lab Billing still skipped when the visit already has one). When it has none, or before the migration runs, the current code path is used unchanged — nothing breaks on a database that hasn't been migrated.
- Reception: the Lab only button loads the `LAB_ONLY` journey instead of transforming the tests journey. The `LAB_ONLY` type is hidden from the normal type buttons (the separate Lab only button stays, so there's no duplicate).
- Server: `labOnlyPlan` (samples-only bookings under Dr. Hospital Admin and the floor sync) reads the same saved journey.
- Settings: no new screen. Lab only shows up as one more type tab in the existing journey editor.

### Safety rules (server-enforced on save)
- The Lab only journey cannot contain consultation steps (vitals, MO/Chief, consultant, prescription, pharmacy) or the normal Billing step — the same rule `labOnlyKeepsStep` applies today. Saving one is refused with a plain message naming the step, so a lab-only patient can never be routed to a doctor by mistake.
- It must keep at least one lab step (Lab Collection or a machine test), otherwise "nothing will reach the lab".
- Deleting the type is already refused while it has a journey. Switching it off (or saving it empty) falls back to the built-in journey, so it doubles as an off switch.

### Display names
- Today the floor shows "Lab Collection" for the catalog step "Blood Sample". Option A: keep the fixed renames (`LAB_ONLY_STEP_NAMES`) for the lab-only journey only. Option B: show catalog names everywhere and rename "Blood Sample" in the Step catalog if wanted. → **decision needed (§5)**.

## 4. Tests (local e2e DB)
- Settings → Flow shows a **Lab only** tab with the five seeded steps and 77 min.
- Admin reorders / changes minutes / adds ECG and saves → reception's Lab only check-in offers exactly that journey; a samples-only booking synced to the floor gets it too.
- Saving a consultation step into Lab only is refused with the message; the saved journey is unchanged.
- No `LAB_ONLY` type / empty journey → today's built-in journey (regression).
- Normal visit types and their suggestions are unaffected (`for_*` flags), existing Gini Flow suites pass.

## 5. Decisions (2026-10-23)
1. Display names: **keep** "Lab Billing / Check-in / Lab Collection / Lab Processing / Report Upload" for the Lab only journey; other journeys keep catalog names.
2. Allowed steps: **anything except consultation** (vitals, MO/Chief, consultant, prescription, pharmacy) and normal Billing.
3. Reception's Lab only button on a consultation booking ("only tests today"): **keep today's behaviour** — that visit type's tests journey with consultation removed. The saved Lab only journey is for samples-only arrivals (booked under Dr. Hospital Admin) at reception and in the floor sync.

## 6. Rollout
- One migration (you run it, or ask me to). Code reads the new flag tolerantly, so local dev on production keeps working before it runs.
- No change to bills, lab orders or the samples-only (Dr. Hospital Admin) rules; only where the step list comes from.

## 7. Built (2026-10-23)
- `shared/labOnly.js`: `labOnlyJourney(..., { saved })` keeps the saved order and steps, drops consultation steps and Lab Billing when a bill exists, applies the lab names (`labOnlyName`).
- Server `giniflow/journey.js`: `savedLabOnlyType()`; `ensurePlan` seeds samples-only visits from it; `labOnlyPlan` uses saved mode when it exists. Both visit-type suggestion queries (`suggestVisitType`, reception arrivals) skip `for_lab_only` types.
- `PUT /api/flow/templates/:visitType` refuses consultation/Billing steps for a lab-only type with a message naming the step.
- Reception: samples-only arrivals load the `LAB_ONLY` journey (falls back while it is missing/empty); the type is hidden from the normal type buttons. The Lab only button on a consultation booking is unchanged (§5.3).
- Settings → Flow: Lab only is a tab in the journey editor, lab names shown, consultation steps not offered in "+ Add step".
- Visits keep their own visit type id (the tests type); only the step list comes from Lab only.
