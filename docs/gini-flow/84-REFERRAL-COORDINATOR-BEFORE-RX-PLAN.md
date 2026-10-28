# 84 — Referred patients see the Care Coordinator before Prescription Explain

> "If pt refer to another department then it will show to care coordinator before proceeding to prescription explanator. Once care coordinator make it done, whatsoever decision taken (appointment booked or denied), then it will move to prescription explanatory."

Status: **built 21 Oct 2026** (uncommitted). See §7 for deploying it and where the build
differs from the plan.

## 1. What changes

```text
Today:     Consultant → Prescription Explain → Pharmacy → Exit
Referred:  Consultant → Care Coordinator → Prescription Explain → Pharmacy → Exit
```

A patient with **no referral** is unchanged.

This reverses one decision in plan 19 (§2: a referral "never moves `current_status`"). It
does **not** reverse 19 §6: a referral still never blocks the consultant's Finalize. The hold
starts after the consultant, not before.

## 2. What exists today (code read, no DB queries)

| Piece                                       | Where                                                                                    | Notes                                                                                                                      |
| ------------------------------------------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Status writer                               | `statusEngine.js` `advanceStatus` (:190), gates at :226–237                              | `assertReportsAreIn` is the precedent for a gate inside the single writer                                                  |
| Scribe Finalize                             | `finalize.js:295` `doctor_done` → `:312` `rx_pending`, same transaction                  | Referral letters are generated after commit (:332)                                                                         |
| HealthRay completion                        | `shared/manualFloor.js` `healthrayTarget`: `completed → rx_pending`                      | Written with `allowSkip`; this is how most patients reach the Rx desk today                                                |
| Rx desk                                     | `rxStation.js` `QUEUE_STATUSES` (:13), `startRxExplain` (:207), `markRxExplained` (:258) |                                                                                                                            |
| Pharmacy-waits-for-Rx gate                  | `pharmacyStation.js:49–66`, valve `SCRIBE_PHARMACY_WAITS_FOR_RX`                         | Station-level gate on a status set: the model this plan copies                                                             |
| Referrals desk                              | `giniflow_referrals`, chips on the Care plan + desk form                                 | Known **before** Finalize                                                                                                  |
| Scribe consultation referral                | `referrals` table, `POST /visit/:patientId/referral`                                     | Known at save                                                                                                              |
| HealthRay note referral                     | parsed from `appointments.healthray_clinical_notes`                                      | Only by the 15-min collector (`CARE_FOLLOWUPS_COLLECT=1`), so often **after** the patient has reached the Rx desk (see Q1) |
| Care Follow-ups                             | `/care-followups`, `care_followups`, statuses in `shared/careFollowups.js`               | Landing page of role `care_coordinator` (`CARE_FOLLOWUPS` capability)                                                      |
| Coordinator stop in chain / catalog / board | —                                                                                        | **None exists**                                                                                                            |

## 3. Design

### 3.1 No new chain status: a hold on `rx_pending` (like the pharmacy gate)

Adding `coordinator_pending` to `CHAIN` would touch ~20 hard-coded
`["doctor_done","rx_pending","with_rx"]` lists, HealthRay's write map, SLA keys and the board.
Instead:

- The visit still reaches `rx_pending` exactly as today (Finalize or HealthRay completion).
- While a **coordinator hold** is open, the Rx desk shows the patient as
  **"With Care Coordinator"** (greyed, cannot be started), and `startRxExplain` /
  `markRxExplained` refuse with 409 `awaitingCoordinator`.
- The gate also goes in `advanceStatus` for `toStatus ∈ {with_rx, pharmacy_pending}`, so no
  path (Rx desk, board drag, HealthRay, fast path) can step past it. Same reasoning as
  `assertReportsAreIn`.
- Pharmacy is already behind the Rx desk (`SCRIBE_PHARMACY_WAITS_FOR_RX`), so nothing more is
  needed there.

### 3.2 The hold: one row per visit

New table `giniflow_coordinator_holds`:

| Column                          | Meaning                                                                                      |
| ------------------------------- | -------------------------------------------------------------------------------------------- |
| `visit_id` (unique)             | one hold per visit, covering every referral on it                                            |
| `opened_at`, `opened_by_source` | `gf_referral` / `rx_referral` / `hr_note_referral`                                           |
| `status`                        | `waiting` → `done` (or `skipped` by an admin override)                                       |
| `decision`                      | `booked_ghm`, `booked_outside`, `declined`, `not_available`, `call_later` (required on done) |
| `note`                          | free text, required for `declined` and `call_later`                                          |
| `done_at`, `done_by`            | who released the patient                                                                     |

The hold opens when the visit has a referral, as soon as Scribe knows:

- a `giniflow_referrals` row for the visit (chip or desk form), any specialty, GHM or
  outside (Q3),
- a Scribe `referrals` row for that patient and day,
- a referral in the **HealthRay note**, read when the note syncs, not on the 15-minute
  collector (Q1), but only while the visit is still `doctor_done` / `rx_pending`. A patient
  the Rx desk has already started is never pulled back; their referral goes to Follow-ups
  as today,
- an **echo referral** (`giniflow_visits.echo_referral`, set by `appointmentSync.js:660`)
  (Q4). The Rx desk's echo report handover (`rxStation.js` `getEchoHandovers`) is
  unchanged, and the coordinator Done comes first,

and closes only by the coordinator's **Done** (or an admin **Send on without coordinator**,
with a reason; audited).

Removing the last referral while the hold is `waiting` closes it as `skipped`, reason
"Referral removed".

Excluded: Online (Tele) visits (they never stand on the floor), lab-only visits, visits
already `with_rx` or later when the referral appears (never pull a patient back).

### 3.3 The coordinator's screen: `/care-followups`

A new top section, **"On the floor now — waiting for you"**, above the existing worklist:

```text
On the floor now (3)                                              Updated 10:42
┌───────────────────────────────────────────────────────────────────────────────┐
│ Sunita Handa · P_182248 · 68F · Dr Bhansali     waiting 6 min                 │
│ Referred to: Cardiology (GHM ✓) · Ophthalmology (outside)                     │
│ [Book at GHM]  [Log call]                         [Done — send to Rx desk ▸]  │
└───────────────────────────────────────────────────────────────────────────────┘
```

- **Done — send to Rx desk** opens a small dialog: patient + UHID, the referrals, a
  required decision (Booked at GHM / Booked outside / Patient declined / Not available /
  Will call later) and a note. Confirm → hold `done`, the patient appears on the Rx desk
  as normal.
- The decision is also written to the matching `care_followups` items (booked / declined /
  not_available; `call_later` leaves them **open**, so the existing follow-up calling
  continues). The patient leaving does not end the follow-up.
- Live update over the existing Gini Flow event stream, no page refresh.
- Uses the existing card, dialog and status-badge components. No new design.

### 3.4 Everywhere else the patient shows

| Screen                       | Shows                                                                                                                                                                                                 |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rx desk                      | "With Care Coordinator · 6 min" row, Start disabled, reason in words                                                                                                                                  |
| Board, `rx` column           | same card with a "With Care Coordinator" badge (label + icon, not colour only)                                                                                                                        |
| Journey / timeline           | a **Care Coordinator** step (new catalog row, station `Care Coordinator`, role `care_coordinator`, no `chain_status`) inserted before `rx_explain` when the hold opens, ticked done with the decision |
| `/visit/:token` patient page | "Please see the Care Coordinator" stop                                                                                                                                                                |

### 3.5 Valve

No valve. Since 2026-10-28 the block is always on in code: a patient waiting for the Care
Coordinator cannot be started or explained at the Rx station (the env switch
`SCRIBE_RX_WAITS_FOR_COORDINATOR` was removed).

## 4. Server

- Migration `2026-12-10_coordinator_holds.sql`: table + catalog row `care_coordinator`.
- `server/services/giniflow/coordinatorHold.js`: `openHoldIn(client, visitId, source)`,
  `closeHoldIn(client, visitId, {decision, note}, ctx)`, `skipHoldIn`, `holdFor(visitId)`,
  `assertCoordinatorDone(client, visitId, toStatus)`.
- Open from: `referralsStation.createReferral` and `removeReferral`, the Scribe referral
  route, and the Finalize transaction (catches chips saved earlier).
- Gate: `advanceStatus` (beside `assertReportsAreIn`), `rxStation.QUEUE_SQL` (adds
  `coordinator_hold`), `startRxExplain`, `markRxExplained`.
- Routes (`routes/careFollowups.js`): `GET /care-followups/on-floor`,
  `POST /care-followups/on-floor/:visitId/done`, `POST …/skip` (admin). Zod schemas in
  `schemas/index.js`.
- RBAC (`shared/permissions.js`): `CARE_FOLLOWUPS` covers the list and Done. New
  `CARE_HOLD_SKIP` for admin only.

## 5. Tests (Playwright, test DB): `e2e/giniflow/G1xx-referral-coordinator-hold.spec.js`

1. No referral: Finalize → Rx desk as today, no hold.
2. Chip referral → Finalize → Rx desk shows "With Care Coordinator", Start refused (409).
3. Coordinator Done (Booked at GHM) → Rx desk can start; follow-up item `booked`.
4. Done (Declined) requires a note; follow-up item `declined`.
5. Done (Will call later) → patient released, follow-up item stays `open`.
6. Two referrals, one hold, one Done releases both.
7. HealthRay completion (`completed → rx_pending`) with a referral → held the same way.
8. Board drag / fast path to `with_rx` while held → refused.
9. Referral removed while waiting → hold `skipped`, patient released.
10. Admin skip with reason → released, audited; non-admin gets 403.
11. Online visit and lab-only visit with a referral → no hold.
12. Valve off → hold recorded and listed, nothing blocked.

13. HealthRay-note referral synced while `rx_pending` → held; synced after `with_rx` → not
    held, follow-up item still created.
14. Echo-referral visit → held; after Done, the Rx desk echo handover works as before.
15. Outside-hospital referral → held; Done "Booked outside" → follow-up `booked_outside`.

## 6. Decisions (21 Oct 2026)

- **Q1. HealthRay-note referrals hold the patient: yes, if the Rx desk has not started.**
  The note is parsed when it syncs (`routes/sync.js` note writes, plus `appointmentSync`),
  using the same parser the Follow-ups collector uses, so both agree on what is a referral.
- **Q2. "Will call later" is a Done: yes.** The patient is released and the follow-up stays
  `open`.
- **Q3. All referrals count**: GHM departments and outside hospitals.
- **Q4. Echo referrals are included.**

Next: your review of this plan, then build in small steps (migration → hold service + gate
→ Rx desk → coordinator section → HealthRay note → board/journey), with the e2e tests
alongside each step.

## 7. As built

**Deploy order**

1. Apply `server/migrations/2026-12-11_coordinator_holds.sql` on production
   (`node migrations/_runOne.mjs migrations/2026-12-11_coordinator_holds.sql`). Until the
   table exists every hold path is a no-op (`holdsReady()`), so the code is safe to deploy
   first, but nothing is recorded either.
2. Deploy, then restart the API and the worker.
3. Holds are recorded, the coordinator's list fills, and the Rx station blocks referred
   patients until the coordinator is done.

**Where the build differs from the plan**

- Hold sources are re-read in one place, `syncHoldIn` (`coordinatorHold.js`), called on the
  way into `doctor_done` / `rx_pending` (`advanceStatus`), on desk / chip referral create and
  remove, on the Scribe `POST /visit/:patientId/referral`, before the gate, and every 30 s by
  `syncDayHolds` in the floor sync (`appointmentSync.js`). The floor sync is what catches
  HealthRay notes and echo flags. There is no separate note-sync hook.
- A HealthRay note counts only once that day's appointment is `completed` / `seen`. Before
  that, the cumulative note still holds the previous visit's plan (see the memory note
  "Cumulative notes → stale baseline labs").
- Booked at GHM writes a history note on the follow-up item, not `booked`. `booked` needs the
  GHM appointment id, which the coordinator links from the row's own **Book appointment**.
  Booked outside / Declined / Not available move the item. Will call later leaves it open.
  The follow-ups are collected first, so HealthRay-note items that do not exist yet are not
  missed.
- Patient tracker: the new **Care Coordinator** journey step shows there like any other stop.
  No separate text.

**Tests**: `e2e/giniflow/G112-referral-coordinator-hold.spec.js`, 14/14 (service level).
The route-level checks (403 on skip for non-admin, the on-floor list over HTTP) still need a
run on a fresh test API.
