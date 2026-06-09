# 06 — Rollout Plan, Testing & Acceptance

Ship in phases so enforcement never surprises live booking. Each phase is
independently deployable; enforcement stays `off` until data is clean.

---

## Phase 0 — Audit & decisions (no code)
- [ ] Run the unresolved-name audit (Doc 01 §0): every distinct
      `appointments.doctor_name` must resolve to a `doctors` row, or be
      knowingly legacy. Fix names / add short_names / add doctors.
- [ ] Confirm the 5 open decisions in Doc 00 §6 (granularity, strictness,
      reassignment selection, notifications, scope). Owner sign-off.
- [ ] Confirm the canonical weekly hours per active doctor with the clinic
      (source data for seeding Phase 2).
- [ ] Coordinate with the prod-schema owner: the `appointments` `CREATE TABLE`
      and its unique `ON CONFLICT` index live in the production DB, **not** in
      this repo (verified). Confirm the live column list and agree how the
      optional `doctor_id` column/index lands.

**Exit:** zero *unexpected* unresolved doctor names; decisions signed off; prod
schema owner aligned.

---

## Phase 1 — Schema + resolver (backend, dormant)
- [ ] Migrations (Doc 01): `resolve_doctor_id()`, `slot_catalog` (+seed from
      `TIME_SLOTS`), `doctor_weekly_schedule`, `doctor_recurring_breaks`,
      `doctor_unavailability`, `appointment_reassignments`.
- [ ] `server/services/availability.js` with `isSlotAvailable`,
      `getDoctorDayAvailability`, `findAvailableDoctors`,
      `getAffectedAssignments` + unit tests (Doc 02 §7).
- [ ] Feature flag `SCHEDULE_ENFORCEMENT=off` (default). No write-path change
      visible yet.

**Exit:** resolver unit tests green; tables present; booking behaves exactly as
before (flag off).

---

## Phase 2 — Schedule data entry (admin UI + read APIs)
- [ ] Schedule/breaks/leave routes (Doc 03 §1–5) + schemas.
- [ ] `DoctorManagementPage` tabs 1–3 + Day-Availability tab (Doc 05).
- [ ] Seed each active doctor's weekly schedule + standing breaks (lunch).
- [ ] Reception/admin can view per-doctor day availability.

**Exit:** every active doctor has a weekly schedule + breaks entered and
verifiable in Tab 5.

---

## Phase 3 — Enforcement (warn → strict)
- [ ] Wire `isSlotAvailable` into `POST /appointments` + `PUT /appointments/:id`
      behind the flag (Doc 03 §7).
- [ ] Booking UIs (GHM/OPD/companion) fetch availability + grey unavailable
      slots; handle `409` (Doc 05 §4).
- [ ] Deploy with `SCHEDULE_ENFORCEMENT=warn` for ~1 week — log every would-be
      block, review false positives (usually unresolved names or missing
      schedule rows).
- [ ] Flip to `strict` once warn logs are clean. ADMIN `force=true` override
      remains.

**Exit:** unavailable bookings are rejected (or overridden+audited); no
legitimate booking is blocked by a data gap.

---

## Phase 4 — Emergency leave + reassignment
- [ ] `POST /doctors/:id/emergency-leave`, `POST /appointments/reassign`,
      `PUT /appointments/:id/reassign` (Doc 03 §6).
- [ ] Reassignment screen + Emergency tab (Doc 05 §3–4).
- [ ] `appointment_reassignments` audit populated; `reassignment_done` lifecycle.
- [ ] Park-for-CC path for un-reassignable patients (Doc 04).

**Exit:** an emergency leave surfaces all affected patients and moves them with
a full audit trail; no patient stranded on the unavailable doctor.

---

## Phase 5 — Notifications (deferred hook → sender)
- [ ] Wire `appointment_reassignments.patient_notified=false` rows into the
      existing MSG91 / push layer (`server/services/msg91.js`,
      `pushNotifier.js`). Out of scope for v1 *logic* but the hook exists from
      Phase 4.

---

## Testing strategy

**Unit (resolver):** the full matrix in Doc 02 §7.

**Integration (API):**
- Booking blocked on each reason (`not_working`/`holiday`/`break`/`leave`/
  `emergency`/`manual_block`/`full`); `force` override path.
- Emergency leave returns correct affected set (incl. short_name matches,
  excludes cancelled/no_show/completed, flags in-progress).
- Bulk reassign: success, partial (target_full), idempotent re-apply.
- Concurrency: two reassigns of one appointment; two bookings racing the last
  capacity slot.

**Data-safety:**
- Re-run every migration twice (idempotency).
- Verify existing `appointment_slots` / `clinic_holidays` reads still pass.
- Snapshot `appointments` row counts before/after migrations (must be equal).

**Manual smoke (use `/verify` skill):**
- Add leave with existing bookings → prompted to reassign.
- Lunch break greys the 1–2 PM slot in the booking grid.
- Emergency leave for "rest of today" → reassignment screen → all moved →
  audit rows present.

---

## Acceptance criteria (definition of done)

1. Each doctor has editable weekly working hours, recurring breaks, and
   leave/holiday windows.
2. The booking API **rejects** assigning a patient to a doctor who is not
   working / on break / on leave / on a clinic holiday / at capacity — with a
   clear reason (admin override audited).
3. Booking UI only offers available slots; shows reasons for the rest.
4. Declaring emergency leave lists **every** already-assigned patient in the
   window and lets staff reassign them (single or bulk) to available doctors,
   with ranked suggestions.
5. Every reassignment is recorded in `appointment_reassignments`; no patient is
   silently left on the unavailable doctor.
6. Zero destructive change to existing tables; rollback = drop new tables +
   flag `off`.

---

## Risk register

| Risk | Mitigation |
|------|------------|
| Unresolved `doctor_name` silently bypasses rules | Phase-0 audit gate; warn phase logs; pass-through only for known-legacy names. |
| Enforcement blocks real bookings (missing schedule rows) | `warn` phase before `strict`; seed all doctors in Phase 2; ADMIN `force`. |
| Slot label drift between catalog and legacy rows | Seed catalog with the **exact** existing `TIME_SLOTS` strings; FK on `slot_label`. |
| Reassignment overflows target doctor | Per-row re-check in the apply transaction; partial-failure reporting. |
| Capacity double-counting (name vs short_name) | All counts use `doctor_name = ANY([name, short_name])`. |
| Cancelling leave doesn't revert moves (surprise) | Documented (Doc 04 #9); audit trail enables manual revert. |

---

## File-change map (when implementation starts)

| Area | New / changed |
|------|---------------|
| Migrations | `server/migrations/2026-06-XX_*.sql` (6 files, Doc 01) |
| Service | `server/services/availability.js` (new) |
| Routes | `server/routes/doctorSchedule.js` (new); edits to `appointments.js`, `appointment-slots.js` |
| Schemas | `server/schemas/index.js` (5 new schemas, Doc 03 §9) |
| Mount | `server/index.js` (`app.use("/api", doctorScheduleRoutes)`) |
| Permissions | `shared/permissions.js` (optional `SCHEDULE_MANAGE` capability) |
| Frontend | `src/pages/DoctorManagementPage.jsx` (+css), route in `src/router.jsx`, nav in `AppLayout.jsx`; availability fetch in `GHMPage.jsx`/`OPD.jsx`/`DoctorSelect.jsx` |
| Config | `SCHEDULE_ENFORCEMENT` flag (env, read in `appointments.js`) |
