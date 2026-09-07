# 29 — Reception check-in with a per-patient journey

Planned 2026-09-07. Not yet built.

## Why

Reception's "✓ Arrived" on `/giniflow/station/reception` is one click that moves
the visit to `checked_in`. Nothing is recorded about what the patient is here
for, so nothing downstream knows whether this is a 45-minute follow-up or a
two-hour new case with an ECG and an X-Ray. The board shows the same fixed
columns for everyone, the patient is told nothing, and the floor cannot see a
stop that has no column — an ABI, a dietitian visit — until someone mentions it.

`/flow/checkin` (the older module) already solves this: pick a visit type, get
that type's default journey, edit it freely, check in with an ETA and a WhatsApp.
All of it is data — `flow_visit_types`, `flow_step_catalog`,
`flow_step_templates`, `flow_staff` — and all of it is admin-editable. What is
missing is that Gini Flow's reception does not use any of it.

**Goal:** reception must choose the visit type and confirm the journey _before_
the arrival completes, and that journey is then visible to the floor and to the
patient — with nothing fixed in code.

## Decisions

| Decision                | Choice                                                              | Consequence                                                                                                              |
| ----------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Where the journey lives | A **new Gini Flow table**, sharing the existing reference data      | One catalog, one set of templates, one staff list to edit — but the tracker and the per-step screens are Gini Flow's own |
| How much it controls    | It **plans and shows**; board columns and station buttons unchanged | Small blast radius on a live floor; journey-driven routing can be switched on later                                      |
| WhatsApp                | Sent at check-in, reusing the existing sender                       | Patient gets their ETA and tracker link, as `/flow/checkin` already does                                                 |

## Reused, not rebuilt

| Need                                        | Already exists                                                                                                                                                                                                                                                |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Visit types, step catalog, templates, staff | `flow_visit_types`, `flow_step_catalog`, `flow_step_templates`, `flow_staff`, with admin CRUD at `server/routes/flow.js:604-880`                                                                                                                              |
| Reference API + hooks                       | `/api/flow/visit-types`, `/step-catalog`, `/templates/:visitType`, `/staff`; `useFlowVisitTypes`, `useFlowStepCatalog`, `useFlowTemplate`, `useFlowStaff` (`src/queries/hooks/useFlow.js`). Reception already holds `FLOW_RECEPTION`, so these work unchanged |
| Tracker token                               | `genVisitToken()` — `server/services/flow/journey.js`                                                                                                                                                                                                         |
| WhatsApp message                            | `sendFlowCheckin()` — `server/services/msg91.js:89`                                                                                                                                                                                                           |
| New-vs-follow-up                            | the `visit_number` lateral in `server/services/giniflow/board.js:105`                                                                                                                                                                                         |
| Status write + event log                    | `advanceStatus()` — `server/services/giniflow/statusEngine.js`                                                                                                                                                                                                |
| Blocked-patient guard                       | `blockDetail()` — `server/services/patientBlockView.js`                                                                                                                                                                                                       |

## Data model

### New: `giniflow_visit_steps`

```sql
CREATE TABLE giniflow_visit_steps (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  visit_id             UUID NOT NULL REFERENCES giniflow_visits(id) ON DELETE CASCADE,
  step_order           INT  NOT NULL,
  step_catalog_id      TEXT REFERENCES flow_step_catalog(id),   -- NULL for a custom step
  step_name            TEXT NOT NULL,
  planned_duration_min INT  NOT NULL DEFAULT 0,
  station              TEXT,
  assigned_role        TEXT,
  assigned_staff_id    TEXT,          -- doctors.id or flow_staff.id, as flow does
  assigned_staff_name  TEXT,
  chain_status         TEXT,          -- snapshot of the catalog mapping; NULL = off-chain stop
  status               TEXT NOT NULL DEFAULT 'pending',  -- pending | in_progress | done | skipped
  started_at           TIMESTAMPTZ,
  completed_at         TIMESTAMPTZ,
  source               TEXT NOT NULL DEFAULT 'template',  -- template | added | custom | auto
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT giniflow_visit_steps_order UNIQUE (visit_id, step_order) DEFERRABLE INITIALLY IMMEDIATE
);
```

`DEFERRABLE` for the same reason `flow_visit_steps` needed it
(`2026-06-15_flow_step_order_deferrable.sql`): reordering renumbers rows and
would otherwise trip the unique key mid-update.

`chain_status` is a **snapshot** taken at check-in, not a live join. If an admin
re-maps a catalog step next month, journeys already on the floor keep behaving
the way the desk was shown when they checked the patient in.

### On `giniflow_visits`

`visit_type_id` → `flow_visit_types(id)`, `planned_total_min`, `visit_token`
(unique), `whatsapp_sent`, `checked_in_by`.

### Two additive columns on the shared reference tables

- `flow_step_catalog.chain_status` — which Gini Flow status this step corresponds
  to (`with_vitals`, `with_sd`, `with_doctor`, `with_rx`, `dispensed`…).
  **NULL = an off-chain stop** the chain has no column for: ECG, X-Ray, ABI, VPT,
  dietitian.
- `flow_visit_types.for_followup`, `for_walkin` — let the screen _suggest_ a type
  without naming an id in code. No match → nothing preselected, reception picks.

Both nullable, both admin-editable. No `flow_*` behaviour changes.

## Backend flow

New service `server/services/giniflow/journey.js`.

### Check-in

```
POST /api/giniflow/stations/reception/:visitId/checkin
  { visitTypeId, steps[], sendWhatsapp, tokenNumber? }
    │
    ├─ BEGIN
    ├─ advanceStatus(checked_in)          ← existing engine, existing guard
    ├─ INSERT giniflow_visit_steps × N    ← order = array order
    ├─ UPDATE giniflow_visits SET visit_type_id, planned_total_min, visit_token
    ├─ COMMIT
    └─ sendFlowCheckin(...)               ← after commit, best-effort, never blocks
```

Idempotent: a visit that already has steps is not given a second set — the same
double-tap discipline the payment desk has. The existing `markArrived` guard
(already past reception → refuse) stays exactly as it is.

### The auto-tick

`syncFromStatus(client, visitId, toStatus)`, called from inside `advanceStatus`
so it lands in the same transaction as the status change:

- every step whose `chain_status` is **at or behind** the new status → `done`
  (at or behind, not equal, so `allowSkip` jumps cannot leave the plan behind);
- the step matching the new status → `in_progress`;
- on a terminal status (`exited`, `cancelled`, `no_show`) every remaining
  `pending` step → **`skipped`, never `done`** — the tracker must not claim an
  X-Ray happened.

This is what keeps the journey live without adding one extra click for the
mainline steps. Off-chain stops have no `chain_status` and are ticked by hand.

### Planless visits

`ensurePlan(visitId)` — the HealthRay sync checks patients in without ever
touching this screen, so a visit can reach the floor with no journey. On first
read, seed one from the suggested type with `source='auto'`; reception can edit
it afterwards. Without this the floor has planless patients the moment the sync
runs, which on this floor is most of them.

### Routes

| Route                                  | Capability                                              | Purpose                                 |
| -------------------------------------- | ------------------------------------------------------- | --------------------------------------- |
| `GET .../reception/:visitId/journey`   | `GINIFLOW_VIEW`                                         | read + `ensurePlan`                     |
| `POST .../reception/:visitId/checkin`  | `GINIFLOW_STATION_RECEPTION`                            | the whole arrival action                |
| `POST/PATCH/DELETE .../journey/steps…` | `GINIFLOW_STATION_RECEPTION` or `GINIFLOW_MANAGE_QUEUE` | add / tick / reorder / remove mid-visit |
| `GET /api/giniflow/track/:token`       | public                                                  | patient tracker                         |

Bodies validate against `server/schemas/index.js` via `middleware/validate.js`,
like every other station route.

### Tracker

Same payload shape as `/api/flow/track/:token` (`server/routes/flow.js:3746`):
first name, token number, current step, index, remaining minutes, timeline, with
`is_background` steps hidden. `PatientJourneyPage` tries the Gini Flow token
first and falls back to the flow endpoint on 404, so one public URL serves both
modules and `flow_*` stays untouched.

⚠ The route must be added to `PUBLIC_PATTERNS` in `server/middleware/auth.js`
(alongside `/^\/api\/flow\/track\/[^/]+$/`). An endpoint missing from that list
returns 401 to the patient with no other symptom.

## UI flow

### The check-in panel

1. Reception presses **✓ Arrived** on an expected patient (or **✓ Check in** on a
   walk-in). Nothing is written yet.
2. A detail panel opens — the `dp-*` idiom `LabStationPage` already uses:
   - **Visit type** chips from `flow_visit_types`, with the suggestion
     preselected: follow-up vs new from `visit_number`, walk-in vs appointment
     from the appointment, matched against `for_followup` / `for_walkin`.
   - **Journey** — the type's template, editable: ▲▼ reorder, minutes input,
     assignment select (doctors for doctor roles, `flow_staff` otherwise),
     ✕ remove, **+ Add step** from the catalog, **+ Custom step**.
   - **Totals** — `N steps · Est. X min`, recomputed as they edit.
   - **WhatsApp preview** — the message as the patient will receive it.
3. Two buttons: **✓ Check In + Send WhatsApp** and **Check In Only**.
4. Changing the visit type reloads the template but keeps steps the desk added by
   hand — retyping an X-Ray because they corrected the type is the kind of thing
   that gets a screen abandoned.

### After check-in

- The arrival row carries `3/8 · next: ECG`; off-chain stops get their tick
  there, since nothing else can complete them.
- The board card carries the same one-line summary.
- The patient's tracker shows the timeline, ticking itself as the visit advances.

`ARRIVAL_SELECT` (`receptionStation.js:519`) gains `visit_number` — reusing
board.js's lateral rather than a second implementation — plus the appointment's
walk-in flag and its doctor: the three facts the suggestion and the assignment
prefill need.

New component `src/components/giniflow/JourneyBuilder.jsx`, presentational: it
takes steps and returns steps.

**Deliberately not done:** `FlowCheckinPage.jsx` (1,808 lines, live, no automated
coverage) is _not_ refactored onto the new builder. Extracting the shared block
would be tidier, but with no test over that page it is a poor trade today. Worth
revisiting once the new builder has proven itself.

## Nothing hardcoded

Visit types, their durations and their default journeys; every step's name,
duration, station and role; who can be assigned; which step maps to which board
status; which type is suggested for a follow-up or a walk-in — all rows, all
editable through the existing `/flow/admin` CRUD. The only code-level constant
left is the Gini Flow status chain itself, unchanged by decision 2.

## Edge cases, and where each is handled

| Case                                     | Handling                                                        |
| ---------------------------------------- | --------------------------------------------------------------- |
| Patient checked in by the HealthRay sync | `ensurePlan` seeds a journey on first read                      |
| Second check-in / double tap             | Existing chain guard + "already has steps" check                |
| Status skipped (`allowSkip`)             | Auto-tick completes everything at or behind the new status      |
| Visit ends early                         | Remaining steps `skipped`, never `done`                         |
| Blocked patient                          | Existing `blockDetail` refusal is untouched on both paths       |
| Patient with no phone                    | WhatsApp skipped, check-in proceeds — as `/flow/checkin` does   |
| Catalog re-mapped later                  | `chain_status` snapshotted per step at check-in                 |
| Custom step (no catalog row)             | `step_catalog_id` nullable, `source='custom'`                   |
| Reordering                               | Deferrable unique key on `(visit_id, step_order)`               |
| Walk-in                                  | Same panel, same journey, existing walk-in booking logic reused |

## Build order

1. Migration + `journey.js` + the smoke script — the plan can be built, read and
   ticked before any screen exists.
2. Routes + schemas + the auto-tick hook in `statusEngine`.
3. `JourneyBuilder` + the reception panel + the arrival-row summary.
4. Tracker endpoint + `PatientJourneyPage` fallback + the public-path entry.
5. Board card summary.

## Verification

1. `node migrations/_runOne.mjs migrations/2026-09-08_giniflow_journey.sql` —
   additive; prints any catalog row left without a `chain_status`, so the mapping
   is seen rather than assumed.
2. `npm run smoke:giniflow-journey` (new): a template becomes an editable plan;
   check-in writes steps, token and ETA in one transaction; a second check-in
   adds no second plan; the auto-tick completes the right steps as the visit
   advances, including across a skipped status; `exited` marks the rest skipped,
   never done; a sync-checked-in visit gets a plan on first read; a custom step
   survives a reorder; the tracker payload leaks no more than the flow one.
3. `smoke:giniflow-reception`, `smoke:giniflow-lab` — unchanged, including the
   assertion that the `flow_visits` row count does not move.
4. `npx vite build`, `npm run format`.
5. Manual: check in a follow-up and a new patient with an added ECG, watch the
   board line, open the tracker as the patient, then advance the visit through
   vitals → SD and watch the journey tick itself.
6. `/code-review high` over the diff; fix findings; re-run 2-4; record the
   outcome in this doc.

## Plan review

Reviewed against the live database and the call sites before any code was
written. Five gaps found in the first draft, all folded in above and listed here
so the reasoning survives:

1. **Template flags were ignored.** `flow_step_templates` carries `is_default`,
   `is_optional` and `condition_key` (`needs_tests`, `needs_chief`,
   `needs_diet`), and `/api/flow/templates/:visitType` already returns them
   (`server/routes/flow.js:870`). The builder must honour them: an optional step
   is offered but unticked, and a conditional one is driven by its toggle.
   Ignoring them would have quietly dropped a distinction the templates already
   encode.
2. **The auto-tick runs on 22 call sites.** `advanceStatus` is called from every
   station and several routes. `syncFromStatus` therefore has one hard
   constraint: it may only `UPDATE` rows of `giniflow_visit_steps` for that
   visit, must no-op when the visit has no plan, and must never raise — because
   it shares the station's transaction, and a journey bug that rolls back a
   nurse's "vitals done" would be far worse than a journey that is briefly
   wrong. A smoke check covers exactly this: a visit with no plan advances
   normally.
3. **A visit type can have no template.** Live data has six types — including an
   `ONLINE` one an admin added after the seed — and nothing guarantees each has
   template rows. The builder must open with an empty list and let reception add
   steps, rather than showing a blank panel that looks broken.
4. **The suggestion has better inputs than `visit_number`.** `appointments`
   carries `is_walkin`, `visit_type` and `appointment_type`. Use them alongside
   the visit-number lateral; `visit_number` alone cannot tell an appointment from
   a walk-in.
5. **Which number is the ETA.** `flow_visit_types.max_time_min` is the type's
   ceiling; the sum of the step durations is the estimate. `/flow/checkin` sends
   the **sum** to the patient (`totalPlanned`) and keeps `max_time_min` as the
   internal budget. Do the same, or the patient is promised a number nobody is
   working to.

That the live `flow_visit_types` already contains a type nobody seeded is the
clearest argument for the whole approach: any code that named `FU_APPT` and
friends would already be wrong today.

## Known trade-offs, stated rather than hidden

- **Off-chain stops are ticked by hand.** They have no board column, so nothing
  else can know they happened. A direct consequence of decision 2; it disappears
  if journey-driven routing is turned on later.
- **Two clocks.** The journey ETA is the patient's promise; the Gini Flow SLA
  stays the floor's internal target. Shown separately, deliberately not merged.
- **`flow_*` gains two nullable columns.** No behaviour there changes, and the
  existing smoke assertion on `flow_visits` still guards it.
- **The journey does not yet decide anything.** Until routing is switched on, a
  plan that says "no MO step" will still show the patient in the SD/MO column.
  Reception should read the plan as the expectation, not the rule.
