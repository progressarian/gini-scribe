# 83 — Connect the Referrals desk and Care Follow-ups

> "now tell me that /giniflow/station/referrals this page is connected with /care-followups ?? … first check it in details and make plans how we can connect and also if any question then ask me"

Status: **built 21 Oct 2026** (uncommitted). Migration `2026-12-09_care_followups_desk_link.sql` written; apply on prod before or with the deploy. Tests: `e2e/care/CF03-desk-link.spec.js` 9/9, all care tests 27/27.

## 1. What exists today

### Referrals desk — `/giniflow/station/referrals` (plan 19)

- Table `giniflow_referrals`, one row per **(visit, specialty)**.
- Written by the consultant's **Referral chips** on the Care plan (specialty only, usually) and by the desk's **+ New referral** form (outside doctor, phone, hospital, urgency, reason, tests).
- Built around a **letter to an outside specialist**. Its statuses are the letter's journey:

  | Status               | Label               | Set by                                                                   |
  | -------------------- | ------------------- | ------------------------------------------------------------------------ |
  | `created`            | Created             | chip / form                                                              |
  | `letter_generated`   | Letter generated    | 📄 Generate letter                                                       |
  | `appointment_booked` | Appointment pending | 📅 Book appointment: a date the **outside** clinic gave (free text note) |
  | `completed`          | Completed           | 📥 Record specialist reply (with medicines) or ✓ Complete                |

- Lists the visit day plus 30 days back. Can be removed only while `created` with no letter.
- An edit (chip or form again for the same visit + specialty) updates the row while it is still `created` with no letter.

### Care Follow-ups — `/care-followups` (plan 81)

- Table `care_followups`, one row per referral, from three sources: the desk (`gf_referral`, key `gf:<referral id>`), Scribe consultation referrals (`rx_referral`) and HealthRay notes (`hr_note_referral`).
- Collector every 15 minutes (worker, `CARE_FOLLOWUPS_COLLECT=1`) or on demand for an earlier day.
- Statuses: `open → booked → done`, or closed as `not_available` / `declined` / `closed` (done elsewhere). Calls are logged on the row.
- "Booked" always means a **GHM appointment** (`booked_appointment_id`). Booked → done when that visit completes; back to open on cancel / no-show.
- Availability (`✓ Available / ✕ Not at GHM / ? Check`) comes from the specialty or named doctor against GHM's consultants.

### How they are connected now

| Direction                                                         | Today                                                                     |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Desk referral created → Follow-ups item                           | ✅ within 15 min (copied once: target, reason, hospital, tests, due date) |
| Desk referral removed → Follow-ups item                           | ✅ closed "Referral removed at source"                                    |
| Desk referral edited (doctor, hospital, reason) → Follow-ups item | ❌ the item keeps the first copy                                          |
| Desk: letter generated / sent                                     | ❌ not visible on Follow-ups                                              |
| Desk: outside appointment booked                                  | ❌ Follow-ups item stays **open** — coordinator may call to book again    |
| Desk: specialist reply / completed                                | ❌ Follow-ups item stays open                                             |
| Follow-ups: calls, booked at GHM, closed, reopened                | ❌ desk card shows nothing                                                |
| Link between the two screens                                      | ❌ none either way                                                        |

## 2. Gaps found

- **G1. Double work.** A referral booked outside on the desk, or completed there, stays open on Follow-ups, so the coordinator calls a patient who is already sorted.
- **G2. Outside referrals look bookable.** When the doctor names an outside hospital, Follow-ups still offers booking at GHM if GHM has the specialty. **Kept on purpose (Q1: GHM first)**; the outside hospital stays visible in the row's detail ("At Fortis").
- **G3. Stale copy.** Edits on the desk (adding the outside doctor or hospital later) never reach the Follow-ups item.
- **G4. Blind desk.** The desk can't see that the coordinator already called 3 times, booked the patient at GHM, or the patient declined.
- **G5. No way across.** No button to open the letter or the desk card from Follow-ups, or the Follow-ups history from the desk.
- **G6. 15-minute lag.** Desk actions reach Follow-ups only on the next collector run.

## 3. Proposed connection

One referral, one story, shown on both screens. Each screen keeps its own statuses (the desk's are about the letter, Follow-ups' about the patient), and an action on one side updates the other **in the same transaction**, not on the next collector run.

### 3.1 Desk → Follow-ups (immediate)

| Desk action                      | Follow-ups item becomes                                                                | History line                            |
| -------------------------------- | -------------------------------------------------------------------------------------- | --------------------------------------- |
| Referral created (chip / form)   | created at once (no 15-min wait)                                                       | "From the Referrals desk"               |
| Edited while `created`           | target / detail / availability refreshed (open items only)                             | —                                       |
| Outside hospital or doctor named | unchanged: GHM first when we have the specialty (**Q1**); hospital shown in the detail | —                                       |
| 📅 Appointment booked (outside)  | **Booked outside** (new active status; no call prompts)                                | "Outside appointment 28 Oct — Fortis"   |
| 📥 Reply recorded / ✓ Complete   | **done**                                                                               | "Specialist reply recorded on the desk" |
| Removed                          | closed (as today)                                                                      | "Referral removed at source"            |

### 3.2 Follow-ups → Desk (immediate)

| Follow-ups action                         | Desk referral                                                                                                                          | Shown on desk card              |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| Call logged                               | unchanged                                                                                                                              | "📞 2 calls · last: No answer"  |
| Booked at GHM                             | **Appointment pending**, date = GHM visit date, note "Booked at GHM with Dr X" (only while the desk is `created` / `letter_generated`) | "Booked at GHM · Dr X · 24 Oct" |
| GHM visit completed (auto)                | unchanged (Q4)                                                                                                                         | "Seen at GHM on 24 Oct"         |
| Not available / Declined / Done elsewhere | unchanged (Q4)                                                                                                                         | "Patient declined — reason"     |
| Reopened                                  | unchanged                                                                                                                              | badge goes back to "Open"       |

### 3.3 Links between the screens

- **Follow-ups row and drawer** (desk referrals only): letter status chip ("Letter sent to patient 21 Oct"), **📄 Open letter** (the stored PDF, same URL the desk uses), and **↗ Open on Referrals desk** (opens the desk searched to that patient).
- **Desk card:** a "Coordinator" line with the Follow-ups status and last call, and **🧭 Open follow-up history** (opens `/care-followups` with that item's drawer).
- Links show only to roles that can open the other page (today: care coordinator and admin hold both).

## 4. Decisions (21 Oct 2026)

| #   | Question                                                      | Decision                                                                                                  |
| --- | ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Q1  | Outside doctor / hospital named — still offer booking at GHM? | **Yes, GHM first.** Availability is unchanged; the hospital shows in the detail.                          |
| Q2  | Outside appointment booked on the desk → Follow-ups?          | **New status "Booked outside"** (active): stops calling; done when the desk records the reply / Complete. |
| Q3  | Booked at GHM on Follow-ups → desk?                           | **Desk set to "Appointment pending"** with the GHM date and "Booked at GHM with Dr X".                    |
| Q4  | Follow-ups done / declined / not available → desk?            | **Badge only.** The desk keeps its own status.                                                            |

## 5. Build (after answers)

- **Migration**: widen `care_followups_status_check` with `booked_outside`; add it to `FOLLOWUP_STATUSES` and `ACTIVE_STATUSES`. Applied on prod before the code deploys (the list reads the status, never a new column). No new table — the link is the existing `source_key = 'gf:' || giniflow_referrals.id`.
- **`server/services/careFollowups/referralLink.js`** (new):
  - `syncFromDeskReferral(client, referralId, event)` — insert / refresh / move the Follow-ups item inside the desk's own transaction, writing `care_followup_events` with kind `desk`.
  - `deskSummaryFor(referralIds)` — Follow-ups status, attempts, last call for the desk cards.
- **`referralsStation.js`**: call the sync from `createReferral`, `bookAppointment`, `recordResponse`, `completeReferral`; `getReferrals` adds the coordinator summary (left join on `care_followups`, guarded so the desk works if the follow-ups table is missing).
- **`careFollowups/actions.js`**: `markBooked` (and the collector's auto-booking) sets the desk to Appointment pending (Q3). Close / done leave the desk alone (Q4).
- **`careFollowups/collect.js`**: stays as the safety net for anything the immediate sync missed; `autoProgress` leaves `booked_outside` items alone.
- **`list.js` / `readFollowup`**: desk letter status, letter URL and urgency for `gf:` items.
- **UI**: `CareFollowupsPage.jsx` (letter chip, Open letter, Open on desk, Booked outside status), `ReferralCard.jsx` (Coordinator line, Open follow-up history). Desk page accepts `?q=` to open searched; Follow-ups accepts `?item=` to open a drawer.
- **Docs**: plan 81 and plan 19 get a "Linked with plan 83" note.

## 6. Tests (new `e2e/care/CF03-desk-link.spec.js`)

1. A chip referral appears on Follow-ups immediately (no collector run).
2. Editing the referral on the desk (adding hospital) refreshes the item's detail; Book appointment still shows when GHM has the specialty (Q1).
3. Outside appointment on the desk → item "Booked outside", history line written; Specialist reply then makes it done.
4. Specialist reply / Complete on the desk → item done (from open or booked outside).
5. Booked at GHM on Follow-ups → desk "Appointment pending" with the GHM date and note; a desk already Completed is not changed.
6. Declined on Follow-ups → desk card badge; desk status unchanged.
7. Letter chip and Open letter on Follow-ups; Open on desk lands on the desk searched to the patient; Open follow-up history opens the drawer.
8. Removing a referral still closes the item; the collector run afterwards adds nothing twice.
9. Roles: floor coordinator and reception see no cross-links; the desk still loads when the follow-up summary can't be read.

## 7. As built

- **Where the links sit.** The Follow-ups **row** shows a one-line chip ("↗ Referrals desk · Created · letter sent"); the **📄 Open letter** and **↗ Open on Referrals desk** buttons are in the drawer's new "Referrals desk" card (status, urgency, hospital, letter, appointment), so the row keeps its three actions. The buttons show only to roles holding `GINIFLOW_REFERRALS`.
- **Desk card.** A teal "🧭 Care coordinator: <status> · N calls · last: <result> · <reason>" line, with **Open follow-up history** (`/care-followups?item=<id>`) for roles holding `CARE_FOLLOWUPS`.
- **Deep links.** `/giniflow/station/referrals?q=<file no>` opens the desk searched; `/care-followups?item=<id>` opens that drawer.
- **Code.** `server/services/careFollowups/referralLink.js` (`syncFromDeskReferral`, run inside the desk's transaction under a savepoint: a failure is logged and never blocks the desk); `deskReferral.js` (`markDeskBookedAtGhm`, used by `markBooked` and the collector's auto-booking, only while the desk is `created` / `letter_generated`); `collect.js` exports the desk item shape so both paths build the same row; the desk's remove / outside booking / reply / Mark seen pass the actor through.
- **History.** Desk changes are written as kind `desk` and shown as "Referrals desk" in the drawer.
- **Before the list starts** (`care_followups_since` unset) or for a visit before that date, desk actions create no item; an existing item still moves.
- **Before the migration is applied**, the desk keeps working: a `booked_outside` move fails the old check inside the savepoint and is logged, and the item simply stays as it was.
