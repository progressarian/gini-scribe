# Flow ↔ OPD/GHM Integration — Wiring Plan

**Status:** PLAN for review (no code yet)
**Date:** 2026-06-15
**Goal:** Make the Patient Flow module (`/flow/*`) and the existing OPD/GHM pages feed each other, so the flow stops being a parallel silo and becomes the live floor layer on top of the real OPD day.

> **IMPLEMENTATION STATUS (2026-06-15):**
> - ✅ **Bridge B (walk-ins → OPD/GHM)** — built & verified. Flow check-in links an existing appointment, or **creates one** (`booking_source='flow'`, `status='checkedin'`) when none exists, so walk-ins/new patients appear in OPD/GHM. Behind `FLOW_CREATE_APPOINTMENTS` (default on). Confirmed it shows in the today OPD list query.
> - ✅ **Bridge A backend** — `POST /api/flow/from-appointment/:id` (idempotent, builds journey, links appt, prefills SD). Verified.
> - ✅ **Bridge D backend** — `GET /api/flow/by-appointments?date=` (appointment_id → current step / pct / urgency). Verified.
> - ✅ **Bridge C (flow → appt status)** — checkedin/in_visit/completed forward-only sync (done earlier).
> - ✅ **New + Walk-in form** — added Age + Sex fields (registers new patients properly, matching the OPD new-appt form). Patient create now passes age/sex.
> - ✅ **Frontend hooks** — `useFlowByAppointments`, `useFlowStartFromAppointment`.
> - ⏳ **Remaining (frontend UI on the large OPD/GHM pages):** the **"Start flow" button** + **live flow chip** on each OPD (`LiveDashboard.jsx`) and GHM (`GHMPage.jsx`) row (Bridge A/D *frontend*), and **Bridge C reverse** (cancel the flow visit when its appointment is cancelled/no_show). Backend + hooks are ready; this is wiring the button/chip into those two big components.

---

## 0. Where we are today

| Already wired | Detail |
|---|---|
| Shared entities | Flow reuses `patients`, `doctors`, login/roles. |
| Appointment **link** | `flow_visits.appointment_id` → `appointments.id` (set when reception checks in a patient who already has a today appointment). |
| Check-in **prefill** | Flow check-in reads the patient's today appointment for time/type/doctor. |
| Status **sync** (flow → appt) | When a *linked* flow visit advances, the appointment status moves `checkedin → in_visit → completed` (forward-only, no UPDATE trigger, safe). |
| Clinical panels | SD/Chief/Pharmacy clinical views show the `FlowPanel`. |

### The gap (what makes it feel like an island)
1. **OPD/GHM → Flow is manual.** A booked appointment does **not** create a flow visit. Reception must separately search the patient in `/flow/checkin`.
2. **Flow → OPD is absent for non-appointment patients.** A flow check-in for a **walk-in / new** patient creates **no** appointment row, so it never appears in OPD/GHM.
3. **OPD/GHM rows don't show flow progress** beyond the coarse status column.

This plan closes those three with four bridges.

---

## 1. Key technical facts (verified) that shape the plan

- **`appointments` has an AFTER INSERT trigger** `trg_appt_notify_insert` → `NOTIFY appt_inserted` → `appointmentInsertListener` → `backfillPatientOpd(patient_id)` (HealthRay OPD enrichment). It is **skipped** when `source='healthray'` or `healthray_id` is set.
  - **Implication:** inserting an appointment from flow fires the *same* backfill that a **GHM walk-in booking already triggers** today. So creating appointments from flow is **not novel risk** — it behaves like an existing walk-in insert. (Bridge B is feasible.)
- **No UPDATE trigger on `appointments`.** Updating `status` is safe (already used by the flow status sync).
- **`appointments` relevant columns:** `status`, `source`, `booking_source`, `appointment_type`, `visit_type`, `time_slot`, `reporting_time_slot`, `doctor_name`, `patient_id`, `file_no`, `patient_name`, `phone`, `appointment_date`.
- **OPD status pipeline:** `scheduled → checkedin → in_visit → seen → completed`. The route `PATCH /appointments/:id` does heavy work on **`seen`** (auto-creates a consultation, links records, HealthRay sync). **Flow must never set `seen`** via SQL — it stays in the `checkedin/in_visit/completed` lane (already the case).
- **`/opd`** reads `GET /api/opd/appointments`; **`/ghm`** reads the GHM appointment routes. Both render off the `appointments` table.

---

## 2. The four bridges

### Bridge A — OPD/GHM → Flow ("Start flow" button)  ★ highest value, lowest risk
**What:** On each appointment row in OPD and/or GHM, add a **"Start flow"** action. Clicking it creates a `flow_visits` (+ default journey steps) for that patient, **linked** to the appointment, and (optionally) opens the check-in/journey builder pre-filled.

**Why safe:** it only **reads** the appointment and **writes flow_ tables** (+ links). No appointment row is created; at most the linked appointment's status moves to `checkedin` (which the flow status-sync already does).

**Backend (new):**
- `POST /api/flow/from-appointment/:appointmentId` — server-side:
  1. Load the appointment (patient, file_no, visit_type, doctor, time).
  2. Resolve patient → `patient_db_id`.
  3. Map `appointment.visit_type` → a flow `visit_type_id` (follow-up/new × tests). (Reuse the mapping logic already in the check-in UI.)
  4. Expand the default journey from `flow_step_templates`.
  5. Pre-assign SD from `appointment.doctor_name`, MO/Chief from patient history (reuse the check-in derivation).
  6. Call the existing check-in logic with `appointment_id` set.
  7. Idempotency: if a flow visit already exists for this `appointment_id` today, return it instead of duplicating.

**Frontend:**
- Add a small **"▶ Start flow"** button to the OPD row (`LiveDashboard.jsx`) and the GHM row (`GHMPage.jsx`). On click → call the endpoint → toast + (option) navigate to `/flow/coordinator` or open the check-in pre-filled for review.
- Show a **"in flow"** chip on rows that already have a linked flow visit (so staff don't double-start).

**Decision needed:** *one-click create* (instant, uses defaults) **vs** *open check-in pre-filled* (reception reviews the journey before confirming). Recommend: **open pre-filled** for appointment patients (lets reception tweak the journey), with a "Quick start (defaults)" option.

---

### Bridge B — Flow → OPD (walk-ins create an appointment)
**What:** When a flow check-in is for a patient **without** a today appointment (walk-in / new), also create an `appointments` row so they appear in OPD/GHM.

**Why acceptable:** this is exactly what GHM walk-in booking already does (insert → backfill trigger). Mark the row `booking_source='flow'` (and `source` left null so the backfill still runs like a walk-in).

**Backend (extend `/api/flow/checkin`):**
- After creating the flow visit, **if `appointment_id` is null**, insert an `appointments` row:
  - `patient_id` (db id), `file_no`, `patient_name`, `phone`, `appointment_date=today`, `time_slot`/`reporting_time_slot` from the check-in time, `doctor_name` = assigned SD, `visit_type` from the flow type, `status='checkedin'`, `booking_source='flow'`.
  - Capture the new appointment id back into `flow_visits.appointment_id` (so the link + status sync work from then on).
- Make it **best-effort + behind a flag** (`FLOW_CREATE_APPOINTMENTS=true`) so it can be turned off if the clinic doesn't want walk-ins in OPD.

**Risks / to verify before building:**
- The INSERT trigger calls `backfillPatientOpd` — confirm it's a no-op/harmless for a patient with **no HealthRay data** (likely: it tries HealthRay, finds nothing, exits). Test with a throwaway patient.
- Google-Sheets / no-show sync: confirm a `booking_source='flow'` row isn't picked up by any sheet export. (Grep `sheetsSync`/`todaysShowSync` for source filters.)
- Avoid duplicates: only insert when there's truly no today appointment for that patient.

**Decision needed:** do walk-ins belong in OPD/GHM at all? (Some clinics keep walk-ins separate.) → the feature flag answers this per-clinic.

---

### Bridge C — Status sync completeness (mostly done)
**What's done:** flow advance → appointment `checkedin / in_visit / completed` (forward-only).
**To add/decide:**
- **Pharmacy exit → `completed`** is done. Decide whether flow completion should also set OPD `seen` — **No** (seen has clinical side effects); leave `seen` to the clinical "mark seen" action. Document this boundary.
- **Reverse direction (OPD → flow):** if OPD marks an appointment `cancelled`/`no_show`, should the linked flow visit be cancelled too? Recommend: yes — add a small hook (or a periodic reconcile) to cancel the flow visit when its appointment is cancelled. *(Optional, phase 2.)*

---

### Bridge D — OPD/GHM rows show live flow progress (read-only mirror)
**What:** Beyond the status column, show the patient's current **flow stage** on the OPD/GHM row (e.g., a small "🔬 Lab · 62/90m" chip).
**Backend:** a light `GET /api/flow/by-appointments?date=` → `{ [appointment_id]: { current_step, pct_elapsed, urgency, remaining_min } }`.
**Frontend:** OPD/GHM fetch it once and render a chip per row for appointments that have a linked flow visit. (Read-only; no writes.)
**Note:** `LiveDashboard.jsx` is large (~1500 lines) — inject a single compact cell, don't restructure the table.

---

## 3. Data-model touchpoints

| Table | Change |
|---|---|
| `flow_visits.appointment_id` | Already exists. Becomes always-populated (Bridge A sets it; Bridge B back-fills it). |
| `appointments.booking_source` | Already exists. Use `'flow'` for flow-created walk-ins (Bridge B). |
| `appointments` | No schema change. Only INSERT (Bridge B, flagged) + UPDATE status (existing sync). |
| New endpoints | `POST /api/flow/from-appointment/:id`, `GET /api/flow/by-appointments`. Extend `POST /api/flow/checkin` (Bridge B). |

No new tables. No destructive changes.

---

## 4. Build order (phased, each shippable)

**Phase 1 — Bridge A (OPD/GHM → Flow):** the cohesion win.
- [ ] `POST /api/flow/from-appointment/:id` (+ idempotency, visit-type mapping, journey expansion, care-team prefill).
- [ ] "Start flow" button + "in flow" chip on GHM rows (`GHMPage.jsx` — simpler than OPD).
- [ ] Same button on OPD rows (`LiveDashboard.jsx`).
- [ ] Verify: booked patient → one click → appears on Flow Floor, linked, status `checkedin`.

**Phase 2 — Bridge D (OPD/GHM shows flow progress):** visibility.
- [ ] `GET /api/flow/by-appointments`.
- [ ] Compact flow chip on OPD + GHM rows.

**Phase 3 — Bridge B (walk-ins → OPD), behind `FLOW_CREATE_APPOINTMENTS` flag:** the riskier one.
- [ ] Pre-work: verify backfill trigger + sheets sync behaviour for a `booking_source='flow'` insert (throwaway test).
- [ ] Extend `/api/flow/checkin` to insert + link the appointment when none exists.
- [ ] Verify walk-in appears in OPD/GHM and advances status correctly.

**Phase 4 — Bridge C extras (reverse cancel/no-show sync):** polish.
- [ ] Cancel the linked flow visit when its appointment is cancelled/no-show.

---

## 5. Risks & decisions to confirm before coding

1. **[DECISION] Bridge A UX:** one-click-with-defaults vs open-check-in-prefilled (recommend prefilled + a quick-start option).
2. **[DECISION] Bridge B in scope?** Should flow walk-ins appear in OPD/GHM? (Feature-flagged either way.)
3. **[VERIFY] Backfill trigger** is harmless for a no-HealthRay walk-in insert. (Test in Phase 3 pre-work.)
4. **[VERIFY] Sheets/no-show sync** ignores `booking_source='flow'` rows (or filter them out).
5. **[BOUNDARY] Flow never sets appointment `seen`** — that stays a clinical action (it auto-creates the consultation). Documented; keep the sync in the `checkedin/in_visit/completed` lane.
6. **Idempotency everywhere:** "Start flow" twice → one flow visit; check-in for an already-appointmented patient → link, don't create a second appointment.
7. **OPD page size:** inject minimal cells/buttons into `LiveDashboard.jsx`; avoid refactoring the large table.

---

## 6. End state (what "wired" looks like)

- Reception sees the booked OPD/GHM day → clicks **Start flow** on a patient → that patient is on the **Flow Floor** with their journey, linked to the appointment.
- As they move Vitals → MO → SD → Pharmacy, the **OPD/GHM status** advances `checkedin → in_visit → completed` automatically, and the row shows a **live flow chip**.
- A **walk-in** checked in via `/flow/checkin` (if the flag is on) also shows up in OPD/GHM as a `booking_source='flow'` appointment.
- Net: one patient, one record, visible in both the **clinical day list (OPD/GHM)** and the **live floor (Flow)** — no double entry, no silo.

---

### Appendix — files this will touch (for estimation)
- **Backend:** `server/routes/flow.js` (new endpoints + checkin extension), maybe `server/services/flow/` helper for appointment↔flow mapping. No migrations (columns already exist).
- **Frontend:** `src/components/opd/LiveDashboard.jsx` (button + chip), `src/pages/GHMPage.jsx` (button + chip), small flow hook in `src/queries/hooks/useFlow.js`.
- **Config:** `FLOW_CREATE_APPOINTMENTS` env flag (Bridge B).
</content>
