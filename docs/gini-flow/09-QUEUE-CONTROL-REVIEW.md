# Board queue control — mid-implementation review

**Date:** 1 Sep 2026
**Reviewing:** the task currently in the working tree — patient priority, manual queue order, and
drag-to-move on the Flow Manager board.

**Files:** `server/migrations/2026-09-01_giniflow_priority_queue.sql`,
`server/services/giniflow/queue.js`, `src/queries/hooks/useGiniflowQueue.js`, and the changes to
`shared/giniflowStatus.js`, `shared/permissions.js`, `server/routes/giniflow.js`,
`server/schemas/index.js`, `server/services/giniflow/board.js`,
`server/services/giniflow/statusEngine.js`, `src/pages/giniflow/FlowManagerPage.jsx`.

**Method:** static review. Nothing executed against the database; no files changed.
This is a review of work in progress, not of a finished feature — the UI is deliberately absent, so
findings are aimed at what to settle _before_ the screen is written.

**Findings:** 3 blocking · 2 high · 5 medium · 2 low.

---

## 1. State of the task

| Layer                                                                                      | State |
| ------------------------------------------------------------------------------------------ | ----- |
| Migration — `priority`, `queue_position`, `priority_set_by/at`, index                      | ✅    |
| Shared vocabulary — `PRIORITIES`, `COLUMN_ENTRY_STATUS`, `canDropInColumn`, `compareQueue` | ✅    |
| Service — `setPriority`, `reorderColumn`, `moveToColumn`                                   | ✅    |
| API — 3 endpoints, Zod schemas, `GINIFLOW_MANAGE_QUEUE`, 409 on an illegal move            | ✅    |
| Board — carries `priority`/`queuePosition`/`resumeStatus`, sorts by `compareQueue`         | ✅    |
| `advanceStatus` clears `queue_position` on every move                                      | ✅    |
| Optimistic client hooks — priority, reorder, move                                          | ✅    |
| **The UI** — no drag handlers, no drop targets, no priority control, no CSS                | ❌    |
| **Smoke coverage** — none for any of the three endpoints or the sort rule                  | ❌    |
| **A plan document** — `08-MO-SD-STATION-PLAN.md` is a different feature                    | ❌    |

`FlowManagerPage.jsx` imports `BOARD_COLUMNS`, `PRIORITIES`, `PRIORITY_LABEL`, `PRIORITY_ICON`,
`canDropInColumn`, `compareQueue` and all three hooks, and uses none of them. That is the honest
marker of where this stands: the back half is complete, the screen is untouched.

---

## 2. What is good — keep

- **Priority is not an event, and the reason is written down.** Every duration in Gini Flow is the
  gap between consecutive `giniflow_visit_events` rows, so a non-journey event would restart the
  patient's station timer and split their timeline. Recording priority on the visit row — like
  `category` and `blocked_reason` — is correct, and both the migration and the service say why.
- **`reorderColumn` takes the column's whole order**, not one card's new index, so the result does
  not depend on which render of the board the manager happened to be dragging.
- **Stale ids are ignored rather than rejected.** The board polls every 10s; failing an entire
  reorder because one card had moved on would discard the intent for everyone else in the column.
- **`moveToColumn` goes through `advanceStatus`** with `actorRole: 'coordinator'` and no
  `allowSkip` — the same log, the same legality rules, the same timers as a station screen. This is
  the rule Phase 2's vitals station broke, and it is respected here.
- **`coordinator` was added to `ACTOR_ROLES`** rather than logging a manager's action as `system` —
  an event a person caused stays attributable to them.
- **One ordering rule in `shared/`**, applied by the board service and again by the client after an
  optimistic drag, so the two cannot disagree. (The intent is right; see BQ-01 for where it slips.)
- **Illegal moves answer 409 with the chain's own message**, not a 500 — a manager's mis-drop is not
  a server fault.
- **The reorder array is capped at 200** so a malformed client cannot push an unbounded array into
  the `UNNEST`.

---

## 3. Blocking — settle before writing the UI

### 🔴 BQ-01 — server and client disagree about what a priority change does

`useGiniflowSetPriority` optimistically sets `queuePosition: null`, with a comment explaining why:
the manager has just said something stronger about where the patient belongs, and leaving the old
position would pin an urgent patient below the person they were meant to overtake. **`setPriority`
in the service does not clear it.**

The card jumps to the top of the column, then snaps back to its pinned position on the next 10s
poll. `compareQueue` lives in `shared/` precisely so the client and the server can never disagree
about order; this is that disagreement, one layer up.

**Recommendation.** Clear `queue_position` in the `setPriority` UPDATE. The client's reasoning is
the correct one — make the server match it.

### 🔴 BQ-02 — "adjacent column" drags will fail constantly

The comment on `COLUMN_ENTRY_STATUS` says the entry points are spaced so that every adjacent column
drag is a legal forward move under `MAX_FORWARD_JUMP = 2`. That is true of the entry statuses
(2→4→6→8→9→11→13, every gap ≤ 2) — but **a card sitting in a column is usually not at that column's
entry status**:

| Card's real status | Lives in column | Drag one column right → | Jump  | Result      |
| ------------------ | --------------- | ----------------------- | ----- | ----------- |
| `vitals_done` (5)  | SD / MO         | `ready_for_doctor` (8)  | **3** | ❌ rejected |
| `sd_pending` (6)   | SD / MO         | `ready_for_doctor` (8)  | 2     | ✅          |
| `doctor_done` (10) | Pharmacy        | `exited` (13)           | **3** | ❌ rejected |
| `checked_in` (2)   | Checked in      | `with_vitals` (4)       | 2     | ✅          |

The SD column holds three statuses and the pharmacy column two, so this is not an edge case — it is
the common case for those columns. `canDropInColumn` will grey the drop out with no explanation, and
anyone hitting the API directly gets a 409 they cannot act on.

**Recommendation.** Decide the rule before drawing the UI: either raise the allowed jump for a
manager's explicit drag (it is a deliberate act, not a mis-tap), or have the drop target show _why_
it is refused. Silently un-droppable columns are the worst of the three options.

### 🔴 BQ-03 — dropping on "Done today" is an irreversible `exited`

`COLUMN_ENTRY_STATUS.done = 'exited'`. Dropping a card there writes a terminal status, with no
confirmation and no undo — backwards transitions are rejected by design, and the append-only
doctrine means a correction can only ever be a further forward event, of which there are none.

Two consequences: a mis-drop on a touch wall display permanently ends that patient's journey on the
board, and it skips `dispensed`, so pharmacy time is never measured for that visit.

**Recommendation.** Require a confirmation for the Done column specifically (the copy can name what
it does: "marks the patient as having left — this cannot be undone"), and consider whether the drop
should write `dispensed` rather than `exited`.

---

## 4. High

### 🟠 BQ-04 — the lab column is now sorted by the wrong clock

`getDayBoard` sorts every column except `done` with `compareQueue`, whose final tiebreak is
`statusMinutes`. Lab-track cards are timed on `lab.minutes` — a different clock, against the
`lab_total` budget. Before this change the column inherited the SQL's `ORDER BY last_ev.occurred_at`;
it now orders by how long the patient has been waiting somewhere else entirely.

**Recommendation.** Either exclude `lab` from `compareQueue` as `done` already is, or give the
comparator the card's own timer rather than assuming `statusMinutes`.

### 🟠 BQ-05 — dragging a blocked patient silently unblocks them

`advanceStatus` nulls `blocked_reason` on any transition that is not into `blocked_reports`. So a
drag clears the block with no record of who cleared it or why — while the engine, since GF-18,
_requires_ a reason to set one. The asymmetry means the board can undo a documented decision with an
undocumented gesture.

**Recommendation.** Either refuse to move a blocked card without an explicit unblock, or record the
clearing in the move event's `meta`.

---

## 5. Medium

**🟡 BQ-06 — a stale `queue_position` pins a patient to the top of a column they have left.** The
position is a bare int with no column key; `compareQueue` sorts any positioned card above every
unpositioned one. `advanceStatus` clears it (good), but anything that changes status by another path
— the demo seeder's bulk insert, a manual UPDATE, a future backfill — leaves a position behind.
_Store the column the position belongs to, or clear it in the same places `current_status` is
written._

**🟡 BQ-07 — priority has no reason and no history.** `priority_set_by/at` hold only the latest
change; there is no `priority_reason`. An ❗ on a card tells the floor nothing about why, and the
project has already set the opposite precedent for blocking. Keeping priority out of the event log
is right; a small audit table, or a `meta` column, would preserve the reasoning without touching the
timers.

**🟡 BQ-08 — a partially applied reorder reports success.** `reorderColumn` returns `{ordered: n}`,
never compared against `visitIds.length`, and the client does not check. _Return the ignored ids so
the UI can say "2 patients had already moved on" instead of implying the order took._

**🟡 BQ-09 — reorder is accepted on `done`, then discarded.** `COLUMN_ENTRY_STATUS.done` is truthy,
so the endpoint allows it; `getDayBoard` skips sorting Done. The manager rearranges and nothing
happens. _Reject it, or sort Done too._

**🟡 BQ-10 — `GINIFLOW_MANAGE_QUEUE` was granted to `reception` as well as `coordinator`.**
Reception can move any patient to any column, including exited, and reorder every queue. That is a
wider grant than the payment desk needs, and it is not derived from any plan. _Confirm it is
intended, or narrow it to `coordinator` and `admin`._

---

## 6. Low

**🔵 BQ-11 — the optimistic move leaves the lab copy of a dual-rendered card stale.** A patient with
an open lab order appears in two columns; the move handler returns the lab column unchanged, so its
copy keeps the old status and timer until the next poll.

**🔵 BQ-12 — the new index serves nothing yet.** `(visit_date, queue_position, priority)` — sorting
happens in Node after the fetch, and the board query filters on neither column. Harmless, but it is
an index maintained for a query that does not exist.

---

## 7. Missing

| Missing                                     | Why it matters                                                                                     |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| The entire drag-and-drop UI                 | The feature is unreachable; the page imports its helpers and uses none                             |
| Any priority indicator on a card            | `PRIORITY_ICON` exists; nothing renders it, so setting a priority is currently invisible           |
| Smoke coverage                              | Every other part of Gini Flow ships one, and `compareQueue` is now in the board's hot path         |
| A keyboard path for reordering and moving   | Drag-only is inaccessible; Phase 1 already took findings on this                                   |
| An empty-column drop target                 | An empty column renders a muted "—" with no drop affordance                                        |
| Undo, or any correction path for a mis-drop | See BQ-03                                                                                          |
| A plan document for this feature            | The repo's convention is a plan before the feature; reviewing "is it done?" has no reference point |

---

## 8. Recommended order

1. **BQ-01** — clear `queue_position` in `setPriority`. One line, and it changes what the UI shows.
2. **BQ-02** — decide the drag-distance rule. This determines what the drop targets can do.
3. **BQ-03** — decide what a Done drop writes and whether it confirms.
4. **BQ-04**, **BQ-05** — both are server-side and both are wrong today regardless of the UI.
5. Write the smoke suite for the three endpoints, the sort rule and the drop-legality matrix —
   before the UI, so the UI is built against settled behaviour.
6. Then the screen: drop targets, priority control, the ❗ indicator, keyboard equivalents.
7. **BQ-06 – BQ-10** alongside.

The two that actually block drawing anything are BQ-01 and BQ-02: both change what the screen has to
do, and both are cheaper to settle now than to retrofit around a finished interaction.
