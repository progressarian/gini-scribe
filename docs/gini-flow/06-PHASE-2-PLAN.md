# Phase 2 — The flow becomes real

**Brief deliverable (§5):** "Reception (check-in + payments) · Vitals · MO/SD · Lab stations — all
writing real `visit_events` · cross-station triggers 1–3 · Flow Manager now shows real data ·
Triage board"

**Spec files, all now in `docs/Flow-Manage/`:**

| Screen            | File                        | Screen id     | Status                                    |
| ----------------- | --------------------------- | ------------- | ----------------------------------------- |
| Vitals station    | `gini-flow-v2.html`         | `s-vitals`    | full mockup                               |
| Reception         | `gini-stations.html`        | `s-reception` | full mockup                               |
| Lab               | `gini-stations.html`        | `s-lab`       | full mockup                               |
| Triage board      | `gini-triage-v3-final.html` | —             | full mockup **+ embedded dev-notes spec** |
| **MO/SD station** | —                           | —             | **no mockup exists — see Task 2.0**       |

Not Phase 2: `gini-doctor-final.html` / `gini-doctor-v3.html` (Phase 3),
`gini-prescription-v2.html` (reference), `gini-doctor-view.html` / `gini-doctor-v2.html`
(superseded — ignore), pharmacy `s-pharmacy` / `s-rx` and `s-referrals` (Phase 4).

**Depends on:** Phase 1 — schema, status engine, capabilities, theme, board, HealthRay
appointment sync. All shipped.

**Design spec:** `02-DESIGN-SYSTEM.md` → _Phase 2 — stations, triage and the launcher_: token
reconciliation across the three prototypes, the triage category palette, biomarker-chip colour
rules, the 12 new components, and the responsiveness decision each station needs.

> ### Separation rule — and Phase 2 is where it is easiest to breach
>
> Phase 1 built one screen the old module also had. Phase 2 rebuilds **four screens the old
> module already runs on the floor today**, so the temptation to reuse is far stronger. Do not.
>
> **Off limits — the old station module owns all of this:**
>
> | Layer             | Belongs to the old module                                                                                                                                                    |
> | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
> | Tables            | `flow_visits`, `flow_visit_steps`, `flow_events`, `flow_staff`, `flow_step_catalog`, `flow_step_templates`, `flow_visit_types`, `flow_wait_daily`, `flow_wait_station_daily` |
> | Pages             | `src/pages/flow/*` — `FlowStationPage`, `FlowCheckinPage`, `FlowCoordinatorPage`, `FlowMyPatientsPage`, `FlowConsultantsPage`, `FlowReportsPage`, `FlowAdminPage`            |
> | Components        | `src/components/flow/*` — `StationQueue`, `StationSwitcher`, `LabPanel`, `FlowPanel`, `ConsultationBox`, `VisitDetailModal`, `ConsultantLoadBoard`, and the rest             |
> | Routes / services | `server/routes/flow.js`, `server/services/flow/*`                                                                                                                            |
> | URLs              | `/flow/*` including `/flow/station/:role`                                                                                                                                    |
> | Capabilities      | every `FLOW_*` key                                                                                                                                                           |
>
> **Phase 2 builds its own of each:** `giniflow_*` tables · `src/pages/giniflow/*` ·
> `src/components/giniflow/*` · `server/routes/giniflow*.js` · `server/services/giniflow/*` ·
> `/giniflow/station/*` · `GINIFLOW_*` capabilities.
>
> Not even the components. `StationQueue` already renders a vitals form — copying it would import
> the old module's step model, its `flow_staff` assignment and its `flow_visit_steps` writes along
> with the markup. Carry the _ideas_ across; leave the code where it is.
>
> **The one shared category is the hospital's clinical data** — `patients`, `doctors`,
> `appointments`, `vitals`, `lab_results`, `documents`. Both modules read and write these because
> they are the patient's record, not either module's state. See 0.5 for why `vitals` sits on this
> side of the line, and question 12 if you disagree.
>
> **Consequence to accept up front:** for the parallel-run period the floor has two vitals
> screens, two lab screens and two reception screens, backed by different tables. Staff must be
> told which one is live for them, or the same patient gets recorded in both. This is a rollout
> problem, not a technical one, and it is bigger in Phase 2 than it was in Phase 1.

---

## 0. What reading the prototypes changed

Four things that are not in the brief and that change the scope. Settle them before writing code.

### 0.1 There is no MO/SD mockup — and it is the most important screen

The brief's §1.2 says `gini-flow-v2.html` specifies "Vitals station **and MO/SD station**
screens". It does not: its five screens are launcher, Flow Coordinator, Vitals, **Doctor**,
Pharmacy. The MO/SD station has no design anywhere in the folder.

It is also the screen that matters most. Per §4.3 it owns three actions the whole floor depends
on — **Ready for Dr. Bhansali**, **Order tests**, and **Close** (green-category patients skipping
the doctor entirely) — and it is where the "waiting for doctor" queue the Flow Manager exists to
expose actually forms.

**Options:** (a) Gurjot draws it; (b) we design it from §4.3 plus the vitals screen's visual
language and have it reviewed before build; (c) defer MO/SD to Phase 2b and ship vitals +
reception + lab first. **Recommendation: (b)** — the actions are specified, only the layout is
not, and deferring it means the bottleneck stays invisible.

### 0.2 Three different status models are now in play

| Source                        | Model                                                                                                                                                            |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Developer brief §2.2          | 13-status chain — `booked → … → exited`                                                                                                                          |
| **Triage dev notes**          | **16-status chain** — adds `confirmed_call`, `confirmed_day_before`, `vitals_in_progress`, `awaiting_lab`, `results_received`, `prescription_pending`, `billing` |
| `gini-flow-v2.html` `s-floor` | 9 step chips — Vitals · MO · Blood · Wait · SD · Chief · Rx · Billing · Pharmacy (the _old_ `flow_step_catalog`)                                                 |

Phase 1 implemented the brief's chain plus `with_vitals`. The triage chain is a superset and is
closer to the floor: it separates appointment confirmation (OBT's work) from arrival, and adds
`billing`, which the old module has as a real step and the brief drops entirely.

**Recommendation:** extend `shared/giniflowStatus.js` to the triage chain now, while only the
sync writes statuses. Adding `billing` after the pharmacy screen exists is expensive; adding it
today is a migration and a map entry. **Blocking Task 2.2.**

### 0.3 The addendum (v1.1) reaches into Phase 2

`gini-addendum-mockup.html` is a doctor-view change list, but two of its four changes are not
Phase 3:

- **Change ④ — the allergy strip is "visible on every screen, every role."** That means vitals,
  MO/SD, lab and reception. Retrofitting it into four screens later costs more than adding it to
  a shared component now.
- **Change ③ — the MO proposes prescription changes** ("Atchol 20mg → 40mg, LDL 127") which the
  doctor approves, adjusts or rejects. The MO/SD station therefore needs prescription-proposal
  capability, which §4.3 never mentions. It also implies a `giniflow_rx_proposals` table in
  Phase 2, not Phase 3.

### 0.4 Some of this is already automatic

Phase 1 established that HealthRay drives `booked`, `checked_in`, `in_visit` and `completed`, and
that `labSync` already pulls lab results. Two of the brief's manual screens are therefore partly
redundant:

- **Reception check-in** — HealthRay already reports `checkedin`. Reception's real Phase 2 job is
  **payments**, not arrival marking. Keep an arrival button for walk-ins and corrections.
- **Lab "Upload report"** — results already arrive via `labSync`. The lab screen should _confirm_
  and attribute an upload, not be the only path by which results appear.

### 0.45 Which prototype wins where a screen exists twice

Three screens are drawn twice across the folder. Decisions, so nobody re-litigates them mid-build:

| Screen           | Drawn in                                                                                           | **Use**                                                                    |
| ---------------- | -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Flow Coordinator | `gini-flow-manager.html` (kanban) · `gini-flow-v2.html` `s-floor` (list + step chips, 120m budget) | **`gini-flow-manager.html`** — built in Phase 1                            |
| **Pharmacy**     | `gini-stations.html` `s-pharmacy` (queue) · `gini-flow-v2.html` `s-rx` (dispense detail)           | **`gini-flow-v2.html` `s-rx`** — decided                                   |
| Doctor consult   | `gini-flow-v2.html` `s-doctor` · `gini-doctor-final.html`                                          | `gini-doctor-final.html` — the brief calls it "THE definitive doctor view" |

**On pharmacy** — the two are less rival designs than two halves of one screen, and taking `s-rx`
alone loses real things:

- `s-rx` has what the _work_ needs: the **Hindi counselling script** in plain language
  ("Toujeo 18 units kar diya hai — pehle 16 tha"), a **per-medicine dispense checklist** with
  dose-change markers (`↑ Changed 16→18U`), per-medicine stock and quantity, and
  **"All dispensed — confirm patient exit"** with an NPS survey sent to MHG on exit.
- `s-pharmacy` has what the _queue_ needs: three counters (to dispense / stock warnings /
  dispensed), "Finalized 10:22" timing, queue-level stock badges, and — per §4.6 and its own
  buttons — the **out-of-stock substitution flow** ("Use Telmikind AM").

So: **`s-rx` is the dispense view**, and the queue keeps `s-pharmacy`'s counters, timings and
substitution flow. Dropping the substitution flow would remove something the brief explicitly
specifies. (Pharmacy is Phase 4; recorded here because the decision was taken now.)

### 0.5 More of this already exists than the plan first assumed

Checked against the live database, not the brief. Five corrections:

| Assumed                                         | Actually                                                                                                                                                                                            |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase 2 needs a `giniflow_vitals` table         | **`vitals` already exists** with every field the mockup wants — `bp_sys`, `bp_dia`, `pulse`, `temp`, `spo2`, `weight`, `height`, `bmi`, `waist`, plus `source`, `appointment_id`, `consultation_id` |
| Vitals are typed by a person                    | **54 vitals rows today, `source = 'healthray'`** — HealthRay already supplies them, like check-in and lab results                                                                                   |
| Triage needs biomarkers built from scratch      | **`appointments.biomarkers` is populated on 115 appointments today** — `{hba1c, fg, bpSys, bpDia, weight, followup, rmo, tag}`, exactly what the chips need                                         |
| Category is a new field                         | **`appointments.category` already exists and is set on 45 today** — but with a _different_ vocabulary: `maint / complex / new / ctrl`, not triage's five                                            |
| The allergy strip just reads the patient record | **There is no allergy field.** `patients` has `notes` and nothing else                                                                                                                              |

Two consequences worth stating plainly:

- **Vitals are clinical data, not module state.** The separation rule shares the hospital's data
  (`patients`, `doctors`, `appointments`) and forbids sharing the old module's. `vitals` is the
  former: it is written today by the HealthRay sync and read by Scribe's own consult flow. Gini
  Flow's vitals station must **write to `vitals`**, not to a private copy — a second vitals table
  would fork a patient's clinical record, which is worse than forking a module.
- **The allergy strip has no data source.** Addendum change ④ calls for it on every screen and
  every role, and it is the highest-stakes field in the app — nothing else on these screens can
  hurt a patient by being wrong. It needs a schema decision before it is drawn.

---

## Stations by role

Every station, its screen, who works it and what it writes. Phase 2 builds rows 1–4; the rest are
listed so the capability model and the launcher are designed once rather than four times.

| Station               | Role (this repo)       | Capability                               | Screen source                                   | Actions                                                              | Writes                                                                             |
| --------------------- | ---------------------- | ---------------------------------------- | ----------------------------------------------- | -------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| **Triage** (pre-OPD)  | `coordinator`          | `GINIFLOW_TRIAGE`                        | `gini-triage-v3-final.html`                     | categorise, override, assign SD, upload reports                      | `giniflow_triage`, `assigned_sd_id`                                                |
| **Reception**         | `reception`            | `GINIFLOW_STATION_RECEPTION`             | `gini-stations.html` `s-reception`              | payment received, insurance claim, (walk-in arrival)                 | `giniflow_lab_orders.payment_status`, lab order events                             |
| **Vitals**            | `nurse`                | `GINIFLOW_STATION_VITALS`                | `gini-flow-v2.html` `s-vitals`                  | record 7 vitals, voice entry, Done →                                 | `vitals` (shared), `vitals_done`                                                   |
| **MO / SD**           | `mo`, `consultant`     | `GINIFLOW_STATION_MO`                    | **none — Task 2.0**                             | ready for doctor, order tests, close (green only), propose Rx change | `ready_for_doctor` / `doctor_done`, `giniflow_lab_orders`, `giniflow_rx_proposals` |
| **Lab**               | `lab`, `tech`          | `GINIFLOW_STATION_LAB`                   | `gini-stations.html` `s-lab`                    | sample collected, processing, results done, upload                   | `sample_status`, lab order events, `results_status`                                |
| Doctor _(Phase 3)_    | `consultant`           | `GINIFLOW_DOCTOR`                        | `gini-doctor-v3` + `gini-doctor-final`          | consult, finalize                                                    | prescriptions, `doctor_done`                                                       |
| Pharmacy _(Phase 4)_  | `pharmacy`             | `GINIFLOW_STATION_PHARM`                 | `gini-flow-v2.html` `s-rx` + `s-pharmacy` queue | dispense per medicine, substitute, all dispensed                     | `dispensed` → `exited`                                                             |
| Referrals _(Phase 4)_ | `coordinator`          | `GINIFLOW_REFERRALS`                     | `gini-stations.html` `s-referrals`              | create referral, letter, track                                       | `giniflow_referrals`                                                               |
| Flow Manager          | `coordinator`, `admin` | `GINIFLOW_VIEW` (+ `GINIFLOW_SLA_ADMIN`) | `gini-flow-manager.html`                        | read, edit budgets                                                   | `giniflow_sla_config`                                                              |

Roles are this repo's existing ones — the brief's seven map onto them (`flow_manager` →
`coordinator`, `mo_sd` → `mo`, `vitals` → `nurse`). No new roles.

**Landing page per role.** The brief says "login lands each role directly on their station
screen". During the parallel run, leave `ROLE_HOME` pointing at the old module and let staff reach
Gini Flow from the nav; flip it per role as each station is signed off, not in one move.

### 2.0 — Station launcher

Both prototypes open on a launcher (`s-land`) — tiles per station with a live count
("4 in queue", "6 pending 4 uploaded"). Build one at `/giniflow/stations`, showing only the
stations the signed-in role holds a capability for, and the Flow Manager all of them (subject to
question 7 — view or act).

### 2.0b — Design the MO/SD station (do this before 2.7)

Blocked on question 1. Produce a mockup in the prototypes' visual language covering: queue of
`sd_pending` filtered to the logged-in SD; patient brief (category, biomarker chips, last visit,
MHG questions/symptoms); plan textarea; and the three actions. Review with Gurjot before 2.7.

**Done when:** a reviewed mockup exists, or option (c) is taken and Phase 2b is scheduled.

### 2.1 — Audit what Phase 1 already gives each station

Before building: for each of the four stations, list what already exists —
`advanceStatus`, `giniflow_lab_orders`, `giniflow_lab_order_events`, the board's queue
queries, the capability model. Prevents rebuilding the engine per screen.

**Done when:** a short table in this file naming, per station, what is new and what is reuse.

### 2.2 — Schema: extend the chain, add the station tables

**File:** `server/migrations/2026-09-XX_giniflow_phase2.sql`

- Extend `shared/giniflowStatus.js` to the triage chain (0.2): add `confirmed_call`,
  `confirmed_day_before`, `vitals_in_progress`, `awaiting_lab`, `results_received`,
  `prescription_pending`, `billing`. Update `STATUS_TO_SLA_KEY`, `BOARD_COLUMNS`, `WAIT_STATUSES`.
  Statuses are TEXT with no CHECK, so this is a code change plus a board-column decision.
- **No `giniflow_vitals` table** (0.5). The vitals station writes to the existing `vitals` table,
  tagging `source` so a station entry is distinguishable from HealthRay's. It also writes the
  reading into the event `meta`, so the timeline shows what was recorded without a join. Last-visit
  comparison ("↑ 1.4 kg from last visit") reads `vitals` history, which already exists per patient.
- `giniflow_rx_proposals` — addendum change ③: `visit_id`, `medicine_name`, `from_dose`,
  `to_dose`, `reason`, `proposed_by`, `status` (`proposed|approved|adjusted|rejected`),
  `decided_by`, `decided_at`.
- `giniflow_triage` — `appointment_id`, `category`, `auto_category`, `overridden_by`,
  `assigned_sd_id`, `data_complete`, `reports_status`, `updated_at`. `auto_category` sits beside
  `category` so an override is visible as an override.
  **Do not write `appointments.category`**: it already carries a different vocabulary
  (`maint/complex/new/ctrl`, set on 45 rows today) that something else depends on. Overwriting it
  with triage's five categories would silently change whatever reads it. Open question 9.
- **Allergies** — no source exists (0.5). Either add `patients.allergies text[]` plus an entry
  point, or extract from `patients.notes` with review. **A blank strip is worse than no strip:**
  "ALLERGIES: None recorded" reads as a cleared check, not as missing data. Decide before 2.10.
- `system_config` — does **not** exist; create it for the auto-routing rules rather than
  hardcoding them (dev notes).

**Rollback:** all additive. Nothing outside Gini Flow reads these.

### 2.3 — Every station write goes through `advanceStatus`

The engine is built and tested (13 chain hops, blocked→recovery, cancellation, jump limits).
Station routes call it; none writes `current_status` directly. Each passes its own `actor_role`
and `actor_id` so the log says who did it — the Flow Manager's timeline already renders this.

**Done when:** a grep shows no `UPDATE giniflow_visits SET current_status` outside the engine.

### 2.4 — Reception station

**Spec:** `gini-stations.html` `s-reception`. Three counters: payment pending / sample pending /
cleared. Per patient: ordered-by, time, urgency, the test list **with per-test prices and a
total**, and two actions — **✓ Payment received — notify lab**, and **Insurance claim**.

- Payment received → `giniflow_lab_orders.payment_status = 'paid'` + a `payment` event → the
  sample task appears on the lab screen (trigger 3).
- Insurance → `insurance_claim`, same downstream effect.
- Arrival marking stays available for walk-ins (0.4), but is not the main job.
- **Needs a price source.** The mockup shows real prices (HbA1c ₹250, Lipid ₹350). Decide:
  a `giniflow_test_catalog` table, or read from the existing lab/billing data. **Open question.**

### 2.5 — Lab station

**Spec:** `gini-stations.html` `s-lab`. Five buckets — sample pending → collecting → processing →
ready to upload → uploaded — with a four-step progress rail per card (Payment ✓ › Collect sample ›
Process › Upload) and a timer ("12m since order", "24m in analyzer", "18m results waiting").

- Each button writes a `giniflow_lab_order_events` row (built in Phase 1) and moves
  `sample_status`.
- `uploaded` sets `visit.results_status = 'ready'` (trigger 1) — the flip that turns a patient
  green on the MO and doctor queues. The screen's own banner states this.
- **Hard rule, enforced server-side:** no sample collection until `payment_status` is `paid` or
  `insurance_claim`.
- Reconcile with `labSync` (0.4): a result that arrives automatically should advance the order
  without waiting for a tap, and the screen should show it as already uploaded.

### 2.6 — Vitals station

**Spec:** `gini-flow-v2.html` `s-vitals`. Queue on the left (Now / Next / timed), form on the right.

- **Seven fields**, not the brief's four: weight, height, **BMI (auto)**, BP sys/dia, pulse,
  SpO2, temperature. The brief lists BP, weight, height, waist; the mockup has no waist and adds
  three.
- **Last-visit comparison inline** — "↑ 1.4 kg from last visit", "Last: 152/96".
- **Voice entry** — "Weight 72 kilos, BP 148 over 94, pulse 82, SpO2 98" fills the fields. Not in
  the brief at all. This repo already has transcription (`src/services/transcription.js`) and
  extraction; reuse rather than rebuild. Scope it explicitly: it is a feature, not a detail.
- "Done →" advances and **auto-loads the next patient**.
- **Writes to the existing `vitals` table** with `source` set to distinguish a station entry from
  HealthRay's, plus event meta, then advances to `vitals_done`.
- **HealthRay already supplies vitals** — 54 rows today (0.5). So this screen is a _fallback and a
  correction path_, not the only source. Decide what happens when both exist: the station's own
  reading should win for the visit, but it must not overwrite HealthRay's row silently.

### 2.7 — MO/SD station

Per §4.3 and the Task 2.0 mockup:

- Queue of `sd_pending` for the logged-in SD (`assigned_sd_id`).
- Patient brief; plan textarea.
- **Ready for Dr. Bhansali** → `ready_for_doctor`.
- **Order tests** → creates a `giniflow_lab_orders` row with `payment_status = 'pending'`
  (trigger 2) → appears on reception.
- **Close** → `doctor_done`, skipping the doctor. **Green category only, enforced server-side.**
- **Propose a prescription change** (addendum ③) → `giniflow_rx_proposals`.

### 2.8 — Triage board

**Spec:** `gini-triage-v3-final.html` + its dev notes, which are the densest spec in the folder.

- Five category columns: `getting_worse_out` (red, Dr. Bhansali leads) · `getting_worse_in`
  (amber, SD leads) · `getting_better_yet` (mid-green, SD closes) · `in_control` (dark green, SD
  closes independently) · `no_reports` (purple, chase reports).
- **Auto-categorisation rule engine** on HbA1c trend — `>9.0 or rising >1.5 → worse_out`;
  `7.0–9.0 and rising → worse_in`; `improving and >7.0 → getting_better`; `≤7.0 and stable →
in_control`; none → `no_reports`. **Coordinator can override any of it**, and the override must
  stay visible (2.2).
- **Pipeline bar** — total / lab reports in / uploaded / data complete / categorised / assigned /
  checked in / no-show+cancel.
- **Biomarker chips** — `6.9 → 7.4 HbA1c` with prev→current colour rules and per-marker
  thresholds (HbA1c >7, FBS >130, LDL >100, TG >150, UACR >30). **The data already exists**:
  `appointments.biomarkers` is populated on 115 of today's appointments with `hba1c`, `fg`,
  `bpSys`, `bpDia`, `weight` (0.5). Read it before building anything new; `lab_results` supplies
  the markers it lacks.
- **Doctor pills** double as an assignment control and a display filter.
- **Report upload** — per-card (patient pre-locked) or global (AI auto-match by name, always
  confirmed). **AI extracts biomarker values; the coordinator reviews before saving.**
- **MHG pre-visit questions and symptoms**, submitted 1–10 days before the appointment.
  Three symptom tables already exist — `patient_symptom_log`, `symptom_logs`, `visit_symptoms`.
  Establish which is the pre-visit one before assuming this is new work.

The dev notes name three endpoints (`GET /api/appointments`, `GET /api/pipeline-stats`,
`PATCH /api/appointments/:id`). Ours become `/api/giniflow/triage*` — the notes were written
before the separation decision.

### 2.9 — Cross-station triggers 1–3

`server/services/giniflow/triggers.js`, called from `advanceStatus` inside the caller's transaction:

1. Lab `uploaded` → `results_status = 'ready'` → MO/SD and doctor queues show "Results ready".
2. Tests ordered, urgency `today` → `lab_order` with `payment_status = 'pending'` → reception.
3. Reception marks paid → sample task → lab sees "Collect now".

Trigger 4 (doctor Finalize) is Phase 3; 5 (pharmacy) is Phase 4.

### 2.10 — Allergy strip (addendum ④)

One shared component on every station screen, for every role. Cheap now; four retrofits later.

**Blocked on the data source (0.5): there is no allergy field.** Do not ship the strip reading an
empty column — "ALLERGIES: None recorded" against a patient nobody ever asked is a false negative
on the one field on these screens that can cause direct harm. Either add the field and a way to
populate it, or render "Allergies not recorded — ask the patient" until it is.

### 2.11 — Capabilities

New per-station capabilities so the coordinator can be granted some desks and not others — the
model this repo already uses (`FLOW_STATION_*`):
`GINIFLOW_STATION_VITALS`, `GINIFLOW_STATION_MO`, `GINIFLOW_STATION_LAB`,
`GINIFLOW_STATION_RECEPTION`, `GINIFLOW_TRIAGE` — plus `GINIFLOW_STATION_PHARM`,
`GINIFLOW_REFERRALS` and `GINIFLOW_DOCTOR` declared now (unused until Phases 3–4) so the launcher
and the matrix are designed once. See the **Stations by role** table. Register in `shared/permissions.js`,
`src/config/routes.js`, `src/router.jsx` and the nav in the same change (enforcement is on).

Settle §2.4's open question first: may the Flow Manager _act_ at a station, or only view? If they
may act, the event records **their** identity, not the station's.

### 2.12 — Smoke coverage

- `smoke:giniflow-stations` — walk one visit check-in → vitals → SD → tests ordered → payment →
  sample → upload, asserting one event per transition, correct `actor_role`, the payment gate
  rejecting early collection, and `results_status` flipping to `ready`.
- `smoke:giniflow-triage` — the rule engine against fixture biomarkers, override precedence,
  pipeline counts.
- Extend `smoke:giniflow-render` to each new page.
- Every suite keeps the `flow_*` isolation assertion, extended to `flow_visit_steps`, `flow_staff`
  and `flow_wait_*` — Phase 2 touches the station tables Phase 1 never went near.
- **An import guard:** a check that no file under `src/pages/giniflow/`,
  `src/components/giniflow/` or `server/services/giniflow/` imports anything from the old
  module's paths. A copied component is the most likely way the separation quietly ends.

---

## Definition of done

- [ ] A patient can be walked the full pre-doctor chain from two browsers in different roles, every screen updating live without refresh.
- [ ] Every transition appears in `giniflow_visit_events` exactly once with the right `actor_role`.
- [ ] The Flow Manager board runs on real floor activity, not only the HealthRay sync — the vitals, SD and lab columns populate.
- [ ] Lab cannot collect a sample before payment; the server, not the UI, enforces it.
- [ ] Triage auto-categorises from HbA1c and the coordinator can override, with the override visible.
- [ ] The allergy strip appears on every station screen **and shows real data** — never a blank "None recorded" for a patient nobody asked.
- [ ] The vitals station writes to `vitals`; no second copy of a patient's clinical readings exists.
- [ ] `smoke:giniflow-stations` and `smoke:giniflow-triage` pass; `format:check` clean; `verify-rbac` passes.
- [ ] Nothing in `flow_*` changed — asserted by every Phase 2 smoke suite, covering `flow_visits`, `flow_visit_steps`, `flow_events`, `flow_staff` and `flow_wait_*`.
- [ ] No Phase 2 file imports from `src/pages/flow/`, `src/components/flow/` or `server/services/flow/` — checked by grep in the smoke run.

## Open questions

1. **MO/SD mockup** — who draws it (0.1 / task 2.0b). **Blocks 2.7.**
2. **Which status chain** — brief's 13, triage's 16, or the old 9 steps (0.2). **Blocks 2.2.**
3. **Test prices** — new catalogue table or existing billing data (2.4).
4. ~~Voice vitals~~ — **built.** Deterministic parser in `shared/giniflowVitalsSpeech.js`, transcribed through the existing `/api/ai/transcribe`; fills the form, never saves, and shows the transcript for read-back.
5. **AI biomarker extraction** on report upload — reuse the existing extraction service, or new (2.8)?
6. **MHG pre-visit questions** — which of `patient_symptom_log` / `symptom_logs` /
   `visit_symptoms` is the pre-visit source (2.8)?
7. **Flow Manager acting at stations** — view or act (2.11)?
8. **Lab upload vs `labSync`** — which wins when both fire (0.4 / 2.5)?
9. **`appointments.category`** — triage's five categories vs. the existing `maint/complex/new/ctrl`
   already on 45 rows today. Coexist, migrate, or map (2.2 / 2.8)? **Blocks 2.8.**
10. **Allergy source** — new column, extraction from `notes`, or HealthRay (0.5 / 2.10).
    **Blocks 2.10**, and it is the highest-risk field in Phase 2.
11. **Station vitals vs HealthRay vitals** — which wins for a visit when both exist (2.6)?
12. **Is writing `vitals` a breach of the separation rule?** The plan says no: it is the patient's
    clinical record, written today by the HealthRay sync and read by Scribe's consult flow, not
    the old flow module's state — and a private copy would fork a patient's readings. If the
    ruling is that Gini Flow must own its vitals too, say so before 2.6 and the plan adds
    `giniflow_vitals` with a sync back into `vitals`.
13. **Theme drift** — normalise the three prototypes onto the Phase 1 tokens, or let triage keep
    its own greyscale? See `02-DESIGN-SYSTEM.md` → Phase 2. Recommendation: normalise, adopt the
    additions (`--c0…--c7`, mid-tones, `--mid-grn`).
14. **Which stations must work below 1024px?** Every Phase 2 prototype is fixed-width desktop with
    zero media queries. Vitals is the one with a real tablet case. Deciding after the build is a
    rewrite (`02-DESIGN-SYSTEM.md` → Phase 2).
15. **Rollout** — during the parallel run, which staff use which station screens, and who tells
    them? Two vitals desks recording the same patient into different tables is the most likely
    way this goes wrong on the floor.

## Sequencing

```
2.0 MO/SD design ─────────────────────────────┐
2.1 audit → 2.2 schema ─┬─→ 2.3 engine wiring ─┼─→ 2.6 vitals ──┐
                        ├─→ 2.4 reception ─────┤                ├─→ 2.9 triggers → 2.12 smoke
                        ├─→ 2.5 lab ───────────┤                │
                        └─→ 2.8 triage ────────┴─→ 2.7 MO/SD ───┘
2.10 allergy strip and 2.11 capabilities run alongside, needed by every screen.
```

Vitals first of the four: it has a complete mockup, real data to verify against (46 vitals rows
today), and it lights up the one empty column next to the largest queue.
