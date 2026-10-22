# Slot capacity by patient type, with admin approval

Status: plan, not built. Builds on `docs/DOCTOR_SLOT_TEMPLATES_PLAN.md` (weekly schedule templates, steps 1–6 + bulk schedule).

## 1. What is asked

- In a consultant's weekly schedule, each block of working hours can limit **per slot**: new patients, follow-ups, walk-ins. Example: Mon 09:00–13:00, 30-min slots, per slot **3 new, 2 follow-up, 5 walk-in**. Blank = no limit.
- **No borrowing**: each type has its own limit; a free new-patient place can't be used by a follow-up.
- Walk-in number = **maximum walk-ins accepted** in that slot (nothing is held back for them).
- When a booking would go over its type's limit, it is **not refused and not silently accepted**: it is saved as **Pending approval**. An admin approves (the booking stays in that slot) or rejects (staff must choose another slot). Until the decision, the booking shows "Pending approval" everywhere it appears.
- This applies regardless of `SCHEDULE_ENFORCEMENT` (that setting keeps governing hours/breaks/leave only).

## 2. Who counts as what

One shared rule in `shared/slotCapacity.js`, used by server and screens:

| Type | Rule |
|---|---|
| Walk-in | `appointments.is_walkin = true` |
| New | not a walk-in and `isNewVisitType(visit_type)` (existing rule in `shared/patientLists.js`; the "returning patient is never New" DB triggers already correct `visit_type`) |
| Follow-up | everything else |

Counted in the slot that holds the booking's time (labels, `HH:MM` HealthRay times and sheet ranges — same `homeIn` placement the resolver uses). Cancelled / no-show / rejected bookings don't count. **Pending bookings count** (so two people can't both slip into the last place), approved ones count, HealthRay bookings count.

## 3. Data (one additive migration)

- `doctor_slot_template_hours`: `cap_new`, `cap_followup`, `cap_walkin` — `INTEGER NULL CHECK (>= 0)`. Null = no limit. Old versions keep null (no limits), so nothing changes on deploy.
- New table `booking_approvals`: `id`, `appointment_id` (FK, unique while pending), `doctor_id`, `appointment_date`, `slot_label`, `patient_type` (`new|followup|walkin`), `limit_at_request`, `count_at_request`, `status` (`pending|approved|rejected|withdrawn`), `requested_by`, `requested_at`, `decided_by`, `decided_at`, `reason`. RLS forced, anon revoked, like the template tables. Every decision is kept (audit).
- `appointments` gets no new status value (many lists and the HealthRay/Sheets syncs filter on `status`); "pending" lives on the approval row and is joined where shown.

## 4. Booking flow

1. Slot picker (OPD, GHM ×2, Find, Dashboard) shows per slot: `New 2/3 · Follow-up 2/2 full · Walk-in 1/5`. A full type is still selectable, marked **"Full — needs admin approval"**.
2. Saving into a full type: the appointment is created/moved as today **plus** a `pending` approval row. Response says `pending_approval: true`; the screen shows "Booked — pending admin approval" (not a plain success).
3. Lists that show bookings (OPD, GHM, reception arrivals) show a **Pending approval** badge on that row.
4. Admin decides:
   - **Approve** → approval `approved`; nothing else changes.
   - **Reject** (reason required) → approval `rejected`; the booking keeps its date and doctor but its slot is cleared, and it shows **"Rejected — choose another slot"** with the reason. Choosing a new slot runs the same check again (may become pending again).
5. If the booking is cancelled or moved while pending, its approval becomes `withdrawn`.
6. Walk-ins: the walk-in count is checked when a walk-in is added in Scribe (OPD walk-in, reception). Over the limit → the walk-in is still registered (the patient is physically there) with a pending approval, so the floor is not blocked.
7. HealthRay-created bookings and walk-ins are counted but never put to approval (Scribe can't hold or move them); they can push a slot over its limit, which the slot picker then shows.

Paths that run the check: `appointments.js` POST + PATCH (slot/date/doctor change), `ghm-appointments.js` POST + PATCH (via `checkBookingChange`), reassign (`applyMove`: the target slot's limit for that type; over limit → refused with a reason, as reassignment is already an admin action).

## 5. Admin approval screen

- Staff Management header: **Approvals (N)** button next to Bulk schedule (N = pending). Admin only.
- List: patient (name + Health ID), type, doctor, date, slot, "4th new patient — limit 3", requested by / when. Actions: **Approve**, **Reject** (reason dialog). Filters: Pending / Decided.
- The doctor's Booking availability (Schedule tab) shows pending bookings in each slot.

## 6. Schedule editor

- Each block of hours in the weekly editor and Bulk schedule gets **Per slot: New [ ] Follow-up [ ] Walk-in [ ]** (blank = no limit). "Copy Mon to all working days" copies limits too. Version summary/history shows them ("9 AM–1 PM · 30 min · 3 new, 2 FU, 5 walk-in").
- Saving new limits never touches existing bookings; slots already over the new limit just show as over.
- Validation: whole numbers 0–99.

## 7. API

- `GET /availability/day` slots gain `caps: {new, followup, walkin}` and `counts: {new, followup, walkin, pending}`.
- Booking responses gain `pending_approval` + `approval_id`.
- `GET /booking-approvals?status=pending|decided` (admin), `POST /booking-approvals/:id/approve`, `POST /booking-approvals/:id/reject {reason}`.
- Template save/apply accept `capNew/capFollowup/capWalkin` on each hours row.

## 8. Tests

- Unit: type classification; counting by time incl. HealthRay `HH:MM`; pending counts; rejected/cancelled don't.
- e2e API: 4th new patient into a 3-new slot → pending; approve → stays; reject → slot cleared + reason; cancel while pending → withdrawn; follow-up full doesn't block a new patient (no borrowing); HealthRay booking counts but never pending; templates without limits behave exactly as today.
- e2e UI: editor limits fields; slot picker shows counts and "needs admin approval"; Approvals screen approve/reject; badges on OPD/GHM rows.

## 9. Rollout

1. Migration + shared counting + resolver counts (no behaviour change: no limits set anywhere).
   🛠 Built on the e2e DB 2026-10-22, **not on production**: migration `server/migrations/2026-10-23_slot_capacity_approvals.sql` (three `cap_*` columns, `booking_approvals` with a decide-once trigger, RLS forced, anon revoked); `shared/slotCapacity.js` (`patientTypeOf`, `patientTypeSql`, `isFull`); limits flow template → `dayPlan` slot `caps`; `/availability/day` slots gain `caps` and `counts {new, followup, walkin, pending}`; validation 0–99. Reads are safe on a database without the migration (`to_jsonb(h)->>'cap_*'`, `to_regclass` check for `booking_approvals`), so local dev on the production DB keeps working. Nothing writes the new columns or table yet. Unit tests 54/54; old vs new resolver 1432/0.
2. Editor fields (single + bulk) and slot-picker display.
   🛠 Built on the e2e DB 2026-10-22, not deployed: each block of hours has "Patients per slot: New / Follow-up / Walk-in" (blank = no limit, 0–99, errors under the row), in the single editor and Bulk schedule; Copy day / bulk copy carry them; saved schedule and version history show "per slot 3 new, 2 follow-up, 5 walk-in". Saves write `cap_*` only when a limit is set, so schedules without limits still save on a database without the migration. Slot dropdowns (OPD, GHM ×2, Find, Dashboard) and Booking availability show "New 2/3 · Follow-up 2/2 full" through one `slotOptionLabel` / `capacityNote`. Nothing is enforced yet. Tests: `G114` 15, `G117` 8.
   - Open: appointments default `visit_type = 'OPD'`, which the shared rule counts as follow-up — a brand-new patient booked without "New…" counts against the follow-up limit.
3. Pending approvals on all booking paths + badges.
4. Approvals screen.
Each step tested before the next; nothing deployed or committed without a go-ahead.

## 10. Decisions (2026-10-22)

1. **Who approves:** admin and reception admin. New capability `BOOKING_APPROVE` in `shared/permissions.js`, granted to `admin` and `reception_admin`, checked on the server routes and used to show the Approvals button.
2. **Telling staff:** the badge on the booking only — Pending approval → Approved, or Rejected — choose another slot (with the reason) — on OPD, GHM and reception rows.
3. **Still pending on the day:** stays pending; shown as **Overdue** (red, top of the Approvals list). Nothing is decided automatically.
4. **Admin's own over-limit booking:** saved as approved straight away, with an approval row recording who booked it and that it was over the limit (`decided_by` = the admin, reason "Booked by an admin"). A reception admin's own booking is treated the same (they can approve anyway).
