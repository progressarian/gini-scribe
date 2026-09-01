# Vitals station queue — waiting time, priority, reasons, and a done list

**Date:** 1 Sep 2026
**Status:** implemented
**Screen:** `/giniflow/station/vitals` — `src/pages/giniflow/VitalsStationPage.jsx`
**Service:** `server/services/giniflow/vitalsStation.js`
**Builds on:** `10-QUEUE-CONTROL-PLAN.md` (priority, manual order)

Does **not** touch the MO/SD station (`08-MO-SD-STATION-PLAN.md`) — that work is left as it stands.

---

## 1. What the screen shows today

The queue column renders, per patient: a slot word (`Now` / `Next` / an appointment time), the name,
`age/sex · file no · visit number`, a category badge, and up to two biomarker chips. Under the list,
one line: `✓ Done today: 12 patients`.

Four things the nurse cannot see:

| Missing                        | Consequence on the floor                                                                                                           |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| **How long anyone has waited** | The board is measuring `checkin_to_vitals` against an SLA and colouring cards red. The station that could act on it shows nothing. |
| **Why this patient matters**   | An urgent patient sits in appointment-time order like everyone else.                                                               |
| **Any reason text**            | A priority has a reason and a hold has a reason; neither reaches the station.                                                      |
| **Who is already done**        | A count, not a list. A nurse who mistyped a weight has no way back to the patient.                                                 |

## 2. What the data already knows

Findings from reading the current code, before proposing anything:

- **The wait is already computed — and thrown away.** `getVitalsQueue` returns `checkedInAt` for
  every row; `VitalsStationPage` never renders it. The board derives its timers from the last event
  (`status_since`) and colours them with `budgetColour` against `STATUS_TO_SLA_KEY`. All of that is
  reusable; the station just never asked.
- **Priority landed last week.** `giniflow_visits.priority` + `priority_reason` exist from the board
  queue-control work, and `compareQueue` is already the shared ordering rule.
- **There is no VIP flag in Gini Flow, and we must not borrow one.** `is_vip` exists only on
  `flow_visits`, in the retired `flow_*` module. Gini Flow shares no tables with it by design
  (`00-OVERVIEW.md` §2.3, GF-13), so reaching for `is_vip` would reconnect the two systems through
  the back door. **VIP is `priority: urgent`.** One concept, one column, already in the UI vocabulary.
- **Blocked patients silently vanish from this screen.** `QUEUE_STATUSES` is
  `checked_in · vitals_pending · with_vitals`; `blocked_reports` is not in it. A patient held for
  missing reports is sitting in the waiting room and the station has no idea they exist, or why.
- **A correction is already supported server-side.** `saveVitals` only advances a patient who is
  still in the queue statuses — "a correction to an already-recorded visit saves the reading without
  dragging them back through the chain". So a done list can be tappable with no new write path.

## 3. Plan

### 3.1 Waiting time — the number, live

`getVitalsQueue` gains the last-event timestamp per row and returns, per patient:

- `statusSince` — when they entered their current status
- `waitMinutes` + `waitBudget` + `waitColour` — via the same `slaKeyForStatus` / `budgetColour` the
  board uses, so a red card on the board is a red row here
- `checkedInAt` — kept, now actually rendered as "in since 10:42"

The row shows `⏱ 23m waiting`, ticking client-side between the 15s polls (the board's `useTick` +
server-offset pattern), because a queue timer that only moves every 15 seconds reads as frozen.

For the patient at the station (`with_vitals`) the same chip measures time **at** the station against
the `vitals` budget instead — the queue wait ended when they sat down.

### 3.2 Priority to the top, with its reason

Queue order becomes:

1. the patient physically at the station (`with_vitals`) — there is exactly one "Now", unchanged
2. **priority** — urgent, then high, then normal
3. a manual position set from the board, when it belongs to this queue (`queue_column`)
4. longest waiting first

Which is `compareQueue` with the at-station rule in front of it. An urgent row gets a red left edge,
an `❗ URGENT` chip, and its `priority_reason` on its own line ("chest pain"). High gets the amber
equivalent. Normal rows look exactly as they do today.

The slot word stays: `Now`, `Next`, then appointment times. It describes position in the queue, which
is now the prioritised order — that is the point.

### 3.3 Reasons

Two different reasons, both surfaced, never conflated:

- **`priority_reason`** — why this patient jumped the queue. Shown on the row, under the name.
- **`blocked_reason`** — why a patient is not callable. Blocked patients get their own group under
  the queue, **"Held — not ready"**, muted and not tappable, each with its reason ("Lab payment
  pending"). They are in the building; the station should know they exist and know not to call them.

### 3.4 Done list at the bottom

The count becomes a list. `getVitalsQueue` returns `done[]` — every visit with a `giniflow_vitals`
row today, newest first: name, file no, the time recorded, the key readings (BP, weight), and where
the patient is **now** (`With SD`, `Waiting — doctor`), so the nurse can see the queue moving.

Tapping a done row reopens that patient's reading for correction. The detail pane already loads
`recorded` values into the form, and `saveVitals` already refuses to walk them backwards — so this is
a read path, not a new write path. The save button says **"Save correction"** rather than "Save and
send to MO" when the patient has already moved on.

## 4. Not doing

- **No new VIP column.** See §2 — VIP is `priority: urgent`.
- **No priority editing from the station.** Setting priority is the coordinator's call from the
  board, where the whole floor is visible; a nurse re-ranking their own queue from inside it is how
  queues stop meaning anything. The station shows priority, it does not set it.
- **No unblocking from here.** Same reasoning as BQ-05: a hold is cleared where it was set.
- **Not touching the MO/SD station.**

## 5. Files

| File                                        | Change                                                                          |
| ------------------------------------------- | ------------------------------------------------------------------------------- |
| `server/services/giniflow/vitalsStation.js` | wait/budget/colour per row, priority sort, held group, done list                |
| `src/pages/giniflow/VitalsStationPage.jsx`  | live timer chip, priority chip + reason, held group, done list, correction copy |
| `src/styles/giniflow-station.css`           | priority rows, timer chips, held + done groups                                  |
| `server/scripts/smoke-giniflow-vitals.mjs`  | order, wait maths, held exclusion, done list                                    |

No migration: every column this needs already exists.
