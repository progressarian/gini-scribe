# Gini Scribe — Patient Flow Management: Implementation Plan

**Status:** DRAFT for review (no code written yet)
**Author:** Claude Code
**Date:** 2026-06-15 (rev 3 — re-reviewed against design HTML + spec)

> **Rev 3 changelog (this pass):** Reconciled the spec's internal inconsistency between auto-advance (§4.2) and manual "Call in" (§6.3) by defining an explicit **step state machine** with a new `ready` status, a `/start` (call-in) endpoint, one-active-per-station enforcement, and **wait-step** (`wait_sd`/`wait_chief`) auto-completion semantics — see new §4.1, plus updates to §3.2, the §4 endpoint table, §5 station view, and §10. Added two open items to §11: deferred "give sample & come back" visits and `is_flexible` per-day benchmark adjustment.

> **Rev 2 changelog:** Folded in details found by re-checking the design HTML against the spec — X-Ray + Custom steps (catalog gap), VIP handling (UI + dashboard priority), reception "+ New" file generator, last-visit values in station forms, billing step placement in default journeys, `condition_key` conditional-step logic, lab sequential test dependencies, and the patient journey functional-aging mini-assessment. See §3.2, §3.3, §3.4, §5, and Appendix A.
**Spec source:** `gini-scribe-flow-spec (3).md`
**Design source:** `gini-scribe-flow-design (2).html`
**Target app:** `gini-scribe` (this repo) — Vite/React client + Express/Postgres server

> **IMPLEMENTATION STATUS (2026-06-15):** Sprint 1 + the Sprint 2 backend are **built and verified**.
> - DB: migration `server/migrations/2026-06-15_flow_management.sql` applied (5 visit types, 18 catalog steps, 43 templates, 6 staff). Blocking unknown #1 resolved → main DB is separate from the Genie Supabase, so **reads poll** (realtime deferred). Blocking unknown #2 → `flow_staff` table (option A) created.
> - Backend: `server/routes/flow.js` + `server/services/flow/journey.js` (check-in, advance, start/call-in, duration, reassign, add/remove, queue, dashboard, public track, reports). Mounted in `index.js`; auth rules added. End-to-end smoke test passed (check-in → call-in → wait-step auto-complete → drain to completion).
> - Frontend: `src/pages/flow/{FlowCheckinPage,FlowCoordinatorPage,FlowStationPage}.jsx`, hooks `src/queries/hooks/useFlow.js`, styles `src/styles/flow.css`; RBAC caps + routes + nav wired. `vite build` green.
> - **Sprint 3–4 additions (also built & verified):** MSG91 check-in send (`sendFlowCheckin` in `server/services/msg91.js`, wired into `/api/flow/checkin`, best-effort, dev-fallback until template registered); public patient journey page `src/pages/PatientJourneyPage.jsx` at `/visit/:token` (sanitized, polling); Reports UI `src/pages/flow/FlowReportsPage.jsx` at `/flow/reports`. Smoke-tested: WhatsApp vars + `whatsapp_sent` flag/event, track-endpoint sanitization (no PII leak), 404 on bad token.
> - **§7.4 clinical-view panels (built & verified):** `src/components/flow/FlowPanel.jsx` — a compact journey strip with an "advance / Confirm Exit" action — embedded in `ConsultantPage` (SD/Chief; there is no separate chief page) and `MedicineCollectionPage` (Pharmacy). Renders **nothing** when the patient has no live flow visit, so it's invisible for clinics not using the module. Backed by new `GET /api/flow/active-visit?patient_db_id=&file_no=` (returns the in-progress visit for today, or null). Smoke-tested: lookup by file_no, null for unknown/no-params.
> - **Polish items (built & verified):** Admin settings page `/flow/admin` (edit benchmarks + step durations/active; ADMIN-gated front and back); admin-only station role switcher on the station page; journey-builder **drag-reorder** (native HTML5 drag + up/down buttons); patient-page **file-number gate + functional-aging mini-assessment** (public `verify` + `assessment` endpoints, stored as a `patient_assessment` flow_event). Smoke-tested: admin edits persist + restore, verify is case-insensitive and rejects wrong file numbers, assessment 403s on mismatch.
> - **OPD/appointment integration (built & verified):** check-in pre-fills from the patient's today OPD/GHM appointment (visit type, time, doctor, usual MO) and **links** `flow_visits.appointment_id`; flow progress **mirrors onto the linked appointment's status** (checkedin → in_visit → completed) so the existing OPD/GHM pages reflect it via their status column — forward-only (never downgrades seen/completed/cancelled), best-effort, and safe (appointments has no UPDATE trigger). Patient search bug fixed (was reading the wrong response field). New-patient check-in auto-generates the GNI file number. Phone (+91-fixed, digits-only, validated) and appointment time (time picker) hardened with inline validation.
> - **The whole module is now built.** Remaining is the one **external dependency**: register the MSG91 flow template + set `MSG91_WA_FLOW_TEMPLATE_NAME` (+ WABA env) to switch WhatsApp from dev-console to real send — no code change needed. (Realtime stays polling unless the flow tables are colocated with the Genie Supabase project.)

---

## 0. How to read this document

This plan **adapts** the original spec to the way `gini-scribe` is actually built. The spec was written assuming a greenfield Supabase-RPC + Supabase-Realtime app. This repo is **Express + direct Postgres (`pg` pool)**, with Supabase used **only** for client-side realtime. The three foundational decisions below were confirmed with the product owner before writing this plan.

| # | Decision | Choice | Consequence for this plan |
|---|----------|--------|---------------------------|
| 1 | Backend architecture | **Adapt to existing** | Flow logic = Express routes on the `pg` pool (Section 4). Spec's "Supabase RPCs" become Express endpoints. Realtime = existing Supabase channel pattern, read-only, for the live dashboard (Section 6). |
| 2 | Reuse vs new tables | **New `flow_` module, reuse entities** | New `flow_*` tables (Section 3) are self-contained. We reuse existing `patients` and `doctors` tables for lookups. We do **not** modify `station_tracking`, `active_visits`, `appointments`, or any clinical table. |
| 3 | Role access | **Real RBAC + demo switcher** | Each flow view maps to an RBAC capability (Section 7). A dev/admin-only "Viewing as" switcher is included for testing/shared-device use, gated behind ADMIN. |

> **Everything below reflects these three choices.** Where this plan deviates from the literal spec, the deviation is called out in a `> NOTE` block.

---

## 1. What already exists (gap analysis)

The repo already contains substantial flow-adjacent functionality. The new module must **complement, not duplicate** these. Summary of the audit:

| Existing piece | File(s) | What it does | Relationship to new module |
|----------------|---------|--------------|-----------------------------|
| `station_tracking` table + API | `server/routes/station-tracking.js` | Records per-appointment check-in/out timestamps for vitals/Rx/DM/exam/counsel stations; journey time; wait reasons; follow-up booking. **Post-hoc timing, one row per appointment, no step ordering, no queues.** | **Reference, don't reuse.** The new `flow_visit_steps` model is an ordered, per-step superset. Decision #3 (new-module + migrate later) means we may retire overlapping `station_tracking` fields in a later phase — out of scope for v1. |
| `active_visits` table + API | `server/routes/active-visits.js` | Tracks one open clinical visit per doctor (status + current route + `step_data` JSONB) for session restore. | **Leave as-is.** Clinical session state. Flow module references `appointment_id`/`patient_id` but does not write here. Optional later hook: when a doctor opens a clinical visit, advance the matching flow step. |
| OPD live dashboard + triage | `server/routes/opd.js`, `src/OPD.jsx`, `src/components/opd/{LiveDashboard,TriageView,TriageViewV3,OpdRangeReport}.jsx` | Mature day-management: appointment pipeline (`scheduled→checkedin→in_visit→seen→completed`), biomarker prep steps, tier classification, range reports. | **Sibling module.** The Flow Coordinator dashboard is a new, time-/journey-centric view. It can later cross-link to OPD, but is built fresh. |
| Walk-ins | `server/routes/walkins.js`, `walkin_bookings` table | Booking record + WhatsApp text generation for unscheduled patients. No journey/timing. | **Feeds check-in.** Reception check-in can pre-fill from a `walkin_bookings` row. |
| Appointments | `server/routes/appointments.js`, `appointment-slots.js`, `ghm-appointments.js` | Full booking system; `appointments` has `patient_name/file_no/phone/visit_type/time_slot/doctor_name/status`. | **Source of truth for the visit's appointment.** `flow_visits.appointment_id` links here; check-in can pre-fill from an appointment. |
| Role station pages | `src/pages/{VitalsPage,MOPage,ConsultantPage,ExamPage,AssessPage,LabPortalPage,IntakePage}.jsx` | Clinical data-entry views inside the 6-step visit flow (Intake→Vitals→Exam→Assess→MO→Consultant). **No queue/timing.** | **Embed a flow panel.** SD/Chief/Vitals/Pharmacy clinical views get a small "journey progress + advance step" panel (Section 7.4). New standalone station queue views are built for non-clinical roles (Vitals queue, Lab queue, Dietitian, Rx Explain, Pharmacy). |
| Inbox/queue views | `src/pages/{ReceptionInboxPage,RoleInboxPage,LabInboxPage}.jsx` | Message queues with **Supabase realtime** (`postgres_changes`) + 5s polling fallback. | **Pattern to copy** for the flow realtime subscription (Section 6). |
| RBAC | `shared/permissions.js`, `src/config/routes.js`, `server/middleware/auth.js`, `RequireCapability.jsx` | 10 roles, 13 capabilities, role→capability matrix. **Master switch `GRANT_ALL_CAPABILITIES = true`** (everyone passes today). Path→capability maps on both client and server. | **Extend.** Add flow capabilities + page/route mappings (Section 7.1). |
| Doctors/staff | `doctors` table, `server/routes/doctorSchedule.js`, `DoctorManagementPage.jsx`, `/api/doctors` | `doctors(id,name,short_name,role,specialty,is_active,...)`. Availability model (`doctor_profile`, `doctor_unavailability`, `slot_catalog`). | **Reuse for assignment dropdowns.** SD/Chief/MO pickers read `/api/doctors`. Non-doctor staff (vitals associate, nurse, lab tech, dietitian, pharmacist) are **not** in `doctors` — see Section 3.7 open question. |
| Messaging | `server/services/msg91.js`, `docs/MSG91_*.md` | MSG91 WhatsApp **OTP only** today. Dev mode prints to console. | **Extend for flow.** New template for check-in confirmation + tracking link (Section 8). |
| DB access | `server/config/db.js` (`pg` Pool, `cronPool`), `server/migrations/*.sql` | Direct Postgres. Additive dated SQL migrations run via `_runOne.mjs`. DATE cols returned as strings. | **The model for all flow tables/queries.** |
| Frontend Supabase | `src/lib/genieSupabase.js` | `createClient` w/ anon key, `persistSession:false`, realtime `eventsPerSecond:5`. Null if env unset. | **Realtime transport for the dashboard.** |

**Net conclusion:** ~60% of the *foundations* the spec needs already exist (patients, doctors, appointments, RBAC, MSG91, Supabase realtime client, route/migration patterns). **0% of the ordered-journey/step-timing/queue engine exists.** That engine is what we build.

---

## 2. Time benchmarks (unchanged from spec)

Defaults seeded into `flow_visit_types` (configurable later via admin):

| id | Label | Max (min) | Flexible |
|----|-------|-----------|----------|
| `FU_APPT` | F/U Appt | 45 | no |
| `FU_APPT_TESTS` | F/U Appt + Tests | 90 | no |
| `NEW_APPT` | New Appt | 90 | no |
| `FU_WALK` | Walk-in F/U | 90 | yes |
| `NEW_WALK` | Walk-in New | 120 | yes |

**Timing rules (implemented in Section 4 logic):**
- Clock starts at `flow_checkin` (`checkin_time`).
- Clock stops when Pharmacy confirms exit (`actual_completion`).
- Each step has `planned_duration_min`; coordinator can edit mid-visit.
- Step amber if actual > planned + 5 min; red if > planned + 10 min.
- Visit row amber at ≥ 80% of `max_time_min` elapsed; red (BREACH) at ≥ 100%.
- Suggested wait at check-in = Σ step planned durations.

> NOTE: The spec lists six visit types but only five distinct ones (it repeats `NEW_WALK`). This plan uses the five above. "New + Appt, no tests" maps to `NEW_APPT` (90).

---

## 3. Database schema (Postgres migrations, not Supabase SQL editor)

All tables live in the existing Postgres DB, created via **dated additive migration files** in `server/migrations/` (same convention as every other table), run with `server/migrations/_runOne.mjs`. Prefix everything `flow_`.

> NOTE: Spec wrote `ALTER PUBLICATION supabase_realtime ADD TABLE ...`. That line is **only** valid if the Postgres instance is the Supabase Postgres. Confirm in Section 6 / open questions whether the realtime DB is the same instance. If yes, the publication line is added to the migration. If no, the dashboard uses polling (already the established fallback).

### 3.1 Migration files to create

```
server/migrations/2026-06-XX_flow_visit_types.sql        -- table + seed (Section 2)
server/migrations/2026-06-XX_flow_step_catalog.sql       -- table + seed (spec 3.2)
server/migrations/2026-06-XX_flow_step_templates.sql     -- table + seed default journeys
server/migrations/2026-06-XX_flow_visits.sql             -- table + indexes
server/migrations/2026-06-XX_flow_visit_steps.sql        -- table + indexes
server/migrations/2026-06-XX_flow_events.sql             -- audit table
server/migrations/2026-06-XX_flow_realtime_publication.sql -- ONLY if same Supabase PG
```

### 3.2 Tables (DDL follows the spec sections 3.1–3.6 verbatim, with these adaptations)

- **Types kept as in spec** (`flow_visit_types`, `flow_step_catalog`, `flow_step_templates`, `flow_visits`, `flow_visit_steps`, `flow_events`). The spec DDL in `gini-scribe-flow-spec (3).md` §3.1–3.6 is the source — copy it into the migrations.
- **`flow_visits.patient_id`**: spec types it `TEXT` (file number like `P_14207`). This repo's `patients.id` is `SERIAL` and the file number is `patients.file_no TEXT`. **Store both:** add `patient_db_id INT REFERENCES patients(id)` (nullable, for walk-ins with no record yet) and keep `patient_id TEXT` = `file_no` for display/links. Index `patient_db_id`.
- **`flow_visits.appointment_id INT REFERENCES appointments(id)`** (nullable) — link to the booking when one exists. Not in spec; needed for OPD/appointment cross-linking.
- **`assigned_sd` / `assigned_chief`**: spec types `TEXT` (staff id). Use `INT REFERENCES doctors(id)` since SD/Chief are real `doctors` rows. Keep `assigned_sd_name` denormalized for display.
- **`flow_visit_steps.assigned_staff_id`**: keep `TEXT` (see Section 3.7 — non-doctor staff aren't in `doctors`). Store `assigned_staff_name` always.
- **`flow_visit_steps.step_catalog_id`**: make **nullable** (spec had it `NOT NULL`) so ad-hoc **Custom** steps can be inserted with only a free-text `step_name` (see §3.3).
- **`flow_visit_steps.status` CHECK**: extend the spec's enum `pending/in_progress/completed/skipped` with **`ready`** (queued-at-station, awaiting call-in) — see the state machine in §4.1.
- **`updated_at` triggers**: this repo updates `updated_at` in the route SQL (`updated_at=NOW()`), not via DB triggers (see `station-tracking.js`). Follow that convention — no triggers.
- **DATE/TIMESTAMP**: `db.js` returns DATE as strings; compute elapsed/remaining on the server in the query (`EXTRACT(EPOCH FROM ...)`), not by parsing dates in JS.

### 3.3 Seed: `flow_step_catalog`

Use the spec's 17-row seed (§3.2): `vitals, mo_assessment, blood_sample, abi, vpt, fundus, ecg, echo, tmt, wait_sd, sd_consult, wait_chief, chief_consult, dietitian, rx_explain, billing, pharmacy`.

> NOTE — **catalog gap vs design HTML.** The prototype's journey-builder "+ Add step" and the MO add-step panel both offer **X-Ray** and **Custom**, which the spec §3.2 seed omits. Resolution:
> - Add `xray` ('X-Ray', ~10 min, station 'Lab', role 'lab_tech') to the seed → makes the catalog 18 rows.
> - Support a **custom/ad-hoc step**: the add-step picker has a "Custom…" option that inserts a `flow_visit_steps` row with a free-text `step_name`, a chosen `assigned_role`, and a duration, **without** a `step_catalog_id` (make `flow_visit_steps.step_catalog_id` nullable to allow this). Custom steps don't appear in bottleneck-by-catalog reports but still count toward visit timing.

### 3.4 Seed: `flow_step_templates` (default journeys)

Per visit type, the default + optional steps. Proposed defaults (toggleable at check-in):

| Visit type | Default steps (in order) |
|------------|--------------------------|
| `FU_APPT` | vitals → mo_assessment → wait_sd → sd_consult → rx_explain → pharmacy |
| `FU_APPT_TESTS` | vitals → mo_assessment → blood_sample → (optional tests) → wait_sd → sd_consult → rx_explain → pharmacy |
| `NEW_APPT` | vitals → mo_assessment → blood_sample → (optional tests) → wait_sd → sd_consult → wait_chief → chief_consult → rx_explain → pharmacy |
| `FU_WALK` | vitals → mo_assessment → wait_sd → sd_consult → rx_explain → pharmacy |
| `NEW_WALK` | vitals → mo_assessment → blood_sample → wait_sd → sd_consult → wait_chief → chief_consult → dietitian → rx_explain → pharmacy |

Optional steps (`is_optional=true`, off by default, toggle at check-in or add via MO): `abi, vpt, fundus, ecg, echo, tmt, xray, dietitian, wait_chief, chief_consult`.

> NOTE — **billing placement.** In the design HTML, real journeys put **billing** immediately before pharmacy (e.g. Kulwinder: Vitals→SD→Chief→Billing→Pharmacy; Mahajan: Vitals→SD→Billing→Pharmacy). Treat `billing` as a **default** step (not optional) inserted just before `pharmacy` in all appointment journeys; keep it toggleable for clinics that bill at pharmacy. Also note the HTML shows some F/U journeys **without** `mo_assessment` (straight Vitals→SD) — confirm with clinical whether MO is default for follow-ups or only for new/walk-in patients.
>
> These default journeys are a **starting point for review** — the clinical team should confirm them before seeding.

> NOTE — **`condition_key` semantics.** `flow_step_templates.condition_key` drives which optional steps auto-include at check-in based on the visit's flags:
> - `needs_tests` → include `blood_sample` (+ MO-chosen tests) when `has_tests_available = false` (fresh samples needed).
> - `needs_chief` → include `wait_chief` + `chief_consult` for New/Red-Amber patients or when Chief is assigned.
> - `needs_diet` → include `dietitian` when flagged at check-in or added by MO.
> At check-in, the journey builder pre-checks template steps whose `condition_key` matches the selected patient type/flags; the receptionist can still toggle any of them. Steps with no `condition_key` and `is_default=true` are always included.

### 3.5 Realtime publication

If (and only if) the realtime DB == the app Postgres (Supabase): add `flow_visits` and `flow_visit_steps` to `supabase_realtime` publication. Otherwise omit; dashboard polls (Section 6).

### 3.6 Indexes

As per spec §3.4–3.6 plus `idx_flow_visits_appointment`, `idx_flow_visits_patient_db_id`.

### 3.7 OPEN QUESTION — non-doctor staff identity

The "assign staff" dropdowns in the journey builder (Anita/Deepak for vitals, Nurse Preeti, Pharmacy Counter, Lab Team) reference people **not** in the `doctors` table. Options:
- **(A)** Add a lightweight `flow_staff(id, name, role, is_active)` table seeded with station staff. *Recommended — smallest, keeps doctors clean.*
- **(B)** Reuse `doctors` for everyone (add nurse/lab/pharmacy rows). Pollutes the clinical doctors list.
- **(C)** Free-text assignment (`assigned_staff_name` only, no id). Simplest, no referential integrity, weakest for "my queue" filtering by exact staff.

**This plan assumes (A).** Add `2026-06-XX_flow_staff.sql`. Queue filtering then works by `assigned_role` (always) and optionally `assigned_staff_id`.

---

## 4. Backend — Express routes (replaces spec's "Supabase RPC")

New router file `server/routes/flow.js`, mounted in `server/index.js` (same pattern as `station-tracking.js`), guarded by the new `FLOW_*` capabilities in `server/middleware/auth.js` (Section 7.1). All handlers use the `pg` pool and `handleError` like existing routes. Each mutating endpoint writes a `flow_events` row in the **same transaction**.

| Spec RPC | New endpoint | Method | Logic (per spec §4) |
|----------|--------------|--------|----------------------|
| `flow_checkin_patient` | `/api/flow/checkin` | POST | Tx: insert `flow_visits`; insert all `flow_visit_steps` from posted journey; compute `suggested_wait_min` + `estimated_completion`; generate `visit_token` (crypto random, unique); set first step `in_progress`+`started_at`; insert `checkin` event; return `{visit_id, visit_token}`. Optionally fire MSG91 (Section 8). |
| `flow_advance_step` | `/api/flow/visits/:id/advance` | POST | Tx: complete current step (status, `completed_at`, `actual_duration_min`, merge `data`); find next step; set it `ready` (auto-start to `in_progress` only if that station/staff has no other `in_progress` patient — see §4.1); or if none, set visit `completed`+`actual_completion`; insert event. |
| — (start/call-in) | `/api/flow/steps/:stepId/start` | POST | Station staff "Call in" — set a `ready`/`pending` step to `in_progress` + `started_at`; rejected if the same `assigned_role`/`assigned_staff_id` already has an `in_progress` step (one active per station). Also completes a preceding `wait_*` step. Event `step_started`. |
| `flow_update_step_duration` | `/api/flow/steps/:stepId/duration` | PATCH | Update `planned_duration_min`; recompute visit `suggested_wait_min`+`estimated_completion`; event `duration_edited`. |
| `flow_reassign_step` | `/api/flow/steps/:stepId/reassign` | PATCH | Update `assigned_staff_id`/`name` (and/or `assigned_role`); event `reassigned`. |
| `flow_add_step` | `/api/flow/visits/:id/steps` | POST | Insert step after `insert_after_order`; reorder following steps; recompute totals; event `step_added`. |
| `flow_remove_step` | `/api/flow/steps/:stepId` | DELETE | Soft `skipped` or hard delete; reorder; recompute; event `step_removed`/`step_skipped`. |
| — (read) | `/api/flow/visits?date=&status=` | GET | Coordinator dashboard feed: visits + steps + server-computed `elapsed_min`, `remaining_min`, `pct_elapsed`, urgency class. Sort: breach first, then **VIP** ahead of same-urgency non-VIP, then `remaining_min / max_time_min` ascending (spec §6.2). |
| — (read) | `/api/flow/visits/:id` | GET | Single visit + full ordered steps (detail modal). |
| — (read) | `/api/flow/queue/:role` | GET | Station view: steps where `assigned_role=:role` and status in (`in_progress`,`ready`,`pending`) for today, with patient + overall remaining time. Active patient = `in_progress`; `ready` = callable queue; `pending` = waiting on a prior step. |
| — (read) | `/api/flow/visit-types`, `/api/flow/step-catalog`, `/api/flow/templates/:visitType` | GET | Reference data for the journey builder. |
| — (read) | `/api/flow/reports?start=&end=` | GET | Benchmark compliance + bottleneck queries (spec §6.4 SQL). |
| — (patient) | `/api/flow/track/:token` | GET | **Public/anon** read for the patient journey page (no auth) — returns sanitized live status by `visit_token` only. Rate-limited. |

**Server-side helpers** (`server/services/flow/`):
- `journey.js` — compute totals, estimated completion, urgency/colour classification (single source for amber/red thresholds), step state-machine transitions (§4.1).
- `checkin.js` — token generation, template→steps expansion.
- `whatsapp.js` — build + send check-in message via `msg91.js`.

### 4.1 Step state machine, call-in & wait steps

The spec is internally inconsistent: §4.2 says advance **auto-starts** the next step, while §6.3 shows a manual **"Call in"** button and "current patient must be completed first." This plan reconciles both with one explicit state machine. `flow_visit_steps.status` is extended to:

`pending` → `ready` → `in_progress` → `completed` (or `skipped`)

- **`pending`** — not yet reachable (a prior step is still open).
- **`ready`** — the patient has reached this step and is queued at the station, but no one has started them. Set when the prior step completes.
- **Auto-start rule:** on advance, if the next step's `assigned_role` (and `assigned_staff_id`, if set) currently has **no** `in_progress` step, it auto-promotes `ready`→`in_progress` (matches §4.2 for an idle station). If the station is busy, it stays `ready` and the patient sits in `MyQueue` until staff press **Call in** (matches §6.3). This is the single rule that makes both spec statements true.
- **One active per station:** `/start` rejects a second `in_progress` step for the same role/staff. The station UI's "Call in" is disabled until the current patient is completed.

**Wait steps (`wait_sd`, `wait_chief`).** These model "patient is queued for a doctor." They are assigned to `flow_coordinator` and behave specially: a `wait_*` step is considered the active/queue marker (it's what shows "Wait SD ⚠ 32m" red on the dashboard). When the doctor presses **Call in** on the following `sd_consult`/`chief_consult` step, the preceding `wait_*` step is auto-`completed` in the same transaction (its `actual_duration_min` = real time spent waiting — this is what feeds the "Wait for SD" bottleneck report in §6.4). Wait steps never need their own staff action.

> The `ready` status is an addition to the spec's enum (`pending/in_progress/completed/skipped`). Update the `CHECK` constraint in the `flow_visit_steps` migration (§3.2) accordingly.

---

## 5. Frontend — pages & components

New page folder `src/pages/flow/` + components `src/components/flow/`. State via a Zustand store `src/stores/flowStore.js` (matches existing store pattern). Data fetching via React Query hooks under `src/queries/hooks/` (matches `useOpdAppointments.js`).

| View | Route | Page component | Key child components |
|------|-------|----------------|---------------------|
| Reception check-in + journey builder | `/flow/checkin` | `FlowCheckinPage.jsx` | `PatientTypeSelector` (4 types), `TestAvailabilityToggle`, **`VipToggle`** (sets `is_vip`), `PatientStatusSelector` (Improving/Same/Worse — shown for follow-ups), `PatientInfoForm` (file lookup reusing existing patient search **+ "+ New" generator** to create a `patients` row inline when no file exists), `DoctorAssignment` (SD + Chief dropdowns read `/api/doctors`; Chief supports "Auto-assign based on triage"), `JourneyBuilder` (drag-reorder, editable durations, staff dropdowns, add-step picker incl. X-Ray/Custom, live total + buffer), `WhatsAppPreview`, today's check-ins table |
| Flow Coordinator dashboard | `/flow/coordinator` | `FlowCoordinatorPage.jsx` | `StatsRow` (Active / Completed / Breached / At-risk / Avg-wait / With-doctors), `BreachAlerts` (per-patient bottleneck + suggested action + action buttons — see note), `PatientFlowTable`/`PatientFlowRow` (journey pills, time bar, bottleneck msg, ⭐ VIP badge), `StationOccupancy` (per-station live count + idle/active/waiting state), `DoctorLoad` (per-doctor queue bars + "IDLE ← reassign here" hint), `PatientDetailModal` (edit duration / reassign / add-remove / skip / notes) |
| Station queues (generic) | `/flow/station/:role` | `FlowStationPage.jsx` | `StationHeader` (queue/done counts), `ActivePatient` (the one `in_progress` patient + role-specific form + "Done — advance" button), `MyQueue` (`ready` patients with a **"Call in"** button — disabled while a patient is active; `pending` shown as "queued after <prior step>"). Renders per `:role` (vitals, mo, lab, dietitian, rx_explain, pharmacy) |
| Reports | `/flow/reports` | `FlowReportsPage.jsx` | `DateRangeSelector`, `SummaryStats`, `BenchmarkComplianceByType`, `BottleneckAnalysis` (uses `recharts`, already a dep), `DailyBreakdown`, `Recommendations` |
| Patient journey (public) | `/visit/:token` | `PatientJourneyPage.jsx` (outside `AppLayout`, like `/companion`) | Live status timeline (current step, time remaining) — no login. After file-number entry (gate): unlocks pre-consultation questions + **functional-aging mini-assessment** (spec §8, later phase) |

**Role-specific `step.data` forms** (spec §6.3 table) — implemented in `src/components/flow/forms/`:
`VitalsForm, MoForm (+ add/remove steps), LabForm, DietitianForm, RxExplainForm, PharmacyForm (+ Confirm Exit)`. SD & Chief reuse existing clinical views with an added flow panel (Section 7.4).

Form/queue details captured from the design HTML:
- **Last-visit context:** station forms show the patient's previous values for comparison (the HTML vitals form shows "Last visit: Weight 63.2 kg · BP 128/82 · Pulse 74 · SpO2 98%"). Reuse existing data — read the latest `vitals` row (and labs for relevant steps) by `patient_db_id`; no new storage needed.
- **Step-of-N + at-station timer:** every station header shows "Step X of N", the at-station elapsed vs the step budget, and an on-track/over colour (drives the amber/red rule from §2).
- **Lab sequential dependencies:** the Lab queue shows multiple test steps per patient with budget / waiting / patient-time-left columns, and renders dependent steps as "Queued after <prev step>" (non-actionable until the prior lab step completes). This is just ordered `flow_visit_steps` with the same `assigned_role='lab_tech'` — the queue UI greys out steps whose predecessor in the same visit isn't `completed`.
- **VIP surfacing:** VIP patients show a ⭐ badge in queues and the coordinator table, and sort ahead of same-urgency non-VIP patients (see dashboard sort below).

> NOTE — **breach-alert suggested actions.** The HTML breach banner shows context-specific actions ("Reassign Harjinder → Dr. Simranpreet", "Ping Lab for Amrit Lal", "Send chai offer to both"). For v1: implement **Reassign** (calls the reassign endpoint) and **Ping Lab/role** (posts a `patient_messages` row to the role inbox — reuses existing messaging). The "suggested" target (which idle doctor to move to) is derived from the `DoctorLoad` computation. Comfort actions like "send chai offer" are **stretch/optional** and can be a no-op placeholder in v1.

**Design tokens:** the prototype's CSS variables (spec §10) — reconcile with `src/styles/global.css`. Reuse existing tokens where present; add only the missing `--tl/--nv/--sk/--lv` etc. Fonts (Outfit/DM Mono/Instrument Serif) — confirm whether already loaded; if not, add to `index.html`.

---

## 6. Realtime

Reuse the **exact** pattern in `src/pages/RoleInboxPage.jsx` / `MessagesPage.jsx`:
- Subscribe via `genieSupabase.channel('flow-dashboard').on('postgres_changes', {table:'flow_visits'|'flow_visit_steps', filter:`visit_date=eq.${today}`}, handler).subscribe()`.
- **Fallback:** if `genieSupabase` is null OR the same-instance assumption fails, poll the GET endpoints every 15–30s (dashboard) / 10s (station queue). The inbox pages already prove this dual pattern.
- Patient journey page subscribes filtered by `visit_id` (looked up from token) — only if anon RLS allows; otherwise polls.

> NOTE: Realtime requires the `flow_*` tables to live in the **Supabase** Postgres that `genieSupabase` points at. If the app's primary `DATABASE_URL` is a *different* Postgres than the Genie Supabase project, realtime won't see these tables and we ship polling-only for v1. **This must be verified early (Section 11, blocking).**

---

## 7. RBAC, navigation & integration

### 7.1 New capabilities (in `shared/permissions.js`)

Add to `CAPABILITIES`: `FLOW_RECEPTION`, `FLOW_COORDINATOR`, `FLOW_STATION` (covers vitals/mo/lab/dietitian/rx), `FLOW_PHARMACY`, `FLOW_REPORTS`. Map into `ROLE_CAPABILITIES`:
- `reception` → `FLOW_RECEPTION`
- `coordinator` + `admin` → `FLOW_COORDINATOR`, `FLOW_REPORTS`
- `nurse` → `FLOW_STATION` (vitals/rx)
- `mo`/`consultant` → `FLOW_STATION`
- `lab`/`tech` → `FLOW_STATION` (lab)
- `pharmacy` → `FLOW_PHARMACY`

> NOTE: `GRANT_ALL_CAPABILITIES` is currently `true`, so during development every role already passes — no blocker. Real enforcement only matters once the master switch is flipped.

### 7.2 Route/page maps
- Client: add `/flow/*` and `/visit/:token` to `src/config/routes.js` `PAGE_CAPABILITIES` (the public `/visit/:token` requires none).
- Server: add `/api/flow` prefixes to `server/middleware/auth.js` `ROUTE_CAPABILITIES`; **exempt** `/api/flow/track/:token` from auth (public).
- Router: register pages in `src/router.jsx`; `/visit/:token` outside `AppLayout` (sibling of `/companion`).

### 7.3 Navigation
Add nav items to `src/components/AppLayout.jsx` `NAV_ITEMS`: "Reception (Flow)", "Flow Coordinator", "Reports (Flow)" gated by the new caps and `show` predicates. Station views are reached by role/device, not the main nav.

### 7.4 Clinical view integration (SD / Chief / Pharmacy)
- In `ConsultantPage.jsx` (SD) and the Bhansali/Chief view: add a `<FlowPanel visitId>` showing journey progress + a "Done — advance flow step" action that calls `/api/flow/visits/:id/advance`. When SD clicks "Ready for Dr. Bhansali" / Chief signs Rx, also advance.
- Pharmacy "Confirm Exit" (in `MedicineCollectionPage.jsx` or the flow Pharmacy view) calls advance on the final step → sets `actual_completion` (stops the clock). **This is the single authoritative clock-stop.**

### 7.5 Demo "Viewing as" switcher
Admin-only component (`FlowRoleSwitcher`) that sets a client-side "acting role" for shared station devices/testing. Does **not** bypass server auth — only switches which flow view is rendered. Hidden unless `ADMIN`.

---

## 8. WhatsApp (MSG91, not WATI)

Extend `server/services/msg91.js` with `sendFlowCheckin(phone, vars)` using a **new approved WhatsApp template** (the spec's WATI template is re-registered in MSG91). Variables: `patient_name, file_number, doctor_name, estimate_min, est_completion_time, visit_link`. Dev mode prints to console (existing behaviour). Triggered by `/api/flow/checkin` when "Check In + Send WhatsApp" is used. Tracking link: `https://<host>/visit/:token`.

> Blocked on: client registering the new template + confirming MSG91 WABA number (same handoff as `docs/MSG91_CLIENT_HANDOFF.md`).

---

## 9. Build order (sprints)

Adjusted from spec §9 for this architecture. Each sprint ends shippable behind the (currently permissive) RBAC.

**Sprint 1 — Foundation & vertical slice**
- Migrations: all `flow_*` tables + seeds + `flow_staff` (3.7-A). Verify realtime-DB question (11).
- `server/routes/flow.js`: `checkin`, `advance`, visit/queue reads + `journey.js` helper.
- Reception check-in + JourneyBuilder (`/flow/checkin`).
- Coordinator dashboard read-only (`/flow/coordinator`) with polling.
- Vitals station view (`/flow/station/vitals`) — proves the full check-in→advance loop.

**Sprint 2 — Role views**
- MO view (add/remove journey steps), Lab view (multi-test steps), Dietitian, Rx Explain, Pharmacy (Confirm Exit / clock stop).
- SD + Chief flow panels wired into existing clinical pages.
- `add_step`/`remove_step`/`reassign`/`duration` endpoints + Coordinator detail modal.

**Sprint 3 — Realtime & comms**
- Supabase realtime subscriptions for dashboard + station queues (fallback polling already in place).
- MSG91 check-in template + send.
- Patient journey page (`/visit/:token`) — status only.
- Coordinator: breach alerts, station occupancy, doctor-load panels.

**Sprint 4 — Reports & polish**
- Reports view (compliance, bottlenecks, daily breakdown, recommendations).
- Admin settings: editable benchmarks (`flow_visit_types`) + step catalog.
- Patient journey page: file-gate + pre-consultation questions (optional/stretch).
- Demo role switcher; design-token reconciliation.

---

## 10. Testing checklist (from spec §11, adapted)

- [ ] Check in a walk-in with 8 steps → journey created, first step `in_progress`, `flow_events` has `checkin`.
- [ ] Advance through all steps → patient appears in each role queue at the right time; `actual_duration_min` recorded.
- [ ] Edit a step duration mid-visit → `estimated_completion` + `suggested_wait_min` recalc; `duration_edited` event.
- [ ] Force a breach → row turns red on dashboard; breach alert shows bottleneck + action.
- [ ] Reassign SD → patient moves queues; `reassigned` event.
- [ ] Two patients reach Vitals while one is active → second sits `ready`, "Call in" disabled until the first is completed (one-active-per-station).
- [ ] SD presses "Call in" → preceding `wait_sd` step auto-`completed` with `actual_duration_min` = real wait; `sd_consult` goes `in_progress`.
- [ ] MO adds a VPT step mid-visit → inserts in order, totals recalc.
- [ ] Pharmacy Confirm Exit → visit `completed`, `actual_completion` set, total time correct.
- [ ] Reports show correct compliance % for completed visits in range.
- [ ] Two tabs (coordinator + vitals) → realtime (or ≤30s poll) sync on step complete.
- [ ] `/visit/:token` shows correct live status with no login; invalid token → safe 404.
- [ ] RBAC: with master switch OFF, each role sees only its flow view; `/api/flow/track/:token` works unauthenticated.

---

## 11. Risks & blocking unknowns (resolve before Sprint 1 coding)

1. **[BLOCKING] Same-Postgres question.** Is the app's `DATABASE_URL` Postgres the same instance as the Genie Supabase project (`VITE_GENIE_SUPABASE_URL`)? Determines whether realtime works or we ship polling-only. *Action: confirm with infra / check envs.*
2. **[BLOCKING] Non-doctor staff identity** (Section 3.7). Confirm option A (`flow_staff` table). *Action: product decision.*
3. **Default journeys** (Section 3.4) need clinical sign-off before seeding `flow_step_templates`.
4. **MSG91 flow template** registration + WABA number (Section 8) — external dependency, start early.
5. **`station_tracking` overlap** — v1 runs the new module **in parallel**; reconciliation/retirement of overlapping fields is a deliberate later phase (Decision #3), not v1.
6. **Patient PII on public `/visit/:token`** — return only first name + step status; never phone/file/clinical data without the file-number gate. RLS or server-side allowlist enforced.
7. **Design tokens / fonts** may partially collide with `global.css` — reconcile, don't blanket-import the prototype CSS.
8. **OPEN — "give sample & come back" deferred visits.** Spec §2 benchmark table says no-tests patients may "give sample + come back later." This implies a visit can be **paused** (patient leaves, clock pauses/parks) and **resumed**. Not modelled in v1 (no pause/resume state). *Action: product decision — is this in scope? If yes, add a `paused` visit status + `paused_at`/resumed-at handling and decide whether the clock keeps running. Recommend deferring to a later phase.*
9. **`is_flexible` per-day benchmark adjustment.** Spec §2 marks walk-in types flexible "based on the day." `flow_visit_types.is_flexible` is seeded but v1 has no UI to vary `max_time_min` per day. *Action: admin settings (Sprint 4) can expose editing benchmark values; true per-date overrides are a later enhancement.*

---

## 12. File manifest (what gets created/touched)

**New (server):** `routes/flow.js`; `services/flow/{journey,checkin,whatsapp}.js`; `migrations/2026-06-XX_flow_*.sql` (×7–8).
**Touched (server):** `index.js` (mount router), `middleware/auth.js` (route caps + public token exemption), `services/msg91.js` (flow template).
**New (client):** `pages/flow/{FlowCheckinPage,FlowCoordinatorPage,FlowStationPage,FlowReportsPage}.jsx`, `pages/PatientJourneyPage.jsx`; `components/flow/**`; `stores/flowStore.js`; `queries/hooks/useFlow*.js`.
**Touched (client):** `router.jsx`, `config/routes.js`, `components/AppLayout.jsx`, `ConsultantPage.jsx` + Chief/Pharmacy views (flow panels), `shared/permissions.js`, `index.html` (fonts, if needed), `styles/global.css` (tokens).

---

### Appendix A — Deviations from the original spec at a glance
1. Supabase RPCs → **Express routes** on the `pg` pool.
2. Supabase-SQL-editor tables → **dated migration files**.
3. `patient_id TEXT` → **`patient_db_id INT` (FK) + `patient_id TEXT` (file_no)**.
4. `assigned_sd/chief TEXT` → **`INT REFERENCES doctors(id)`** + denormalized name.
5. Non-doctor staff → **new `flow_staff` table** (option A).
6. WATI → **MSG91** (existing provider).
7. Free realtime everywhere → **realtime if same Supabase PG, else polling** (with proven fallback).
8. Global role switcher → **real RBAC** + admin-only demo switcher.
9. `flow_visits.appointment_id` link added for OPD/appointment cross-referencing.
10. Catalog gap reconciled: **`xray` added** to `flow_step_catalog`; **`step_catalog_id` made nullable** to support ad-hoc **Custom** steps (both present in the design HTML, absent from spec §3.2).
11. **`billing`** treated as a default pre-pharmacy step (design HTML shows it in real journeys; spec left it ambiguous).
12. **`condition_key`** semantics defined (`needs_tests` / `needs_chief` / `needs_diet`) — spec declared the column but not its behaviour.
13. **VIP** (`is_vip`) surfaced end-to-end: check-in toggle, queue/table ⭐ badge, and dashboard priority sort (spec had the column only).
14. Reception **"+ New" file generator** creates a `patients` row inline (spec §6.1 mentioned it; this plan ties it to the real `patients` table).
15. Station forms show **last-visit values** from existing `vitals`/labs (design HTML detail; no new storage).
16. **Step state machine** adds a `ready` status + `/start` (call-in) endpoint + one-active-per-station rule, reconciling spec §4.2 (auto-advance) with §6.3 (manual call-in).
17. **Wait steps** (`wait_sd`/`wait_chief`) auto-complete when the doctor calls the patient in; their `actual_duration_min` feeds the wait-time bottleneck report.
