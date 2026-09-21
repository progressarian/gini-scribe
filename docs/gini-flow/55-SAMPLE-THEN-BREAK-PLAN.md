# 55 — Sample first, then a break: Lab 1 sends the patient away, the clock starts on return

Status: **BUILT 21 Sep 2026** as amended in §8 (`npm run smoke:sample-break`, `smoke:routing-gates`). Not committed.

---

## 1. The case, in the floor's words

Reception marks the patient arrived. Reception clears the lab bill. The patient goes straight to
Lab 1 and gives the sample — **before vitals**. Then they leave (breakfast, home, errands) and come
back later in the day. By then their reports are usually ready. On return they do vitals → Chief
→ consultant → Rx explain → pharmacy, and **skip the lab, because it is already done**.

The time they were away is not waiting time. Their waiting time starts when they come back.

---

## 2. What the code does today

| #   | Today                                                                                                                                                                                                                                                                                          | Where                                                                     |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| T1  | **The draw is refused before vitals** — "…the patient goes to vitals before the draw". This case cannot be recorded at all.                                                                                                                                                                    | `labStation.js:981` `assertVitalsRecorded`, called at `:1171 :1184 :1514` |
| T2  | The clock runs through the whole absence: the card sits in Checked in timed from arrival, goes red, raises the column average, can be named bottleneck; the check-in→vitals hop and the Done-today journey average both include the hours away.                                                | `board.js:1150-1155 :1375 :1590 :1660`                                    |
| T3  | The only way to hold the clock is reception / the board pressing ⏹ Stop and ▶ Restart by hand. The maths is right (a not-started patient restarts from zero) but nothing prompts it.                                                                                                           | `statusEngine.js:850-1009`                                                |
| T4  | **Stations ignore a pause.** The vitals queue shows the absent patient as waiting with a running timer. Starting vitals on a paused visit leaves the pause open (board frozen), and a later Resume shifts every anchor by the whole gap including the time at vitals.                          | `vitalsStation.js:40-72 :487`                                             |
| T5  | The patient tracker `/visit/:token` counts from the first check-in and ignores pauses.                                                                                                                                                                                                         | `journey.js:1154-1171`                                                    |
| T6  | Reception's Arrivals counts them as "here".                                                                                                                                                                                                                                                    | `receptionStation.js:1017-1048`                                           |
| W1  | **Loophole:** the vitals gate accepts a `with_vitals` event by a person as proof of vitals. Tapping the patient at vitals and releasing them without saving a reading — or a board drag into the vitals column — opens the lab and the machine room.                                           | `labStation.js:986-992`, same check in `machineStation.js`                |
| W2  | **Loophole:** a Scribe lab order may jump any number of rungs forward (`toIdx > fromIdx`). The vitals and draw gates run only on `drawing` / `sample_collected`, so a paid order walked straight to `sample_received` or later skips both. HealthRay cases already enforce one rung at a time. | `labStation.js:1158-1185` vs `:1470-1483`                                 |

Already right, no change needed:

- **Lab is skipped on return.** Recording the sample ticks the journey's Blood Sample step (and Lab
  Billing once paid) inside the same transaction — `labStation.js:1236` → `syncLabStepsFromLab` →
  `journey.js:1004-1005`. The journey's "next" is then Vitals, not the lab.
- **Reports still pending on return** hold the Chief step and show "Waiting for N reports"
  (`testsHold.js`, plan 40). Reports landing during the break are a marker event and move nothing.
- **Payment before the sample** (`opensLabGate`, `assertLabBillingCleared`) — unchanged.
- **Blood before any machine test** (plan 39 G2) — already satisfied by the early draw.

---

## 3. The design

### 3.1 Lab 1 gets a second way to finish the collection

On the card at the "Sample taken" step, Lab 1 sees two buttons:

```
[ ✓ Sample taken ]      [ ✓ Sample taken · patient on break ⏸ ]
```

- **Sample taken** — as today.
- **Sample taken · patient on break** — records the sample exactly as today **and**, in the same
  transaction, puts the visit on break (`pauseVisit` with reason `sample_break`, actor `lab`).

The lab's own ladder is untouched: the tube still goes sent → received → processing → results →
uploaded while the patient is away. The break is on the **visit**, never on the lab order.

Offered on both kinds of lab card: Scribe orders (`advanceSample`, `to: sample_collected`) and
HealthRay cases (`markLabCaseAction`, `action: sample_taken`). Same button, same effect.

### 3.2 What the break means, by where the patient is

Reuses the two kinds of pause the engine already has (`hasNotStarted`):

| Patient at when the sample is taken     | Break kind                   | On return                                                                  |
| --------------------------------------- | ---------------------------- | -------------------------------------------------------------------------- |
| `checked_in` / `vitals_pending` (usual) | not started → clock restarts | Vitals waiting list, wait timed **from return**, journey total from return |
| past vitals (e.g. waiting for Chief)    | underway → clocks held       | Back in the queue they left, break time left out                           |

A patient inside a room (`with_vitals`, `with_sd`, …) cannot be drawn at all — `assertPatientIsFree`
already refuses — so no third kind exists.

### 3.3 While they are away

| Screen             | Shows                                                                                                                                                                 |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Vitals station     | Not in the waiting list. A collapsed group **"⏸ On break — sample given (N)"** with "left 08:20", no timer. Tappable, because tapping one means they are back (§3.4). |
| Manager board      | Card stays in its column labelled **"⏸ On break · sample given 08:20"**; left out of the column average and the bottleneck.                                           |
| Reception Arrivals | Counted as **away**, not here. Row shows **▶ Back**.                                                                                                                  |
| Lab 1              | Drops off the collection queue, as any collected patient does. Lab 2 carries on with the tube.                                                                        |
| Patient tracker    | "On a break — see reception when you are back", clock frozen.                                                                                                         |

### 3.4 Coming back — whichever happens first

1. **Reception presses ▶ Back** (the existing Restart button, labelled "Back" for a `sample_break`).
   The patient appears in the Vitals waiting list, timed from that moment.
2. **The vitals nurse taps them** from the On-break group without reception doing anything —
   `startVitals` ends the break and takes them in, in one transaction. Their time starts at vitals
   start, which is the floor's rule when nobody marks the return.
3. **Any other station start or a board drag** does the same (`resumeIfPaused`), so a break can never
   stay open on a patient who is standing at a desk.

Then the journey carries on as normal: Vitals → (Machine Room if billed) → Chief → Consultant → Rx
Explain → Pharmacy. The lab is already ticked done.

---

## 4. Changes

### 4.1 The early draw (T1)

`assertVitalsRecorded` leaves the **lab draw** — Scribe orders and HealthRay cases. The Machine Room
keeps its vitals gate. Payment gate unchanged. Plan 39 §G1 updated to say "machine only";
`smoke-routing-gates.mjs` updated to pin the new rule.

### 4.2 Close the loopholes (W1, W2)

- **W1** — "vitals recorded" becomes a `giniflow_vitals` row, or a `vitals_done` event by a person.
  A `with_vitals` event alone no longer counts (someone was taken in, nothing was measured). One
  shared helper used by the lab and the machine room, so they cannot drift.
- **W2** — `advanceSample` moves one rung at a time, with the same single exception HealthRay cases
  already have: Lab 2 may record `sample_received` straight after `sample_collected` (receipt is its
  own proof of sending). Mirrors `labStation.js:1476-1483`.

### 4.3 The break (T2, T3)

- `statusEngine.js` — split `pauseVisit` / `resumeVisit` into transaction-taking cores
  (`pauseVisitTx(client, …)`, `resumeVisitTx(client, …)`) with the existing functions as thin
  wrappers. Add `resumeIfPaused(client, visitId, actor)`.
- `shared/giniflowStatus.js` — `SAMPLE_BREAK_REASON = "sample_break"` and its label.
- `labStation.js` — `advanceSample` and `markLabCaseAction` take `thenBreak`; when true and the step
  is the collection, call `pauseVisitTx` in the same transaction with
  `meta: { reason: "sample_break", lab_order_id | case_no }`. Undoing that collection cancels the
  break if it is still open and is still the `sample_break` one (no clock moved — the patient never
  left).
- `server/schemas/index.js` — `thenBreak: z.boolean().optional()` on both lab bodies.
- `src/components/giniflow/lab/LabRoom.jsx` + its query hooks — the second button on the collection
  step.

### 4.4 Stations respect the break (T4)

- `vitalsStation.js` — queue excludes paused visits from the waiting list and returns them as an
  `onBreak` group; wait timer uses `WAIT_SINCE_SQL` and freezes at `paused_at`, matching the board.
  `startVitals` calls `resumeIfPaused` before moving to `with_vitals`.
- `moStation.js`, `doctorStation.js`, `rxStation.js`, `pharmacyStation.js`, `machineStation.js`,
  lab draw start, and the board's column drop — each "start" calls `resumeIfPaused`.

### 4.5 Screens (T2, T5, T6)

- `board.js` — `pausedReason` already on the card; paused cards excluded from `timedCards` and the
  bottleneck. `FlowManagerPage.jsx` renders the `sample_break` label.
- `receptionStation.js` / `ReceptionStationPage.jsx` — `away` count; "arrived 08:10 · back 13:40";
  the button reads **▶ Back** for a sample break.
- `journey.js trackByToken` — latest journey start (`JOURNEY_START_SQL`), frozen while paused.
- Timeline — show `meta.original_occurred_at` for the shifted check-in, and an
  "On break 08:20–13:40 (sample given)" row from the paused/resumed pair.

Averages need no query change: resume already moves the check-in event to the return time, so the
check-in→vitals hop and the journey total measure from return.

---

## 5. Edge cases

| Case                                             | Behaviour                                                                                                           |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| Never comes back                                 | Stays on break on every screen; nightly `staleVisits` closes it (exited if HealthRay completed it, else abandoned). |
| Reports ready before return                      | Nothing to do — the Chief is not held.                                                                              |
| Reports still pending on return                  | Vitals as normal; Chief card shows "Waiting for N reports" (plan 40).                                               |
| Blood + machine tests                            | Blood → break → on return Vitals → Machine Room → Chief.                                                            |
| Lab tech pressed plain "Sample taken" by mistake | Reception's ⏸/⏹ on Arrivals, or the board card, puts them on break as today.                                        |
| Break button pressed by mistake                  | Reception ▶ Back — patient is timed from that moment.                                                               |
| Two lab orders, break pressed on the first       | Break is on the visit and idempotent; the second order's draw auto-resumes (they are at the bench).                 |
| HealthRay re-check-in on return                  | Ignored by the manual floor (`manualFloor.js`); ▶ Back or vitals start is the return signal.                        |

---

## 6. Build order (each checked before the next)

1. W1 + W2 loopholes — `smoke:giniflow-lab`, `smoke:lab-steps`, `smoke-routing-gates`.
2. Early lab draw (4.1).
3. `pauseVisitTx` / `resumeVisitTx` / `resumeIfPaused` refactor — no behaviour change.
4. Lab 1 break button, server + UI (4.3).
5. Stations respect the break (4.4).
6. Board, reception, tracker, timeline (4.5).
7. `smoke-sample-break.mjs`: draw before vitals allowed; machine still refused; break freezes
   clocks; vitals tap ends the break and times from vitals start; ▶ Back times from return; undo
   cancels the break; lab ladder continues while on break; journey next is Vitals, not the lab.

⚠️ Smoke scripts run against the production database — fixtures must clean up after themselves.

---

## 7. Decisions (21 Sep 2026)

- **The early draw is allowed for every patient**, not only one going on break. Payment is still
  required first; a patient drawn early who stays simply walks on to vitals.
- **No second sample on return.** One collection per lab order, as today.

---

## 8. As built — where it differs from §4

- **One place ends a break, not seven.** `advanceStatus` ends an open break when the move proves
  the patient is present: entering a room (`with_vitals`, `with_sd`, `with_doctor`, `with_rx`) or
  `dispensed` — by anyone, including the HealthRay sync opening them with the Chief — or the first
  move by a person on a patient nobody had seen yet (e.g. vitals saved without "start"). A queue move
  made from a desk (Rx finalised, MO closing, sync parking them in a queue) does **not** end a break —
  the patient may still be out. The lab draw start and the machine start call `resumeVisitTx`
  directly.
- **MO and consultant queues** freeze the wait timer and show "⏸ on break" for a paused patient.
- **W2 as built:** no rung past the draw until the sample is recorded (`assertSampleDrawn`), checked in
  `advanceSample`, `uploadReport` and typed results **before** anything is written. Lab 2 may still
  tap any later rung in any order once the tube is drawn, as before.
- **W1 as built:** `VITALS_TAKEN_SQL` in `visitVitals.js` — a `giniflow_vitals` row or a
  `vitals_done` by a person. Used by the machine room's start gate and its queue card.
- **Reception** shows "Sample given · on break since 08:20" and the **▶ Back** button; the counts
  read "N here · N on break · N left". It does not print the original arrival time — the timeline
  does, as an "Arrived — time before the break is not counted" marker from
  `meta.original_occurred_at`.
- **Undo** exists only for HealthRay cases (a Scribe order cannot step back from
  `sample_collected`); undoing `sample_taken` or `drawing_started` cancels an open sample break with
  no clock moved (`cancelPauseTx`).
- **Not run:** `smoke:giniflow-vitals`, `smoke:giniflow-lab` (they seed demo rows on the production
  database). `smoke:lab-steps` fails on its lab-billing checks with and without this change.
