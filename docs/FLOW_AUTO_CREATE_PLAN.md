# Plan: Auto-start the Flow journey from HealthRay status (with billing steps + correct timing)

> Status: **IMPLEMENTED behind `FLOW_AUTO_CREATE` (off by default).** Date: 2026-06-22.
> Code: `server/services/flow/autoCreate.js` (new), hook in `server/services/cron/healthraySync.js`
> (`syncAppointmentStatuses`), `POST /flow/from-appointment` refactored to share the creator,
> flag documented in `.env.example`. Enable on the worker with `FLOW_AUTO_CREATE=1`.
> Hard requirement from product: **must not corrupt or affect any other patient's data.**
> See the dedicated **§7 Data-Safety Guarantees** for how that is enforced.

---

## 1. Problem

On the Flow Coordinator board, patients who completed their whole OPD journey *inside
HealthRay* show up as **all-steps-done with `Elapsed 0m`** (e.g. Kuldeep Singh, P_180164:
`checkin_time` and `actual_completion` were **1.6 seconds apart**, every step's
`started_at = NULL`, every `completed_at` identical).

This is not a timer bug — `classifyVisit()` computes
`elapsed = actual_completion − checkin_time` correctly. The real cause is **when** the
flow visit is created.

## 2. Root cause (verified in code)

A `flow_visits` row is INSERTed in only **three** places:

| Path | Trigger | File |
|---|---|---|
| `POST /flow/checkin` | Reception manually checks a patient in | `server/routes/flow.js:533–760` |
| `POST /flow/from-appointment/:id` | Someone clicks "Start Flow" on an appointment | `server/routes/flow.js:1384–1511` |
| demo seed | Dev only | `server/services/flow/demo.js:155` |

**No cron / sync path ever inserts a flow visit.** The HealthRay sync function
`syncFlowFromAppointment()` (`server/services/cron/healthraySync.js:795`) only **UPDATEs an
already-existing** visit. So if nobody manually checks the patient in, the board never
tracks them live. The visit only materializes later (or via a bulk back-fill), which is why
all steps get the same `completed_at` and elapsed reads `0m`.

## 3. Goal

When HealthRay reports a patient as **`checkedin`** or **`in_visit`** — which already flips
`appointments.status` in `syncAppointmentStatuses()` and shows on the scribe OPD page —
**auto-create the flow visit + journey at that moment**, including the billing-extracted
lab/imaging/machine steps, and **auto-start it**. Then the existing state machine advances
the steps as HealthRay progresses.

Because creation happens at arrival and steps complete over real time,
`elapsed = actual_completion − checkin_time` becomes a **true duration** instead of `0m`,
and no one has to manually add the patient on `/flow/checkin`.

## 4. Everything needed already exists — it just isn't wired to the cron

| Building block | Where | Reused for |
|---|---|---|
| Idempotent visit + journey creator (template → steps, auto-start step 1 with `started_at=NOW()`) | `POST /flow/from-appointment` → `flow.js:1402–1503` | The creation engine |
| Status → step state machine (`in_visit` completes pre-doctor steps with real durations; `completed` closes the rest; `cancelled` cancels) | `syncFlowFromAppointment()` → `healthraySync.js:795–888` | Step advancement |
| Vitals auto-complete (real Vitals timing, 30–45s latency) | `syncFlowVitalsFromAppointment()` → `healthraySync.js:952–1027` | Real Vitals timing |
| Billing → lab/imaging/machine step suggestions | `transactionsToBilling()` → `billingExtractor.js:107–160` | The billed steps |
| Rate-limited HealthRay transport (token bucket + cooldown) | `gatedFetch` / `fetchPatientTransactions` → `healthray/client.js` | No new WAF exposure |
| HealthRay status map (`Waiting→checkedin`, `Engaged→in_visit`, `Checkout→completed`) | `mapStatus()` → `mappers.js:53–62` | The trigger signal |

The work is **wiring + one new reconciliation pass**, not new subsystems.

## 5. Design

### 5.1 Trigger point
`syncAppointmentStatuses()` (`healthraySync.js:1666–1822`) is the per-tick loop that maps
each HealthRay appointment's status and persists `appointments.status`. Right where it
already calls `syncFlowFromAppointment(appointmentId, newStatus)` (~line 1801), we insert a
**guarded auto-create** step:

```
when newStatus ∈ { "checkedin", "in_visit" }
 and FLOW_AUTO_CREATE is enabled
 and no non-cancelled flow_visit exists for this appointment
   → createFlowVisitFromAppointment(appt, { extraSteps: billingSteps })
   → (existing) syncFlowFromAppointment(appointmentId, newStatus)  // advances it
```

We trigger on **`checkedin`** (earliest, = HealthRay "Waiting") so timing starts at arrival.
`in_visit` is also handled for patients who appear already-engaged.

### 5.2 Extract the creation engine (no behavior change to the existing route)
Move the body of `POST /flow/from-appointment` (`flow.js:1402–1503`) into a reusable
service function:

- **New file:** `server/services/flow/autoCreate.js`
- **Export:** `createFlowVisitFromAppointment(client, appt, { extraSteps = [], actor = "auto:healthray" })`
  - Same idempotency guard (one non-cancelled visit per `appointment_id`).
  - Same template selection (`flow_step_templates` ⋈ `flow_step_catalog`).
  - Same INSERT into `flow_visits` + `flow_visit_steps`, same first-step auto-start.
  - Appends `extraSteps` (billing-derived) **before the Billing step**, deduped.
- **The existing route** `POST /flow/from-appointment` is refactored to call this same
  function → single source of truth, zero behavior change for manual "Start Flow".

### 5.3 Billing-step injection + reconciliation
- **At creation:** if `appt.healthray_patient_id` is set, call `fetchPatientTransactions`
  (already routed through `gatedFetch`), run `transactionsToBilling`, look up each
  suggested step's duration/station/role from `flow_step_catalog`, and pass them as
  `extraSteps`. Each injected step is stamped `data.from_billing = true` (mirrors the
  client-side check-in behavior so the floor UI can still ✕-remove them).
- **Later reconciliation:** the bill is often *created after* check-in. So on each tick,
  for an existing auto-created visit whose bill has appeared, run
  `reconcileBillingSteps(client, visitId, appt)`:
  - Idempotent: dedupe by `step_catalog_id` / `step_name` against current steps.
  - Insert any missing lab/imaging/machine steps as `pending`, positioned **before the
    Billing step** (or appended if Billing is already completed).
  - **Throttle:** only runs while `bill_created` is still false **or** no `from_billing`
    steps exist yet; once tests are injected it stops re-polling that patient.

### 5.4 Visit-type heuristic
Keep the route's existing default (`is_walkin ? FU_WALK : FU_APPT`). Refinement: if billing
already shows lab items at creation time, use `FU_APPT_TESTS` (its template already contains
Blood Sample, so dedup prevents a duplicate).

### 5.5 What "correct time management" will and will not give
- ✅ **Real timing** at: `checkin_time` (arrival), Vitals (completes when HealthRay vitals
  land), and the doctor step (starts at "Engaged"). `classifyVisit()` then reports a true
  elapsed duration instead of `0m`.
- ⚠️ **Honest limitation:** HealthRay only exposes `checkedin / in_visit / completed`
  (+ vitals). It does **not** report per-station completion for Rx-explain / Billing /
  Pharmacy, so those steps all close at the `completed` transition and compress into that
  moment. Visit- and doctor-level timing is real; the post-doctor tail is best-effort.
  Truly granular per-station timing only comes from staff using the station screens.

## 6. Files touched (all server-side)

| # | File | Change | Risk |
|---|---|---|---|
| 1 | `server/services/flow/autoCreate.js` *(new)* | `createFlowVisitFromAppointment()` + `reconcileBillingSteps()` | New code, additive |
| 2 | `server/services/cron/healthraySync.js` | In `syncAppointmentStatuses`, call (1) when `checkedin`/`in_visit` + flag on + no visit; call reconcile for existing auto-visits | Behind flag; guarded |
| 3 | `server/routes/flow.js` | Refactor `POST /flow/from-appointment` to delegate to (1) — **no behavior change** | Pure refactor; covered by manual test |
| 4 | `docs/FLOW_AUTO_CREATE_PLAN.md` *(this file)* + `.env.example` flag note | Document + env flag | Docs only |

No migrations. No schema changes (all needed columns already exist: `flow_visits.appointment_id`,
`flow_visit_steps.data`, `appointments.healthray_patient_id` / `bill_paid` / `bill_created`).

## 7. Data-Safety Guarantees (the "must not affect other data" requirement)

This is the controlling constraint. The design enforces it as follows:

1. **Additive only — no destructive SQL.** The feature only ever runs `INSERT INTO
   flow_visits` / `flow_visit_steps` and the *existing* status `UPDATE`s in
   `syncFlowFromAppointment`. It issues **no `DELETE`**, no `TRUNCATE`, no bulk `UPDATE`,
   and touches no table other than `flow_visits`, `flow_visit_steps`, `flow_events`
   (audit), and the already-written `appointments.status`.

2. **Strictly scoped by `appointment_id` / `visit_id`.** Every write is parameterized to a
   single appointment or its single visit. There is no statement that can fan out across
   other patients (no `WHERE visit_date=...` mass update introduced).

3. **Idempotent — safe to run every tick.** Creation is guarded by the existing
   "one non-cancelled visit per `appointment_id`" check; billing reconciliation dedupes by
   `step_catalog_id` / `step_name`. Re-running the sync produces **no duplicates** and no
   second visit.

4. **Never overwrites a manual check-in.** If reception already created a visit (manual
   `/flow/checkin` or `/flow/from-appointment`), the idempotency guard makes auto-create a
   no-op for that appointment. Manual data always wins; we never edit or replace it.
   *(Edge case handled: a patient-id-only manual check-in is linked to its appointment via
   the existing `ensureFlowAppointment()`, and the guard additionally checks
   `patient_db_id + visit_date` to avoid a twin visit.)*

5. **Transactional.** Creation runs inside the existing `BEGIN … COMMIT` block (as the
   route does today). A failure rolls back the whole visit+steps insert — no half-created
   journeys.

6. **Off by default.** Gated behind env **`FLOW_AUTO_CREATE=1`**. With the flag unset the
   code path is inert and the system behaves exactly as it does today. Enable on the worker
   only, watch a few patients, then leave on.

7. **No new HealthRay load / WAF risk.** Billing fetches reuse `gatedFetch`
   (token-bucket + concurrency gate + cooldown). Reconciliation is throttled to stop polling
   once tests are injected, so a patient is billed-checked at most a few times, not every tick.

8. **Worker-only writes.** Cron runs in the worker process (`server/worker.js`); it already
   owns `ensureSyncColumns()` and the shared advisory lock, so no cross-process write races
   are introduced.

9. **Reversible.** Rollback = set `FLOW_AUTO_CREATE=0` (instant) or revert the commit. Any
   visits already auto-created remain valid, normal flow visits — nothing to clean up. If
   desired, they are identifiable by `checked_in_by = 'auto:healthray'`.

## 8. Decisions (defaults chosen; change before build if needed)

1. **Scope — all OPD patients.** Per the request ("whenever *any* patient" reaches
   checkedin/in_visit), the board will auto-populate with **every** OPD patient, not just
   ones reception picked. *Default: yes, all.* (If you want a subset, gate by doctor or
   visit_type.)
2. **Already-finished patients — skip.** If the *first* time we ever see a patient they are
   already `completed`, **do not** auto-create (avoids re-introducing a fake `0m` row).
   *Default: skip.* Only patients we observe at `checkedin`/`in_visit` get a live visit.
3. **Roll-out — behind `FLOW_AUTO_CREATE=1`, off by default.** *Default: flagged.*

## 9. Verification

1. **Live create:** pick a patient currently "Waiting" in HealthRay with no flow visit →
   run one sync tick → a `flow_visits` row appears (`status=in_progress`, step 1
   `in_progress` with `started_at` set, `checkin_time ≈ now`, `checked_in_by='auto:healthray'`).
2. **Advance:** push them to "Engaged" → pre-doctor steps complete with real
   `actual_duration_min`; doctor step goes `in_progress`.
3. **Billing inject:** add a bill with lab tests → `reconcileBillingSteps` inserts a single
   "Blood Sample" step before Billing, `data.from_billing=true`; run twice → still one.
4. **Complete:** mark Checkout in HealthRay → visit `completed`, **elapsed > 0**, per-step
   timestamps spread over real time.
5. **Idempotency:** run the sync loop repeatedly → no duplicate visit or steps.
6. **No-regression:** manual `/flow/checkin` and `/flow/from-appointment` still work; when a
   manual check-in and auto-create race the same appointment, exactly **one** visit exists.
7. **Isolation:** confirm no other patient's `flow_visits` / steps / `appointments` rows
   changed during the run (diff `updated_at` set before/after a tick — only the targeted
   appointment's rows move).
8. **WAF:** worker/API logs show no new 403 burst (billing fetch gated + throttled).

## 10. Rollback

- Instant: `FLOW_AUTO_CREATE=0` and restart the worker.
- Full: revert the commit. Auto-created visits remain valid; optional cleanup query (only if
  ever wanted): delete `flow_visits WHERE checked_in_by='auto:healthray'` — **not required**.
