# 47 — X-Ray and Echo columns on the Flow Manager board

Status: **Phase 1 (§3–§5) and Phase 2 (§7–§11) BUILT 16 Sep 2026**, except X10 (deferred,
see §12). `npm run smoke:giniflow-machine-board` and `npm run smoke:machine-steps` pass;
`vite build` is clean. See §12 for what was verified and what still needs a deploy. Follows `43-MACHINE-ROOM-BOARD-TRACK-PLAN.md` (the Machine Room column),
`45-ECHO-STATION-PLAN.md` and `46-XRAY-STATION-PLAN.md` (the two stations split out of the
Machine Room). Picks up the item plan 45 §4 left out of scope.

---

## 1. What was asked

> Implement two more boxes in `/giniflow/manager` for the X-ray station and the Echo station.

Plans 45 and 46 gave X-ray and Echo their own screens, roles and people, but the board still put
every machine patient in one **Machine Room** column. So the coordinator couldn't tell a patient
waiting at the X-ray room from one on the treadmill, and a bottleneck banner said "Machine Room"
when the Echo desk was the one running behind.

---

## 2. Starting point (read from the code)

| Fact                                                                                                        | Where                                                                            |
| ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Each machine has a station in the catalogue: `machine_room` \| `xray` \| `echo`                             | `flow_step_catalog.machine_station`, `shapeMachine().station`                    |
| Echo can't start until the visit's X-ray is `reported`                                                      | `machine_requires_before`, `shapeMachine().requiresBefore`, `assertReadyToStart` |
| The board places a patient in exactly one place; `placement === "machine"` means "a machine room owns them" | `placementFor` in `board.js` (plan 43 §10)                                       |
| `card.machine` lists **every** open paid machine test of the visit, with its own clock and journey budget   | `machineCardFor`                                                                 |
| One column, `machine`, took every `placement === "machine"` card                                            | `getDayBoard` column partition                                                   |
| Station screens and notices already use the keys `machine`, `xray`, `echo`                                  | `MachineStationPage station=…`, `StationNotice`, `useGiniflowMachine` query keys |

---

## 3. Design

### D1 — Two new side-track columns

```js
{ key: "machine", name: "Machine Room", icon: "🩺", slaKey: null, statuses: null },
{ key: "xray",    name: "X-Ray",        icon: "🩻", slaKey: null, statuses: null },
{ key: "echo",    name: "Echo",         icon: "❤️", slaKey: null, statuses: null },
```

X-Ray comes before Echo, matching the order the floor has to follow. They are built like the
Machine Room column: `COLUMN_ENTRY_STATUS` is `null`, they are not in `ORDERED_COLUMNS`, cards
can't be dragged or reordered, and there is no ⋮ menu.

`shared/giniflowStatus.js` now holds the column vocabulary once, so no call site has to list the
machine columns itself:

- `MACHINE_STATION_COLUMN = { machine_room: "machine", xray: "xray", echo: "echo" }`
- `MACHINE_COLUMNS`, `SIDE_TRACK_COLUMNS` (`lab` + the machine columns)
- `isMachineColumn(key)` and `machineColumnFor(station)` (a station it doesn't know maps to the Machine Room)

### D2 — Placement is unchanged; the column is chosen inside it

`placementFor` still returns `"machine"` for any machine-owned patient, so these are unchanged:
the one-place rule, `machineOwned`, the HealthRay sync hold, the timeline hold and plan 42's gates.
The only new decision is **which** machine column, made by the pure helper
`owningMachineStation(tests)` in `board.js`:

1. A test that is **running** decides it: the patient is physically in that room.
2. Otherwise, take the first station, in the order Machine Room → X-Ray → Echo, that has a
   **waiting test that can start now**. A test can't start while the machine named in its
   `requiresBefore` still has an open order (so Echo waits while X-ray is open, even if X-ray is
   `done` but not yet reported).
3. Otherwise (everything left is "test done, report pending"), take the first station in that
   order that still has an open test.
4. With no match, the Machine Room.

`machineCardFor` stamps each test with its `station`, and the card with `station` and
`column`. The column partition becomes
`placement === "machine" && card.machine.column === col.key`.

Why Machine Room before X-ray when nothing is running: nothing in the catalogue orders them, and
the Machine Room has the most machines (it's the most likely to be free). Only one ordering is a
real rule: X-ray before Echo. It lives in the catalogue data, not in this list, so changing
`machine_requires_before` changes the board with no code change.

### D3 — The card still shows the whole machine journey

A card in the X-Ray column still lists **every** open machine test (for example
"▶️ X-Ray 4m of 15m · ⏳ 2D Echo · 20m"). The coordinator can see where the patient goes next,
and the card's clock and budget stay the same as the timeline hold (`getTestsPlacement`).
The column budget is still the mean of its cards' journey budgets, as in plan 43 D6.

### D4 — Timeline hold names the room

`getTestsPlacement` labels the hold with the owning column's name (for example
"X-Ray — X-Ray, 2D Echo" or "Echo — 2D Echo"). Before, every hold was labelled
"Machine Room — …". It also returns `machine.column`.

### D5 — Client

- `PatientCard`: `isMachine` is `isMachineColumn(card.column)`, so the machine card layout
  (test chips, running clock, red on overrun) renders in all three columns.
- `ORDERABLE` and the optimistic move in `useGiniflowQueue.js` use `SIDE_TRACK_COLUMNS`.
- The column header shows "Journey budget:" for all three.
- `NOTIFY_TARGET.xray = ["xray"]`, `NOTIFY_TARGET.echo = ["echo"]`. A bottleneck on either
  column now notifies that desk's screen (`StationNotice station={station}` already listens).
- `useGiniflowLive`: a `lab_order` event also invalidates `["giniflow","xray"]` and
  `["giniflow","echo"]`. Those screens use their own query keys and weren't refreshed live before.

---

## 4. Work items

| #   | Change                                                                            | Files                                             |
| --- | --------------------------------------------------------------------------------- | ------------------------------------------------- |
| W1  | `xray` / `echo` columns, entry status `null`, station→column vocabulary           | `shared/giniflowStatus.js`                        |
| W2  | `owningMachineStation`, per-test `station`, card `station`/`column`               | `server/services/giniflow/board.js`               |
| W3  | Column partition, budget/avg, sort and `getBottleneck` for every machine column   | `board.js`                                        |
| W4  | Timeline hold label from the owning column                                        | `board.js`                                        |
| W5  | Card, `ORDERABLE`, header label, `NOTIFY_TARGET`                                  | `src/pages/giniflow/FlowManagerPage.jsx`          |
| W6  | Optimistic move keeps every side-track copy                                       | `src/queries/hooks/useGiniflowQueue.js`           |
| W7  | Live refresh of the X-ray/Echo screens                                            | `src/queries/hooks/useGiniflowLive.js`            |
| W8  | Smoke: room choice, column vocabulary for all three, live-board checks per column | `server/scripts/smoke-giniflow-machine-board.mjs` |

No migration and no route or schema change. `giniflowNoticeSchema` already accepts any station string.

---

## 5. Tests (`smoke-giniflow-machine-board.mjs`, section "which machine room")

| #   | Case                                       | Expect                                                                                                                                                 |
| --- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| T1  | ABI only                                   | `machine`                                                                                                                                              |
| T2  | X-ray only                                 | `xray`                                                                                                                                                 |
| T3  | Echo only                                  | `echo`                                                                                                                                                 |
| T4  | X-ray and Echo both waiting                | `xray` (Echo requires X-ray)                                                                                                                           |
| T5  | X-ray `done` (not reported) + Echo waiting | `xray`                                                                                                                                                 |
| T6  | ABI waiting + Echo `in_progress`           | `echo` (a running test wins)                                                                                                                           |
| T7  | X-ray + ABI waiting                        | `machine`                                                                                                                                              |
| T8  | ABI `done` + X-ray waiting                 | `xray`                                                                                                                                                 |
| T9  | Test name not in the catalogue             | `machine`                                                                                                                                              |
| T10 | ABI + X-ray running                        | card lists both tests                                                                                                                                  |
| T11 | `machine`/`xray`/`echo`                    | exist, not drop targets, not in chain order, no status maps to them                                                                                    |
| T12 | Board order                                | Machine Room < X-Ray < Echo                                                                                                                            |
| T13 | Live board                                 | each machine card sits in the column its `machine.column` names; exactly one place per patient; timeline hold agrees on `since`, `budget` and `column` |

Run on 16 Sep 2026: all passed; the live board had one patient (open 2D Echo) correctly in Echo,
and the bottleneck banner named Echo.

Not run: `smoke:giniflow-queue` and `smoke:giniflow`. Both move real visits, and `.env` is production.

---

## 6. Risks and loose ends (Phase 1)

- **Wider board.** The board scrolls sideways (`.gf .board { overflow-x: auto }`), and two more
  columns make it wider. No layout change was made.
- **Column budget = whole machine journey.** An X-Ray card's budget includes the Echo still to
  come (D3). This matches the timeline hold. A per-room budget would need the hold to split too.
- **Station order when nothing is running** (D2 step 2) is a board default, not a floor rule.
  If the floor wants a different default, change `MACHINE_STATION_COLUMN`'s key order.
- Timeline wording and the Behind panel were listed here after Phase 1. The review moved both
  into Phase 2 (G3, G1).

---

## 7. Gap review (16 Sep 2026)

Method: every `machine` key, `BOARD_COLUMNS` consumer, `requiresBefore` check and
`BEHIND_STATIONS` use was read, and production was queried **read-only** (no writes) for whether
each gap actually happens.

| #   | Gap                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Evidence                                                                                                                                                                                                                                               | Severity                                   |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------ |
| G1  | The Behind panel, the card's "not ticked at …" line and the HealthRay hold (`firstUnrecordedStation`) record every open machine test as `behind_station = 'machine'`, labelled **Machine Room**. X-ray/Echo are never named. The X-ray/Echo desk is never told, and a coordinator walks to the wrong room.                                                                                                                                                   | `observation.js:27-35`, `:87`, `:210`. **Live 16 Sep:** a `vitals_done` patient whose only open test is `2D Echo` has `behind_station = 'machine'`.                                                                                                    | High, visible today                        |
| G2  | Three different answers to "is X-ray still blocking Echo?". The **board** counts only _paid, today_ X-ray orders. The **station queue** counts _today_ orders at any payment. The **service** (`assertReadyToStart`) counts _any urgency, any payment_. So (a) with an unpaid X-ray and a paid Echo, the board puts the patient in **Echo** as startable while the Echo screen refuses; (b) a `next_visit` X-ray blocks today's Echo in the service forever. | `board.js` `owningMachineStation` (paid lateral), `machineStation.js:257-262` (no `urgency` filter), `:441-451`. Last 7 days: 5 open _today_ machine orders still `payment_pending`. No visit has had unpaid X-ray + paid Echo yet, so this is latent. | Medium, latent                             |
| G3  | The timeline still says "Waiting for the Machine Room — 2D Echo" and "On the machine — X-Ray". The per-test list in the timeline modal has no room.                                                                                                                                                                                                                                                                                                          | `board.js` `testSegmentsFor` (3 labels), `machineStation.js` `getMachineTrack`, `FlowManagerPage.jsx` "🩺 Machine tests". Smoke output 16 Sep: _"Waiting for the Machine Room — 2D Echo"_.                                                             | Low, wording                               |
| G4  | The patient's **journey** can put Echo before X-ray. The journey strip, the patient's `/visit/:token` tracker and the step order then contradict the floor rule, which both the board and the station enforce. `testsBeforeDoctors` ranks lab steps only and keeps machine steps in insertion order.                                                                                                                                                         | `shared/journeyOrder.js:5`, `:27-30`. **Live 16 Sep:** the only visit with both steps has `echo.step_order = 2`, `x_ray.step_order = 3`.                                                                                                               | Medium, visible today                      |
| G5  | Plan 45 §2 _Access_ says `echo_tech` holds `GINIFLOW_BOARD`. The code removed it (`shared/permissions.js:341-358`), and `xray_tech` matches.                                                                                                                                                                                                                                                                                                                 | Doc drift.                                                                                                                                                                                                                                             | **Fixed in this review** (plan 45 updated) |
| G6  | `RESUME_CAPS` holds no machine, X-ray or Echo capability, so none of those techs can resume a paused patient. Already known from plan 43 §9.6, and it now affects three roles.                                                                                                                                                                                                                                                                               | `routes/giniflow.js:527-534`                                                                                                                                                                                                                           | Low, carried over                          |

Checked and found fine: `COLUMN_NAME` maps in the lab, pharmacy and machine station services
(`columnForStatus` never returns a machine column); `queue.js` `columnStatuses` (returns `null`,
so it refuses a move); `smoke-giniflow-queue.mjs` column loop (skips `statuses: null`);
`STAT_FILTERS` (no column keys); `giniflowNoticeSchema` (free-text station);
`/flow/step-catalog` (already returns `machine_requires_before` via `SELECT *`); station
launcher tiles (plan 46 already split them).

---

## 8. Phase 2 design

### P1 — Behind names the room (G1)

`behind_station` becomes `'machine' | 'xray' | 'echo'`, the same strings as the board column keys.
It is a free `TEXT` column (`2026-09-11_healthray_observation.sql`), so **no migration** is needed.

- `observation.js`: `BEHIND_STATIONS = [..., "machine", "xray", "echo"]`, and
  `BEHIND_STATION_LABEL` gets `xray: "X-Ray"` and `echo: "Echo"`.
- Both SQL builders (`firstUnrecordedStation`, `recordHealthrayObservation`) replace the
  `machine_open` boolean with `machine_behind`, the first open machine room in board order:

  ```sql
  (SELECT CASE
            WHEN bool_or(COALESCE(m.station, 'machine_room') = 'machine_room') THEN 'machine'
            WHEN bool_or(m.station = 'xray') THEN 'xray'
            WHEN bool_or(m.station = 'echo') THEN 'echo'
          END
     FROM giniflow_lab_orders o
     JOIN giniflow_lab_order_tests t ON t.lab_order_id = o.id
     LEFT JOIN LATERAL (
       SELECT c.machine_station AS station
         FROM flow_step_catalog c
        WHERE c.machine AND COALESCE(c.is_active, TRUE)
          AND ${FLAT('t.test_name')} = ANY (
                SELECT ${FLAT('n')} FROM unnest(array_append(COALESCE(c.bill_names, '{}'), c.order_test_name)) n)
        LIMIT 1
     ) m ON TRUE
    WHERE o.visit_id = v.id AND o.urgency = 'today' AND o.kind = 'machine'
      AND o.sample_status <> 'reported') AS machine_behind
  ```

  `FLAT(x)` = `regexp_replace(lower(x), '[^a-z0-9]+', '', 'g')`, the SQL twin of
  `machineStages.flatten`. It is exact-match only. A name that only the JS substring tier would
  match falls back to `machine_room`, which is the same fallback the station queue uses.
  `CASE … WHEN s.machine_open THEN 'machine'` becomes `ELSE s.machine_behind`.

  Catalogue columns checked on 16 Sep 2026: `order_test_name`, `bill_names`, `machine_station`
  and `is_active` are the names `machineCatalog.js` loads.

- `schemas/index.js` `giniflowBehindQuerySchema`: add `"xray"` and `"echo"` to the enum.
  **Coordinate first:** another session has uncommitted auth changes in that file (16 Sep).
- Rows already written keep `'machine'`. The observation loop rewrites a row only when the value
  changes, so today's rows correct themselves on the next pass (≤30 s). No backfill is needed.

### P2 — One definition of "X-ray still blocks Echo" (G2)

**Rule:** a machine's `requiresBefore` blocks it while the same visit has a **today** order for
that machine that isn't `reported`, **whatever its payment state**. An unpaid X-ray still has to
be paid and done first, because payment comes before any test (settled floor rule).

- `machineStation.js` `assertReadyToStart`: add `AND o.urgency = 'today'` (fixes G2b).
- Station queue: already this rule (today, any payment). No change.
- Board: `MACHINE_HOLD_SQL` gains `open_machine_tests`, the names of every today machine test not
  yet `reported`, at any payment. `machineCardFor` passes the resolved ids to
  `owningMachineStation(tests, blockerIds)` in place of the ids it derives from paid tests.
- Card wording: a waiting test held by a blocker says
  `⏳ 2D Echo — X-Ray first`, and if the blocker is unpaid,
  `⏳ 2D Echo — X-Ray to be paid and done first`. `machineCardFor` sets the per-test
  `heldBy: { machine, label, unpaid }`, and the client chip reads it.
- Placement is otherwise unchanged. An unpaid X-ray still never reaches the track (plan 43 D2),
  so a patient with an unpaid X-ray and a paid Echo sits in **Echo**, and the card says why they
  can't start. The Echo tile/column count is honest; the button state matches the screen.

### P3 — Timeline names the room (G3)

- `testSegmentsFor`: each `machineOrders` entry carries `station`, set at the point where
  `getTestSegments` resolves names with `machineForTest`. Labels become
  `Waiting for ${roomName} — …` (the room of the first waiting test, by the P2 rule) and
  `On the ${roomName} machine — …`. For the Machine Room this keeps the current wording.
  `roomName` = `machineColumnName(machineColumnFor(station))`.
- `getMachineTrack`: resolve `station` per row with `getMachines(db)`, and return `room`.
- `FlowManagerPage.jsx` timeline modal: show `m.room` before each machine row. The header becomes
  "🩺 Machine tests" → "🩺 Machine, X-Ray & Echo tests" only when more than one room appears.

### P4 — Journey honours `requiresBefore` (G4)

- `shared/journeyOrder.js`: new pure `requiredStepsFirst(steps, { idOf, requiresOf })`. It is a
  stable pass: for each step whose required step comes **later** in the list, move the required
  step to just before it. Pending steps only; a started or completed step never moves. It returns
  the same array when nothing changes, same as `testsBeforeDoctors`.
- `journey.js` `placeTestsBeforeDoctors`: select `c.machine_requires_before` and run
  `requiredStepsFirst` **after** `testsBeforeDoctors`. This runs even when the doctor step has
  already started, because ordering between two tests doesn't depend on the doctor.
- `ReceptionStationPage.jsx` `withBilledSteps`: same composition, with
  `requiresOf: (s) => catalogue[s.catalogId]?.machine_requires_before`. The catalogue rows
  already carry the field.
- Existing journeys: the next `placeTestsBeforeDoctors` call (any test order) fixes them. For
  today's floor, `server/scripts/reorder-required-steps.mjs` (dry run by default, `--apply` to
  write) runs `placeTestsBeforeDoctors` on today's visits that have both steps.
  **Production write:** run it only with the user's go-ahead.

### P5 — Resume (G6)

Add `GINIFLOW_STATION_MACHINE`, `GINIFLOW_STATION_XRAY` and `GINIFLOW_STATION_ECHO` to
`RESUME_CAPS`. Pause stays with the coordinator (`PAUSE_CAPS` unchanged).

---

## 9. Phase 2 work items

| #   | Change                                                                                                   | Files                                                                                                          | Gap |
| --- | -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | --- |
| X1  | Behind keys/labels for `xray`, `echo`; `machine_behind` in both SQL builders                             | `server/services/giniflow/observation.js`                                                                      | G1  |
| X2  | Behind query enum (coordinate with the auth session)                                                     | `server/schemas/index.js`                                                                                      | G1  |
| X3  | `urgency = 'today'` on the requires-before check                                                         | `server/services/giniflow/machineStation.js`                                                                   | G2  |
| X4  | `open_machine_tests` in `MACHINE_HOLD_SQL`; `owningMachineStation(tests, blockerIds)`; per-test `heldBy` | `server/services/giniflow/board.js`                                                                            | G2  |
| X5  | Chip text for `heldBy`                                                                                   | `src/pages/giniflow/FlowManagerPage.jsx`                                                                       | G2  |
| X6  | Room-aware segment labels; `station` on `machineOrders`                                                  | `board.js`                                                                                                     | G3  |
| X7  | `room` on `getMachineTrack`; timeline row shows it                                                       | `machineStation.js`, `FlowManagerPage.jsx`                                                                     | G3  |
| X8  | `requiredStepsFirst`, used by `placeTestsBeforeDoctors` and `withBilledSteps`                            | `shared/journeyOrder.js`, `server/services/giniflow/journey.js`, `src/pages/giniflow/ReceptionStationPage.jsx` | G4  |
| X9  | Dry-run/apply reorder script for today                                                                   | `server/scripts/reorder-required-steps.mjs`                                                                    | G4  |
| X10 | Machine/X-ray/Echo caps in `RESUME_CAPS`                                                                 | `server/routes/giniflow.js`                                                                                    | G6  |
| X11 | Smoke cases §10                                                                                          | `server/scripts/smoke-giniflow-machine-board.mjs`, `server/scripts/smoke-machine-steps.mjs`                    | all |

**Build order:** X3 (one line, independent) → X4 + X5 → X6 + X7 → X8 → X11 → X1 → X2 (after
coordinating) → X10 → X9 (dry run; `--apply` only on the user's go-ahead). After each step run
`npm run smoke:giniflow-machine-board`. After X8 also run `npm run smoke:machine-steps`.
Finish with `vite build` and `npm run format:check`.

---

## 10. Phase 2 tests

Pure checks (no database):

| #   | Case                                                           | Expect                                                                                         |
| --- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| U1  | Echo paid, X-ray `payment_pending` (blocker ids include X-ray) | column `echo`; Echo test `heldBy.unpaid === true`; chip says "X-Ray to be paid and done first" |
| U2  | Echo paid, X-ray `next_visit` only                             | Echo not held                                                                                  |
| U3  | Echo + X-ray both paid, X-ray `reported`                       | Echo not held, column `echo`                                                                   |
| U4  | `requiredStepsFirst`: `[vitals, echo, x_ray, doctor]`          | `[vitals, x_ray, echo, doctor]`                                                                |
| U5  | Same, but `echo` already `in_progress`                         | unchanged                                                                                      |
| U6  | No `requiresOf` hits                                           | same array reference returned                                                                  |
| U7  | `testsBeforeDoctors` then `requiredStepsFirst` with lab steps  | lab billing → blood → X-ray → Echo → doctor                                                    |
| U8  | Segment labels for an Echo-only visit                          | "Waiting for Echo — 2D Echo" / "On the Echo machine — 2D Echo"                                 |
| U9  | Segment labels for an ABI visit                                | unchanged Machine Room wording                                                                 |

Live, read-only (today's board):

| #   | Case                                                                   | Expect                                                              |
| --- | ---------------------------------------------------------------------- | ------------------------------------------------------------------- |
| L1  | Every visit with `behind_station` in (`machine`, `xray`, `echo`)       | value equals the room of its first open machine test in board order |
| L2  | `getBehindVisits(day, db, { station: "echo" })`                        | returns only Echo-owed rows; no throw                               |
| L3  | For every machine card, `getMachineTrack` rooms                        | include the card's `machine.column` room                            |
| L4  | Visits with both `x_ray` and `echo` pending steps                      | `x_ray.step_order < echo.step_order` (after X9 is applied)          |
| L5  | For every Echo-column card with a `heldBy`, the Echo station queue row | has `nextAction === null` and the same blocker in `blockedReason`   |

Rolled back (inside `BEGIN … ROLLBACK`, like the existing smoke):

| #   | Case                                                              | Expect                                 |
| --- | ----------------------------------------------------------------- | -------------------------------------- |
| R1  | `assertReadyToStart` for Echo with only a `next_visit` X-ray open | does not throw the requires-before 409 |
| R2  | `placeTestsBeforeDoctors` on a visit with Echo before X-ray       | returns `true`; X-ray now first        |

---

## 11. Phase 2 risks

- **SQL vs JS name matching (P1).** The SQL match is exact-only. A HealthRay bill line that only
  the JS substring tier recognises lands in `machine` for Behind while the board puts the patient
  in X-Ray/Echo. L1 catches it on the live board. If it fires, pass the resolved per-order
  station from JS instead (a `text[]` parameter of order ids per room).
- **`schemas/index.js` is being edited by the auth session.** Land X2 after that work is
  committed, or as a separate small commit that doesn't touch their hunks.
- **Journey reorder is a production write (X9).** It changes `step_order` only for pending
  steps, but it is still a write to live visits. Do a dry run first and get the user's go-ahead.
- **More status text in the chip (X5).** Check the card at 400 px width, where chip text already
  wraps.

---

## 12. Phase 2 build record (16 Sep 2026)

| #   | State              | Note                                                                                                                                                                                              |
| --- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| X1  | Built              | `MACHINE_BEHIND_SQL` in `observation.js`. The stored `behind_station` changes only once the worker/API runs this code; until the deploy, today's Echo patient still reads `machine` in the table. |
| X2  | Built              | One-line enum change in `schemas/index.js`, in a separate hunk from the auth session's uncommitted edits. Stage it on its own.                                                                    |
| X3  | Built              | —                                                                                                                                                                                                 |
| X4  | Built              | `blockersFor` + `open_tests` in `MACHINE_HOLD_SQL`; `owningMachineStation` reads `heldBy`.                                                                                                        |
| X5  | Built              | Chip: `⏳ 2D Echo — X-Ray first` / `— X-Ray to be paid and done first`.                                                                                                                           |
| X6  | Built              | `waitingLabel` / `runLabel` in `board.js`.                                                                                                                                                        |
| X7  | Built              | `getMachineTrack` returns `room`; timeline rows read "Echo · 2D Echo".                                                                                                                            |
| X8  | Built              | `requiredStepsFirst` runs in `placeTestsBeforeDoctors` (every check-in and test order) and in reception's preview (`inJourneyOrder`).                                                             |
| X9  | Built, not applied | `node server/scripts/reorder-required-steps.mjs [YYYY-MM-DD] [--apply]`. Dry run on 16 Sep: 0 journeys to fix (the misordered visit seen during the review no longer has both steps pending).     |
| X10 | **Deferred**       | No machine, X-Ray or Echo screen has a Resume button, so the capability alone would do nothing. It needs a paused-patient row with a Resume action on `MachineStationPage` first.                 |
| X11 | Built              | Covers U1–U9, L1–L3, L5, and R2 (runs only when a misordered journey exists that day).                                                                                                            |

Live results on 16 Sep: L1 `firstUnrecordedStation` → `echo` for the 2D Echo patient; L2 all three
filters clean; L3 timeline rooms "Echo, X-Ray". L5 had no held card to compare that day.

Not covered by an automated check:

- **R1** (a next-visit X-ray no longer blocks today's Echo). It is a one-line SQL filter, reviewed
  by reading. `smoke-machine-steps.mjs` has no X-ray/Echo scenario; add one when that smoke is
  next touched.
- **L4** is only meaningful after an `--apply`.
- **The board in a browser.** The Chrome extension wasn't connected, so the new chip text and
  the timeline room labels weren't looked at on screen.

---

## 13. Unpaid machine tests sit in their machine column (16 Sep 2026)

**Asked:** a patient whose ABI, VPT and Fundus are still unpaid after vitals (P*181774) was shown
in \_With Chief Endocrinologist*, a column that has nothing to do with them at that point. They
belong in the machine room's column.

**Rule change.** This replaces plan 43 D2's "only paid orders reach the Machine Room column".
Payment still comes first for the _test_: the station screens and `assertReadyToStart` still
refuse to start an unpaid test. What changed is only where the board **shows** the patient.

- `MACHINE_HOLD_SQL` `orders` takes every open today machine order and returns `paid`.
- `machineCardFor`: per-test `unpaid`; card `awaitingPayment` when every waiting test is unpaid;
  subtitle `💳 ABI, VPT — payment pending at reception`. `owningMachineStation` prefers a room
  with a **paid** test that can start, otherwise it falls back to the waiting tests in room order.
  So an unpaid X-ray alone sits in X-Ray.
- Card chip `💳 ABI — pay at reception`; middle line "Payment pending at reception".
- `NOTIFY_TARGET` for `machine` / `xray` / `echo` is now `[<station>, "reception"]`, because
  these columns can now stall at the payment desk, the same way the Lab track can.
- Timeline: `getTestSegments` reads unpaid machine orders too. With nothing paid yet, the
  current step is an open "Waiting for payment at reception — ABI, VPT, Fundus".
- **Lab track, same rule (added later on 16 Sep).** `MACHINE_HOLD_SQL` `lab_undrawn` and
  `lab_open` count lab orders at any payment state, and a new `lab_unpaid` is added. So after
  vitals, an unpaid lab order puts the patient on the Lab track, whose card already says
  "💰 Waiting: reception payment". The timeline hold reads "Waiting for payment at reception — lab
  tests", and `testSegmentsFor` opens a payment wait (`labUnpaid`) instead of "At the lab".
  Collection still needs payment. The Chief-column 💳 hint now only shows for a patient held in a
  doctor's room.

Checks (`smoke:giniflow-machine-board`): only-unpaid card → Machine Room with `awaitingPayment`;
paid ABI + unpaid X-ray → Machine Room; unpaid X-ray alone → X-Ray; T2 now asserts that
unpaid orders appear on the card marked `unpaid`. Live 16 Sep: P_181774 is in Machine Room, and
its timeline's current step is the payment wait.

Lab-track check (rolled back, `smoke:giniflow-machine-board`): an unpaid lab order was added to
a real `vitals_done` visit inside a transaction. The patient then had a Lab hold with the
payment label, an open payment wait in the timeline, and exactly one place on the board (the
Lab track). The transaction was rolled back and nothing was left behind (verified).
