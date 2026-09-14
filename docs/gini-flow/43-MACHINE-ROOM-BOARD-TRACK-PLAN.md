# 43 — The Machine Room on the Flow Manager board

Status: **W1–W9 built 14 Sep 2026** (`npm run smoke:giniflow-machine-board`). Review pass: ownership follows the Machine Room start gate (vitals recorded, not status); a Machine Room patient is judged on the machine clock in stats and filters; the timeline ends the current step when the Machine Room takes the patient and shows "Machine Room — <tests>" against the journey budget; the lab-report wait starts when tests were ordered, not at the start of the queue. Written 14 Sep 2026 against `main` @ `e279036` plus the uncommitted
working tree of plans 40 and 41. Follows `36-MACHINE-TEST-STATION-PLAN.md`,
`39-HYBRID-FLOOR-PLAN.md` (§15/§16 the case lists), `40-ORDERED-TESTS-HOLD-PLAN.md`,
`41-MACHINE-CATALOG-PLAN.md` and `42-SYNC-COMPLETION-GATES-PLAN.md` (§ `showAt: lab|machine`).

> **Coordinate before building.** On 14 Sep 2026 two other sessions have uncommitted work in files
> this plan reads or touches: plan 40 (`testsHold.js`, `appointmentSync.js`, `shared/manualFloor.js`)
> and plan 41 (`machineCatalog.js`, `shared/machineStages.js`, `machineStation.js`, `machineSync.js`,
> `journey.js`, `shared/journeyOrder.js`). This plan edits **none** of those. It edits `board.js`,
> `shared/giniflowStatus.js`, `FlowManagerPage.jsx`, `useGiniflowQueue.js`, `useGiniflowLive.js`,
> and one `getMachineTrack` filter; phase 1 needs no migration. Machine identity must come from
> `machineCatalog.getMachines(db)` (plan 41), never from the removed `MACHINES` literal.

---

## 1. What was asked

> Make the Machine test floor also appear in `/giniflow/manager` and wire it correctly.

The manager board has a **Lab track** column beside the consultation chain. Machine tests (ABI,
VPT, Fundus, TMT, ECG, 2D Echo) have their own station (`/giniflow/station/machine`) but nothing
on the board: a patient on the treadmill for 50 minutes sits in "With Chief Endocrinologist" with no
sign of where they actually are. The coordinator cannot see who is on which machine, who is waiting
for one, or who is running over their machine budget.

---

## 2. How it works today (read from the code)

### 2.1 Machine orders

| Fact                                                                                                                                                                                                                            | Where                                              |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| A machine test is a `giniflow_lab_orders` row with `kind='machine'`, tests in `giniflow_lab_order_tests`, history in `giniflow_lab_order_events` (`track` = `payment` \| `sample`)                                              | migration `2026-09-19_machine_test_station.sql`    |
| Raised by: reception journey builder (`journey.js:363-417`), HealthRay bill sync every 90 s (`machineSync.js:232-259`), MO/consultant `orderTests` (`moStation.js:692-859`), station add (hidden, `MachineStationPage.jsx:317`) | —                                                  |
| `urgency` is always `today` except MO/consultant orders, which may be `tomorrow` / `next_visit`                                                                                                                                 | `moStation.js`                                     |
| Ladder `MACHINE_RUNGS`: `ordered` (`ordered`,`payment_pending`,`paid`) → `in_progress` → `done` → `reported`. No `not_done` rung                                                                                                | `shared/machineStages.js:5-90`                     |
| Moving to `done` immediately continues to `reported` (a second event), so `done` only persists after a report is removed                                                                                                        | `machineStation.js:666-681`, `:830-842`            |
| Forward moves need payment cleared (`paid`/`claim_approved`); starting needs vitals recorded, blood drawn, the patient not in a room (unless the room was written by the HealthRay sync), and the machine free                  | `machineStation.js:87-201`, `:590-599`             |
| **Machine work never writes `giniflow_visits.current_status` or a visit event.** The patient stays in whatever chain column they were in                                                                                        | `advanceMachineTest`, `addMachineTestOn`           |
| One order can hold several machine tests (MO `orderTests` groups by kind); the station queues it under the **first** matching machine only                                                                                      | `moStation.js:779-796`, `machineStation.js:77-83`  |
| Machine events arrive on the live stream as `kind:'lab_order'`, which already invalidates `["giniflow","board"]`                                                                                                                | `eventTailer.js:24-47`, `useGiniflowLive.js:53-59` |

### 2.2 The board

| Fact                                                                                                                                                                                                                | Where                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| One query, `BOARD_SQL`, with a `lab` lateral filtered to `kind='lab'`, newest one only (`LIMIT 1`), clock from `o.updated_at`                                                                                       | `board.js:165-189`                                           |
| `card.lab` comes from a Scribe lab order, else a HealthRay case (`hrlab`), else a lab-only summary                                                                                                                  | `board.js:460-534`                                           |
| Lab track = `onFloor.filter(c => c.lab && !(c.finished && c.labSettled))`                                                                                                                                           | `board.js:553`                                               |
| Every other column runs `col.statuses.includes(c.status)` — a new column with `statuses: null` and no special case **throws**                                                                                       | `board.js:565`                                               |
| `PRE_MO_COLUMNS` rule hides a patient with `card.lab` from Checked in / Chief columns unless they are in a room                                                                                                     | `board.js:353`, `:562-571`                                   |
| The same card renders in the chain column and the lab track; the client marks the side copy with `card.column === "lab"`                                                                                            | `FlowManagerPage.jsx:365`, `:726`                            |
| Lab cards: not draggable, not orderable, no ⋮ menu, grey when unbudgeted                                                                                                                                            | `FlowManagerPage.jsx:391`, `:617`, `:528`                    |
| Machine tests already feed the chain card indirectly: `awaitingReports` (all kinds), `heldForTests` / `chiefWaitClock` (plan 40), `behind.station='machine'`                                                        | `board.js:90-92`, `testsHold.js`, `observation.js`           |
| Timeline modal already has a machine section from `getMachineTrack` — **no `urgency` filter**, so next-visit orders show as "waiting"                                                                               | `machineStation.js:861-898`, `FlowManagerPage.jsx:1053-1093` |
| SLA: no machine key in `giniflow_sla_config`. The `lab_total` perf average reads **every** order with `uploaded_at`, and machine orders set `uploaded_at` when reported — machine times already skew the lab figure | `board.js:823-844`, `machineStation.js:652`, `:670`          |

### 2.3 Places that assume the fixed column set

`BOARD_COLUMNS` (`shared/giniflowStatus.js:121-173`), `COLUMN_ENTRY_STATUS` (`:310-320`),
`ORDERED_COLUMNS` / `nextColumn` / `canDropInColumn` (`:322-345`), the column partition and
`getBottleneck` in `board.js`, `COLUMN_NAME` in `labStation.js:43` / `machineStation.js:42` /
`pharmacyStation.js:25` (safe — `columnForStatus` never returns a null-status column),
`FlowManagerPage.jsx` (`isLab`, `ORDERABLE`, header budget label, `NOTIFY_TARGET`, `STAT_FILTERS`,
`noMoveReason`), the optimistic move in `useGiniflowQueue.js:170-185`, `giniflowMoveSchema`
(`schemas/index.js:951-953`), and smokes `smoke-giniflow-queue.mjs:82-115`,
`smoke-giniflow-manager.mjs:57-67`.

---

## 3. Gaps this plan closes

- **G1** No machine card anywhere on the board; a patient on a machine looks idle in a chain column.
- **G2** Nothing distinguishes "on the machine now" from "waiting for the machine", and nothing
  judges either against the machine durations already set in the patient's journey.
- **G3** `lab_total` perf average counts machine tests.
- **G4** Timeline shows next-visit machine orders as today's work.
- **G5** A machine event does not refresh the Machine Room screen's own query (only the board's).

Out of scope, recorded in §9: multi-machine orders queued under one machine, MO orders adding no
machine journey step, machine steps never auto-ticking, no `not_done` rung, `giniflowMoveSchema` and
`NOTIFY_TARGET` both missing `rx`.

---

## 4. Design

### D1 — A new side-track column

```js
{ key: "machine", name: "Machine Room", icon: "🩺", slaKey: null, statuses: null }
```

placed directly after `lab` in `BOARD_COLUMNS`; `COLUMN_ENTRY_STATUS.machine = null`; **not** added
to `ORDERED_COLUMNS`, `giniflowMoveSchema` or `queue.js`. Cards are not draggable, not orderable and
carry no ⋮/pause menu. While the Machine Room owns a patient they are shown **only** here (D5).

### D2 — Data: one aggregated `machine` lateral per visit

A visit often has two or three machine orders, and one order can name two machines, so the lab's
`LIMIT 1` pattern would hide work. Add to `BOARD_SQL`:

```sql
LEFT JOIN LATERAL (
  SELECT json_agg(json_build_object(
           'orderId', o.id,
           'tests', (SELECT array_agg(t.test_name ORDER BY t.test_name)
                       FROM giniflow_lab_order_tests t WHERE t.lab_order_id = o.id),
           'sampleStatus', o.sample_status,
           'paymentStatus', o.payment_status,
           'since', COALESCE(
              (SELECT max(e.occurred_at) FROM giniflow_lab_order_events e
                WHERE e.lab_order_id = o.id AND e.track = 'sample'),
              o.created_at)
         ) ORDER BY o.created_at) AS orders
    FROM giniflow_lab_orders o
   WHERE o.visit_id = v.id AND o.kind = 'machine' AND o.urgency = 'today'
     AND o.payment_status IN ('paid', 'claim_approved')
     AND o.sample_status <> 'reported'
) machine ON TRUE
```

**Payment first.** Only orders reception has cleared (`opensLabGate`, `shared/labPayment.js:37-38`)
reach the Machine Room column — the same gate the station enforces on every forward move. An unpaid
test is reception's work, not the Machine Room's, and never appears here.

The lateral also returns the visit's own machine journey steps
(`giniflow_visit_steps.step_catalog_id`, `planned_duration_min`, `started_at`, `completed_at`) so each
test is judged against the budget in **that patient's journey** (D6).

The clock anchors on `sample` events, not `updated_at` (a payment change must not reset
"on the machine for 12m").

Machine names are resolved in JS: `getDayBoard` loads `getMachines(db)` once per call (cached 60 s
by plan 41) and maps each test name with the catalogue's matcher, so a two-machine order yields two
entries and a test the catalogue does not know shows under its own test name.

### D3 — The card field

```js
card.machine = {
  tests: [{ orderId, machine, label, stage, budget, startedAt, minutesOnMachine }], // one per test
  running, // the test in_progress, if any
  subtitle, // "▶️ On TMT · 12m of 20m" | "⏳ Waiting: ABI, VPT" | "✅ Test done — report pending"
  since, // the later of: payment cleared on the first open test, vitals saved
  minutes, // in the Machine Room so far
  budget, // sum of this patient's planned machine durations still open
  colour, // budgetColour(minutes, budget); the running test's own overrun forces red
};
```

Stage: a running test is always named first (`in_progress` → "On <machine> · Xm of Ym"); otherwise
`paid`/`ordered` → "Waiting for <machines>"; only `done` left → "Test done — report pending". Built
by a pure helper `machineCardFor(orders, steps, machines, now)` in `board.js` so the smoke can test
it without a database.

### D4 — Column membership

`machine` column = `onFloor.filter(c => c.machine)`. A patient is on it from the moment reception
clears payment for a today machine test until every such test is `reported`; then `card.machine` is
`null` and they return to their chain column.

### D5 — Shown only in the Machine Room

While `card.machine` exists the patient's chain card is **removed from every chain column** and
lives only on the Machine Room track, the way a lab patient already leaves Checked in / Chief for
the Lab track (`board.js:562-571`), extended to all chain columns:

- **Before vitals** (`checked_in`, `vitals_pending`, `with_vitals`) they stay in their vitals column:
  the machine station refuses to start a test until vitals are recorded
  (`machineStation.js:159-201`), and the journey places tests after vitals
  (`shared/journeyOrder.js`). They move to the Machine Room the moment vitals are saved.
- **Physically in a doctor's or the Rx room** (`with_sd`, `with_doctor`, `with_rx`, room not written by
  the HealthRay sync) they stay in that room's column — the machine cannot take them there either
  (`assertPatientIsFree`).
- Everything else (`vitals_done`, `sd_pending`, `ready_for_doctor`, `rx_pending`,
  `pharmacy_pending`) → Machine Room only.

This is plan 42's `showAt: machine` for the board. The lab track keeps its own existing rule; a
patient owed both blood and a machine test shows on both side tracks.

### D6 — Timing: the patient's own journey budget

Every machine test already has a predefined duration in the patient's journey:
`giniflow_visit_steps.planned_duration_min`, seeded from `flow_step_catalog.default_duration_min`
(14 Sep 2026: ABI 10, VPT 5, Fundus 10, TMT 20, ECG 5, 2D Echo 20). The board uses exactly that:

- **Per test:** minutes since its `in_progress` event, judged against that test's
  `planned_duration_min` (catalogue `durationMin` when the visit has no step for it, e.g. an MO order,
  §9.2). Shown as "12m of 20m".
- **Per card:** minutes since the patient became the Machine Room's (payment cleared and vitals
  saved, whichever is later — D5), judged against the sum of the
  open tests' planned durations. A running test over its own budget turns the card red regardless.
- **Per column:** `budgetMinutes` = mean card budget, `avgMinutes` = mean card minutes, so the
  existing `hot` flag and `getBottleneck` work unchanged and name the Machine Room when patients
  overrun their machine budgets.

No new `giniflow_sla_config` row is needed — the budgets live in the journey, where the floor
already sets them.

Separately, fix G3: add `AND o.kind = 'lab'` to the order branch of the `lab_total` average
(`board.js:823-829`).

### D7 — Client

- `PatientCard`: replace `isLab` with a side-track switch
  `const track = card.column === "lab" || card.column === "machine" ? card.column : null;`
  and read `card[track]` for anchor, minutes, budget, subtitle, hint. Everything currently gated on
  `!isLab` becomes `!track`. Machine cards list their tests as chips (reuse `.pc-tests`) with each
  test's "Xm of Ym" while running.
- `ORDERABLE = (key) => !["lab", "machine", "done"].includes(key)`.
- Column header for machine: "Journey budget: <mean> min".
- `NOTIFY_TARGET.machine = ["machine"]` (`StationNotice station="machine"` already listens,
  `MachineStationPage.jsx:558`). Reception is not notified: nothing on this track is unpaid.
- `useGiniflowQueue.js` optimistic move: treat `machine` like `lab` (patch the copy in place) so the
  machine card does not vanish until the refetch.
- `STAT_FILTERS`: `filteredCount` counts unique card ids, not column copies.
- Timeline modal: no change beyond W6.

### D8 — Realtime

Board refresh already works (`lab_order` → board). Add `["giniflow","machine"]` to
`INVALIDATES.lab_order` in `useGiniflowLive.js` so the Machine Room screen also updates when
reception clears a payment (G5). Vitals saves already arrive as `kind:'vitals'` and invalidate the
board, so a patient moves to the Machine Room column without waiting for a poll.

---

## 5. Work items

| #   | Change                                                                                                                                                           | Files                                                                                          |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| W1  | `machine` column in `BOARD_COLUMNS`, `COLUMN_ENTRY_STATUS.machine = null`                                                                                        | `shared/giniflowStatus.js`                                                                     |
| W2  | `machine` lateral (paid only, with the visit's machine steps), `machineCardFor` helper, `card.machine` with journey budgets                                      | `server/services/giniflow/board.js`                                                            |
| W3  | Column partition branch for `machine` (no `statuses.includes`), D5 hiding of the chain copy, column budget/avg from card budgets                                 | `board.js`                                                                                     |
| W4  | `lab_total` average filtered to `kind='lab'`                                                                                                                     | `board.js`                                                                                     |
| W5  | Client side-track generalisation, `ORDERABLE`, `NOTIFY_TARGET`, unique `filteredCount`                                                                           | `src/pages/giniflow/FlowManagerPage.jsx`                                                       |
| W6  | `getMachineTrack` filtered to `urgency='today'`                                                                                                                  | `server/services/giniflow/machineStation.js` (one line — agree with the plan 41 session first) |
| W7  | Optimistic move keeps the machine copy                                                                                                                           | `src/queries/hooks/useGiniflowQueue.js`                                                        |
| W8  | `lab_order` also invalidates `["giniflow","machine"]`                                                                                                            | `src/queries/hooks/useGiniflowLive.js`                                                         |
| W9  | Smoke `smoke-giniflow-machine-board.mjs` + `npm run smoke:giniflow-machine-board`; update `smoke-giniflow-queue.mjs` column loop if it trips on `statuses: null` | `server/scripts/`, `server/package.json`                                                       |
| W10 | Copy: "Eight columns" → count-free wording                                                                                                                       | `FlowManagerPage.jsx:1734`                                                                     |

Build order: W1 + W3 together (the server throws otherwise) → W2 → W4 → W5 + W7 → W6, W8 → W9.

---

## 6. Tests (smoke, pure where possible)

| #   | Case                                                       | Expect                                                                                           |
| --- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| T1  | No machine orders                                          | `card.machine === null`; column empty; no throw                                                  |
| T2  | One ABI order `payment_pending`                            | not on the Machine Room column; patient stays in their chain column                              |
| T3  | ABI and VPT paid, `vitals_done`                            | only in Machine Room, "Waiting for ABI, VPT", budget 15m                                         |
| T4  | TMT `in_progress` 25m, planned 20m                         | "On TMT · 25m of 20m", card red                                                                  |
| T5  | One order naming ABI and VPT                               | two entries in `tests`                                                                           |
| T6  | All machine orders `reported`                              | patient back in their chain column, not in Machine Room                                          |
| T7  | `next_visit` machine order only                            | not on the machine column, not in the timeline machine track                                     |
| T8  | Paid ABI, patient `checked_in` / `with_vitals`             | stays in the vitals columns; appears in Machine Room once vitals are saved                       |
| T9  | Payment change after start                                 | clock unchanged (anchored on the `sample` event)                                                 |
| T13 | Paid ECG, patient `with_sd` written by Scribe              | stays in the Chief column until released                                                         |
| T14 | Visit step `planned_duration_min` edited to 30 for TMT     | TMT judged against 30, not the catalogue 20                                                      |
| T10 | `lab_total` average with a reported machine order that day | machine order excluded                                                                           |
| T11 | Board column loop with `statuses: null`                    | `nextColumn`, `canDropInColumn`, `columnForStatus` unaffected; `moveToColumn("machine")` refused |
| T12 | Machine card drag                                          | not draggable; ⋮ menu absent                                                                     |

---

## 7. Floor rules this plan is built on (confirmed 14 Sep 2026)

| Rule                                                                                                 | Where it lands |
| ---------------------------------------------------------------------------------------------------- | -------------- |
| Each machine test is timed against the predefined duration in the patient's journey                  | D6             |
| A patient with machine tests open is shown **only** in the Machine Room                              | D5             |
| Patients do not go home with a machine test still open — no "left before the test" state is modelled | D4             |
| No lab or machine test happens before reception clears payment — unpaid tests never reach the track  | D2             |

---

## 8. Risks

- **Crash on deploy** if W1 lands without W3 (`col.statuses.includes` on null). Ship together.
- **Two side-track copies** (lab + machine) for a patient owed both inflate per-column counts;
  `getDayStats` uses unique cards, only the client filter count needs W5.
- **Plan 41 churn**: the catalogue matcher's name/signature may still change; W2 must import from
  `machineCatalog.js` / `shared/machineStages.js` as they stand when this is built.
- **Plan 40 overlap**: plan 40's `heldForTests` keeps a held patient in the Chief/consultant column
  with a hint; D5 moves a machine-held patient out of those columns entirely. Agree with the plan 40
  session that D5 wins for machine tests before building.
- **A room with no end**: a patient stuck in `with_sd` stays in the Chief column (D5); a machine test
  that cannot be done has no `not_done` rung (§9.3) and would keep the patient on the track all day.

---

## 9. Found while reading, not fixed here

1. MO/consultant `orderTests` puts several machine tests in one order; the station queues only the
   first machine (`machineStation.js:77-83`). The board (D2) shows all of them, the station does not.
2. MO/consultant orders insert no machine journey step (`moStation.js:849`); machine steps never
   auto-tick from order status and are swept to `skipped` on exit (`journey.js:639-645`).
3. No `not_done` machine rung: a test that cannot be done holds the patient under `testsHold` forever.
4. Upload from `ordered` jumps to `reported`, skipping the start gates (`labStation.js:1185`).
5. `giniflowMoveSchema` omits `rx` (a consultant → Rx drop fails validation); `NOTIFY_TARGET`
   omits `rx`.
6. `RESUME_CAPS` has no `GINIFLOW_STATION_MACHINE`; the machine tech cannot resume a paused patient
   (`routes/giniflow.js:454-461`).
7. `GET /api/giniflow/machines` is gated on `GINIFLOW_STATION_MACHINE`, not any Gini Flow capability
   as plan 41 D2 intended.
8. Four different definitions of "tests outstanding" (`reports_outstanding`, `testsHold`,
   `assertReportsAreIn`, the lab lateral) disagree on kinds, urgency and HealthRay cases.

---

## 10. One station at a time (floor rule, 14 Sep 2026)

A patient is in exactly one place on the board. `placementFor` in `board.js` decides it, in order:

| #   | Situation                                                                              | Place                                 |
| --- | -------------------------------------------------------------------------------------- | ------------------------------------- |
| 1   | Visit finished                                                                         | Done                                  |
| 2   | Vitals not recorded (samples-only patients exempt), or at the vitals desk              | Their chain column                    |
| 3   | Physically in the Chief's, consultant's or Rx room (a room Scribe wrote, not the sync) | That room's column                    |
| 4   | A paid lab test with the sample not yet collected                                      | Lab track                             |
| 5   | A paid machine test not yet reported                                                   | Machine Room                          |
| 6   | Lab reports still outstanding                                                          | Lab track ("waiting for lab reports") |
| 7   | Nothing open                                                                           | Their chain column (the Chief, etc.)  |

So after vitals: lab first until the sample is collected, then the machine, then back to the Chief once every
report is in. When the Chief orders tests the same order applies, and the Chief's step is not completed by the
HealthRay sync while any test is open (sync hold, sweep filters and the `advanceStatus` backstop).

The stations enforce the same order: the lab refuses to collect from a patient who is on a machine, and the
Machine Room refuses to start while blood is undrawn — including a HealthRay lab case with no floor collection
recorded. The timeline ends the current step when the Lab or Machine Room takes the patient.
