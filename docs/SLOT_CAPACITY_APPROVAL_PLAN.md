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
   🛠 Built on the e2e DB 2026-10-23, not deployed:
   - **Who is New (decision 2026-10-23, option A):** walk-in if marked; otherwise a patient with an earlier attended visit (`appointment_patient_came_before`, the same function as the returning-patient triggers) is a follow-up and anyone else is new, whatever `visit_type` says. A booking with no patient record is new unless its visit type says follow-up. `shared/slotCapacity.js` `patientTypeSql`.
   - `server/services/slots/capacityGuard.js`: after a Scribe booking is written, if its type is now over the slot's limit, a `booking_approvals` row is added — `pending`, or `approved` straight away when the person booking has `BOOKING_APPROVE` (admin, reception admin). HealthRay bookings, past dates, done/cancelled bookings and slots without limits are skipped. Hooked into `POST/PUT /appointments` (OPD, Find, Dashboard) and `POST/PATCH /ghm-appointments` (when date, slot or doctor change). Reassign into a slot already at its limit for that type is refused (`target_over_limit`).
   - Migration `2026-10-23_booking_approvals_withdraw.sql`: a pending request is withdrawn automatically when its booking is cancelled, marked no-show, or moved to another date, time or doctor — on every path, syncs included. **Applied to the e2e DB only.**
   - New permission `BOOKING_APPROVE` (admin via ALL, reception admin).
   - Screens: one `GET /booking-approvals/latest?ids=` per list; `ApprovalBadge` on OPD rows and the GHM visit-type cell (Pending approval / Approved over limit / Rejected — choose another slot); each booking form shows "Booked, pending admin approval…" after saving.
   - Tests: `G122` (7), `G114` 15 updated for the new rule.
4. Approvals screen.
   🛠 Built on the e2e DB 2026-10-23, not deployed: page `/booking-approvals` (`BOOKING_APPROVE`: admin, reception admin), nav tab "✅ Approvals", "Approvals (N)" button on Staff Management. Pending list (overdue first, red "Overdue" label) shows patient name, file no, Health ID, doctor, date and slot, "3rd new patient · limit 1", who requested and when; Decided tab shows the last 30 days with who decided and the reason. Approve keeps the booking; Reject (reason required, dialog names patient, doctor, slot) clears the slot, keeps date and doctor, and logs both changes in the booking's change log. A request can only be decided once (409 after). API: `GET /booking-approvals`, `GET /booking-approvals/count`, `POST /booking-approvals/:id/approve`, `POST /booking-approvals/:id/reject`. Tests: `G122` 8–10.
   - Fixed while testing: the "is the approvals table there" check raced when two requests arrived together and returned an empty list; it now shares one in-flight check.
Each step tested before the next; nothing deployed or committed without a go-ahead.

## 10. Decisions (2026-10-22)

1. **Who approves:** admin and reception admin. New capability `BOOKING_APPROVE` in `shared/permissions.js`, granted to `admin` and `reception_admin`, checked on the server routes and used to show the Approvals button.
2. **Telling staff:** the badge on the booking only — Pending approval → Approved, or Rejected — choose another slot (with the reason) — on OPD, GHM and reception rows.
3. **Still pending on the day:** stays pending; shown as **Overdue** (red, top of the Approvals list). Nothing is decided automatically.
4. **Admin's own over-limit booking:** saved as approved straight away, with an approval row recording who booked it and that it was over the limit (`decided_by` = the admin, reason "Booked by an admin"). A reception admin's own booking is treated the same (they can approve anyway).

## 11. Merged into Desk requests (2026-10-23)

- The approvals list is now the **Booking limits** tab of `/desk-requests`, next to Billing requests and Test cancellations; each tab shows only to people who can decide it (Booking limits: `BOOKING_APPROVE` — admin, reception admin).
- `/api/approvals/waiting` adds `bookingApprovals`, so the 📥 Desk requests nav badge counts them too. `/booking-approvals` redirects to `/desk-requests?tab=bookings`; the separate nav item is gone; Staff Management's "Approvals (N)" links to the tab.
- Tests updated: `P4B-22` 1 and 4 (new count key; reception admin now sees two tabs), `G122` 10.

## 12. Checked at the moment a slot is picked (2026-10-23)

Decisions: reassign into a full slot is allowed with the same dialog and an approval record (was refused); approvers still see a short confirmation; the list shows all types until a patient is chosen, then only that patient's type; changing patient/date/doctor updates the list silently. A slot with no limit set is unlimited.

- `GET /availability/day` takes the patient (`patient_id`, `file_no`, `walkin=1`, `visit_type`, and `exclude=<appointment>` when changing an existing booking so it doesn't count itself) and returns `patient_type` and per-slot `over_limit {patient_type, limit, count}`.
- `GET /availability/doctors-for-slot?appointment=` marks each suggested doctor's `over_limit` for that booking's patient and lists full ones last; Reassign auto-fill skips them.
- `applyMove` no longer refuses; it records an approval (reassign is admin-only, so it is approved under the admin's name).
- One dialog (`src/components/booking/OverLimitDialog.jsx`): "10 AM to 10:30 AM is full for new patients · The limit is 3 … Choose another slot / Book and send for approval" (approvers: "Book over the limit"). Wired into OPD → New appointment, GHM → New appointment and Edit booking, Find → Quick book, Patient dashboard → Book, and Reassign patients.
- Slot labels: before a patient is chosen "New 2/3 · Follow-up 2/2 full · Walk-in 1/5"; after, only theirs: "Follow-up 2/2 full · over the limit".
- Tests: `G122` 7 (reassign allowed and recorded), 11 (type-aware list, exclude, unlimited doctor), 12 (Find: dialog → choose another / book and send → pending).

## 13. GHM Time Slot column from the schedule (setting, 2026-10-23)

- Settings → Patient Flow → **GHM time slots**: "Use each consultant's own time slots in GHM" (`giniflow_floor_settings` key `ghm_slots_from_schedule`, default off — no migration; a missing row reads as off).
- Off: unchanged — twelve one-hour windows with the hourly count badge.
- On: each GHM row lists its consultant's slots for that row's date (preferred doctor/date, else booked), from `GET /api/availability/days?pairs=doctor|date,…` (one request per screen, up to 60 pairs). Breaks/leave/day off greyed out with the reason; badge = patients in the slot, red when any type is at its limit, tooltip with the per-type counts. Rows with no consultant, or whose consultant has no schedule, keep the one-hour windows. A stored time not in the list (e.g. a HealthRay "10:40") stays shown.
- The column is still the patient's **preferred time** (a note); picking one doesn't book, so no approval dialog here.
- GHM users read the switch through `GET /api/ghm-appointments/display-settings`. Test: `G122` 13.

## 14. GHM "Consultant slots" panel (2026-10-23)

- GHM Ops header button **Consultant slots** (next to New Appointment) opens a read-only panel: pick a consultant and a day (‹ › to step), see every slot with patients booked and "New 2/3 · Follow-up 1/2 full · Walk-in 0/5" (red when full) or "No limit"; breaks show their reason, leave/holiday/day off are greyed. Summary line: open slots, patients booked, slots full for at least one type.
- Uses `GET /api/availability/day` by name, which reception and OBT can already read. `src/components/ghm/ConsultantSlotsPanel.jsx`. Test: `G122` 14 (as OBT).
- The panel now opens docked on the left (non-modal) and has a **Search consultant** box that narrows the list and picks the consultant when only one matches.

## 15. GHM Time Slot column moves the booking and asks first (2026-10-23)

- On a booking for today or later (not completed/cancelled/no-show, no Preferred Date on another day), changing **Time Slot** moves the booking's own `time_slot`; before, it only wrote `preferred_time_slot`, which the list never shows for a current booking, so the change snapped back. Clearing the column never un-books. Past visits still only change their preferred time. Test: `G26`.
- Before saving, the column checks the slot fresh for that patient's type and opens the same over-limit dialog as the booking forms.

## 16. Reason for booking over the limit (2026-10-23)

- The over-limit dialog asks "Why does the patient need this slot?" (≤300 characters). Required when the booking goes for approval; optional for admins and reception admins, whose booking is approved straight away.
- Sent as `over_limit_reason` by every booking path (OPD, Find, Dashboard, GHM new/edit/Time Slot column, Reassign) and stored in `booking_approvals.request_reason` (migration `2026-10-23_slot_capacity_request_reason.sql`; the decide-once trigger also locks it). Code reads and writes it only once the column exists, so screens keep working before the migration.
- Shown to approvers on Desk requests → Booking limits under "Over the limit" (or "No reason given"), in the reject confirmation, and in the row badge's tooltip. Test: `G122` 10 and 12.

## 17. GHM Time Slot count = real bookings (2026-10-23)

- The number beside each hour in GHM's Time Slot list (`GET /api/ghm-appointments/slot-counts`) now counts only real bookings, the same way as the Consultant slots panel: the booking's `time_slot`, cancelled and no-show left out. Patients who only gave a preferred time, and the reporting-time fallback, are no longer added in.

## 18. Requester sees the decision on GHM Ops (2026-10-23)

- Decided by the user: shown only on GHM Ops, only to the person who requested, dismissed with one click (nothing recorded).
- `GET /api/booking-approvals/mine` (anyone who can reach the approvals routes: reception, OBT, approvers) returns the caller's requests approved or rejected in the last 7 days, leaving out self-approved bookings.
- GHM Ops shows "Your booking requests: N decided" above the tabs, refreshed every minute. Approved → "Tell the patient their slot is confirmed." Rejected → the admin's reason and "Call the patient and book another slot", or "Already rebooked at X" once the desk has picked a new slot. **Show in sheet** jumps to that date filtered by the file no; **Dismiss** hides it in this browser (localStorage per user). `src/components/ghm/DecidedRequests.jsx`.
