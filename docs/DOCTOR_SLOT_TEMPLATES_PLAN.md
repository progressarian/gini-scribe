# Doctor slot templates — dynamic slots, off days and named breaks

Status: **steps 1–2 done (production)**, steps 3–6 planned · rev 2, 2026-10-22 · Staff Management → Schedule (`/staff-management`)

Rev 2 is the result of reviewing rev 1 against the code. The gaps it closes are listed in §11.

## 1. What is asked

An admin should be able to, without a deploy or a migration:

1. Pick a **start and end time** for a working day and a **slot length** (15, 20, 30, 45, 60 min or a custom number) and have the slots made automatically.
2. Pick the **off days** of the week.
3. Add **named breaks** ("Lunch", "Ward round", "Tea") with a start and end time. No slot is made inside a break.
4. Apply this to **one consultant, several, or all consultants** at once.

## 2. How slots work today, and why that blocks this

| Piece                                   | Where                                                                                                                                                                                             | Problem for this feature                                                                                                                                                                                                                                                                         |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| One **global** slot list                | `slot_catalog` (migrations `2026-06-08`, `-06-09` ×2, `-08-21`)                                                                                                                                   | Every doctor shares the same slots. The day is **mixed**: 30-min slots 09:00–17:00, 1-hour slots 17:00–09:00. Changing it takes a migration.                                                                                                                                                     |
| The same list **hard-coded twice more** | `TIME_SLOTS` in `server/routes/appointment-slots.js` (also served at `GET /appointment-slots/time-slots` and used as a fallback with capacity 5), `SLOT_CATALOG` in `src/lib/slotAvailability.js` | Three copies kept equal by hand.                                                                                                                                                                                                                                                                 |
| Per-doctor profile                      | `doctor_profile` (`off_weekdays`, `work_start/end`, `lunch_start/end`)                                                                                                                            | One window, one unnamed lunch, no slot length. No row = available 24 h, every catalog slot.                                                                                                                                                                                                      |
| Date exceptions                         | `doctor_unavailability` (leave / holiday / emergency / break, `slot_labels`)                                                                                                                      | Part-day entries are stored as **labels** — they stop matching once a doctor's slots change length.                                                                                                                                                                                              |
| Per-date capacity / manual block        | `appointment_slots` (doctor **name** + label + date)                                                                                                                                              | Keyed on label too.                                                                                                                                                                                                                                                                              |
| Bookings                                | `appointments.time_slot` free text                                                                                                                                                                | Three formats in one column: catalog labels (Scribe/GHM), `HH:MM` (HealthRay — `healthray/mappers.js extractTimeSlot`; Google Sheet — `cron/sheetsSync.js mapSheetTimeSlot`), and HealthRay sheet ranges (`05. 1-2PM`). Counts match by exact label, so the last two never count against a slot. |
| Time parser                             | `shared/slotHour.js` (`slotStartTime`) — already reads all three formats; used by `giniflow/appointmentSync.js`                                                                                   | Reusable as is.                                                                                                                                                                                                                                                                                  |
| Resolver                                | `server/services/availability.js` — `isSlotAvailable`, `getDoctorDayAvailability`, `getAffectedAssignments`, `findAvailableDoctors`; routes `/availability/day`, `/availability/doctors-for-slot` | Walks `slot_catalog`, matches by label. `findAvailableDoctors` runs `isSlotAvailable` once per doctor (about six queries each).                                                                                                                                                                  |
| Booking checks                          | `bookingGuard.js` (env `SCHEDULE_ENFORCEMENT` off / warn / strict) is called from `ghm-appointments.js`; `appointments.js` calls `isSlotAvailable` directly                                       | The other insert paths — `walkins.js` / `walkinBooking.js`, `flow.js`, `cc-calling.js`, `ghmLead.js` — are not checked at all. Non-catalog labels are skipped (`unknown_slot`).                                                                                                                  |
| Reassign                                | `routes/doctorSchedule.js applyMove`                                                                                                                                                              | Changes the doctor and keeps the old label — wrong once the two doctors' slots differ.                                                                                                                                                                                                           |
| Unused                                  | `doctor_weekly_schedule`, `doctor_recurring_breaks` (2026-06-08)                                                                                                                                  | No code reads them. Leave them; do not build on them (label-keyed).                                                                                                                                                                                                                              |

The core change: **a doctor's slots become a function of a template (times + length), not rows in a shared label list.** A label stays only as the display string a booking stores.

## 3. Data (one additive migration)

```text
doctor_slot_templates            one row per version
  id, doctor_id → doctors
  effective_from  DATE NOT NULL
  status          'active' | 'withdrawn'          a scheduled future version can be withdrawn
  partial_last    'drop' | 'short'  DEFAULT 'drop'
  created_by, created_at, withdrawn_by, withdrawn_at, note
  UNIQUE (doctor_id, effective_from) WHERE status = 'active'

doctor_slot_template_hours       working windows; a weekday with no rows is a day off
  template_id, weekday 0–6, start_time, end_time, slot_minutes 5–240
                                  end <= start = overnight; the window belongs to its start day

doctor_slot_template_breaks      named breaks
  template_id, weekday NULL = every working day, name NOT NULL, start_time, end_time

doctor_unavailability            + start_time, end_time (nullable) for part-day entries
```

- **Slot length is per window, not per doctor.** Rev 1 had one length per template, which cannot express today's mixed day (30 min until 17:00, 60 min after) — the seed in §8 step 2 would have changed every doctor's evening. Per window also covers "20-min slots in the morning clinic, 30-min in the evening".
- **Versions are append-only.** Saving creates a new version from `effective_from`; it never edits one in place. `effective_from` must be today or later (only the seed may backdate). A future version can be withdrawn (status, who, when) but not deleted. The version list is the audit trail: who changed what, when, from which date.
- The active version for a date is the latest active row with `effective_from <= date`.
- **Patient-type caps (later phase, decision 1)** go in `doctor_slot_template_caps (template_id, patient_type 'new' | 'follow_up' | 'walk_in', max_per_slot)`. Nothing in v1 reads it. When built, the type comes from `appointments.is_walkin` and `visit_type` — that mapping is part of that phase.

## 4. Generation — computed, not stored

`shared/slotTemplates.js` — pure functions, no DB, imported by the **server** (resolver, validation) and the **client** (live preview while editing), so the preview cannot disagree with what booking sees.

```text
slotsFor(template, date) →
  windows of that weekday
  → subtract breaks, giving free segments
  → cut each segment from its own start into the window's slot_minutes
  → last piece shorter than slot_minutes: drop it, or keep it (partial_last)
  → [{ start, end, label, windowIndex }]

validate(template) → [{ field, message }]
```

- **A break restarts the slots.** With 9:30–13:30, 30-min slots and a break 11:00–11:15, slots are 9:30, 10:00, 10:30, then 11:15, 11:45, 12:15, 12:45; 13:15–13:30 is short (dropped or kept). Slots never straddle a break.
- **Labels** keep the existing style so stored bookings and `slot_labels` still read naturally: `9:30 AM to 10 AM`, `12 PM to 12:30 PM`, `11:20 AM to 11:40 AM`, `11 PM to 12 AM`.
- **Not stored as rows.** A row per doctor × day × slot would be ~350k rows a year to generate and rewrite on every edit — the bulk write the house rules warn the Supabase instance about. Computing on read costs one template lookup per doctor per day. "Generate" in the UI is **Preview + Save**.
- **Validation** (shared, so the form and the API refuse the same things): `slot_minutes` 5–240; windows on a weekday must not overlap, including an overnight window running into the next day's first window; a break must lie inside a window of a weekday it applies to; each working day must produce at least one slot; at most 4 windows and 10 breaks per day. Messages say how to fix it ("Ward round (13:15–13:45) ends after the morning window closes at 13:30").

## 5. Resolver (`server/services/availability.js`)

- **Slot list** for doctor + date: active template → `slotsFor`. No template → the current `slot_catalog` + `doctor_profile` path, unchanged.
- **Kill switch:** env `SLOT_TEMPLATES=off` makes the resolver ignore templates entirely — an instant rollback with no data change.
- **Booked counts by time.** Every booking's `time_slot` goes through `shared/slotHour.js slotStartTime`; it counts in the slot whose `[start, end)` contains that time. Covers labels, HealthRay `HH:MM` and sheet ranges. A booking whose time cannot be read is not dropped silently: it is counted for the day and listed as "time not readable" in Day preview.
- **Doctor names** stay matched through the existing `names` array (name + short name), as today.
- **Date exceptions by time.** `doctor_unavailability` part-day rows block slots overlapping `[start_time, end_time]`. Legacy rows with only `slot_labels` are converted through `slot_catalog` (inactive rows included — it stays as the label → time lookup).
- **`appointment_slots` overrides** apply when their label is one of the doctor's slots that day. An override for a label that no longer exists is ignored and shown in Day preview ("Block on 4 PM to 4:30 PM no longer matches a slot") so it isn't lost silently.
- **Breaks** report `blocked_by: 'break'` with `detail` = the break's name; `SLOT_REASON` in `src/lib/slotAvailability.js` shows "Break — Lunch".
- **HealthRay warning (decision 6).** A booking with `healthray_id` whose time falls outside working hours, on a day off, or inside a break, is returned in a `warnings` list: "Booked in HealthRay at 1:15 PM — inside Lunch". Read-only.
- **`findAvailableDoctors` / `doctors-for-slot`** take a **time** (not a label), load all active templates for the date in one query and resolve in memory — removes the per-doctor query loop.
- **Emergency "rest of today" (decision 5):** this doctor's remaining slots by IST clock; the API refuses `from_now` when `end_date` is after today.

## 6. Booking and reassignment

- **What a booking stores.** Every Scribe booking path stores the generated label of the chosen slot. Sync paths (HealthRay, Google Sheet, today's-show) are untouched and keep writing `HH:MM`.
- **One check for every Scribe insert path.** `checkBookingAvailability` resolves by **time** instead of exact label, and is called from all six paths: `appointments.js`, `ghm-appointments.js`, `walkins.js` / `walkinBooking.js`, `flow.js`, `cc-calling.js`, `ghmLead.js`. Behaviour still follows `SCHEDULE_ENFORCEMENT` (off / warn / strict). Walk-ins are checked at their arrival time and follow the same setting (decision 9): in `strict` mode a walk-in outside hours or in a break is refused unless an admin overrides, so the desk needs an admin at hand — the refusal message says so.
- **Reassign** (`applyMove`) writes the **target doctor's** label for the slot that contains the booking's time. If the target has no slot at that time the move is refused with a reason, not written.
- **Sorting.** Lists that `ORDER BY time_slot` sort text ("10 AM" before "9:30 AM"). The day lists the new resolver feeds sort by `slotStartTime`. Other existing orderings are left alone unless they are on a screen this work touches.

## 7. Apply to one, several or all consultants

`POST /api/doctor-slot-templates/apply` `{ doctor_ids | all: true, effective_from, template, dry_run = true }`

1. **Dry run** (the default): per doctor, the future bookings from `effective_from` that fall outside the new hours, on a new day off, or inside a new break — counted by time, so HealthRay bookings are included. Nothing is written.
2. The UI shows the result per doctor ("Dr X — 4 booked patients fall outside the new hours", HealthRay ones marked "move in HealthRay too").
3. Confirm writes one version per doctor in batches with progress; one doctor failing stops the run and reports which ones were saved, per the bulk-change rules. Rerunning skips doctors who already have that exact version.
4. Affected Scribe bookings go to the existing **Reassign patients** window, one doctor at a time. HealthRay bookings are listed, not moved — Scribe cannot change HealthRay.
5. Existing bookings inside the new hours stay where they are (decision 3).

Applies to `SCHEDULED_ROLES` (consultants and MOs, decision 4). Admin only (`CAP.ADMIN`) on the server, like the current schedule endpoints.

## 8. Rollout (each step tested before the next)

1. **Generator + tables.** ✅ Done 2026-10-22 — `shared/slotTemplates.js` (`dayPlan`, `slotsFor`, `validateTemplate`), 25 unit tests in `tests/unit/` (`npm run test:unit`), migration `server/migrations/2026-10-22_doctor_slot_templates.sql` applied to the e2e DB, and to **production on 2026-10-22** (one transaction, 5 s lock timeout; verified: RLS forced, no anon access, triggers present, `doctor_unavailability.start_time/end_time` added, 0 templates). Versions are append-only by trigger (only active → withdrawn is allowed). No behaviour change.
2. **Seed** one template per consultant/MO so nothing changes on day one. ✅ Done on production 2026-10-22: 46 consultants/MOs → 46 templates, 816 hour rows, 0 breaks (45 had no profile → 24 h Sunday off; 1 had 10:00–17:00). Live resolver vs templates: 46 doctors × 14 days = 644 doctor-days identical.
   - with a `doctor_profile`: its off days; its working slots grouped into windows by the catalog's own shape (30-min parts inside 09:00–17:00, 60-min parts inside 17:00–09:00 — a unit test proves this reproduces all 32 labels of today's catalog); lunch → break "Lunch" (split at the 30/60 boundary if it crosses it);
   - without one (available 24 h today): every day except Sunday, 24 h, same shape.
   - Code: `server/services/slots/seedFromProfile.js` (pure, unit-tested), rules shared with the live resolver through `server/services/slots/profileRules.js` (moved out of `availability.js` unchanged).
   - Script: `node server/scripts/seed-slot-templates.mjs` — dry run by default (every batch rolled back); `--apply` commits; `--batch=5` doctors per batch (~100 rows), each its own transaction, 300 ms apart; skips doctors who already have a template, so it is rerunnable; stops if a session is idle in a transaction > 60 s; reads every saved template back and re-checks it before committing; stops on the first error. `effective_from` 2026-01-01.
   - Check: `--verify-resolver --days=14` runs the live resolver for every seeded doctor and day and compares (read-only). On the e2e DB: 3 doctors × 14 days identical; a deliberately changed profile is caught.
   - Production order, each step only with a go-ahead: all done 2026-10-22.
3. **Resolver reads templates** (fallback + kill switch); counts by time; HealthRay warnings. 🛠 Built and tested on the e2e DB 2026-10-22; **not deployed**.
   - `server/services/slots/templateStore.js` (active version per doctor and date, one query for many doctors; `SLOT_TEMPLATES=off` disables), `server/services/slots/dayView.js` (pure day calculation, unit-tested), `availability.js` keeps every export and response shape; doctors without a template use the old code.
   - `/availability/day` and `/doctors/:id/availability` add `warnings`, `unreadable`, `orphan_overrides`, `from_template` next to the unchanged `slots`.
   - A template break is **one row** named after the break (e.g. "1 PM to 2 PM — Lunch") instead of one greyed row per old slot. Production has no breaks today, so nothing changes there.
   - Gap closed: the existing Schedule form (`PUT /doctors/:id/profile`) now also saves a template version effective today in the same transaction — otherwise its edits would stop reaching booking until step 4. Saving twice in a day withdraws the earlier version of that day.
   - The old path now also understands time-range time off (`start_time`/`end_time`), so the kill switch cannot turn a one-hour break into a whole-day block.
   - Emergency "rest of today" is refused for leave past today (`from_now_today_only`); the Staff Management checkbox only shows for today-only leave.
   - `getAffectedAssignments` matches bookings by time as well as label, so HealthRay `HH:MM` bookings inside a break are listed for reassignment.
   - Review fixes (2026-10-22): each booking counts in exactly one slot or break (an early window and an overnight window sharing a clock time no longer double-count); whole-day leave also covers break rows, so screens that check "every slot off" still see a day off; a schedule with every day off saves again (validation `requireHours: false` for the profile path); two admins saving the same doctor at once get a 409 with a readable message; the conflicts list skips HealthRay `HH:MM` bookings that are only outside hours or in a break (those are the read-only warnings) but does list them under leave; the emergency clock uses `hourCycle: "h23"`.
   - e2e fixtures seed every consultant/MO with the production 24 h template (`e2e/setup/reset.mjs`), so the suite exercises the new path; `G114` covers the behaviour.
4. **Schedule tab** for one doctor: editor, preview, version history, withdraw a future version. 🛠 Built and tested on the e2e DB 2026-10-22; **not deployed**.
   - UI `src/components/doctors/ScheduleEditor.jsx` replaces the old Working days / hours / Lunch form (the old `PUT /doctors/:id/profile` endpoint stays and still writes a version). Per weekday: tick to work, up to 4 blocks of hours each with its own slot length, "Copy <first day> to all working days"; named breaks for every working day or one day; last-short-slot choice; "Applies from" date (today or later). Preview of any of the 7 days from that date, computed in the browser with the shared generator. Errors from `validateTemplate` sit under the row they belong to; Save stays disabled until there are none.
   - **Check bookings** lists the future bookings (up to the next saved version) that fall on a day off, outside the hours or inside a break, marking HealthRay ones "move in HealthRay too". Save shows the same list afterwards. Moving them is step 5; bookings are never changed by a save (decision 3).
   - Version history: start date, status (In use / Starts later / Replaced / Withdrawn), summary, who saved and when, note; an upcoming version can be withdrawn (confirmation names the doctor and the schedule).
   - API: `GET /doctors/:id/slot-templates`, `POST /doctors/:id/slot-templates/check`, `POST /doctors/:id/slot-templates`, `POST /doctors/:id/slot-templates/:templateId/withdraw` (admin; consultants and MOs only; past start dates refused; only versions that have not started can be withdrawn). Services: `templateStore.templateVersions`, `bookingImpact.bookingsOutsideTemplate`, `templateWrites.withdrawFutureVersion`.
   - Day preview below the editor now shows break names and the HealthRay warnings from step 3, and no longer reads `doctor_profile`.
   - Tests: `G114` tests 6–9 (API), `G117` (editor UI).
   - Not in this step: Time off → Break by time range (Time off still picks catalog slots, which still block any overlapping template slot); kill switch `SLOT_TEMPLATES=off` falls back to `doctor_profile`, which the new editor does not update.
5. **Apply to many** with dry run and reassign; booking check on all six paths; reassign by time. 🛠 Built and tested on the e2e DB 2026-10-22; **not deployed**.
   - Schedule tab "Apply to": this doctor / choose doctors / all consultants and MOs. Check bookings runs `POST /doctor-slot-templates/apply` with `dry_run` (per doctor: bookings outside, HealthRay count, already has this exact version). Save asks for confirmation naming the doctors, start date and summary, then sends doctors in batches of `APPLY_BATCH` (10, `shared/slotTemplates.js`) with progress; the server refuses a write of more than one batch. Each doctor is its own short transaction; the first failure stops the run and the screen says who was saved; saving again skips doctors who already have that exact version from that date. Service `server/services/slots/applyTemplate.js`.
   - After saving, affected **Scribe** bookings open the existing Reassign window (moved to `src/components/doctors/ReassignModal.jsx`, trigger `schedule_change`), one doctor at a time. HealthRay bookings are listed only.
   - Booking check, per path as found in the code: `appointments.js` POST and `ghm-appointments.js` POST already called `checkBookingAvailability` (which reads time since step 3). Added: `ghm-appointments.js` PATCH — moving a booking to another date, time or doctor goes through `checkBookingChange` (only when one of those actually changes, the date is today or later, and the booking is not cancelled/done). Not applicable: `ghmLead.js` (lead rows have no date), `flow.js` (check-in of a patient already present, no slot), `walkinBooking.js` (walk-in slots have no doctor), `cc-calling.js` (writes the calling log, not appointments). All still follow `SCHEDULE_ENFORCEMENT` (production `warn`, so nothing is refused there today).
   - Reassign (`applyMove`) writes the target doctor's slot label holding the booking's time (template doctors only; HealthRay bookings keep their `HH:MM`); a target with no open slot at that time is refused as before.
   - Tests: `G114` 10–12 (apply API, batch limit, reassign label), `G117` 5 (choose doctors, save, move a patient); the PATCH guard was checked in strict mode against the e2e DB with a scratch script (enforcement is off in the e2e env).
6. **Clean up:** `TIME_SLOTS` and `SLOT_CATALOG` removed (dropdowns always read `/availability/day`; `GET /appointment-slots/time-slots` returns the catalog from the DB); writers of `doctor_profile` hours/lunch removed (columns kept).
   🛠 Done on the e2e DB 2026-10-22; **not deployed**.
   - Client `SLOT_CATALOG` removed: booking dropdowns (OPD, GHM ×2, Find, Dashboard) show the doctor's day from `/availability/day`, and before a doctor/date is picked, the catalog from `GET /api/slot-catalog` through one cached query (`useSlotCatalog`, `qk.slotCatalog`). OBT can now read `/api/slot-catalog` (it could already read `/api/availability`), since it books from GHM.
   - Server `TIME_SLOTS` removed: `/appointment-slots` defaults and `/appointment-slots/time-slots` read `slot_catalog`.
   - `PUT /doctors/:id/profile`, `profileUpdateSchema` and `saveTemplateFromProfile` removed; nothing writes `doctor_profile` now (table and `GET` kept — the kill switch and the seed script still read it). `G114` 2–3 now save through `POST /doctors/:id/slot-templates`.
   - Kept on purpose: the legacy resolver path for doctors without a template and for `SLOT_TEMPLATES=off`. With the kill switch on, doctors fall back to their last `doctor_profile`, which may be older than their template.

## 9. UI — Staff Management → Schedule tab

Replaces Working days / Working hours / Lunch. Same page, same visual language.

```text
Schedule for Dr. Anil Bhansali                          [Version history]

Applies from [ 27 Oct 2026 ]      Last short slot (•) drop ( ) keep shorter

Working hours                                   Slot length
  Mon  [x]  09:30 – 13:30                        [30 min ▾]   + add window
            17:00 – 20:00                        [60 min ▾]   ✕
  Tue  [x]  09:30 – 13:30                        [30 min ▾]
  …
  Sun  [ ]  Off
  [Copy Monday to all working days]

Breaks
  Lunch        13:00 – 14:00   Every working day   ✕
  Ward round   11:00 – 11:30   Wed only            ✕
  + add break

Preview [ Tue 28 Oct ▾ ]   11 slots · Lunch 1–2 PM skipped
  [9:30–10] [10–10:30] … [Lunch] … [5–6 PM] …

Apply to (•) this doctor ( ) choose doctors… ( ) all consultants and MOs
                                            [Check bookings]  [Save schedule]
```

- Preview updates as fields change (shared generator, no request).
- **Save** stays disabled until validation passes; each error sits next to its field.
- **Check bookings** runs the dry run; Save then reads "Save and reassign N patients".
- Several / all asks for confirmation naming the doctors and the start date.
- **Version history:** who, when, from which date, summary ("Mon 30 → 20 min; Lunch added"); a future version has **Withdraw**.
- **Time off → Break** picks a start and end time instead of slot checkboxes.
- The Schedule tab loads with an error state if the template fails to load (as the current tab now does) — never with an editable default.
- After a save, the GHM availability query (`qk.ghm.availability`) is invalidated; other open desks pick it up on their next refetch.

## 10. Tests

- **Unit** — the repo has none today. Use Node's built-in `node:test` (no new dependency) with `npm run test:unit` → `node --test shared/`. Cases: 15/20/30/45/60 cuts; a break restarting slots; breaks at window edges; two windows with different lengths; overnight 17:00–01:00; overnight overlapping next day rejected; partial last slot drop / keep; label formatting (12 PM, 12 AM, odd minutes); every validation message.
- **Resolver against the e2e DB**: template beats profile; no template = today's output; kill switch; HealthRay `HH:MM`, sheet range and label bookings each counted in the right slot; unreadable time listed; legacy `slot_labels` break still blocks; orphaned `appointment_slots` override reported; next Monday's version leaves this week alone; withdrawn version ignored.
- **e2e** `e2e/giniflow/G7x-slot-templates.spec.js`: build 20-min mornings + 60-min evenings with a named Lunch; preview shows the right slots and "Lunch"; apply to all with dry run listing an out-of-hours booking; reassign it; GHM and OPD dropdowns show the new slots; Time off break by time range; withdraw a future version.
- **Seed check script** (step 2) comparing before/after Day preview for every doctor.
- `G71` updated for the new Schedule tab.

## 11. Gaps found reviewing rev 1

| Gap in rev 1                                                                                             | Fixed in       |
| -------------------------------------------------------------------------------------------------------- | -------------- |
| One slot length per doctor cannot reproduce today's 30/60 mixed day; the seed would change every evening | §3, §8 step 2  |
| Doctors with no profile (24 h today) had no seeding rule                                                 | §8 step 2      |
| How breaks cut slots (drop overlapping slots vs restart after the break) was undefined                   | §4             |
| Generator was server-only, so the preview could drift from booking                                       | §4             |
| "Count by time" did not say how; three `time_slot` formats exist, and `slotHour.js` already parses them  | §2, §5         |
| Bookings with unreadable times would vanish from counts                                                  | §5             |
| Only two of six Scribe insert paths check availability                                                   | §6             |
| Reassign keeps the old label — wrong across different slot grids                                         | §6             |
| `appointment_slots` overrides keyed on labels that may no longer exist                                   | §5             |
| `findAvailableDoctors` is a per-doctor query loop — worse with templates                                 | §5             |
| No rule for past `effective_from`, withdrawing a future version, or two saves on one date                | §3             |
| No rollback short of a code revert                                                                       | §5 kill switch |
| No unit-test runner in the repo                                                                          | §10            |
| Text sort of `time_slot` puts 10 AM before 9:30 AM                                                       | §6             |
| Validation rules only sketched; overnight overlap into the next day missed                               | §4             |
| Cache refresh after a save not considered                                                                | §9             |
| HealthRay bookings in the bulk dry run need "move in HealthRay too"                                      | §7             |
| `capacity` column contradicted decision 1                                                                | §3             |

## 12. Out of scope

- Writing anything to HealthRay.
- Patient-type caps (decision 1 — later phase; the table is reserved).
- GHM arrival windows (`ARRIVAL_TIME_RANGES`, hourly) — a separate concept from booking slots.
- Part-day clinic holidays (`clinic_holidays` stays whole-day).
- Patient-app self-booking.
- Merging duplicate doctor accounts — a template belongs to one `doctors.id`; a consultant split across two accounts (see the duplicate-accounts recipe) must be merged first or one account shows no schedule.

## 13. Decisions

Agreed 2026-10-22:

1. **Capacity** — each slot will get a cap split by **new**, **follow-up** and **walk-in**, defined later. **Later phase**: v1 is unlimited, as today; `doctor_slot_template_caps` is reserved (§3).
2. **Split shifts** — yes, several windows per weekday (§3).
3. **Changing slot length** — existing bookings stay; they count by time; only those outside the new hours, on a new day off or inside a new break are flagged (§7).
4. **Roles** — consultants and medical officers.
5. **Emergency "rest of today"** — today only; the API refuses `from_now` past today (§5).
6. **HealthRay** — read-only warning when a HealthRay booking lands outside hours or in a break (§5).

Agreed after the rev 2 review:

7. **Breaks restart the slots** — slots start fresh when a break ends (§4).
8. **24-hour doctors** — seeded as 24 h so nothing changes on day one; admins tighten each doctor later (§8 step 2).
9. **Walk-ins** — follow `SCHEDULE_ENFORCEMENT` like any booking: warn in `warn` mode, refused in `strict` mode unless an admin overrides (§6).

## 14. Bulk schedule and end dates (added 2026-10-22, not deployed)

- Staff Management header → **Bulk schedule** opens the editor without a doctor: start Empty or "Copy from Dr X", apply to all consultants and MOs or chosen doctors. Start-date shortcuts: Today, Next Monday, 1st of next month; period shortcuts (bulk only): Next week only (Mon–Sun), Next month only (calendar month).
- **Ends: Until [date]** (bulk only, `effective_until` on `POST /doctor-slot-templates/apply`). Per doctor, in one transaction: the new version from the start date, and a "Back to the usual schedule after …" version from the day after the end, copying the schedule that was in effect before the period. If a version already starts on the day after the end, nothing is added there.
- A doctor with another active version starting inside the period is a **conflict**: shown in the dry run and the confirmation, and the save is blocked until it is withdrawn or the doctor is unticked (never overwritten). A doctor with no earlier schedule to return to is a conflict too.
- Rerunning the same period skips doctors who already have both versions.
- Booking impact for a period counts bookings up to the end date only.
- Tests: `G114` 13–14, `G117` 6–7.

## 15. Block slots from Booking availability (added 2026-10-23, not deployed)

- Schedule tab → Booking availability → **Select slots to block**: tick any number of open slots on the chosen day (past slots of today and already-blocked slots can't be picked), give a reason (required), **Block N slots**. Creates one Time off **Break** for that date with those slot labels (`POST /doctors/:id/break`), so it also lists under Time off and booked patients open the Reassign window.
- A slot blocked by a Time off break shows the reason and is clickable: **Remove break** (confirmation lists every slot of that break) cancels that entry. Template breaks (Lunch etc.) are not clickable — change them in Edit schedule.
- Slots now carry `time_off_id` when blocked by a Time off entry (template doctors).
- Break only, by decision 2026-10-23; longer absences stay in Time off. Test: `G117` 9.

## 16. Clear a schedule from a date (2026-10-23)

- Staff Management → Schedule → **Clear schedule** (next to Edit schedule, admin only). Pick a date (today or later). From that date the person has no slots; booking treats them as available all day with no per-slot limits, as before schedules existed. Every active version starting on or after that date is withdrawn. Days before keep their schedule; bookings, time off and blocked breaks are untouched.
- Stored as a new version with `doctor_slot_templates.clears = TRUE` and no hours (migration `2026-10-23_slot_templates_clears.sql`), so history stays append-only. The resolver (`activeTemplates`) treats a clearing version as "no schedule"; the list shows it as "Schedule cleared — no slots" / "Cleared", and a future clear can be withdrawn like any upcoming version.
- `POST /api/doctors/:id/slot-templates/clear {effective_from}`; returns 503 until the migration has run.
